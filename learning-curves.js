// ==========================================================================
// learning-curves.js  (register-module, same shape as efficiency-permissions.js)
//
// Curvas de aprendizaje por ESTILO y LÍNEA para el Plan Board.
//
//   Una curva reemplaza la eficiencia del estándar del planeador durante los
//   primeros días que un estilo corre en una línea:
//
//     Estilo NUEVO      días 1-2 → 25% · días 3-4 → 50% · días 5-6 → 60% · día 7+ → 70%
//     Estilo EXISTENTE  días 1-2 → 50% · días 3-4 → 60% · día 5+   → 70%
//
//   "Día N" = la N-ésima FECHA DISTINTA en la que el estilo tiene piezas
//   asignadas en esa línea desde la fecha de inicio de la curva. Fines de
//   semana, festivos y días sin ese estilo no cuentan. Si el planeador mueve
//   casillas, el conteo sigue al tablero.
//
//   Capacidad del día con curva:
//     piezas/día = operarios × horas × 60 × eficiencia_curva ÷ SAM
//   La curva nunca sube la eficiencia por encima del estándar del estilo
//   (eficiencia usada = min(curva, estándar)).
//
//   Avisos al CEO: cada vez que una curva llega a una etapa nueva (25 → 50,
//   50 → 60, 60 → 70) se escribe un evento en learning_curve_events. La
//   detección es "perezosa" (sin cron, apto para Lambda): se revisa al consultar
//   /api/ceo/learning-curve-events o /api/learning-curves, como mucho una vez
//   por minuto. El evento lleva la fecha real en que empezó la etapa.
//
//   Capacidad: planner-style-params.js consulta la curva en UN solo lugar, la
//   carga de la línea (lineLoadRange), mediante el resolvedor forLine() de
//   este archivo. Así la curva aplica igual en asignar, mover, mover en lote,
//   cambios urgentes, /api/planning/style-capacity y el re-planeo de estilos,
//   y un día compartido con otros estilos se calcula bien.
//
//   SETUP en server1.js (2 puntos):
//     a) junto a los otros requires/registros, DESPUÉS de plannerStyleParams:
//          const learningCurves = require("./learning-curves");
//          learningCurves(app, { authenticateToken, pool, setSchema, plannerStyleParams });
//        (registra el resolvedor en plannerStyleParams automáticamente)
//     b) en el bloque de arranque, con los otros initSchema (después de
//        work_orders y line_assignments):
//          await learningCurves.initSchema({ pool, setSchema });
// --------------------------------------------------------------------------

const DEFAULT_CURVE_ROLES = ["planner", "master", "ceo", "skyrina"];
const DEFAULT_CEO_ROLES = ["ceo", "master", "skyrina"];

// days = cuántos días dura la etapa; null = el resto de los días.
const PRESETS = {
  new: [
    { days: 2, eff: 0.25 },
    { days: 2, eff: 0.5 },
    { days: 2, eff: 0.6 },
    { days: null, eff: 0.7 },
  ],
  existing: [
    { days: 2, eff: 0.5 },
    { days: 2, eff: 0.6 },
    { days: null, eff: 0.7 },
  ],
};

const SWEEP_MIN_INTERVAL_MS = 60 * 1000;
let lastSweepAt = 0;

