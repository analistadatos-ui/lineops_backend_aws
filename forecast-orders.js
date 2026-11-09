// ==========================================================================
// forecast-orders.js
//
// FORECAST BOARD (Tablero de pronóstico del cliente)
//
// A second board, next to the Plan Board, where the planner loads the
// customer's FORECAST directly — no merchant, no PO, no pre-order. Each
// forecast order carries everything the board needs to size it on a line:
//
//     STYLE NAME · CLIENT · QUANTITY · STYLE DESCRIPTION · SEASON ·
//     HANDOVER DATE · NO. OF OPERATORS · SAM · WORKING HOURS (· efficiency)
//
// The planner drags a forecast card onto a LINE + DAY exactly like a PRE####
// pre-order on the Plan Board: it is packed day by day into the line's free
// capacity and stored as "forecast holds" (one row per line/day).
//
// Capacity (pieces/day of a forecast order on a line):
//     target = operators × working_hours × 60 × efficiency ÷ SAM
// A line-day can mix several forecast orders: each hold uses
// quantity ÷ (its order's target) of the day; what is left is offered to the
// next order, scaled by ITS target.
//
// The forecast board is a SANDBOX: it never touches line_assignments,
// pre_order_day_holds, merchant_week_plan, CEO week locks or the board lock.
// The real Plan Board does not see forecast holds and vice-versa.
//
// PER-LINE CAPACITY: operators (and SAM / hours / efficiency) can differ by
// line. forecast_line_params holds a line's own values for one forecast; a
// line without a row uses the forecast's general values. Changing capacity is
// always done for chosen lines and RE-PACKS this forecast's cells on them from
// today on: same pieces, new pieces/day, packed day by day into the free room
// (weekends + the holidays the board sends are skipped). Past cells are kept.
//
// Register-module, same shape as pre-orders.js / pre-order-holds.js.
//
// --------------------------------------------------------------------------
// SETUP (server1.js)
// --------------------------------------------------------------------------
// 1. In the async startup block, AFTER customers exists (e.g. right after
//    `await registerPreOrderHolds.initSchema(...)`):
//        await registerForecastOrders.initSchema({ pool, setSchema });
//    (registerForecastOrders must be required above that block, see 2.)
//
// 2. Near the other requires/registrations (by registerPreOrderHolds):
//        const registerForecastOrders = require("./forecast-orders");
//        registerForecastOrders(app, { authenticateToken, pool, setSchema });
//
// Endpoints
//   GET    /api/forecast-orders?status=active|cancelled|all&search=
//   GET    /api/forecast-orders/next-number           -> { sequence: "FC0007" }
//   GET    /api/forecast-orders/:id
//   POST   /api/forecast-orders                       -> create (auto FC####)
//   PUT    /api/forecast-orders/:id                   -> edit (active only)
//   POST   /api/forecast-orders/:id/convert           -> link the SKM orders made
//          from it (total or partial), release / shrink its board cells and put
//          the new SKMs on the merchant week plan so they show in the Plan Board
//   POST   /api/forecast-orders/:id/cancel            -> cancel + release holds
//   DELETE /api/forecast-orders/:id                   -> delete (holds cascade)
//
//   GET    /api/forecast-holds[?from=&to=]            -> { holds:[...] }
//   POST   /api/forecast-holds                        -> upsert ONE line/day
//   DELETE /api/forecast-holds?id=                    -> one hold
//   DELETE /api/forecast-holds?preOrderId=|forecastOrderId=  -> all of an order
//
//   POST   /api/forecast-orders/:id/capacity      -> change operators / SAM / hours /
//          efficiency for SELECTED LINES (and/or the general value) and
//          re-pack this forecast's cells on those lines (see below)
//
//   GET    /api/forecast-capacity?lineNo=&style=&from=&to=
//          style = the forecast number (FC0001) — the board keys capacity by it
//          -> { target_pcs, days:[{ date, available }] }
//
// Hold rows are returned with the SAME field names the Plan Board uses for
// pre-order holds (pre_order_id, pre_order_no, style_code, estilo,
// target_date, sam_minutes) so PlanBoard.jsx renders them unchanged.
//
// POST /api/forecast-orders body (camelCase or snake_case):
//   { styleName, customerId?, customerName, quantity, styleDescription?,
//     season?, handoverDate?, operators, samMinutes, workingHours,
//     efficiency? (0.85 or 85; default 100%), notes? }
// ==========================================================================

