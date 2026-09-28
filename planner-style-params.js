// ==========================================================================
// planner-style-params.js
//
// Planner-owned production standards PER STYLE, fully decoupled from the line
// engineers' line_runs. When the planner drops a style into a line/day, the
// Plan Board capacity comes from THIS table:
//
//     pieces/day = operators × working_hours × 60 × efficiency ÷ SAM
//
// Tables (own tables, written only by the planner role):
//   planner_style_params          one row per style_code (current standard)
//   planner_style_params_history  every create / update / delete (audit trail)
//
// A line-day can mix several styles. Each assignment consumes a FRACTION of the
// day equal to qty ÷ (its style's pieces/day). The day is full when the
// fractions add up to 1, so a 20-operator style and a 35-operator style can
// share a day correctly.
//
// Changing a style's standard RE-PLANS every future planned cell (and pre-order
// hold) of that style on every line — see recomputeStyle().
//
// SETUP (server1.js)
//   const plannerStyleParams = require("./planner-style-params");
//   plannerStyleParams(app, { authenticateToken, pool, setSchema,
//                             holidays: registerHolidays, planWeekLocks });
//   // in the migrations block:
//   await plannerStyleParams.initSchema({ pool, setSchema });
// The tables are also created lazily on first use, so the module works even
// when RUN_MIGRATIONS is off.
// ==========================================================================

// Roles allowed to CREATE / EDIT / DELETE style standards. Default: planner only.
// Override with PLANNER_STYLE_WRITE_ROLES="planner,master" if an admin also needs it.
const WRITE_ROLES = (process.env.PLANNER_STYLE_WRITE_ROLES || "planner")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Roles that APPROVE / REJECT efficiency changes. The planner can change SAM,
// operators and working hours directly, but a new EFFICIENCY for a style that
// already has a standard only takes effect after one of these roles approves it.
// Override with PLANNER_EFF_APPROVER_ROLES="ceo,skyrina,master".
const DEFAULT_EFF_APPROVER_ROLES = (process.env.PLANNER_EFF_APPROVER_ROLES || "ceo")
  .split(",").map((s) => s.trim()).filter(Boolean);