const norm = (s) => String(s ?? "").trim().toUpperCase();
const normLine = (l) => (l == null ? "" : String(l).trim());
const normEff = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1 ? n / 100 : n;
};
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const pct = (e) => `${Math.round(Number(e) * 100)}%`;
const dm = (ymd) => (ymd ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}` : "—");
const todayYmd = () => {
  // Fecha local de la planta (México). Se calcula en el servidor para que todos
  // los clientes vean la misma "fecha de hoy" al detectar etapas.
  const tz = process.env.PLANT_TZ || "America/Mexico_City";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
};

// Etapa del día N (1-based) en una lista de pasos.
function stageForDay(steps, n) {
  let start = 1;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.days == null || n < start + s.days) {
      return { index: i, eff: Number(s.eff), dayInStage: n - start + 1, startDay: start, isFinal: i === steps.length - 1 };
    }
    start += s.days;
  }
  const last = steps[steps.length - 1];
  return { index: steps.length - 1, eff: Number(last.eff), dayInStage: 1, startDay: start, isFinal: true };
}

function validSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 10) return null;
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const eff = normEff(steps[i]?.eff);
    if (eff == null || eff > 1) return null;
    const last = i === steps.length - 1;
    const days = last ? null : parseInt(steps[i]?.days, 10);
    if (!last && !(days >= 1 && days <= 60)) return null;
    out.push({ days, eff: Math.round(eff * 1000) / 1000 });
  }
  return out;
}

// SQL: clave de estilo de una orden (igual que el tablero y el servidor:
// style_code, si no estilo).
const WO_STYLE_SQL = "UPPER(TRIM(COALESCE(NULLIF(TRIM(wo.style_code), ''), NULLIF(TRIM(wo.estilo), ''), '')))";

// Fechas distintas (YYYY-MM-DD, ordenadas) en que el estilo tiene piezas en la
// línea desde `fromDate`.
async function assignedDates(client, { style, lineNo, fromDate }) {
  const r = await client.query(
    `SELECT DISTINCT to_char(la.assigned_date, 'YYYY-MM-DD') AS d
       FROM line_assignments la
       JOIN work_orders wo ON wo.id = la.work_order_id
      WHERE la.line_no::text = $1
        AND la.assigned_date >= $2::date
        AND COALESCE(la.status, 'planned') NOT IN ('cancelled', 'rejected')
        AND COALESCE(la.assigned_quantity, 0) > 0
        AND ${WO_STYLE_SQL} = $3
      ORDER BY d`,
    [normLine(lineNo), fromDate, norm(style)]
  );
  return r.rows.map((x) => x.d);
}

async function activeCurve(client, style, lineNo) {
  const r = await client.query(
    `SELECT *, to_char(start_date, 'YYYY-MM-DD') AS start_ymd
       FROM style_learning_curves
      WHERE UPPER(TRIM(style)) = $1 AND line_no = $2 AND status = 'active'
      LIMIT 1`,
    [norm(style), normLine(lineNo)]
  );
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Resolvedor por LÍNEA (lo usa planner-style-params.js para toda la capacidad).
//   forLine(client, { lineNo, styles?, excludeIds? }) → {
//     active, curveOf(style), datesOf(style),
//     stageOn(style, ymd) → { curveId, day, eff, index, ... } | null,
//     factor(style, ymd, stdEff) → min(curva, estándar) ÷ estándar   (1 sin curva)
//     addDate(style, ymd)  → cuenta un día recién colocado (re-planeo)
//   }
// Día N de una fecha = (fechas distintas del estilo en la línea antes de ella) + 1.
// excludeIds: asignaciones que se están moviendo (no cuentan como días).
// ---------------------------------------------------------------------------
const NO_CURVES = Object.freeze({
  active: false, factor: () => 1, stageOn: () => null, addDate: () => {}, curveOf: () => null, datesOf: () => [],
});

async function forLine(client, { lineNo, styles = null, excludeIds = [] } = {}) {
  const line = normLine(lineNo);
  if (!line) return NO_CURVES;
  const keys = Array.isArray(styles) ? [...new Set(styles.map(norm).filter(Boolean))] : null;
  if (keys && !keys.length) return NO_CURVES;
  let rows;
  try {
    rows = (await client.query(
      `SELECT *, to_char(start_date, 'YYYY-MM-DD') AS start_ymd
         FROM style_learning_curves
        WHERE status = 'active' AND line_no = $1
          AND ($2::text[] IS NULL OR UPPER(TRIM(style)) = ANY($2::text[]))`,
      [line, keys]
    )).rows;
  } catch {
    return NO_CURVES; // tabla aún no creada: nunca romper la planeación
  }
  if (!rows.length) return NO_CURVES;

  const byStyle = new Map(rows.map((c) => [norm(c.style), { curve: c, dates: [] }]));
  const minStart = rows.reduce((m, c) => (c.start_ymd < m ? c.start_ymd : m), rows[0].start_ymd);
  const ids = (excludeIds || []).map(Number).filter(Number.isFinite);
  const d = await client.query(
    `SELECT DISTINCT ${WO_STYLE_SQL} AS style, to_char(la.assigned_date, 'YYYY-MM-DD') AS d
       FROM line_assignments la
       JOIN work_orders wo ON wo.id = la.work_order_id
      WHERE la.line_no::text = $1
        AND la.assigned_date >= $2::date
        AND COALESCE(la.status, 'planned') NOT IN ('cancelled', 'rejected')
        AND COALESCE(la.assigned_quantity, 0) > 0
        AND ${WO_STYLE_SQL} = ANY($3::text[])
        AND NOT (la.id = ANY($4::bigint[]))
      ORDER BY 2`,
    [line, minStart, [...byStyle.keys()], ids]
  );
  for (const r of d.rows) {
    const e = byStyle.get(r.style);
    if (e && r.d >= e.curve.start_ymd) e.dates.push(r.d);
  }

  // Cuántas fechas de `arr` (ordenado) son < date.
  const countBefore = (arr, date) => {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < date) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const stageOn = (style, date) => {
    const e = byStyle.get(norm(style));
    const ymd = String(date || "").slice(0, 10);
    if (!e || !isYmd(ymd) || ymd < e.curve.start_ymd) return null;
    const day = countBefore(e.dates, ymd) + 1;
    return { curveId: Number(e.curve.id), day, ...stageForDay(e.curve.steps, day) };
  };
  const factor = (style, date, stdEff) => {
    const st = stageOn(style, date);
    const std = normEff(stdEff);
    if (!st || !std) return 1;
    return Math.min(st.eff, std) / std;
  };
  const addDate = (style, date) => {
    const e = byStyle.get(norm(style));
    const ymd = String(date || "").slice(0, 10);
    if (!e || ymd < e.curve.start_ymd) return;
    const i = countBefore(e.dates, ymd);
    if (e.dates[i] !== ymd) e.dates.splice(i, 0, ymd);
  };
  return {
    active: true,
    curveOf: (style) => byStyle.get(norm(style))?.curve || null,
    datesOf: (style) => [...(byStyle.get(norm(style))?.dates || [])],
    stageOn, factor, addDate,
  };
}

// Eficiencia de curva para (estilo, línea, fecha), o null si no aplica.
async function effOnDate(client, { style, lineNo, date }) {
  if (!style || lineNo == null || !isYmd(String(date).slice(0, 10))) return null;
  const r = await forLine(client, { lineNo, styles: [style] });
  const curve = r.curveOf(style);
  const st = r.stageOn(style, date);
  if (!curve || !st) return null;
  return { curve, day: st.day, stage: st, efficiency: st.eff };
}

// Ajusta el resultado de plannerStyleParams.cellCapacity con la curva.
// cap = { params, availableMinutes, target, available, ... }
async function adjustCellCapacity(client, args, cap) {
  try {
    if (!cap || !cap.params) return cap;
    const lc = await effOnDate(client, { style: args?.style, lineNo: args?.lineNo, date: String(args?.date || "").slice(0, 10) });
    if (!lc) return cap;
    const std = normEff(cap.params.efficiency);
    if (!std) return cap;
    const used = Math.min(lc.efficiency, std);
    const factor = used / std;
    const info = { curveId: lc.curve.id, day: lc.day, stage: lc.stage.index, efficiency: used, standardEfficiency: std, factor };
    if (!(factor < 1)) return { ...cap, learningCurve: info };
    const target = Number(cap.target) || 0;
    const reduction = target * (1 - factor);
    return {
      ...cap,
      target: target * factor,
      available: Math.max(0, (Number(cap.available) || 0) - reduction),
      availableMinutes: (Number(cap.availableMinutes) || 0) * factor,
      learningCurve: info,
    };
  } catch (e) {
    console.warn("⚠️  learning curve adjust skipped:", e.message);
    return cap;
  }
}

// Envuelve plannerStyleParams.cellCapacity para que TODA validación del
// servidor que lo use (asignar, mover, mover en lote, cambios urgentes) vea la
// curva. Las llamadas internas del propio módulo no pasan por aquí.
// Solo para una versión vieja de planner-style-params.js sin soporte nativo.
function wrapPlannerStyleParams(psp) {
  if (!psp || psp.learningCurveNative || typeof psp.cellCapacity !== "function" || psp.cellCapacity.__learningCurve) return;
  const original = psp.cellCapacity;
  const wrapped = async (client, args, ...rest) => adjustCellCapacity(client, args, await original(client, args, ...rest));
  wrapped.__learningCurve = true;
  psp.cellCapacity = wrapped;
}

async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS style_learning_curves(
        id BIGSERIAL PRIMARY KEY,
        style TEXT NOT NULL,
        line_no TEXT NOT NULL,
        curve_type TEXT NOT NULL DEFAULT 'new',
        start_date DATE NOT NULL,
        steps JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        last_stage INT NOT NULL DEFAULT -1,
        created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_by_name TEXT,
        cancelled_by_name TEXT,
        cancelled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_lc_type CHECK (curve_type IN ('new', 'existing', 'custom')),
        CONSTRAINT chk_lc_status CHECK (status IN ('active', 'cancelled'))
      );
    `);
    // Una sola curva ACTIVA por estilo + línea.
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_lc_active_style_line
         ON style_learning_curves (UPPER(TRIM(style)), line_no) WHERE status = 'active';`
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS learning_curve_events(
        id BIGSERIAL PRIMARY KEY,
        curve_id BIGINT REFERENCES style_learning_curves(id) ON DELETE CASCADE,
        style TEXT NOT NULL,
        line_no TEXT NOT NULL,
        event TEXT NOT NULL,
        stage_index INT,
        from_efficiency NUMERIC(4,3),
        efficiency NUMERIC(4,3),
        day_number INT,
        effective_date DATE,
        summary TEXT NOT NULL,
        user_name TEXT,
        seen_at TIMESTAMPTZ,
        seen_by_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_lce_event CHECK (event IN ('created', 'stage', 'completed', 'cancelled'))
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_lce_created ON learning_curve_events (created_at DESC);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_lce_unseen ON learning_curve_events (seen_at) WHERE seen_at IS NULL;");
    // Una etapa se avisa una sola vez por curva, aunque dos consultas corran a la vez.
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_lce_curve_stage
         ON learning_curve_events (curve_id, stage_index) WHERE event IN ('stage', 'completed');`
    );
    console.log("✅ style_learning_curves + learning_curve_events ready");
  } finally {
    client.release();
  }
}

