// ==========================================================================
// planning-style-fit.js  (register-module, same shape as learning-curves.js)
//
// GET /api/planning/style-fit?days=120
//
// Datos para que el Dashboard de Planificación diga QUÉ LÍNEA produce cada
// estilo más rápido y si una orden terminaría antes en otra línea.
//
//   history      → rendimiento REAL por (estilo, línea) en los últimos `days`
//                  días (sin hoy, sin corridas borrador). Misma regla que
//                  /api/skyrina/line-performance-detail:
//                    eficiencia = Σ(pzas empacadas × SAM) ÷ Σ(minutos de la cuadrilla)
//                  Una cuadrilla por (día, línea, estilo): un split de color NO
//                  duplica minutos. Días sin empaque no cuentan.
//   seenStyles   → estilos que ya corrieron alguna vez (curva "existente" vs "nuevo").
//   lines        → configuración vigente de cada línea (operarios, horas, eficiencia,
//                  target), igual que getLineCapacityForDate + planner_lines.
//   holds        → reservas de pre-órdenes desde hoy (ocupan capacidad).
//   holidays     → festivos / paros desde hoy (planta o por línea).
//   lockedDays   → días de semanas bloqueadas por el CEO (si el módulo existe).
//
// A diferencia de /api/skyrina/*, aquí entra cualquier usuario autenticado
// (el planeador necesita verlo).
//
// SETUP en server1.js, después de registerHolidays y learningCurves:
//     const registerPlanningStyleFit = require("./planning-style-fit");
//     registerPlanningStyleFit(app, {
//       authenticateToken, pool, setSchema,
//       holidays: registerHolidays,   // opcional
//       planWeekLocks,                // opcional
//     });
// No crea tablas: no necesita initSchema.
// --------------------------------------------------------------------------

const plantToday = () => {
  const tz = process.env.PLANT_TZ || "America/Mexico_City";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
};

const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
};

// DATE de pg llega como Date a medianoche local del servidor.
const toYmd = (v) => {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  const d = new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const normEff = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1 ? n / 100 : n;
};