const normStyle = (s) => String(s ?? "").trim().toUpperCase();

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS planner_style_params(
     style_code       VARCHAR(50) PRIMARY KEY,
     sam_minutes      NUMERIC(10,4) NOT NULL,
     operators_count  INT NOT NULL,
     working_hours    NUMERIC(5,2) NOT NULL,
     efficiency       NUMERIC(5,4) NOT NULL,
     target_pcs       NUMERIC(12,2) NOT NULL,
     target_per_hour  NUMERIC(12,2) NOT NULL,
     notes            TEXT,
     created_by       VARCHAR(100),
     updated_by       VARCHAR(100),
     created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT chk_psp_sam   CHECK (sam_minutes > 0),
     CONSTRAINT chk_psp_ops   CHECK (operators_count > 0),
     CONSTRAINT chk_psp_hours CHECK (working_hours > 0 AND working_hours <= 24),
     CONSTRAINT chk_psp_eff   CHECK (efficiency > 0 AND efficiency <= 1)
   )`,
  `CREATE TABLE IF NOT EXISTS planner_style_params_history(
     id               BIGSERIAL PRIMARY KEY,
     style_code       VARCHAR(50) NOT NULL,
     action           VARCHAR(10) NOT NULL,
     sam_minutes      NUMERIC(10,4),
     operators_count  INT,
     working_hours    NUMERIC(5,2),
     efficiency       NUMERIC(5,4),
     target_pcs       NUMERIC(12,2),
     notes            TEXT,
     changed_by       VARCHAR(100),
     changed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_psp_history_style
     ON planner_style_params_history(style_code, changed_at DESC)`,
  // Efficiency change requests (planner → CEO). One PENDING request per style;
  // a newer request supersedes the older one.
  `CREATE TABLE IF NOT EXISTS planner_style_eff_requests(
     id                    BIGSERIAL PRIMARY KEY,
     style_code            VARCHAR(50) NOT NULL,
     current_efficiency    NUMERIC(5,4),
     requested_efficiency  NUMERIC(5,4) NOT NULL,
     reason                TEXT,
     status                VARCHAR(12) NOT NULL DEFAULT 'pending',
     requested_by          VARCHAR(100),
     requested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
     decided_by            VARCHAR(100),
     decided_at            TIMESTAMPTZ,
     decision_note         TEXT,
     CONSTRAINT chk_pser_eff CHECK (requested_efficiency > 0 AND requested_efficiency <= 1),
     CONSTRAINT chk_pser_status CHECK (status IN ('pending','approved','rejected','cancelled','superseded'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_pser_one_pending
     ON planner_style_eff_requests(style_code) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_pser_status ON planner_style_eff_requests(status, requested_at DESC)`,
];

let schemaReady = null; // one-time lazy creation per process
async function ensureSchema(client) {
  if (!schemaReady) {
    schemaReady = (async () => { for (const sql of SCHEMA_SQL) await client.query(sql); })()
      .catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);
    await ensureSchema(client);
    console.log("✅ planner_style_params tables ready");
  } finally {
    client.release();
  }
}

// ---- math ----------------------------------------------------------------
const effectiveMinutesOf = (p) =>
  (Number(p.operators_count) || 0) * (Number(p.working_hours) || 0) * 60 * (Number(p.efficiency) || 0);
const targetOf = (p) => {
  const sam = Number(p?.sam_minutes) || 0;
  return sam > 0 ? effectiveMinutesOf(p) / sam : 0;
};

// Validate + normalise user input. efficiency accepts 0.85 or 85.
function parseInput(body) {
  const sam = Number(body?.samMinutes);
  const ops = Number(body?.operatorsCount);
  const hours = Number(body?.workingHours);
  let eff = Number(body?.efficiency);
  const errors = [];
  if (!(Number.isFinite(sam) && sam > 0)) errors.push("SAM debe ser mayor a 0");
  if (!(Number.isInteger(ops) && ops > 0)) errors.push("N° de operarios debe ser un entero mayor a 0");
  if (!(Number.isFinite(hours) && hours > 0 && hours <= 24)) errors.push("Horas de trabajo debe estar entre 0 y 24");
  if (Number.isFinite(eff) && eff > 1) eff = eff / 100;
  if (!(Number.isFinite(eff) && eff > 0 && eff <= 1)) errors.push("Eficiencia debe estar entre 1% y 100%");
  if (errors.length) return { errors };
  return {
    params: withTargets({
      sam_minutes: sam, operators_count: ops, working_hours: hours, efficiency: eff,
      notes: body?.notes != null ? String(body.notes).slice(0, 1000) : null,
    }),
    effReason: body?.efficiencyReason != null ? String(body.efficiencyReason).slice(0, 1000) : null,
  };
}

// Fill target_pcs / target_per_hour from the four inputs.
function withTargets(p) {
  const target = targetOf(p);
  const hours = Number(p.working_hours) || 0;
  return {
    ...p,
    target_pcs: Math.round(target * 100) / 100,
    target_per_hour: hours > 0 ? Math.round((target / hours) * 100) / 100 : 0,
  };
}

const sameEff = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;

// The planner may not change efficiency on an EXISTING standard: keep the
// current one and turn the new value into a pending request. A new style's
// first efficiency is accepted as entered (there is nothing to change yet).
// Returns { params, requestedEff } — requestedEff is null when nothing to ask.
function splitEfficiency(prev, params) {
  if (!prev || sameEff(prev.efficiency, params.efficiency)) return { params, requestedEff: null };
  return {
    params: withTargets({ ...params, efficiency: Number(prev.efficiency) }),
    requestedEff: params.efficiency,
  };
}

async function createEffRequest(client, { key, current, requested, reason, who }) {
  await client.query(
    `UPDATE planner_style_eff_requests SET status = 'superseded', decided_at = now()
      WHERE style_code = $1 AND status = 'pending'`,
    [key]
  );
  return (await client.query(
    `INSERT INTO planner_style_eff_requests
       (style_code, current_efficiency, requested_efficiency, reason, requested_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [key, current, requested, reason, who]
  )).rows[0];
}

async function pendingEffRequest(client, key) {
  return (await client.query(
    "SELECT * FROM planner_style_eff_requests WHERE style_code = $1 AND status = 'pending'", [key]
  )).rows[0] || null;
}

// ---- lookups (usable by server1.js inside its own transactions) -----------
async function getParams(client, style) {
  await ensureSchema(client);
  const key = normStyle(style);
  if (!key) return null;
  const r = await client.query("SELECT * FROM planner_style_params WHERE style_code = $1", [key]);
  return r.rows[0] || null;
}

async function getParamsMap(client, styles) {
  await ensureSchema(client);
  const keys = [...new Set((styles || []).map(normStyle).filter(Boolean))];
  const map = new Map();
  if (!keys.length) return map;
  const r = await client.query("SELECT * FROM planner_style_params WHERE style_code = ANY($1::text[])", [keys]);
  for (const row of r.rows) map.set(row.style_code, row);
  return map;
}

// Style key of a work order — same rule the board uses (style_code, else estilo).
async function styleOfWorkOrder(client, workOrderId) {
  const r = await client.query(
    `SELECT UPPER(TRIM(COALESCE(NULLIF(TRIM(style_code), ''), NULLIF(TRIM(estilo), ''), ''))) AS style
       FROM work_orders WHERE id = $1`,
    [workOrderId]
  );
  return r.rows[0]?.style || "";
}

let holdsTableKnown = null; // pre_order_day_holds may not exist on older installs
async function holdsTableExists(client) {
  if (holdsTableKnown === null) {
    const r = await client.query("SELECT to_regclass('pre_order_day_holds') IS NOT NULL AS ok");
    holdsTableKnown = !!r.rows[0]?.ok;
  }
  return holdsTableKnown;
}

// Fraction of each day (0 = empty, 1 = full) already used on a line, for every
// day in [from, to]. Each assignment uses qty ÷ its style's planner pieces/day.
// Assignments whose style has no planner standard yet (created before this
// feature) fall back to the rate stored on the assignment. Pre-order holds use
// their pre-order's style standard. Anything with no known rate is measured
// with `fallbackTarget` (the pieces/day of the style being placed).
async function lineLoadRange(client, { lineNo, from, to, fallbackTarget, excludeIds = [] }) {
  const rows = await client.query(
    `SELECT to_char(la.assigned_date, 'YYYY-MM-DD') AS d,
            la.assigned_quantity::float AS qty,
            la.required_production_rate::float AS rate,
            UPPER(TRIM(COALESCE(NULLIF(TRIM(wo.style_code), ''), NULLIF(TRIM(wo.estilo), ''), ''))) AS style
       FROM line_assignments la
       JOIN work_orders wo ON wo.id = la.work_order_id
      WHERE la.line_no = $1
        AND la.assigned_date BETWEEN $2::date AND $3::date
        AND COALESCE(la.status, 'planned') NOT IN ('cancelled', 'rejected')
        AND NOT (la.id = ANY($4::bigint[]))`,
    [String(lineNo), from, to, excludeIds.map(Number).filter(Number.isFinite)]
  );
  const pmap = await getParamsMap(client, rows.rows.map((r) => r.style));
  const load = new Map();
  const add = (d, qty, tgt) => {
    if (!(qty > 0)) return;
    const frac = tgt > 0 ? qty / tgt : 1; // unknown rate: treat the day as taken
    load.set(d, (load.get(d) || 0) + frac);
  };
  for (const r of rows.rows) {
    const p = pmap.get(r.style);
    add(r.d, r.qty, p ? targetOf(p) : (r.rate > 0 ? r.rate : fallbackTarget));
  }
  if (await holdsTableExists(client)) {
    // Pre-order holds are measured with THEIR OWN style's standard (the style
    // lives on pre_orders); a hold whose style has no standard yet falls back
    // to the style being placed.
    const held = await client.query(
      `SELECT to_char(h.assigned_date, 'YYYY-MM-DD') AS d,
              COALESCE(SUM(h.quantity), 0)::float AS qty,
              UPPER(TRIM(COALESCE(NULLIF(TRIM(h.style_code), ''), NULLIF(TRIM(po.style_code), ''),
                                  NULLIF(TRIM(h.estilo), ''), NULLIF(TRIM(po.estilo), ''), ''))) AS style
         FROM pre_order_day_holds h
         LEFT JOIN pre_orders po ON po.id = h.pre_order_id
        WHERE h.line_no = $1 AND h.assigned_date BETWEEN $2::date AND $3::date
        GROUP BY h.assigned_date, 3`,
      [String(lineNo), from, to]
    );
    const hmap = await getParamsMap(client, held.rows.map((h) => h.style));
    for (const h of held.rows) {
      const p = hmap.get(h.style);
      add(h.d, h.qty, p ? targetOf(p) : fallbackTarget);
    }
  }
  return load;
}

// Capacity of ONE line-day for ONE style.
//   → { params: null } when the style has no planner standard (caller must ask).
//   → { params, target, load, available, availableMinutes }
async function cellCapacity(client, { lineNo, date, style, excludeIds = [] }) {
  const params = await getParams(client, style);
  if (!params) return { params: null, style: normStyle(style), target: 0, load: 0, available: 0 };
  const target = targetOf(params);
  const loads = await lineLoadRange(client, { lineNo, from: date, to: date, fallbackTarget: target, excludeIds });
  const load = loads.get(date) || 0;
  const available = Math.max(0, Math.floor((1 - load) * target + 1e-6));
  return { params, style: params.style_code, target, load, available, availableMinutes: effectiveMinutesOf(params) };
}

// Standard 409 payload so the board can open the "new style" form.
function styleParamsRequired(res, style) {
  return res.status(409).json({
    success: false,
    code: "STYLE_PARAMS_REQUIRED",
    style: normStyle(style),
    error: style
      ? `El estilo ${normStyle(style)} no tiene SAM / operarios / horas / eficiencia registrados por planeación.`
      : "La orden no tiene estilo; no se puede calcular la capacidad.",
  });
}

// ---- recompute: re-plan every future cell of a style after its standard changes
//
// When the planner changes a style's SAM / operators / hours / efficiency, every
// FUTURE planned cell of that style, on every line, is re-packed with the new
// pieces/day:
//   • what moves: line_assignments with status 'planned' and pre-order holds
//     dated from TOMORROW on. Today and past days are never touched, nor are
//     released / completed cells (already with the line leaders); they still
//     occupy their share of the day.
//   • per line, each order (work order + color, or pre-order + color) keeps its
//     START day and its total pieces, then is laid out again day by day: skip
//     weekends and holidays, fill the free room left by other styles, spill
//     the rest forward. Orders keep their original sequence (earliest first).
//   • standard went DOWN → the style runs over more days; went UP → fewer days.
//   • pieces that no longer fit within the horizon go back to the pool
//     (assignments) / stay unreserved (holds) and are reported.
// Other styles' cells are never moved.
const RECOMPUTE_HORIZON_DAYS = 540;

const ymdAdd = (ymdStr, n) => {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};
const ymdWeekend = (ymdStr) => {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
};

async function recomputeStyle(client, style, { holidays = null } = {}) {
  const key = normStyle(style);
  const params = await getParams(client, key);
  if (!params) return { style: key, recomputed: false, reason: "no-standard" };
  const target = targetOf(params);
  const minutes = effectiveMinutesOf(params);
  if (!(target > 0)) return { style: key, recomputed: false, reason: "zero-target" };

  // Re-plan window starts TOMORROW: from's and past cells stay exactly as they are.
  const from = (await client.query("SELECT to_char(CURRENT_DATE + 1, 'YYYY-MM-DD') AS d")).rows[0].d;
  const STYLE_OF_WO = `UPPER(TRIM(COALESCE(NULLIF(TRIM(wo.style_code), ''), NULLIF(TRIM(wo.estilo), ''), '')))`;

  // Future planned cells of this style (locked so nobody edits them meanwhile).
  const aRows = (await client.query(
    `SELECT la.id, la.work_order_id, la.line_no, la.color,
            to_char(la.assigned_date, 'YYYY-MM-DD') AS d, la.assigned_quantity::float AS qty
       FROM line_assignments la
       JOIN work_orders wo ON wo.id = la.work_order_id
      WHERE la.status = 'planned'
        AND la.assigned_date >= $2::date
        AND ${STYLE_OF_WO} = $1
      ORDER BY la.line_no, la.assigned_date, la.id
      FOR UPDATE OF la`,
    [key, from]
  )).rows;

  let hRows = [];
  if (await holdsTableExists(client)) {
    hRows = (await client.query(
      `SELECT h.id, h.pre_order_id, h.line_no, h.color, h.pre_order_no, h.customer_name,
              h.style_code, h.estilo, h.created_by,
              to_char(h.assigned_date, 'YYYY-MM-DD') AS d, h.quantity::float AS qty
         FROM pre_order_day_holds h
         LEFT JOIN pre_orders po ON po.id = h.pre_order_id
        WHERE h.assigned_date >= $2::date
          AND UPPER(TRIM(COALESCE(NULLIF(TRIM(h.style_code), ''), NULLIF(TRIM(po.style_code), ''),
                                  NULLIF(TRIM(h.estilo), ''), NULLIF(TRIM(po.estilo), ''), ''))) = $1
        ORDER BY h.line_no, h.assigned_date, h.id
        FOR UPDATE OF h`,
      [key, from]
    )).rows;
  }

  const summary = {
    style: key, recomputed: true, from, target_pcs: Math.round(target * 100) / 100,
    cellsBefore: aRows.length + hRows.length, cellsAfter: 0, lines: [], unplaced: [],
  };
  if (!aRows.length && !hRows.length) return summary;

  // Group into "units" per line: one unit = one order (+color) on that line.
  const lines = new Map(); // line_no -> Map(unitKey -> unit)
  const unitOf = (lineNo, k, init) => {
    if (!lines.has(lineNo)) lines.set(lineNo, new Map());
    const m = lines.get(lineNo);
    if (!m.has(k)) m.set(k, { ...init, start: null, total: 0, firstId: Infinity, days: [] });
    return m.get(k);
  };
  for (const r of aRows) {
    const u = unitOf(String(r.line_no), `A|${r.work_order_id}|${r.color || ""}`,
      { kind: "assignment", workOrderId: r.work_order_id, color: r.color });
    u.total += r.qty; u.start = u.start && u.start < r.d ? u.start : r.d; u.firstId = Math.min(u.firstId, Number(r.id));
    u.days.push({ d: r.d, qty: r.qty });
  }
  for (const r of hRows) {
    const u = unitOf(String(r.line_no), `H|${r.pre_order_id}|${r.color || ""}`,
      { kind: "hold", preOrderId: r.pre_order_id, color: r.color || "", meta: r });
    u.total += r.qty; u.start = u.start && u.start < r.d ? u.start : r.d; u.firstId = Math.min(u.firstId, Number(r.id));
    u.days.push({ d: r.d, qty: r.qty });
  }

  // Take them off the board, then lay them out again.
  if (aRows.length) await client.query("DELETE FROM line_assignments WHERE id = ANY($1::bigint[])", [aRows.map((r) => r.id)]);
  if (hRows.length) await client.query("DELETE FROM pre_order_day_holds WHERE id = ANY($1::bigint[])", [hRows.map((r) => r.id)]);

  const horizonEnd = ymdAdd(from, RECOMPUTE_HORIZON_DAYS);
  for (const [lineNo, unitsMap] of lines) {
    // Holidays of this line (plant-wide rows too). Best-effort.
    const blocked = new Set();
    if (holidays?.holidaysBetween) {
      try {
        const hs = await holidays.holidaysBetween(client, { from, to: horizonEnd });
        for (const h of hs) if (h.line_no == null || String(h.line_no) === lineNo) blocked.add(h.holiday_date);
      } catch (e) { console.warn("⚠️  recompute: holidays not available:", e.message); }
    }

    const units = [...unitsMap.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.firstId - b.firstId));
    // Free room per day for this style, AFTER removing its own cells.
    const load = await lineLoadRange(client, { lineNo, from, to: horizonEnd, fallbackTarget: target });
    const lineSummary = { line_no: lineNo, orders: units.length, daysBefore: 0, daysAfter: 0 };

    for (const u of units) {
      lineSummary.daysBefore += new Set(u.days.map((x) => x.d)).size;
      let remaining = Math.round(u.total * 100) / 100;
      let day = u.start < from ? from : u.start;
      const placed = [];
      while (remaining > 0.0001 && day <= horizonEnd) {
        if (ymdWeekend(day) || blocked.has(day)) { day = ymdAdd(day, 1); continue; }
        const free = Math.max(0, Math.floor((1 - (load.get(day) || 0)) * target + 1e-6));
        if (free < 1) { day = ymdAdd(day, 1); continue; }
        const chunk = Math.min(remaining, free);
        placed.push({ d: day, qty: chunk });
        load.set(day, (load.get(day) || 0) + chunk / target);
        remaining = Math.round((remaining - chunk) * 100) / 100;
        day = ymdAdd(day, 1);
      }

      const startD = placed[0]?.d || null;
      const endD = placed[placed.length - 1]?.d || null;
      for (const c of placed) {
        if (u.kind === "assignment") {
          await client.query(
            `INSERT INTO line_assignments
               (work_order_id, line_run_id, line_no, assigned_date, assigned_quantity,
                available_minutes, required_production_rate, planned_start_date, planned_end_date, status, color)
             VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, 'planned', $9)`,
            [u.workOrderId, lineNo, c.d, c.qty, minutes, target, startD, endD, u.color ?? null]
          );
        } else {
          const m = u.meta;
          await client.query(
            `INSERT INTO pre_order_day_holds
               (pre_order_id, line_no, assigned_date, quantity, color,
                pre_order_no, customer_name, style_code, estilo, created_by, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
             ON CONFLICT (pre_order_id, line_no, assigned_date, color)
             DO UPDATE SET quantity = pre_order_day_holds.quantity + EXCLUDED.quantity, updated_at = NOW()`,
            [u.preOrderId, lineNo, c.d, c.qty, u.color, m.pre_order_no, m.customer_name, m.style_code, m.estilo, m.created_by]
          );
        }
      }
      summary.cellsAfter += placed.length;
      lineSummary.daysAfter += placed.length;
      if (remaining > 0.0001) {
        summary.unplaced.push({
          line_no: lineNo, kind: u.kind, qty: remaining,
          ref: u.kind === "assignment" ? `WO ${u.workOrderId}` : (u.meta?.pre_order_no || `PRE ${u.preOrderId}`),
          work_order_id: u.workOrderId ?? null, pre_order_id: u.preOrderId ?? null, color: u.color || null,
        });
      }
    }
    summary.lines.push(lineSummary);
  }
  return summary;
}

// Did a change touch the numbers that drive capacity (not just the notes)?
const capacityChanged = (a, b) => !a || !b ||
  Number(a.sam_minutes) !== Number(b.sam_minutes) ||
  Number(a.operators_count) !== Number(b.operators_count) ||
  Number(a.working_hours) !== Number(b.working_hours) ||
  Number(a.efficiency) !== Number(b.efficiency);

// Save (upsert + history) inside the caller's transaction. Returns { row, prev }.
async function upsertParams(client, key, params, who, action = null) {
  const prev = (await client.query("SELECT * FROM planner_style_params WHERE style_code = $1 FOR UPDATE", [key])).rows[0] || null;
  const row = (await client.query(
    `INSERT INTO planner_style_params
       (style_code, sam_minutes, operators_count, working_hours, efficiency,
        target_pcs, target_per_hour, notes, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
     ON CONFLICT (style_code) DO UPDATE SET
       sam_minutes = EXCLUDED.sam_minutes, operators_count = EXCLUDED.operators_count,
       working_hours = EXCLUDED.working_hours, efficiency = EXCLUDED.efficiency,
       target_pcs = EXCLUDED.target_pcs, target_per_hour = EXCLUDED.target_per_hour,
       notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`,
    [key, params.sam_minutes, params.operators_count, params.working_hours, params.efficiency,
     params.target_pcs, params.target_per_hour, params.notes, who]
  )).rows[0];
  await client.query(
    `INSERT INTO planner_style_params_history
       (style_code, action, sam_minutes, operators_count, working_hours, efficiency, target_pcs, notes, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [key, action || (prev ? "update" : "create"), row.sam_minutes, row.operators_count,
     row.working_hours, row.efficiency, row.target_pcs, row.notes, who]
  );
  return { row, prev };
}

// ---- routes ----------------------------------------------------------------
function register(app, {
  authenticateToken, pool, setSchema, holidays = null, planWeekLocks = null,
  effApproverRoles = DEFAULT_EFF_APPROVER_ROLES,
}) {
  const canApproveEff = (req) => effApproverRoles.includes(req.user?.role);
  const approver = (req, res, next) => {
    if (!canApproveEff(req)) {
      return res.status(403).json({ success: false, error: "Solo el CEO puede aprobar cambios de eficiencia." });
    }
    next();
  };
  const canWrite = (req, res, next) => {
    if (!WRITE_ROLES.includes(req.user?.role)) {
      return res.status(403).json({ success: false, error: "Solo el planeador puede modificar los estándares por estilo." });
    }
    next();
  };
  const who = (req) => req.user?.username || (req.user?.id != null ? String(req.user.id) : null);

  const withClient = (handler) => async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      await ensureSchema(client);
      await handler(client, req, res);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("❌ planner-style-params:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  };

  // All standards (the board loads this once).
  app.get("/api/planner/style-params", authenticateToken, withClient(async (client, req, res) => {
    const r = await client.query("SELECT * FROM planner_style_params ORDER BY style_code");
    const pend = await client.query("SELECT * FROM planner_style_eff_requests WHERE status = 'pending'");
    res.json({
      success: true, params: r.rows, pendingEff: pend.rows,
      canEdit: WRITE_ROLES.includes(req.user?.role), canApproveEff: canApproveEff(req),
    });
  }));

  // One style. When the planner has nothing yet, also returns the most recent
  // PRODUCTION record of that style (if any) purely as a suggestion for the form.
  app.get("/api/planner/style-params/:style", authenticateToken, withClient(async (client, req, res) => {
    const key = normStyle(req.params.style);
    const params = await getParams(client, key);
    let suggestion = null;
    if (!params) {
      const h = await client.query(
        `SELECT sam_minutes, operators_count, working_hours, efficiency,
                to_char(run_date, 'YYYY-MM-DD') AS run_date, line_no
           FROM line_runs
          WHERE UPPER(TRIM(style)) = $1
          ORDER BY run_date DESC, id DESC
          LIMIT 1`,
        [key]
      );
      suggestion = h.rows[0] || null;
    }
    const pendingEff = params ? await pendingEffRequest(client, key) : null;
    res.json({ success: true, style: key, found: !!params, params, suggestion, pendingEff });
  }));

  app.get("/api/planner/style-params/:style/history", authenticateToken, withClient(async (client, req, res) => {
    const r = await client.query(
      `SELECT * FROM planner_style_params_history WHERE style_code = $1 ORDER BY changed_at DESC LIMIT 100`,
      [normStyle(req.params.style)]
    );
    res.json({ success: true, history: r.rows });
  }));

  // Runs the recompute inside a SAVEPOINT with the CEO week locks enforced: if
  // it would touch a locked week, only the recompute is undone (the standard is
  // still saved) and the response says so.
  const recomputeSafely = async (client, key) => {
    await client.query("SAVEPOINT recompute_style");
    try {
      if (planWeekLocks?.enforce) await planWeekLocks.enforce(client);
      const r = await recomputeStyle(client, key, { holidays });
      await client.query("RELEASE SAVEPOINT recompute_style");
      return r;
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT recompute_style");
      if (planWeekLocks?.isLockError?.(err)) {
        return { style: key, recomputed: false, reason: "locked", error: err.message };
      }
      throw err;
    }
  };

  // Create or update a style standard (planner only).
  // Body: { samMinutes, operatorsCount, workingHours, efficiency (0.85 | 85), notes?,
  //         recompute? (default true) }
  // When SAM / operators / hours / efficiency change (or the style is new), every
  // future planned cell of the style on every line is re-planned (recomputeStyle)
  // in the same transaction. Response: { params, created, recompute: summary }.
  app.put("/api/planner/style-params/:style", authenticateToken, canWrite, withClient(async (client, req, res) => {
    const key = normStyle(req.params.style);
    if (!key) return res.status(400).json({ success: false, error: "Estilo requerido" });
    const { params: input, effReason, errors } = parseInput(req.body);
    if (errors) return res.status(400).json({ success: false, error: errors.join(". ") });

    await client.query("BEGIN");
    const current = (await client.query(
      "SELECT * FROM planner_style_params WHERE style_code = $1 FOR UPDATE", [key]
    )).rows[0] || null;
    // SAM / operators / hours apply now; a changed efficiency waits for the CEO.
    const { params, requestedEff } = splitEfficiency(current, input);
    const { row, prev } = await upsertParams(client, key, params, who(req));
    let effRequest = null;
    if (requestedEff != null) {
      effRequest = await createEffRequest(client, {
        key, current: current.efficiency, requested: requestedEff, reason: effReason, who: who(req),
      });
    }
    let recompute = { style: key, recomputed: false, reason: "unchanged" };
    if (req.body?.recompute !== false && capacityChanged(prev, row)) {
      recompute = await recomputeSafely(client, key);
    }
    await client.query("COMMIT");
    res.json({ success: true, params: row, created: !prev, recompute, effRequest });
  }));

  // What WOULD change if these values were saved (nothing is written).
  // Body: same as PUT. Response: { recompute: summary, changed }
  app.post("/api/planner/style-params/:style/preview", authenticateToken, canWrite, withClient(async (client, req, res) => {
    const key = normStyle(req.params.style);
    const { params: input, errors } = parseInput(req.body);
    if (errors) return res.status(400).json({ success: false, error: errors.join(". ") });
    await client.query("BEGIN");
    try {
      const current = await getParams(client, key);
      // Same rule as PUT: a changed efficiency is NOT applied here (it is only a request).
      const { params, requestedEff } = splitEfficiency(current, input);
      const { row, prev } = await upsertParams(client, key, params, who(req));
      const changed = capacityChanged(prev, row);
      const recompute = changed ? await recomputeStyle(client, key, { holidays }) : { style: key, recomputed: false, reason: "unchanged" };
      res.json({ success: true, changed, recompute, effNeedsApproval: requestedEff != null });
    } finally {
      await client.query("ROLLBACK");
    }
  }));

  // Re-plan a style with its CURRENT standard (e.g. after lines were edited by hand).
  app.post("/api/planner/style-params/:style/recompute", authenticateToken, canWrite, withClient(async (client, req, res) => {
    const key = normStyle(req.params.style);
    await client.query("BEGIN");
    const recompute = await recomputeSafely(client, key);
    await client.query("COMMIT");
    res.json({ success: true, recompute });
  }));

  // Deleting a standard is reserved to the efficiency approvers: otherwise a
  // delete + re-create would bypass the efficiency approval.
  app.delete("/api/planner/style-params/:style", authenticateToken, approver, withClient(async (client, req, res) => {
    const key = normStyle(req.params.style);
    await client.query("BEGIN");
    const del = await client.query("DELETE FROM planner_style_params WHERE style_code = $1 RETURNING *", [key]);
    if (del.rowCount) {
      const d = del.rows[0];
      await client.query(
        `INSERT INTO planner_style_params_history
           (style_code, action, sam_minutes, operators_count, working_hours, efficiency, target_pcs, notes, changed_by)
         VALUES ($1,'delete',$2,$3,$4,$5,$6,$7,$8)`,
        [key, d.sam_minutes, d.operators_count, d.working_hours, d.efficiency, d.target_pcs, d.notes, who(req)]
      );
    }
    await client.query("COMMIT");
    res.json({ success: true, deleted: del.rowCount > 0 });
  }));

  // ---- efficiency change requests (planner asks, CEO decides) -------------
  // GET /api/planner/style-eff-requests?status=pending|approved|rejected|all
  app.get("/api/planner/style-eff-requests", authenticateToken, withClient(async (client, req, res) => {
    const status = String(req.query.status || "pending");
    const r = await client.query(
      `SELECT r.*, p.sam_minutes, p.operators_count, p.working_hours, p.efficiency AS standard_efficiency
         FROM planner_style_eff_requests r
         LEFT JOIN planner_style_params p ON p.style_code = r.style_code
        WHERE ($1 = 'all' OR r.status = $1)
        ORDER BY r.requested_at DESC
        LIMIT 200`,
      [status]
    );
    res.json({ success: true, requests: r.rows, canApprove: canApproveEff(req) });
  }));

  // Impact of approving: what the style's pieces/day becomes and which cells
  // would be re-planned (nothing is written).
  app.get("/api/planner/style-eff-requests/:id/preview", authenticateToken, approver, withClient(async (client, req, res) => {
    await client.query("BEGIN");
    try {
      const rq = (await client.query("SELECT * FROM planner_style_eff_requests WHERE id = $1", [req.params.id])).rows[0];
      if (!rq) return res.status(404).json({ success: false, error: "Solicitud no encontrada" });
      const cur = await getParams(client, rq.style_code);
      if (!cur) return res.status(409).json({ success: false, error: "El estilo ya no tiene estándar." });
      const next = withTargets({ ...cur, efficiency: Number(rq.requested_efficiency) });
      await upsertParams(client, rq.style_code, next, "preview");
      const recompute = await recomputeStyle(client, rq.style_code, { holidays });
      res.json({ success: true, before: targetOf(cur), after: targetOf(next), recompute });
    } finally {
      await client.query("ROLLBACK");
    }
  }));

  // Approve → the efficiency becomes the style's standard and the style is
  // re-planned from tomorrow (same rules and week locks as a planner change).
  app.post("/api/planner/style-eff-requests/:id/approve", authenticateToken, approver, withClient(async (client, req, res) => {
    await client.query("BEGIN");
    const rq = (await client.query(
      "SELECT * FROM planner_style_eff_requests WHERE id = $1 FOR UPDATE", [req.params.id]
    )).rows[0];
    if (!rq) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "Solicitud no encontrada" }); }
    if (rq.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, error: `La solicitud ya está ${rq.status}.` });
    }
    const cur = (await client.query(
      "SELECT * FROM planner_style_params WHERE style_code = $1 FOR UPDATE", [rq.style_code]
    )).rows[0];
    if (!cur) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, error: "El estilo ya no tiene estándar." });
    }
    const next = withTargets({ ...cur, efficiency: Number(rq.requested_efficiency) });
    const { row } = await upsertParams(client, rq.style_code, next, who(req), "eff_ok");
    const decided = (await client.query(
      `UPDATE planner_style_eff_requests
          SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3
        WHERE id = $1 RETURNING *`,
      [rq.id, who(req), req.body?.note ? String(req.body.note).slice(0, 1000) : null]
    )).rows[0];
    const recompute = capacityChanged(cur, row)
      ? await recomputeSafely(client, rq.style_code)
      : { style: rq.style_code, recomputed: false, reason: "unchanged" };
    await client.query("COMMIT");
    res.json({ success: true, request: decided, params: row, recompute });
  }));

  app.post("/api/planner/style-eff-requests/:id/reject", authenticateToken, approver, withClient(async (client, req, res) => {
    const r = await client.query(
      `UPDATE planner_style_eff_requests
          SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [req.params.id, who(req), req.body?.note ? String(req.body.note).slice(0, 1000) : null]
    );
    if (!r.rowCount) return res.status(409).json({ success: false, error: "La solicitud no está pendiente." });
    res.json({ success: true, request: r.rows[0] });
  }));

  // The planner withdraws a pending request.
  app.post("/api/planner/style-eff-requests/:id/cancel", authenticateToken, canWrite, withClient(async (client, req, res) => {
    const r = await client.query(
      `UPDATE planner_style_eff_requests
          SET status = 'cancelled', decided_by = $2, decided_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [req.params.id, who(req)]
    );
    if (!r.rowCount) return res.status(409).json({ success: false, error: "La solicitud no está pendiente." });
    res.json({ success: true, request: r.rows[0] });
  }));

  // Per-day free capacity of ONE line for ONE style over a date range. The board
  // uses this to pack a dropped order day by day (one call instead of one per day).
  // GET /api/planning/style-capacity?lineNo=3&style=DAMTSH01&from=2026-09-28&to=2027-03-28
  app.get("/api/planning/style-capacity", authenticateToken, withClient(async (client, req, res) => {
    const { lineNo, style, from, to } = req.query;
    if (!lineNo || !from || !to) {
      return res.status(400).json({ success: false, error: "lineNo, from y to son obligatorios" });
    }
    const params = await getParams(client, style);
    if (!params) return styleParamsRequired(res, style);
    const target = targetOf(params);
    const loads = await lineLoadRange(client, { lineNo, from, to, fallbackTarget: target });
    const days = [];
    const [y, m, d] = String(from).split("-").map(Number);
    const cur = new Date(Date.UTC(y, m - 1, d));
    const end = new Date(`${to}T00:00:00Z`);
    for (let i = 0; cur <= end && i < 800; i++) {
      const k = cur.toISOString().slice(0, 10);
      const load = loads.get(k) || 0;
      days.push({ date: k, load: Math.round(load * 10000) / 10000, available: Math.max(0, Math.floor((1 - load) * target + 1e-6)) });
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    res.json({ success: true, style: params.style_code, params, target_pcs: target, days });
  }));
}

module.exports = register;
module.exports.initSchema = initSchema;
module.exports.ensureSchema = ensureSchema;
module.exports.normStyle = normStyle;
module.exports.targetOf = targetOf;
module.exports.effectiveMinutesOf = effectiveMinutesOf;
module.exports.getParams = getParams;
module.exports.getParamsMap = getParamsMap;
module.exports.styleOfWorkOrder = styleOfWorkOrder;
module.exports.lineLoadRange = lineLoadRange;
module.exports.cellCapacity = cellCapacity;
module.exports.recomputeStyle = recomputeStyle;
module.exports.styleParamsRequired = styleParamsRequired;