async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS forecast_orders(
        id                BIGSERIAL PRIMARY KEY,
        forecast_no       VARCHAR(30)   NOT NULL UNIQUE,          -- FC0001
        style_name        VARCHAR(120)  NOT NULL,
        style_description TEXT,
        customer_id       BIGINT REFERENCES customers(id) ON DELETE SET NULL,
        customer_name     VARCHAR(150)  NOT NULL,
        season            VARCHAR(60),
        quantity          NUMERIC(12,2) NOT NULL,
        handover_date     DATE,
        operators_count   INT           NOT NULL,
        sam_minutes       NUMERIC(10,2) NOT NULL,
        working_hours     NUMERIC(6,2)  NOT NULL,
        efficiency        NUMERIC(4,3)  NOT NULL DEFAULT 1,
        notes             TEXT,
        status            VARCHAR(20)   NOT NULL DEFAULT 'active',
        created_by        BIGINT,
        updated_by        BIGINT,
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
        CONSTRAINT chk_fc_status     CHECK (status IN ('active','cancelled')),
        CONSTRAINT chk_fc_qty        CHECK (quantity > 0),
        CONSTRAINT chk_fc_operators  CHECK (operators_count > 0),
        CONSTRAINT chk_fc_sam        CHECK (sam_minutes > 0),
        CONSTRAINT chk_fc_hours      CHECK (working_hours > 0 AND working_hours <= 24),
        CONSTRAINT chk_fc_eff        CHECK (efficiency > 0 AND efficiency <= 1)
      );
    `);
    // Conversion to real SKM orders (total or partial, like pre-orders).
    await client.query("ALTER TABLE forecast_orders ADD COLUMN IF NOT EXISTS converted_pieces NUMERIC(12,2) NOT NULL DEFAULT 0;");
    await client.query("ALTER TABLE forecast_orders ADD COLUMN IF NOT EXISTS work_order_ids BIGINT[] NOT NULL DEFAULT '{}';");
    await client.query("ALTER TABLE forecast_orders ADD COLUMN IF NOT EXISTS work_order_nos TEXT;");
    await client.query("ALTER TABLE forecast_orders ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;");
    await client.query("ALTER TABLE forecast_orders ADD COLUMN IF NOT EXISTS converted_by BIGINT;");
    await client.query("ALTER TABLE forecast_orders DROP CONSTRAINT IF EXISTS chk_fc_status;");
    await client.query("ALTER TABLE forecast_orders ADD CONSTRAINT chk_fc_status CHECK (status IN ('active','partially_converted','converted','cancelled'));");
    await client.query("CREATE INDEX IF NOT EXISTS idx_forecast_orders_status ON forecast_orders(status);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_forecast_orders_customer ON forecast_orders(customer_id);");

    await client.query(`
      CREATE TABLE IF NOT EXISTS forecast_day_holds(
        id                 BIGSERIAL PRIMARY KEY,
        forecast_order_id  BIGINT NOT NULL REFERENCES forecast_orders(id) ON DELETE CASCADE,
        line_no            TEXT   NOT NULL,
        assigned_date      DATE   NOT NULL,
        quantity           NUMERIC(12,2) NOT NULL,
        color              VARCHAR(50) NOT NULL DEFAULT '',
        created_by         BIGINT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_forecast_day_holds_qty CHECK (quantity > 0)
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_forecast_day_holds
        ON forecast_day_holds (forecast_order_id, line_no, assigned_date, color);
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_forecast_day_holds_cell ON forecast_day_holds(line_no, assigned_date);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_forecast_day_holds_order ON forecast_day_holds(forecast_order_id);");
    // Per-line capacity of a forecast (overrides the general values on that line).
    await client.query(`
      CREATE TABLE IF NOT EXISTS forecast_line_params(
        forecast_order_id BIGINT NOT NULL REFERENCES forecast_orders(id) ON DELETE CASCADE,
        line_no           TEXT   NOT NULL,
        operators_count   INT           NOT NULL,
        sam_minutes       NUMERIC(10,2) NOT NULL,
        working_hours     NUMERIC(6,2)  NOT NULL,
        efficiency        NUMERIC(4,3)  NOT NULL DEFAULT 1,
        updated_by        BIGINT,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (forecast_order_id, line_no),
        CONSTRAINT chk_flp_operators CHECK (operators_count > 0),
        CONSTRAINT chk_flp_sam       CHECK (sam_minutes > 0),
        CONSTRAINT chk_flp_hours     CHECK (working_hours > 0 AND working_hours <= 24),
        CONSTRAINT chk_flp_eff       CHECK (efficiency > 0 AND efficiency <= 1)
      );
    `);
    console.log("\u2705 forecast_orders + forecast_day_holds + forecast_line_params tables ready in prod_db_schema");
  } finally {
    client.release();
  }
}

// --- helpers ---------------------------------------------------------------
// A forecast still lives on the board while it is active or partly converted.
const OPEN_STATUSES = ["active", "partially_converted"];
const OPEN_SQL = "('active','partially_converted')";
const txt = (v, n) => (v == null ? null : String(v).trim().slice(0, n || 200) || null);
const col = (v) => String(v == null ? "" : v).trim().toUpperCase().slice(0, 50);
const numOr = (v, d = 0) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
const isYmd = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const dateOr = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (isYmd(s)) return s;
  let m = s.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (m) return m[1];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
};
const ymdLocal = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// Same key the board uses for capacity (style_code = forecast number).
const styleKey = (v) => String(v == null ? "" : v).toUpperCase().replace(/[^A-Z0-9]/g, "");

// pieces/day of one forecast order on any line
const targetOf = (o) => {
  const sam = Number(o?.sam_minutes) || 0;
  if (!(sam > 0)) return 0;
  return ((Number(o.operators_count) || 0) * (Number(o.working_hours) || 0) * 60 * (Number(o.efficiency) || 1)) / sam;
};

// SQL expression for the same target (used to weigh other orders' holds).
// (needs `LEFT JOIN forecast_line_params lp ON lp.forecast_order_id = o.id AND lp.line_no = h.line_no`)
const TARGET_SQL = `(COALESCE(lp.operators_count, o.operators_count) * COALESCE(lp.working_hours, o.working_hours) * 60
  * COALESCE(lp.efficiency, o.efficiency) / NULLIF(COALESCE(lp.sam_minutes, o.sam_minutes), 0))`;

const SELECT_COLS = `
  f.id, f.forecast_no, f.style_name, f.style_description, f.customer_id,
  f.customer_name, f.season, f.quantity,
  to_char(f.handover_date, 'YYYY-MM-DD') AS handover_date,
  f.operators_count, f.sam_minutes, f.working_hours, f.efficiency, f.notes,
  f.status, f.created_by, f.updated_by, f.created_at, f.updated_at,
  ROUND(f.operators_count * f.working_hours * 60 * f.efficiency / NULLIF(f.sam_minutes, 0), 2) AS target_pcs,
  COALESCE(h.held, 0)                              AS held_quantity,
  f.converted_pieces,
  GREATEST(f.quantity - f.converted_pieces, 0)     AS open_quantity,       -- still forecast
  GREATEST(f.quantity - f.converted_pieces - COALESCE(h.held, 0), 0) AS remaining_quantity,
  f.work_order_ids, f.work_order_nos, f.converted_at, f.converted_by,
  to_char(h.first_day, 'YYYY-MM-DD')               AS first_day,
  to_char(h.last_day,  'YYYY-MM-DD')               AS last_day,
  COALESCE(h.lines, '{}')                          AS lines,
  COALESCE(lpx.line_params, '[]'::json)            AS line_params
`;
const FROM_JOIN = `
  FROM forecast_orders f
  LEFT JOIN (
    SELECT forecast_order_id,
           SUM(quantity)       AS held,
           MIN(assigned_date)  AS first_day,
           MAX(assigned_date)  AS last_day,
           ARRAY_AGG(DISTINCT line_no) AS lines
      FROM forecast_day_holds
     GROUP BY forecast_order_id
  ) h ON h.forecast_order_id = f.id
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
             'line_no', lp.line_no, 'operators_count', lp.operators_count,
             'sam_minutes', lp.sam_minutes, 'working_hours', lp.working_hours,
             'efficiency', lp.efficiency,
             'target_pcs', ROUND(lp.operators_count * lp.working_hours * 60 * lp.efficiency / NULLIF(lp.sam_minutes, 0), 2)
           ) ORDER BY lp.line_no) AS line_params
      FROM forecast_line_params lp WHERE lp.forecast_order_id = f.id
  ) lpx ON true
`;