module.exports = function registerPlanningStyleFit(app, { authenticateToken, pool, setSchema, holidays = null, planWeekLocks = null }) {
  app.get("/api/planning/style-fit", authenticateToken, async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 120, 14), 365);
    const today = plantToday();
    const from = addDays(today, -days);
    const yesterday = addDays(today, -1);

    // El pool es chico: una sola conexión y consultas en serie.
    const client = await pool.connect();
    try {
      await setSchema(client);

      // ── 1. Rendimiento real por estilo × línea ────────────────────────────
      const hist = await client.query(
        `WITH packing AS (
           SELECT lr.id,
                  UPPER(TRIM(lr.style))                AS style,
                  lr.line_no::text                     AS line_no,
                  lr.run_date,
                  COALESCE(lr.sam_minutes, 0)::float   AS sam,
                  COALESCE(lr.operators_count, 0)::float * COALESCE(lr.working_hours, 0)::float * 60 AS minutes,
                  COALESCE(SUM(se.sewed_qty), 0)::float AS sewed
             FROM line_runs lr
             JOIN run_operators ro       ON ro.run_id = lr.id
             JOIN operator_operations oo ON oo.run_operator_id = ro.id
             LEFT JOIN operation_sewed_entries se ON se.operation_id = oo.id
            WHERE lr.run_date BETWEEN $1::date AND $2::date
              AND COALESCE(lr.is_draft, false) = false
              AND NULLIF(TRIM(lr.style), '') IS NOT NULL
              AND (oo.operation_name ILIKE '%pack%' OR oo.operation_name ILIKE '%emp%')
            GROUP BY lr.id, lr.style, lr.line_no, lr.run_date, lr.sam_minutes, lr.operators_count, lr.working_hours
         ),
         crews AS (           -- una cuadrilla por (estilo, línea, día); solo días con empaque
           SELECT style, line_no, run_date, MAX(minutes) AS minutes
             FROM packing
            GROUP BY style, line_no, run_date
           HAVING SUM(sewed) > 0
         ),
         cap AS (
           SELECT style, line_no, SUM(minutes) AS minutes, COUNT(*) AS days, MAX(run_date) AS last_day
             FROM crews GROUP BY style, line_no
         ),
         out AS (
           SELECT style, line_no,
                  SUM(sewed)       AS produced,
                  SUM(sewed * sam) AS sam_out
             FROM packing
            WHERE sewed > 0
            GROUP BY style, line_no
         )
         SELECT o.style, o.line_no, o.produced, o.sam_out, c.minutes, c.days,
                to_char(c.last_day, 'YYYY-MM-DD') AS last_day
           FROM out o
           JOIN cap c ON c.style = o.style AND c.line_no = o.line_no`,
        [from, yesterday]
      );

      const history = hist.rows
        .map((r) => {
          const minutes = num(r.minutes);
          const produced = num(r.produced);
          const samOut = num(r.sam_out);
          const daysRun = parseInt(r.days, 10) || 0;
          return {
            style: r.style,
            line_no: String(r.line_no),
            days: daysRun,
            produced: Math.round(produced),
            sam_out: Math.round(samOut * 100) / 100,
            minutes: Math.round(minutes),
            // tope 1.5: un día mal capturado no debe convertir una línea en "la mejor"
            efficiency: minutes > 0 ? Math.min(samOut / minutes, 1.5) : 0,
            pcs_per_day: daysRun > 0 ? produced / daysRun : 0,
            avg_sam: produced > 0 ? samOut / produced : 0,
            last_day: r.last_day,
          };
        })
        .filter((r) => r.minutes > 0 && r.produced > 0);

      // ── 2. Estilos que ya corrieron alguna vez ───────────────────────────
      const seen = await client.query(
        `SELECT DISTINCT UPPER(TRIM(style)) AS style
           FROM line_runs
          WHERE COALESCE(is_draft, false) = false
            AND run_date < $1::date
            AND NULLIF(TRIM(style), '') IS NOT NULL`,
        [today]
      );

      // ── 3. Configuración vigente por línea ───────────────────────────────
      const perLine = await client.query(
        `SELECT DISTINCT ON (line_no)
                line_no, style, operators_count, working_hours, sam_minutes, efficiency, target_pcs
           FROM line_runs
          ORDER BY line_no, (run_date <= $1) DESC, ABS(run_date - $1::date) ASC`,
        [today]
      );
      const lines = perLine.rows.map((l) => ({ ...l, line_no: String(l.line_no) }));
      try {
        const present = new Set(lines.map((l) => l.line_no));
        const seeds = await client.query(
          `SELECT line_no, operators_count, working_hours, sam_minutes, efficiency, target_pcs FROM planner_lines`
        );
        for (const r of seeds.rows) if (!present.has(String(r.line_no))) lines.push({ ...r, line_no: String(r.line_no), style: null });
      } catch { /* planner_lines opcional */ }

      const linesOut = lines.map((l) => ({
        line_no: l.line_no,
        style: l.style || null,
        operators_count: num(l.operators_count),
        working_hours: num(l.working_hours),
        sam_minutes: num(l.sam_minutes),
        efficiency: normEff(l.efficiency) || 0.7,
        target_pcs: num(l.target_pcs),
      }));

      // ── 4. Reservas de pre-órdenes desde hoy ─────────────────────────────
      let holds = [];
      try {
        const ok = await client.query("SELECT to_regclass('pre_order_day_holds') IS NOT NULL AS ok");
        if (ok.rows[0]?.ok) {
          const h = await client.query(
            `SELECT h.line_no::text AS line_no, to_char(h.assigned_date, 'YYYY-MM-DD') AS d,
                    COALESCE(SUM(h.quantity), 0)::float AS qty
               FROM pre_order_day_holds h
               LEFT JOIN pre_orders p ON p.id = h.pre_order_id
              WHERE h.assigned_date >= $1::date
                AND COALESCE(p.status, 'pending') NOT IN ('converted', 'cancelled')
              GROUP BY h.line_no, h.assigned_date`,
            [today]
          );
          holds = h.rows.map((r) => ({ line_no: String(r.line_no), d: r.d, qty: num(r.qty) }));
        }
      } catch (e) {
        console.warn("⚠️  style-fit: holds not available:", e.message);
      }

      // ── 5. Festivos / paros y semanas bloqueadas ─────────────────────────
      let holidayRows = [];
      if (holidays?.holidaysBetween) {
        try {
          const rows = await holidays.holidaysBetween(client, { from: today, to: addDays(today, 400) });
          holidayRows = rows.map((h) => ({ d: toYmd(h.holiday_date), line_no: h.line_no == null ? null : String(h.line_no) }));
        } catch (e) {
          console.warn("⚠️  style-fit: holidays not available:", e.message);
        }
      }
      const lockedDays = [];
      if (planWeekLocks?.lockedWeekSet && planWeekLocks?.isLockedDay) {
        try {
          const set = await planWeekLocks.lockedWeekSet(client);
          for (let i = 0; i < 400; i++) {
            const d = addDays(today, i);
            if (planWeekLocks.isLockedDay(set, d)) lockedDays.push(d);
          }
        } catch (e) {
          console.warn("⚠️  style-fit: week locks not available:", e.message);
        }
      }

      res.json({
        success: true,
        today,
        window: { from, to: yesterday, days },
        history,
        seenStyles: seen.rows.map((r) => r.style),
        lines: linesOut,
        holds,
        holidays: holidayRows,
        lockedDays,
      });
    } catch (err) {
      console.error("❌ Error fetching planning style-fit:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });
};