async function insertEvent(client, ev) {
  await client.query(
    `INSERT INTO learning_curve_events
       (curve_id, style, line_no, event, stage_index, from_efficiency, efficiency,
        day_number, effective_date, summary, user_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11)
     ON CONFLICT DO NOTHING`,
    [
      ev.curveId, ev.style, ev.lineNo, ev.event, ev.stageIndex ?? null,
      ev.fromEff ?? null, ev.eff ?? null, ev.day ?? null, ev.effectiveDate || null,
      ev.summary, ev.userName || null,
    ]
  );
}

// Revisa las curvas activas y escribe un evento por cada etapa alcanzada que
// aún no se haya avisado. Una etapa se "alcanza" cuando su primer día ya llegó
// (fecha ≤ hoy).
async function sweepTransitions(client, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return 0;
  lastSweepAt = now;
  const today = todayYmd();
  const curves = await client.query(
    `SELECT *, to_char(start_date, 'YYYY-MM-DD') AS start_ymd
       FROM style_learning_curves
      WHERE status = 'active' AND start_date <= $1::date`,
    [today]
  );
  let written = 0;
  for (const c of curves.rows) {
    const steps = c.steps;
    if (Number(c.last_stage) >= steps.length - 1) continue; // curva ya completa
    const dates = await assignedDates(client, { style: c.style, lineNo: c.line_no, fromDate: c.start_ymd });
    const reached = dates.filter((d) => d <= today);
    if (!reached.length) continue;
    const top = stageForDay(steps, reached.length).index;
    if (top <= Number(c.last_stage)) continue;
    for (let s = Number(c.last_stage) + 1; s <= top; s++) {
      const st = stageForDay(steps, 1 + steps.slice(0, s).reduce((a, x) => a + (x.days || 0), 0));
      const day = st.startDay;
      const effectiveDate = reached[day - 1] || reached[reached.length - 1];
      const prevEff = s > 0 ? Number(steps[s - 1].eff) : null;
      const isFinal = s === steps.length - 1;
      const head = `${c.style} · Línea ${c.line_no}`;
      const summary = s === 0
        ? `${head}: arranca la curva de aprendizaje en ${pct(st.eff)} (día 1, ${dm(effectiveDate)})`
        : isFinal
        ? `${head}: completa la curva, pasa de ${pct(prevEff)} a ${pct(st.eff)} (día ${day}, ${dm(effectiveDate)})`
        : `${head}: pasa de ${pct(prevEff)} a ${pct(st.eff)} (día ${day}, ${dm(effectiveDate)})`;
      await insertEvent(client, {
        curveId: c.id, style: c.style, lineNo: c.line_no,
        event: isFinal ? "completed" : "stage",
        stageIndex: s, fromEff: prevEff, eff: st.eff, day, effectiveDate,
        summary, userName: "Automático · curva de aprendizaje",
      });
      written++;
    }
    await client.query(
      "UPDATE style_learning_curves SET last_stage = GREATEST(last_stage, $2), updated_at = now() WHERE id = $1",
      [c.id, top]
    );
  }
  return written;
}