// Efficiency accepts 0.85 or 85 (percent). Empty → 100 %.
function parseEfficiency(v) {
  if (v == null || String(v).trim() === "") return 1;
  let e = numOr(v, NaN);
  if (isNaN(e)) return NaN;
  if (e > 1) e = e / 100;
  return e;
}

function parseBody(body) {
  const b = body || {};
  const styleName = txt(b.styleName ?? b.style_name ?? b.style, 120);
  const customerIdRaw = b.customerId ?? b.customer_id;
  const customerId = customerIdRaw == null || customerIdRaw === "" ? null : parseInt(customerIdRaw, 10);
  const customerName = txt(b.customerName ?? b.customer_name ?? b.clientName, 150);
  const quantity = numOr(b.quantity ?? b.pieces, 0);
  const operators = parseInt(b.operators ?? b.operatorsCount ?? b.operators_count, 10);
  const samMinutes = numOr(b.samMinutes ?? b.sam_minutes ?? b.sam, 0);
  const workingHours = numOr(b.workingHours ?? b.working_hours ?? b.hours, 0);
  const efficiency = parseEfficiency(b.efficiency ?? b.efficiencyPct);
  const handoverRaw = b.handoverDate ?? b.handover_date ?? b.targetDate;
  const handoverDate = dateOr(handoverRaw);

  const errors = [];
  if (!styleName) errors.push("style name");
  if (!customerName && !(customerId > 0)) errors.push("client name");
  if (!(quantity > 0)) errors.push("quantity > 0");
  if (!(operators > 0)) errors.push("no. of operators > 0");
  if (!(samMinutes > 0)) errors.push("SAM > 0");
  if (!(workingHours > 0) || workingHours > 24) errors.push("working hours (0–24)");
  if (isNaN(efficiency) || !(efficiency > 0) || efficiency > 1) errors.push("efficiency (1–100 %)");
  if (handoverRaw && !handoverDate) errors.push("handover date (YYYY-MM-DD)");

  return {
    errors,
    data: {
      styleName,
      styleDescription: txt(b.styleDescription ?? b.style_description ?? b.description, 2000),
      customerId: customerId > 0 ? customerId : null,
      customerName,
      season: txt(b.season, 60),
      quantity,
      handoverDate,
      operators,
      samMinutes,
      workingHours,
      efficiency: isNaN(efficiency) ? 1 : Math.round(efficiency * 1000) / 1000,
      notes: txt(b.notes, 2000),
    },
  };
}

// If a customer id is sent, its official name wins; otherwise the free text.
async function resolveCustomer(client, data) {
  if (data.customerId) {
    const { rows } = await client.query("SELECT name FROM customers WHERE id = $1", [data.customerId]);
    if (rows.length) return { customerId: data.customerId, customerName: rows[0].name };
  }
  if (data.customerName) {
    const { rows } = await client.query(
      "SELECT id, name FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1",
      [data.customerName]
    );
    if (rows.length) return { customerId: rows[0].id, customerName: rows[0].name };
  }
  return { customerId: null, customerName: data.customerName };
}