function registerLearningCurves(app, deps) {
  const {
    authenticateToken, pool, setSchema, plannerStyleParams,
    curveRoles = DEFAULT_CURVE_ROLES, ceoRoles = DEFAULT_CEO_ROLES,
  } = deps;

  // La capacidad del Plan Board consulta las curvas a través de este resolvedor.
  if (typeof plannerStyleParams?.setLearningCurveProvider === "function") {
    plannerStyleParams.setLearningCurveProvider({ forLine });
  } else {
    wrapPlannerStyleParams(plannerStyleParams); // versión vieja del módulo
  }
  const canReplan = typeof plannerStyleParams?.replanStyleLines === "function";

  // Re-acomoda desde mañana las casillas 'planned' del estilo en la línea con
  // la capacidad nueva (festivos y semanas bloqueadas del CEO se respetan).
  const replan = async (client, style, lineNo) => {
    if (!canReplan) return null;
    const r = await plannerStyleParams.replanStyleLines(client, style, [lineNo]);
    const ln = (r?.lines || [])[0];
    return {
      recomputed: !!r?.recomputed,
      reason: r?.reason || null,
      error: r?.error || null,
      from: r?.from || null,
      daysBefore: ln?.daysBefore ?? 0,
      daysAfter: ln?.daysAfter ?? 0,
      lockedCells: r?.lockedCells || 0,
      unplaced: (r?.unplaced || []).map((u) => ({ ref: u.ref, qty: Math.round(u.qty), color: u.color })),
    };
  };

  const userName = (req) => req.user?.full_name || req.user?.username || null;
  const requireRoles = (roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: "Not authenticated" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: "No tiene permiso para esta acción." });
    }
    next();
  };

  const withClient = (handler) => async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      await handler(req, res, client);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`❌ learning-curves ${req.method} ${req.path}:`, err.message);
      if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  };

  // Capacidad estándar (piezas/día) del estilo en la línea, si se puede leer.
  const standardOf = async (client, style, lineNo) => {
    try {
      if (!plannerStyleParams?.getParams) return null;
      const sp = await plannerStyleParams.getParams(client, style, lineNo);
      if (!sp) return null;
      const target = typeof plannerStyleParams.targetOf === "function" ? Number(plannerStyleParams.targetOf(sp)) || 0 : 0;
      return { params: sp, efficiency: normEff(sp.efficiency), target };
    } catch {
      return null;
    }
  };

  const shapeCurve = (c) => ({
    id: Number(c.id),
    style: c.style,
    line_no: c.line_no,
    curve_type: c.curve_type,
    start_date: c.start_ymd || (c.start_date instanceof Date ? c.start_date.toISOString().slice(0, 10) : String(c.start_date).slice(0, 10)),
    steps: c.steps,
    status: c.status,
    last_stage: Number(c.last_stage),
    created_by_name: c.created_by_name,
    created_at: c.created_at,
    cancelled_at: c.cancelled_at,
  });

  // Días ya asignados que quedan por encima de la capacidad con curva.
  const overloadReport = async (client, curve) => {
    const std = await standardOf(client, curve.style, curve.line_no);
    if (!std?.efficiency || !(std.target > 0)) return [];
    const r = await client.query(
      `SELECT to_char(la.assigned_date, 'YYYY-MM-DD') AS d, SUM(la.assigned_quantity)::float AS qty
         FROM line_assignments la
         JOIN work_orders wo ON wo.id = la.work_order_id
        WHERE la.line_no::text = $1 AND la.assigned_date >= $2::date
          AND COALESCE(la.status, 'planned') NOT IN ('cancelled', 'rejected')
          AND COALESCE(la.assigned_quantity, 0) > 0
          AND ${WO_STYLE_SQL} = $3
        GROUP BY 1 ORDER BY 1`,
      [curve.line_no, curve.start_ymd, norm(curve.style)]
    );
    const out = [];
    r.rows.forEach((row, i) => {
      const st = stageForDay(curve.steps, i + 1);
      const eff = Math.min(st.eff, std.efficiency);
      const capacity = std.target * (eff / std.efficiency);
      if (row.qty > capacity + 0.5) {
        out.push({ date: row.d, day: i + 1, efficiency: eff, qty: Math.round(row.qty), capacity: Math.floor(capacity), excess: Math.round(row.qty - capacity) });
      }
    });
    return out;
  };

  // ------------------------------------------------------------------
  // GET /api/learning-curves?status=active|all&style=&lineNo=
  // ------------------------------------------------------------------
  app.get("/api/learning-curves", authenticateToken, withClient(async (req, res, client) => {
    try { await sweepTransitions(client); } catch (e) { console.warn("⚠️  lc sweep:", e.message); }
    const { status = "active", style, lineNo } = req.query;
    const where = [];
    const params = [];
    if (status !== "all") { params.push(status === "cancelled" ? "cancelled" : "active"); where.push(`status = $${params.length}`); }
    if (style) { params.push(norm(style)); where.push(`UPPER(TRIM(style)) = $${params.length}`); }
    if (lineNo) { params.push(normLine(lineNo)); where.push(`line_no = $${params.length}`); }
    const r = await client.query(
      `SELECT *, to_char(start_date, 'YYYY-MM-DD') AS start_ymd
         FROM style_learning_curves
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY status = 'active' DESC, created_at DESC
        LIMIT 500`,
      params
    );
    res.json({
      success: true,
      curves: r.rows.map(shapeCurve),
      presets: PRESETS,
      canEdit: curveRoles.includes(req.user?.role),
    });
  }));

  // ------------------------------------------------------------------
  // GET /api/learning-curves/check?style=&lineNo=
  //   ¿El estilo es nuevo? (nunca asignado y nunca producido) y la curva
  //   activa en esa línea, si hay.
  // ------------------------------------------------------------------
  app.get("/api/learning-curves/check", authenticateToken, withClient(async (req, res, client) => {
    const style = norm(req.query.style);
    const lineNo = normLine(req.query.lineNo);
    if (!style) return res.status(400).json({ success: false, error: "style es obligatorio" });
    const hist = await client.query(
      `SELECT
         EXISTS (SELECT 1 FROM line_assignments la JOIN work_orders wo ON wo.id = la.work_order_id
                  WHERE COALESCE(la.status, 'planned') NOT IN ('cancelled', 'rejected')
                    AND ${WO_STYLE_SQL} = $1) AS assigned,
         EXISTS (SELECT 1 FROM line_runs lr
                  WHERE UPPER(TRIM(lr.style)) = $1 AND COALESCE(lr.is_draft, false) = false) AS produced,
         EXISTS (SELECT 1 FROM line_assignments la JOIN work_orders wo ON wo.id = la.work_order_id
                  WHERE COALESCE(la.status, 'planned') NOT IN ('cancelled', 'rejected')
                    AND la.line_no::text = $2 AND ${WO_STYLE_SQL} = $1) AS on_line`,
      [style, lineNo]
    );
    const h = hist.rows[0] || {};
    const curve = lineNo ? await activeCurve(client, style, lineNo) : null;
    res.json({
      success: true,
      style,
      lineNo,
      isNewStyle: !h.assigned && !h.produced,
      isNewOnLine: !h.on_line,
      curve: curve ? shapeCurve(curve) : null,
      presets: PRESETS,
    });
  }));

  // ------------------------------------------------------------------
  // POST /api/learning-curves  { style, lineNo, type: 'new'|'existing', startDate?, steps?, replan? }
  //   replan: true → re-acomoda los días ya planeados del estilo en la línea
  //   con la capacidad de la curva (mismo re-planeo que al cambiar un estándar).
  // ------------------------------------------------------------------
  app.post("/api/learning-curves", authenticateToken, requireRoles(curveRoles), withClient(async (req, res, client) => {
    const style = norm(req.body?.style);
    const lineNo = normLine(req.body?.lineNo);
    const type = ["new", "existing", "custom"].includes(req.body?.type) ? req.body.type : "new";
    if (!style || !lineNo) return res.status(400).json({ success: false, error: "style y lineNo son obligatorios" });
    const steps = type === "custom" ? validSteps(req.body?.steps) : PRESETS[type];
    if (!steps) return res.status(400).json({ success: false, error: "Etapas inválidas" });

    let startDate = String(req.body?.startDate || "").slice(0, 10);
    if (!isYmd(startDate)) {
      // Sin fecha: el primer día asignado del estilo en la línea desde hoy, si no hoy.
      const first = await assignedDates(client, { style, lineNo, fromDate: todayYmd() });
      startDate = first[0] || todayYmd();
    }

    await client.query("BEGIN");
    try {
      const ins = await client.query(
        `INSERT INTO style_learning_curves
           (style, line_no, curve_type, start_date, steps, created_by, created_by_name)
         VALUES ($1, $2, $3, $4::date, $5::jsonb, $6, $7)
         RETURNING *, to_char(start_date, 'YYYY-MM-DD') AS start_ymd`,
        [style, lineNo, type, startDate, JSON.stringify(steps), req.user?.id || null, userName(req)]
      );
      const curve = ins.rows[0];
      const label = type === "new" ? "estilo nuevo" : type === "existing" ? "estilo existente" : "personalizada";
      await insertEvent(client, {
        curveId: curve.id, style, lineNo, event: "created", eff: steps[0].eff, effectiveDate: startDate,
        summary: `Curva de aprendizaje creada (${label}) · ${style} en Línea ${lineNo} desde ${dm(startDate)}: ${steps.map((s) => pct(s.eff)).join(" → ")}`,
        userName: userName(req),
      });
      const replanned = req.body?.replan ? await replan(client, style, lineNo) : null;
      await client.query("COMMIT");
      const overloads = await overloadReport(client, curve);
      res.json({ success: true, curve: shapeCurve(curve), replan: replanned, overloads });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err.code === "23505") {
        return res.status(409).json({ success: false, code: "CURVE_EXISTS", error: `El estilo ${style} ya tiene una curva activa en la Línea ${lineNo}.` });
      }
      throw err;
    }
  }));

  // ------------------------------------------------------------------
  // DELETE /api/learning-curves/:id?replan=1   (cancela; queda en el historial)
  //   replan=1 → re-acomoda los días planeados con la capacidad estándar.
  // ------------------------------------------------------------------
  app.delete("/api/learning-curves/:id", authenticateToken, requireRoles(curveRoles), withClient(async (req, res, client) => {
    const id = parseInt(req.params.id, 10);
    await client.query("BEGIN");
    const r = await client.query(
      `UPDATE style_learning_curves
          SET status = 'cancelled', cancelled_at = now(), cancelled_by_name = $2, updated_at = now()
        WHERE id = $1 AND status = 'active'
        RETURNING *, to_char(start_date, 'YYYY-MM-DD') AS start_ymd`,
      [id, userName(req)]
    );
    if (!r.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, error: "Curva no encontrada o ya cancelada" });
    }
    const c = r.rows[0];
    try {
      await insertEvent(client, {
        curveId: c.id, style: c.style, lineNo: c.line_no, event: "cancelled",
        summary: `Curva de aprendizaje cancelada · ${c.style} en Línea ${c.line_no}. La línea vuelve a su eficiencia estándar.`,
        userName: userName(req),
      });
      const wantReplan = ["1", "true"].includes(String(req.query.replan || "").toLowerCase());
      const replanned = wantReplan ? await replan(client, c.style, c.line_no) : null;
      await client.query("COMMIT");
      res.json({ success: true, curve: shapeCurve(c), replan: replanned });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }));

  // ------------------------------------------------------------------
  // GET /api/learning-curves/graph?style=X
  //   Por cada curva del estilo (cada línea): etapas, eficiencia estándar y,
  //   por día asignado, la eficiencia planeada (curva) y la real (empaque).
  //   Real = Σ(piezas empacadas × SAM) ÷ Σ(operarios × horas × 60).
  // ------------------------------------------------------------------
  app.get("/api/learning-curves/graph", authenticateToken, withClient(async (req, res, client) => {
    const style = norm(req.query.style);
    if (!style) return res.status(400).json({ success: false, error: "style es obligatorio" });
    const curves = await client.query(
      `SELECT *, to_char(start_date, 'YYYY-MM-DD') AS start_ymd
         FROM style_learning_curves
        WHERE UPPER(TRIM(style)) = $1
        ORDER BY status = 'active' DESC, line_no, created_at DESC`,
      [style]
    );
    const today = todayYmd();
    const series = [];
    for (const c of curves.rows) {
      const std = await standardOf(client, c.style, c.line_no);
      const q = await client.query(
        `SELECT to_char(la.assigned_date, 'YYYY-MM-DD') AS d, SUM(la.assigned_quantity)::float AS qty
           FROM line_assignments la
           JOIN work_orders wo ON wo.id = la.work_order_id
          WHERE la.line_no::text = $1 AND la.assigned_date >= $2::date
            AND COALESCE(la.status, 'planned') NOT IN ('cancelled', 'rejected')
            AND COALESCE(la.assigned_quantity, 0) > 0
            AND ${WO_STYLE_SQL} = $3
          GROUP BY 1 ORDER BY 1`,
        [c.line_no, c.start_ymd, style]
      );
      let actual = new Map();
      try {
        const a = await client.query(
          `WITH per_run AS (
             SELECT lr.id, to_char(lr.run_date, 'YYYY-MM-DD') AS d,
                    lr.sam_minutes::float AS sam, lr.operators_count::float AS ops, lr.working_hours::float AS hrs,
                    COALESCE(SUM(se.sewed_qty), 0)::float AS produced
               FROM line_runs lr
               JOIN run_operators ro ON ro.run_id = lr.id
               JOIN operator_operations oo ON oo.run_operator_id = ro.id
               LEFT JOIN operation_sewed_entries se ON se.operation_id = oo.id
              WHERE lr.line_no::text = $1 AND UPPER(TRIM(lr.style)) = $2 AND lr.run_date >= $3::date
                AND (oo.operation_name ILIKE '%pack%' OR oo.operation_name ILIKE '%emp%')
              GROUP BY lr.id
           )
           SELECT d, SUM(produced) AS produced, SUM(produced * sam) AS sam_out, SUM(ops * hrs * 60) AS minutes
             FROM per_run GROUP BY d`,
          [c.line_no, style, c.start_ymd]
        );
        actual = new Map(a.rows.map((x) => [x.d, x]));
      } catch (e) {
        console.warn("⚠️  lc graph actuals skipped:", e.message);
      }
      const points = q.rows.map((row, i) => {
        const st = stageForDay(c.steps, i + 1);
        const used = std?.efficiency ? Math.min(st.eff, std.efficiency) : st.eff;
        const act = actual.get(row.d);
        const actualEff = act && Number(act.minutes) > 0 && Number(act.produced) > 0 && row.d <= today
          ? Number(act.sam_out) / Number(act.minutes)
          : null;
        return {
          date: row.d,
          day: i + 1,
          stage: st.index,
          planned_efficiency: used,
          curve_efficiency: st.eff,
          planned_qty: Math.round(row.qty),
          produced: act ? Math.round(Number(act.produced)) : null,
          actual_efficiency: actualEff,
          is_past: row.d <= today,
        };
      });
      series.push({
        curve: shapeCurve(c),
        standard_efficiency: std?.efficiency ?? null,
        standard_target: std?.target ?? null,
        points,
        current_day: points.filter((p) => p.is_past).length,
      });
    }
    res.json({ success: true, style, today, series });
  }));

  // ------------------------------------------------------------------
  // CEO: avisos de curvas (mismo formato que /api/ceo/urgent-changes).
  //   ids con prefijo "lc-" para no chocar con las otras fuentes de la campana.
  // ------------------------------------------------------------------
  app.get("/api/ceo/learning-curve-events", authenticateToken, requireRoles(ceoRoles), withClient(async (req, res, client) => {
    try { await sweepTransitions(client); } catch (e) { console.warn("⚠️  lc sweep:", e.message); }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const r = await client.query(
      `SELECT e.*, to_char(e.effective_date, 'YYYY-MM-DD') AS effective_ymd,
              c.curve_type, c.steps
         FROM learning_curve_events e
         LEFT JOIN style_learning_curves c ON c.id = e.curve_id
        ORDER BY e.created_at DESC
        LIMIT $1`,
      [limit]
    );
    const unread = await client.query("SELECT COUNT(*)::int AS n FROM learning_curve_events WHERE seen_at IS NULL");
    res.json({
      success: true,
      unread: unread.rows[0]?.n || 0,
      items: r.rows.map((e) => ({
        id: `lc-${e.id}`,
        action: "learning_curve",
        summary: e.summary,
        user_name: e.user_name,
        created_at: e.created_at,
        unread: !e.seen_at,
        details: {
          event: e.event,
          style: e.style,
          lineNo: e.line_no,
          stageIndex: e.stage_index,
          fromEfficiency: e.from_efficiency != null ? Number(e.from_efficiency) : null,
          efficiency: e.efficiency != null ? Number(e.efficiency) : null,
          day: e.day_number,
          effectiveDate: e.effective_ymd,
          curveType: e.curve_type,
          steps: e.steps,
        },
      })),
    });
  }));

  app.post("/api/ceo/learning-curve-events/seen", authenticateToken, requireRoles(ceoRoles), withClient(async (req, res, client) => {
    const r = await client.query(
      "UPDATE learning_curve_events SET seen_at = now(), seen_by_name = $1 WHERE seen_at IS NULL",
      [userName(req)]
    );
    res.json({ success: true, updated: r.rowCount });
  }));

  app.post("/api/ceo/learning-curve-events/:id/seen", authenticateToken, requireRoles(ceoRoles), withClient(async (req, res, client) => {
    const id = parseInt(String(req.params.id).replace(/^lc-/, ""), 10);
    const r = await client.query(
      "UPDATE learning_curve_events SET seen_at = now(), seen_by_name = $2 WHERE id = $1 AND seen_at IS NULL",
      [id, userName(req)]
    );
    res.json({ success: true, updated: r.rowCount });
  }));
}

module.exports = registerLearningCurves;
module.exports.initSchema = initSchema;
module.exports.wrapPlannerStyleParams = wrapPlannerStyleParams;
module.exports.adjustCellCapacity = adjustCellCapacity;
module.exports.effOnDate = effOnDate;
module.exports.forLine = forLine;
module.exports.sweepTransitions = sweepTransitions;
module.exports.stageForDay = stageForDay;
module.exports.PRESETS = PRESETS;