async function nextForecastNo(client) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX((substring(forecast_no from '^FC([0-9]+)'))::int), 0) AS maxseq
       FROM forecast_orders WHERE forecast_no LIKE 'FC%'`
  );
  return `FC${String((rows[0]?.maxseq || 0) + 1).padStart(4, "0")}`;
}

async function getOrderById(client, id) {
  const { rows } = await client.query(`SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE f.id = $1`, [id]);
  return rows[0] || null;
}

// Free pieces of ONE forecast order on ONE line, for each day in [from, to].
// excludeHoldId lets a caller ignore a hold that is about to be replaced.
// The params a forecast uses on one line: its line override, else the general.
async function effectiveParams(client, order, lineNo) {
  const { rows } = await client.query(
    `SELECT operators_count, sam_minutes, working_hours, efficiency
       FROM forecast_line_params WHERE forecast_order_id = $1 AND line_no = $2`,
    [order.id, String(lineNo).trim()]
  );
  return rows[0] ? { ...order, ...rows[0], own_line: true } : { ...order, own_line: false };
}

async function capacityFor(client, { order, lineNo, from, to }) {
  const target = targetOf(await effectiveParams(client, order, lineNo));
  const { rows } = await client.query(
    `SELECT to_char(h.assigned_date, 'YYYY-MM-DD') AS d,
            SUM(h.quantity / NULLIF(${TARGET_SQL}, 0)) AS frac
       FROM forecast_day_holds h
       JOIN forecast_orders o ON o.id = h.forecast_order_id
       LEFT JOIN forecast_line_params lp ON lp.forecast_order_id = o.id AND lp.line_no = h.line_no
      WHERE h.line_no = $1
        AND h.assigned_date BETWEEN $2 AND $3
        AND o.status IN ${OPEN_SQL}
      GROUP BY h.assigned_date`,
    [String(lineNo).trim(), from, to]
  );
  const used = new Map(rows.map((r) => [r.d, Number(r.frac) || 0]));
  const days = [];
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  for (let d = new Date(start), i = 0; d <= end && i < 800; d.setDate(d.getDate() + 1), i++) {
    const key = ymdLocal(d);
    const free = Math.max(0, 1 - (used.get(key) || 0));
    // tiny epsilon so 0.9999999 × target doesn't lose a piece to float noise
    days.push({ date: key, available: Math.max(0, Math.floor(free * target + 1e-6)) });
  }
  return { target, days };
}

// Releases board cells of a forecast for `pieces` converted to SKM, EARLIEST
// days first (the real order takes the forecast's first slots). Cells that
// reach 0 are deleted; the last one touched is reduced.
async function shrinkForecastHolds(client, orderId, pieces) {
  let left = Math.max(0, Number(pieces) || 0);
  if (left <= 0) return 0;
  const { rows } = await client.query(
    "SELECT id, quantity FROM forecast_day_holds WHERE forecast_order_id = $1 ORDER BY assigned_date, line_no, id",
    [orderId]
  );
  let released = 0;
  for (const h of rows) {
    if (left <= 0) break;
    const q = Number(h.quantity) || 0;
    if (q <= left) {
      await client.query("DELETE FROM forecast_day_holds WHERE id = $1", [h.id]);
      left -= q; released += q;
    } else {
      await client.query("UPDATE forecast_day_holds SET quantity = quantity - $2, updated_at = NOW() WHERE id = $1", [h.id, left]);
      released += left; left = 0;
    }
  }
  return released;
}

const mondayOf = (ymd) => {
  const d = new Date(`${ymd}T00:00:00`);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow);
  return ymdLocal(d);
};

// Puts the new SKMs on the merchant week plan (one row per order + color with
// its size breakdown), in `week`, so the Plan Board pool shows them right away
// — same rows pre-orders.js writes when a PRE#### is converted.
async function carryToMerchantPlan(client, workOrderIds, week, userId) {
  if (!week || !workOrderIds.length) return 0;
  const { rows: eqRows } = await client.query(
    "SELECT equivalence FROM merchant_week_plan WHERE equivalence > 0 ORDER BY updated_at DESC NULLS LAST LIMIT 1"
  );
  const eq = Number(eqRows[0]?.equivalence) > 0 ? Number(eqRows[0].equivalence) : 10;
  const { rows: wos } = await client.query(
    `SELECT id, work_order_no, customer_name, customer_po, style_code, estilo,
            style_description, sam_minutes, quantity, color
       FROM work_orders WHERE id = ANY($1::bigint[])`,
    [workOrderIds]
  );
  const { rows: lines } = await client.query(
    "SELECT work_order_id, color, estilo, talla, quantity FROM work_order_lines WHERE work_order_id = ANY($1::bigint[])",
    [workOrderIds]
  );
  let inserted = 0;
  for (const wo of wos) {
    const groups = new Map();
    for (const l of lines.filter((x) => String(x.work_order_id) === String(wo.id))) {
      const k = l.color || "";
      const g = groups.get(k) || { color: k, cantidad: 0, sizes: new Map(), estilos: new Set() };
      const q = Number(l.quantity) || 0;
      g.cantidad += q;
      if (l.talla) g.sizes.set(l.talla, (g.sizes.get(l.talla) || 0) + q);
      if (l.estilo) g.estilos.add(l.estilo);
      groups.set(k, g);
    }
    const rows = groups.size ? [...groups.values()] : [{
      color: (wo.color || "").split(",")[0].trim(), cantidad: Number(wo.quantity) || 0,
      sizes: new Map(), estilos: new Set(wo.estilo ? [wo.estilo] : []),
    }];
    for (const g of rows) {
      const sam = Number(wo.sam_minutes) || 0;
      const eqPerPiece = sam / eq;
      await client.query(
        `INSERT INTO merchant_week_plan
           (work_order_id, pre_order_id, color, week_start, work_order_no, customer_name,
            customer_po, style_code, estilo, style_description, cantidad, sam_minutes,
            equivalence, eq_per_piece, eq_pieces, sizes, is_pre_order,
            created_by, updated_by, created_at, updated_at)
         VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,false,$16,$16,NOW(),NOW())
         ON CONFLICT (COALESCE(work_order_id, 0), COALESCE(pre_order_id, 0), color)
         DO UPDATE SET week_start = EXCLUDED.week_start, updated_at = NOW()`,
        [
          wo.id, String(g.color || "").toUpperCase().slice(0, 50), week,
          wo.work_order_no, wo.customer_name, wo.customer_po, wo.style_code,
          [...g.estilos].join(", ") || wo.estilo, wo.style_description,
          g.cantidad, sam, eq, eqPerPiece, g.cantidad * eqPerPiece,
          JSON.stringify([...g.sizes.entries()].map(([talla, quantity]) => ({ talla, quantity }))),
          userId,
        ]
      );
      inserted++;
    }
  }
  return inserted;
}

// Re-pack ONE forecast on ONE line from `fromDate` on with its current
// effective capacity. Same pieces, packed day by day into the free room left by
// the other forecasts; weekends and `blocked` dates (holidays) are skipped.
// Pieces that don't fit in the horizon go back to the pool (reported).
async function repackLine(client, { order, lineNo, fromDate, blocked = [], userId = null, horizonDays = 400 }) {
  const ln = String(lineNo).trim();
  const { rows: cells } = await client.query(
    `SELECT id, color, quantity, to_char(assigned_date,'YYYY-MM-DD') AS d
       FROM forecast_day_holds
      WHERE forecast_order_id = $1 AND line_no = $2 AND assigned_date >= $3
      ORDER BY assigned_date`,
    [order.id, ln, fromDate]
  );
  if (!cells.length) return { line: ln, cellsBefore: 0, cellsAfter: 0, pieces: 0, unplaced: 0, firstDay: null, lastDay: null };
  const start = cells[0].d;
  const byColor = new Map();
  for (const c of cells) byColor.set(c.color || "", (byColor.get(c.color || "") || 0) + (Number(c.quantity) || 0));
  await client.query(
    "DELETE FROM forecast_day_holds WHERE forecast_order_id = $1 AND line_no = $2 AND assigned_date >= $3",
    [order.id, ln, fromDate]
  );

  const end = new Date(`${start}T00:00:00`);
  end.setDate(end.getDate() + horizonDays);
  const cap = await capacityFor(client, { order, lineNo: ln, from: start, to: ymdLocal(end) });
  const blockedSet = new Set((blocked || []).filter(isYmd));
  const free = new Map(cap.days.map((x) => [x.date, x.available]));

  let after = 0, unplaced = 0, firstDay = null, lastDay = null;
  const pieces = [...byColor.values()].reduce((t, q) => t + q, 0);
  for (const [color, qty] of byColor) {
    let remaining = Math.round(qty * 100) / 100;
    for (const day of cap.days) {
      if (remaining <= 0) break;
      const dow = new Date(`${day.date}T00:00:00`).getDay();
      if (dow === 0 || dow === 6 || blockedSet.has(day.date)) continue;
      const room = free.get(day.date) || 0;
      if (room <= 0) continue;
      const q = Math.min(room, remaining);
      await client.query(
        `INSERT INTO forecast_day_holds
           (forecast_order_id, line_no, assigned_date, quantity, color, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
         ON CONFLICT (forecast_order_id, line_no, assigned_date, color) DO UPDATE SET
           quantity = forecast_day_holds.quantity + EXCLUDED.quantity, updated_at = NOW()`,
        [order.id, ln, day.date, q, color, userId]
      );
      free.set(day.date, room - q);
      remaining -= q;
      after++;
      if (!firstDay || day.date < firstDay) firstDay = day.date;
      if (!lastDay || day.date > lastDay) lastDay = day.date;
    }
    unplaced += Math.max(0, remaining);
  }
  return { line: ln, cellsBefore: cells.length, cellsAfter: after, pieces, unplaced, firstDay, lastDay, targetPcs: cap.target };
}

function registerForecastOrders(app, deps) {
  const { authenticateToken, pool, setSchema } = deps;

  const withClient = (label, handler) => async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      await handler(client, req, res);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`\u274c ${label}:`, err.message);
      if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  };

  // ======================================================================
  // FORECAST ORDERS
  // ======================================================================

  // Registered BEFORE /:id (Express is first-match-wins).
  app.get("/api/forecast-orders/next-number", authenticateToken,
    withClient("GET /api/forecast-orders/next-number", async (client, req, res) => {
      res.json({ success: true, sequence: await nextForecastNo(client) });
    }));

  app.get("/api/forecast-orders", authenticateToken,
    withClient("GET /api/forecast-orders", async (client, req, res) => {
      const status = String(req.query.status || "active").toLowerCase();
      const where = [];
      const params = [];
      if (status === "active") {
        where.push(`f.status IN ${OPEN_SQL}`);            // active + partially converted
      } else if (["partially_converted", "converted", "cancelled"].includes(status)) {
        params.push(status);
        where.push(`f.status = $${params.length}`);
      }
      if (req.query.customerId) {
        params.push(parseInt(req.query.customerId, 10));
        where.push(`f.customer_id = $${params.length}`);
      }
      const search = txt(req.query.search, 80);
      if (search) {
        params.push(`%${search}%`);
        const p = `$${params.length}`;
        where.push(`(f.forecast_no ILIKE ${p} OR f.style_name ILIKE ${p} OR f.customer_name ILIKE ${p}
                     OR f.style_description ILIKE ${p} OR f.season ILIKE ${p})`);
      }
      const { rows } = await client.query(
        `SELECT ${SELECT_COLS} ${FROM_JOIN}
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY (f.status IN ${OPEN_SQL}) DESC, f.handover_date NULLS LAST, f.forecast_no
          LIMIT 1000`,
        params
      );
      const { rows: counts } = await client.query(
        "SELECT status, COUNT(*)::int AS n FROM forecast_orders GROUP BY status"
      );
      const by = counts.reduce((a, r) => ({ ...a, [r.status]: r.n }), {});
      res.json({
        success: true,
        forecastOrders: rows,
        counts: {
          active: (by.active || 0) + (by.partially_converted || 0),
          partially_converted: by.partially_converted || 0,
          converted: by.converted || 0,
          cancelled: by.cancelled || 0,
          all: counts.reduce((s, r) => s + r.n, 0),
        },
      });
    }));

  app.get("/api/forecast-orders/:id", authenticateToken,
    withClient("GET /api/forecast-orders/:id", async (client, req, res) => {
      const row = await getOrderById(client, parseInt(req.params.id, 10));
      if (!row) return res.status(404).json({ success: false, error: "Forecast order not found" });
      res.json({ success: true, forecastOrder: row });
    }));

  app.post("/api/forecast-orders", authenticateToken,
    withClient("POST /api/forecast-orders", async (client, req, res) => {
      const { errors, data } = parseBody(req.body);
      if (errors.length) return res.status(400).json({ success: false, error: `Missing / invalid: ${errors.join(", ")}` });
      const cust = await resolveCustomer(client, data);

      // Number + insert in the same attempt; on a UNIQUE clash (two planners
      // saving at once) retry with the next number.
      let id = null;
      for (let attempt = 0; attempt < 5 && id == null; attempt++) {
        const no = await nextForecastNo(client);
        try {
          const { rows } = await client.query(
            `INSERT INTO forecast_orders
               (forecast_no, style_name, style_description, customer_id, customer_name,
                season, quantity, handover_date, operators_count, sam_minutes,
                working_hours, efficiency, notes, status, created_by, updated_by,
                created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active',$14,$14,NOW(),NOW())
             RETURNING id`,
            [no, data.styleName, data.styleDescription, cust.customerId, cust.customerName,
             data.season, data.quantity, data.handoverDate, data.operators, data.samMinutes,
             data.workingHours, data.efficiency, data.notes, req.user?.id ?? null]
          );
          id = rows[0].id;
        } catch (e) {
          if (e.code !== "23505") throw e;
        }
      }
      if (id == null) return res.status(409).json({ success: false, error: "Could not assign a forecast number, try again" });
      res.json({ success: true, forecastOrder: await getOrderById(client, id) });
    }));

  app.put("/api/forecast-orders/:id", authenticateToken,
    withClient("PUT /api/forecast-orders/:id", async (client, req, res) => {
      const id = parseInt(req.params.id, 10);
      const { errors, data } = parseBody(req.body);
      if (errors.length) return res.status(400).json({ success: false, error: `Missing / invalid: ${errors.join(", ")}` });
      const cur = await getOrderById(client, id);
      if (!cur) return res.status(404).json({ success: false, error: "Forecast order not found" });
      if (!OPEN_STATUSES.includes(cur.status)) {
        return res.status(400).json({ success: false, error: `A ${cur.status} forecast order can't be edited` });
      }
      const held = Number(cur.held_quantity) || 0;
      const conv = Number(cur.converted_pieces) || 0;
      if (data.quantity + 1e-6 < held + conv) {
        return res.status(400).json({
          success: false,
          error: `${Math.round(conv).toLocaleString()} pcs are already converted to SKM and ${Math.round(held).toLocaleString()} are placed on the board. The quantity can't go below ${Math.round(held + conv).toLocaleString()}.`,
        });
      }
      const cust = await resolveCustomer(client, data);
      await client.query(
        `UPDATE forecast_orders SET
            style_name = $2, style_description = $3, customer_id = $4, customer_name = $5,
            season = $6, quantity = $7, handover_date = $8, operators_count = $9,
            sam_minutes = $10, working_hours = $11, efficiency = $12, notes = $13,
            updated_by = $14, updated_at = NOW()
          WHERE id = $1`,
        [id, data.styleName, data.styleDescription, cust.customerId, cust.customerName,
         data.season, data.quantity, data.handoverDate, data.operators, data.samMinutes,
         data.workingHours, data.efficiency, data.notes, req.user?.id ?? null]
      );
      res.json({ success: true, forecastOrder: await getOrderById(client, id) });
    }));

  // ---- POST /:id/capacity: change capacity for chosen lines and re-pack -----
  // Body:
  //   { operators, samMinutes, workingHours, efficiency (0.85 | 85),
  //     lines: ["1","3"],          // lines where the new values apply (re-packed)
  //     applyGeneral: true|false,  // also make them the forecast's general values
  //     fromDate: "YYYY-MM-DD",    // re-pack from here on (the board's "today")
  //     blockedDates: { "1": ["2026-12-25", …], … } }  // holidays per line
  // Only the chosen lines change. When applyGeneral is true, lines that are
  // NOT chosen and had no values of their own are pinned to the OLD general
  // values, so their cells keep matching their capacity.
  app.post("/api/forecast-orders/:id/capacity", authenticateToken,
    withClient("POST /api/forecast-orders/:id/capacity", async (client, req, res) => {
      const id = parseInt(req.params.id, 10);
      const b = req.body || {};
      const operators = parseInt(b.operators ?? b.operatorsCount, 10);
      const samMinutes = numOr(b.samMinutes ?? b.sam, 0);
      const workingHours = numOr(b.workingHours ?? b.hours, 0);
      const efficiency = parseEfficiency(b.efficiency);
      const lines = [...new Set((Array.isArray(b.lines) ? b.lines : []).map((l) => String(l).trim()).filter(Boolean))];
      const applyGeneral = b.applyGeneral === true;
      const fromDate = isYmd(b.fromDate) ? b.fromDate : ymdLocal(new Date());
      const blockedDates = b.blockedDates && typeof b.blockedDates === "object" ? b.blockedDates : {};

      const errors = [];
      if (!(operators > 0)) errors.push("no. of operators > 0");
      if (!(samMinutes > 0)) errors.push("SAM > 0");
      if (!(workingHours > 0) || workingHours > 24) errors.push("working hours (0–24)");
      if (isNaN(efficiency) || !(efficiency > 0) || efficiency > 1) errors.push("efficiency (1–100 %)");
      if (!lines.length && !applyGeneral) errors.push("select at least one line");
      if (errors.length) return res.status(400).json({ success: false, error: `Missing / invalid: ${errors.join(", ")}` });
      const eff = Math.round(efficiency * 1000) / 1000;
      const uid = req.user?.id ?? null;

      await client.query("BEGIN");
      const { rows: oRows } = await client.query(
        `SELECT id, forecast_no, status, operators_count, sam_minutes, working_hours, efficiency
           FROM forecast_orders WHERE id = $1 FOR UPDATE`, [id]);
      const order = oRows[0];
      if (!order) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "Forecast order not found" }); }
      if (!OPEN_STATUSES.includes(order.status)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, error: `This forecast order is ${order.status}` }); }

      // Lines where the forecast has cells, and lines with their own values.
      const { rows: present } = await client.query(
        "SELECT DISTINCT line_no FROM forecast_day_holds WHERE forecast_order_id = $1", [id]);
      const { rows: own } = await client.query(
        "SELECT line_no FROM forecast_line_params WHERE forecast_order_id = $1", [id]);
      const ownSet = new Set(own.map((r) => String(r.line_no)));

      if (applyGeneral) {
        // Pin untouched lines (no own values) to the OLD general values first.
        for (const r of present) {
          const ln = String(r.line_no);
          if (lines.includes(ln) || ownSet.has(ln)) continue;
          await client.query(
            `INSERT INTO forecast_line_params
               (forecast_order_id, line_no, operators_count, sam_minutes, working_hours, efficiency, updated_by, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
            [id, ln, order.operators_count, order.sam_minutes, order.working_hours, order.efficiency, uid]
          );
        }
        await client.query(
          `UPDATE forecast_orders SET operators_count = $2, sam_minutes = $3, working_hours = $4,
                  efficiency = $5, updated_by = $6, updated_at = NOW() WHERE id = $1`,
          [id, operators, samMinutes, workingHours, eff, uid]
        );
      }
      for (const ln of lines) {
        if (applyGeneral) {
          // Follows the (new) general values.
          await client.query("DELETE FROM forecast_line_params WHERE forecast_order_id = $1 AND line_no = $2", [id, ln]);
        } else {
          await client.query(
            `INSERT INTO forecast_line_params
               (forecast_order_id, line_no, operators_count, sam_minutes, working_hours, efficiency, updated_by, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
             ON CONFLICT (forecast_order_id, line_no) DO UPDATE SET
               operators_count = EXCLUDED.operators_count, sam_minutes = EXCLUDED.sam_minutes,
               working_hours = EXCLUDED.working_hours, efficiency = EXCLUDED.efficiency,
               updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
            [id, ln, operators, samMinutes, workingHours, eff, uid]
          );
        }
      }

      // Re-pack the chosen lines with the new capacity.
      const { rows: fresh } = await client.query(
        "SELECT id, forecast_no, status, operators_count, sam_minutes, working_hours, efficiency FROM forecast_orders WHERE id = $1", [id]);
      const recalculated = [];
      for (const ln of lines) {
        recalculated.push(await repackLine(client, {
          order: fresh[0], lineNo: ln, fromDate,
          blocked: Array.isArray(blockedDates[ln]) ? blockedDates[ln] : [], userId: uid,
        }));
      }
      await client.query("COMMIT");
      res.json({ success: true, recalculated, forecastOrder: await getOrderById(client, id) });
    }));

  // ---- POST /:id/convert: the SKM orders made from this forecast ----------
  // Called by the board AFTER POST /api/production-orders succeeded.
  // Body: { workOrderIds:[…], workOrderNos:[…], convertedPieces, fromDate? }
  //   • converted ≥ open pieces → 'converted': all its board cells are released.
  //   • less                    → 'partially_converted': cells are released for
  //     the converted pieces (earliest days first); the rest stays as forecast.
  // The new SKMs go on the merchant week plan in the week of the forecast's
  // first planned day from `fromDate` (else its first cell, else the handover
  // week, else this week) so they appear in the Plan Board pool to assign.
  app.post("/api/forecast-orders/:id/convert", authenticateToken,
    withClient("POST /api/forecast-orders/:id/convert", async (client, req, res) => {
      const id = parseInt(req.params.id, 10);
      const b = req.body || {};
      const ids = (Array.isArray(b.workOrderIds) ? b.workOrderIds : []).map((v) => parseInt(v, 10)).filter((v) => !isNaN(v));
      const nos = (Array.isArray(b.workOrderNos) ? b.workOrderNos : []).map((v) => txt(v, 80)).filter(Boolean);
      const pieces = Math.max(0, numOr(b.convertedPieces, 0));
      const fromDate = isYmd(b.fromDate) ? b.fromDate : ymdLocal(new Date());
      if (!ids.length || !(pieces > 0)) {
        return res.status(400).json({ success: false, error: "workOrderIds and convertedPieces (>0) are required" });
      }
      const uid = req.user?.id ?? null;

      await client.query("BEGIN");
      const { rows: cur } = await client.query(
        `SELECT id, status, quantity, converted_pieces, work_order_ids, work_order_nos,
                to_char(handover_date,'YYYY-MM-DD') AS handover_date
           FROM forecast_orders WHERE id = $1 FOR UPDATE`, [id]);
      const f = cur[0];
      if (!f) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "Forecast order not found" }); }
      if (!OPEN_STATUSES.includes(f.status)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, error: `This forecast order is ${f.status}` });
      }

      // Week for the Plan Board: first planned day from today, else first cell.
      const { rows: wk } = await client.query(
        `SELECT to_char(MIN(assigned_date) FILTER (WHERE assigned_date >= $2),'YYYY-MM-DD') AS next_day,
                to_char(MIN(assigned_date),'YYYY-MM-DD') AS first_day
           FROM forecast_day_holds WHERE forecast_order_id = $1`, [id, fromDate]);
      const anchor = wk[0]?.next_day || wk[0]?.first_day || f.handover_date || fromDate;
      const week = mondayOf(anchor);

      const total = Number(f.quantity) || 0;
      const newConverted = (Number(f.converted_pieces) || 0) + pieces;
      const isFinal = newConverted + 1e-6 >= total;
      const mergedIds = [...new Set([...(f.work_order_ids || []).map(Number), ...ids])];
      const prevNos = String(f.work_order_nos || "").split(",").map((x) => x.trim()).filter(Boolean);
      const mergedNos = [...new Set([...prevNos, ...nos])];

      await client.query(
        `UPDATE forecast_orders SET
            status = $2, converted_pieces = $3, work_order_ids = $4, work_order_nos = $5,
            converted_at = CASE WHEN $6 THEN NOW() ELSE converted_at END,
            converted_by = CASE WHEN $6 THEN $7 ELSE converted_by END,
            updated_by = $7, updated_at = NOW()
          WHERE id = $1`,
        [id, isFinal ? "converted" : "partially_converted", newConverted, mergedIds,
         mergedNos.join(", ") || null, isFinal, uid]
      );

      // Board cells: all released on a full conversion; else shrink earliest first.
      let releasedPieces = 0;
      if (isFinal) {
        const r = await client.query(
          "DELETE FROM forecast_day_holds WHERE forecast_order_id = $1 RETURNING quantity", [id]);
        releasedPieces = r.rows.reduce((t, x) => t + (Number(x.quantity) || 0), 0);
      } else {
        releasedPieces = await shrinkForecastHolds(client, id, pieces);
      }

      // Best effort (own SAVEPOINT): the conversion stands even if this fails.
      let plannedRows = 0, planError = null;
      await client.query("SAVEPOINT carry_plan");
      try {
        plannedRows = await carryToMerchantPlan(client, ids, week, uid);
        await client.query("RELEASE SAVEPOINT carry_plan");
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT carry_plan");
        planError = e.message;
        console.warn(`\u26a0\ufe0f  convert forecast ${id}: merchant plan not updated:`, e.message);
      }

      await client.query("COMMIT");
      res.json({
        success: true, partial: !isFinal, week, plannedRows, planError, releasedPieces,
        forecastOrder: await getOrderById(client, id),
      });
    }));

  // Cancel = out of the board: its holds are released.
  app.post("/api/forecast-orders/:id/cancel", authenticateToken,
    withClient("POST /api/forecast-orders/:id/cancel", async (client, req, res) => {
      const id = parseInt(req.params.id, 10);
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        `UPDATE forecast_orders SET status = 'cancelled', updated_by = $2, updated_at = NOW()
          WHERE id = $1 AND status IN ${OPEN_SQL}`,
        [id, req.user?.id ?? null]
      );
      if (rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, error: "Not found, already converted or already cancelled" });
      }
      const del = await client.query("DELETE FROM forecast_day_holds WHERE forecast_order_id = $1", [id]);
      await client.query("COMMIT");
      res.json({ success: true, releasedHolds: del.rowCount, forecastOrder: await getOrderById(client, id) });
    }));

  // Re-activate a cancelled one (holds were released, it goes back to the pool).
  app.post("/api/forecast-orders/:id/reactivate", authenticateToken,
    withClient("POST /api/forecast-orders/:id/reactivate", async (client, req, res) => {
      const id = parseInt(req.params.id, 10);
      const { rowCount } = await client.query(
        `UPDATE forecast_orders
            SET status = CASE WHEN converted_pieces > 0 THEN 'partially_converted' ELSE 'active' END,
                updated_by = $2, updated_at = NOW()
          WHERE id = $1 AND status = 'cancelled'`,
        [id, req.user?.id ?? null]
      );
      if (rowCount === 0) return res.status(400).json({ success: false, error: "Not found or already active" });
      res.json({ success: true, forecastOrder: await getOrderById(client, id) });
    }));

  app.delete("/api/forecast-orders/:id", authenticateToken,
    withClient("DELETE /api/forecast-orders/:id", async (client, req, res) => {
      const { rowCount } = await client.query(
        "DELETE FROM forecast_orders WHERE id = $1 AND converted_pieces = 0", [parseInt(req.params.id, 10)]);
      if (rowCount === 0) {
        return res.status(400).json({ success: false, error: "Not found, or it was already converted to SKM (converted forecasts are kept as history; cancel it instead)" });
      }
      res.json({ success: true, deleted: rowCount });
    }));

  // ======================================================================
  // CAPACITY (what the board reads before packing a drop)
  // ======================================================================
  app.get("/api/forecast-capacity", authenticateToken,
    withClient("GET /api/forecast-capacity", async (client, req, res) => {
      const lineNo = txt(req.query.lineNo, 20);
      const from = isYmd(req.query.from) ? req.query.from : null;
      const to = isYmd(req.query.to) ? req.query.to : null;
      const key = styleKey(req.query.style || "");
      const byId = req.query.forecastOrderId ? parseInt(req.query.forecastOrderId, 10) : null;
      if (!lineNo || !from || !to || (!key && !byId)) {
        return res.status(400).json({ success: false, error: "lineNo, style (forecast no.), from and to are required" });
      }
      const { rows } = await client.query(
        `SELECT id, forecast_no, operators_count, working_hours, sam_minutes, efficiency, status
           FROM forecast_orders
          WHERE ${byId ? "id = $1" : "UPPER(regexp_replace(forecast_no, '[^A-Za-z0-9]', '', 'g')) = $1"}
          LIMIT 1`,
        [byId || key]
      );
      const order = rows[0];
      if (!order) return res.status(404).json({ success: false, error: `Forecast order ${key || byId} not found` });
      const cap = await capacityFor(client, { order, lineNo, from, to });
      res.json({ success: true, target_pcs: cap.target, days: cap.days });
    }));

  // ======================================================================
  // FORECAST HOLDS (line/day cells of the forecast board)
  // ======================================================================
  app.get("/api/forecast-holds", authenticateToken,
    withClient("GET /api/forecast-holds", async (client, req, res) => {
      const params = [];
      const where = [`o.status IN ${OPEN_SQL}`];
      if (isYmd(req.query.from)) { params.push(req.query.from); where.push(`h.assigned_date >= $${params.length}`); }
      if (isYmd(req.query.to)) { params.push(req.query.to); where.push(`h.assigned_date <= $${params.length}`); }
      const { rows } = await client.query(
        `SELECT h.id,
                h.forecast_order_id,
                h.forecast_order_id               AS pre_order_id,     -- PlanBoard field name
                h.line_no,
                to_char(h.assigned_date, 'YYYY-MM-DD') AS assigned_date,
                h.quantity, h.color, h.updated_at,
                o.forecast_no                     AS pre_order_no,     -- PlanBoard field name
                o.forecast_no,
                o.customer_name,
                o.forecast_no                     AS style_code,       -- capacity key on the board
                o.style_name                      AS estilo,           -- what the cards display
                o.style_name,
                o.season,
                o.sam_minutes,
                to_char(o.handover_date, 'YYYY-MM-DD') AS target_date,
                o.status                          AS pre_status
           FROM forecast_day_holds h
           JOIN forecast_orders o ON o.id = h.forecast_order_id
          WHERE ${where.join(" AND ")}
          ORDER BY h.assigned_date, h.line_no, o.forecast_no`,
        params
      );
      res.json({ success: true, holds: rows });
    }));

  // Upsert one hold. Re-dropping the same order+line+day+color ADDS to it.
  // { skipCapacityCheck: true } is only for restoring a hold exactly as it was.
  app.post("/api/forecast-holds", authenticateToken,
    withClient("POST /api/forecast-holds", async (client, req, res) => {
      const b = req.body || {};
      const orderId = parseInt(b.forecastOrderId ?? b.preOrderId ?? b.pre_order_id, 10);
      const lineNo = txt(b.lineNo ?? b.line_no, 20);
      const assignedDate = b.assignedDate ?? b.assigned_date ?? null;
      const quantity = numOr(b.quantity, 0);
      if (isNaN(orderId) || !lineNo || !isYmd(assignedDate) || !(quantity > 0)) {
        return res.status(400).json({ success: false, error: "forecastOrderId, lineNo, assignedDate (YYYY-MM-DD) and quantity (>0) are required" });
      }
      await client.query("BEGIN");
      // Serialize writers on this line-day so two drops can't both take the last pieces.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`fc|${lineNo}|${assignedDate}`]);

      const { rows: oRows } = await client.query(
        `SELECT id, forecast_no, status, operators_count, working_hours, sam_minutes, efficiency
           FROM forecast_orders WHERE id = $1`,
        [orderId]
      );
      const order = oRows[0];
      if (!order) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "Forecast order not found" }); }
      if (!OPEN_STATUSES.includes(order.status)) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, error: `This forecast order is ${order.status}` }); }

      if (b.skipCapacityCheck !== true) {
        const cap = await capacityFor(client, { order, lineNo, from: assignedDate, to: assignedDate });
        const available = cap.days[0]?.available || 0;
        if (quantity > available) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            success: false,
            error: `Line ${lineNo} only has room for ${available} pcs of ${order.forecast_no} on ${assignedDate}.`,
            available,
          });
        }
      }

      const { rows } = await client.query(
        `INSERT INTO forecast_day_holds
           (forecast_order_id, line_no, assigned_date, quantity, color, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
         ON CONFLICT (forecast_order_id, line_no, assigned_date, color) DO UPDATE SET
           quantity   = forecast_day_holds.quantity + EXCLUDED.quantity,
           updated_at = NOW()
         RETURNING id, to_char(assigned_date,'YYYY-MM-DD') AS assigned_date, quantity`,
        [orderId, lineNo, assignedDate, quantity, col(b.color), req.user?.id ?? null]
      );
      await client.query("COMMIT");
      res.json({ success: true, hold: rows[0] });
    }));

  app.delete("/api/forecast-holds", authenticateToken,
    withClient("DELETE /api/forecast-holds", async (client, req, res) => {
      const id = req.query.id ?? req.body?.id ?? null;
      const orderId = req.query.forecastOrderId ?? req.query.preOrderId ?? req.body?.forecastOrderId ?? req.body?.preOrderId ?? null;
      if (id == null && orderId == null) {
        return res.status(400).json({ success: false, error: "id or forecastOrderId is required" });
      }
      const { rowCount } = id != null
        ? await client.query("DELETE FROM forecast_day_holds WHERE id = $1", [parseInt(id, 10)])
        : await client.query("DELETE FROM forecast_day_holds WHERE forecast_order_id = $1", [parseInt(orderId, 10)]);
      res.json({ success: true, deleted: rowCount });
    }));
}

registerForecastOrders.initSchema = initSchema;
module.exports = registerForecastOrders;