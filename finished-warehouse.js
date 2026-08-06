// finished-warehouse.js
// ---------------------------------------------------------------------------
// Almacén de Producto Terminado (Finished-goods warehouse) module.
//
// Follows the same shape as work-orders.js:
//   const registerFinishedWarehouse = require("./finished-warehouse");
//   await registerFinishedWarehouse.initSchema({ pool, setSchema });
//   registerFinishedWarehouse(app, { authenticateToken, pool, setSchema });
//
// Provides:
//   • Pre-packing lists (draft) with boxes, auto-filled from a work order (PO).
//   • Confirming a list pushes its boxes into finished_inventory (per SKU).
//   • Inventory + a light dashboard.
//
// Field mapping agreed with the team:
//   PO  = work_orders.work_order_no      (our work order)
//   MO  = work_orders.customer_po        (PO cliente)
//   box_code default = "CT_KUBOT_STANDARD"
//   gross/net weight default 0, encasement_qrcode left blank (system field).
// ---------------------------------------------------------------------------

const DEFAULT_BOX_CODE = "CT_KUBOT_STANDARD";

// Reused for the order-level "producido" total (production isn't tracked per size).
const workOrders = require("./work-orders");

// The columns that identify one finished-goods SKU. Confirming a list adds the
// box quantity onto the matching SKU (or creates it).
const SKU_FIELDS = ["customer_code", "po", "style", "color_code", "size_code", "sex", "fabric_code"];
const skuKeyOf = (b) => SKU_FIELDS.map((f) => String(b[f] ?? "").trim()).join("|");

// SheetJS is only needed for Excel export. Load it lazily so the module still
// boots (and CSV export still works) if the package isn't installed yet.
let XLSX = null;
try { XLSX = require("xlsx"); } catch { /* run `npm install xlsx` to enable .xlsx/.xls */ }

// Codigo de color = color + talla (e.g. color "NEG" + talla "M" -> "NEGM").
const colorCodeOf = (color, talla) => `${String(color ?? "").trim()}${String(talla ?? "").trim()}`;

// Size code -> printable label for the packing list. The DB stores only the code
// (work_order_lines.talla / master_codes.talla); this maps it to the label the
// customer expects. PARTIAL LIST — extend as new size codes appear. Any code not
// found here falls back to printing the code itself, so a size is never blank.
const SIZE_LABELS = {
  "130": "xxs",
  "132": "xs",
  "134": "xs",
  "136": "(S)",
  "138": "(M)",
  "140": "L",
  "142": "XL",
  "144": "XXL",
  "004": "I-XS",
  "006": "S",
  "008": "M",
  "010": "L",
};
const sizeLabelOf = (code) => {
  const k = String(code ?? "").trim();
  return SIZE_LABELS[k] ?? k;
};

// BoxRegistry rule agreed with the team: for cliente C&A it is "NCA", blank otherwise.
// Detection is by customer name containing "C&A" (case-insensitive).
const boxRegistryFor = (customerName) =>
  String(customerName ?? "").toUpperCase().includes("C&A") ? "NCA" : null;

// Split an integer `total` across `weights` proportionally, returning whole
// numbers that sum EXACTLY to `total` (largest-remainder / Hamilton method).
// Used to spread the order-level producido across size×color lines by ordered qty.
function allocateProportional(total, weights) {
  const n = weights.length;
  if (n === 0) return [];
  const T = Math.max(0, Math.round(Number(total) || 0));
  const w = weights.map((x) => Math.max(0, Number(x) || 0));
  const sum = w.reduce((s, x) => s + x, 0);

  // No ordered basis to split on -> fall back to an even split.
  const shares = sum > 0 ? w.map((x) => (x / sum) * T) : w.map(() => T / n);

  const parts = shares.map(Math.floor);
  let left = T - parts.reduce((s, x) => s + x, 0);

  // Hand the leftover units to the largest fractional remainders, one each.
  const order = shares
    .map((s, i) => ({ i, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && left > 0; k++, left--) parts[order[k].i]++;

  return parts;
}

// Build the box rows for a list straight from its work order's size×color lines.
// One box per work_order_lines row, every field pre-filled from the DB so the
// operator only has to export. Inserts the rows and returns them.
//
// `moFilter` (optional): when given, only the lines whose PO cliente (line
// customer_po, or the order MO if the line has none) equals it are used — this
// is how one order is split into one list per PO cliente. If nothing matches
// (e.g. a legacy list whose mo is a combined value), it falls back to all lines.
//
// NOTE: caller runs inside its own transaction; this only issues queries.
async function generateBoxesFromOrder(client, list, moFilter) {
  if (!list.work_order_id) return [];

  const woRes = await client.query(
    `SELECT work_order_no AS po, customer_po AS mo FROM work_orders WHERE id = $1`,
    [list.work_order_id]
  );
  if (woRes.rows.length === 0) return [];
  const header = woRes.rows[0];

  const linesRes = await client.query(
    `SELECT talla        AS size_code,
            color        AS color_name,
            estilo       AS style,
            customer_po  AS mo,
            fabric_code,
            quantity
       FROM work_order_lines
      WHERE work_order_id = $1
      ORDER BY color, talla`,
    [list.work_order_id]
  );

  const po = header.po || list.po || null;
  const boxRegistry = boxRegistryFor(list.customer_name);

  // Each line's effective PO cliente: its own customer_po, else the order MO.
  const headerMo = String(header.mo ?? "").trim();
  const effMo = (l) => { const m = String(l.mo ?? "").trim(); return m || headerMo; };

  // Producido is an order-level total (production isn't captured per talla/color).
  // Split it across ALL size×color lines by ordered quantity FIRST, so that when
  // a list is scoped to one PO cliente it still gets only its own lines' share,
  // and the shares across every PO cliente of the order still sum to producido.
  const producedTotal = await workOrders.producedQuantityFor(client, list.work_order_id);
  const allocation = allocateProportional(
    producedTotal,
    linesRes.rows.map((l) => Number(l.quantity) || 0)
  );
  let rows = linesRes.rows.map((l, i) => ({ ...l, _alloc: allocation[i] }));

  // Scope to one PO cliente when asked (fall back to all lines if none match).
  if (moFilter != null && String(moFilter).trim() !== "") {
    const want = String(moFilter).trim();
    const scoped = rows.filter((l) => effMo(l) === want);
    if (scoped.length > 0) rows = scoped;
  }

  const inserted = [];
  for (const l of rows) {
    const { rows: ins } = await client.query(
      `INSERT INTO pre_packing_boxes
         (list_id, box_qrcode, encasement_qrcode, mo, po, style, fabric_code, sex,
          size_code, color_name, color_code, quantity, box_code, box_registry,
          gross_weight, net_weight, customer_code, customer_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        list.id,
        null,                                   // box_qrcode — ticket is the PO on export
        null,                                   // encasement_qrcode (system field)
        effMo(l) || list.mo || null,
        po,
        l.style || null,                        // "label" = estilo -> Estyle column
        l.fabric_code || null,
        null,                                   // sex -> Genero 0 on export
        l.size_code || null,
        l.color_name || null,
        colorCodeOf(l.color_name, l.size_code) || null,
        l._alloc,                               // producido split proportionally by size
        DEFAULT_BOX_CODE,
        boxRegistry,
        0,
        0,
        list.customer_code || null,
        list.customer_name || null,
      ]
    );
    inserted.push(ins[0]);
  }
  return inserted;
}

// Distinct PO cliente (MO) values across a work order's lines. A line with no
// customer_po falls back to the order-level MO. Drives the "one list per PO
// cliente" split at create time. Returned sorted for stable list numbering.
async function distinctLineMos(client, workOrderId, headerMo) {
  const { rows } = await client.query(
    `SELECT DISTINCT COALESCE(NULLIF(TRIM(customer_po), ''), $2) AS mo
       FROM work_order_lines
      WHERE work_order_id = $1`,
    [workOrderId, String(headerMo ?? "").trim()]
  );
  return rows
    .map((r) => String(r.mo ?? "").trim())
    .filter((m) => m.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);

    // Header: one pre-packing list, tied to a client and (optionally) a work order.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pre_packing_lists(
        id BIGSERIAL PRIMARY KEY,
        list_no VARCHAR(20) UNIQUE,
        customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
        customer_code VARCHAR(20),
        customer_name VARCHAR(150),
        work_order_id BIGINT REFERENCES work_orders(id) ON DELETE SET NULL,
        po VARCHAR(60),
        mo VARCHAR(60),
        status VARCHAR(20) NOT NULL DEFAULT 'draft',
        notes TEXT,
        created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        confirmed_at TIMESTAMPTZ,
        CONSTRAINT chk_pp_status CHECK (status IN ('draft','confirmed','cancelled'))
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_pp_lists_customer ON pre_packing_lists(customer_id);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_pp_lists_status ON pre_packing_lists(status);");

    // One row = one box.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pre_packing_boxes(
        id BIGSERIAL PRIMARY KEY,
        list_id BIGINT NOT NULL REFERENCES pre_packing_lists(id) ON DELETE CASCADE,
        box_qrcode VARCHAR(120),
        encasement_qrcode VARCHAR(120),
        mo VARCHAR(60),
        po VARCHAR(60),
        style VARCHAR(60),
        fabric_code VARCHAR(60),
        sex VARCHAR(10),
        size_code VARCHAR(20),
        color_name VARCHAR(60),
        color_code VARCHAR(20),
        quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
        box_code VARCHAR(60) DEFAULT '${DEFAULT_BOX_CODE}',
        box_registry VARCHAR(60),
        gross_weight NUMERIC(12,3) NOT NULL DEFAULT 0,
        net_weight NUMERIC(12,3) NOT NULL DEFAULT 0,
        customer_code VARCHAR(20),
        customer_name VARCHAR(150),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_pp_box_qty CHECK (quantity >= 0)
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_pp_boxes_list ON pre_packing_boxes(list_id);");

    // Aggregated finished-goods stock. sku_key is maintained by the app so the
    // confirm step can upsert with a plain ON CONFLICT.
    await client.query(`
      CREATE TABLE IF NOT EXISTS finished_inventory(
        id BIGSERIAL PRIMARY KEY,
        sku_key TEXT UNIQUE NOT NULL,
        customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
        customer_code VARCHAR(20),
        customer_name VARCHAR(150),
        po VARCHAR(60),
        mo VARCHAR(60),
        style VARCHAR(60),
        fabric_code VARCHAR(60),
        sex VARCHAR(10),
        size_code VARCHAR(20),
        color_name VARCHAR(60),
        color_code VARCHAR(20),
        quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
        box_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Audit trail of every stock movement (one row per confirmed box).
    await client.query(`
      CREATE TABLE IF NOT EXISTS finished_inventory_movements(
        id BIGSERIAL PRIMARY KEY,
        inventory_id BIGINT REFERENCES finished_inventory(id) ON DELETE SET NULL,
        list_id BIGINT REFERENCES pre_packing_lists(id) ON DELETE SET NULL,
        box_id BIGINT,
        direction VARCHAR(6) NOT NULL DEFAULT 'in',
        quantity NUMERIC(14,2) NOT NULL,
        created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_fim_dir CHECK (direction IN ('in','out','adjust'))
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_fim_list ON finished_inventory_movements(list_id);");

    console.log("✅ finished-warehouse tables ready in prod_db_schema");
  } finally {
    client.release();
  }
}

function registerFinishedWarehouse(app, deps) {
  const { authenticateToken, pool, setSchema } = deps;

  // Small helper to run a handler with a schema-scoped client.
  const withClient = (handler) => async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      await handler(req, res, client);
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch {}
      console.error("❌ finished-warehouse:", err.message);
      if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  };

  // ======================================================================
  //  LOOKUPS (populate the Pre-empaque form)
  // ======================================================================

  // Clients for the "select client" dropdown.
  app.get("/api/finished-warehouse/clients", authenticateToken, withClient(async (req, res, client) => {
    const { rows } = await client.query(
      `SELECT id, code, name, market_type FROM customers ORDER BY name ASC`
    );
    res.json({ success: true, clients: rows });
  }));

  // Work orders (POs) — optionally filtered by client — with the fields we
  // auto-fill from. po = work_order_no, mo = customer_po.
  app.get("/api/finished-warehouse/work-orders", authenticateToken, withClient(async (req, res, client) => {
    const { customerId } = req.query;
    const params = [];
    let where = "WHERE wo.status <> 'cancelled'";
    if (customerId) { params.push(customerId); where += ` AND wo.customer_id = $${params.length}`; }
    const { rows } = await client.query(
      `SELECT wo.id,
              wo.work_order_no                     AS po,
              wo.customer_po                       AS mo,
              COALESCE(wo.estilo, wo.style_code)   AS style,
              wo.fabric_code,
              wo.color                             AS color_name,
              wo.customer_id,
              wo.customer_name,
              c.code                               AS customer_code
         FROM work_orders wo
         LEFT JOIN customers c ON c.id = wo.customer_id
         ${where}
         ORDER BY wo.created_at DESC
         LIMIT 500`,
      params
    );
    res.json({ success: true, workOrders: rows });
  }));

  // Everything needed to pre-fill the box form for one work order, plus its
  // size×color lines so the operator can pick a row instead of retyping.
  app.get("/api/finished-warehouse/autofill/:workOrderId", authenticateToken, withClient(async (req, res, client) => {
    const woId = parseInt(req.params.workOrderId, 10);
    const woRes = await client.query(
      `SELECT wo.id,
              wo.work_order_no                     AS po,
              wo.customer_po                       AS mo,
              COALESCE(wo.estilo, wo.style_code)   AS style,
              wo.fabric_code,
              wo.color                             AS color_name,
              wo.customer_id,
              wo.customer_name,
              c.code                               AS customer_code
         FROM work_orders wo
         LEFT JOIN customers c ON c.id = wo.customer_id
        WHERE wo.id = $1`,
      [woId]
    );
    if (woRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Orden de trabajo no encontrada" });
    }
    const header = woRes.rows[0];

    const linesRes = await client.query(
      `SELECT l.talla        AS size_code,
              l.color        AS color_name,
              l.estilo       AS style,
              l.customer_po  AS mo,
              l.fabric_code,
              l.quantity
         FROM work_order_lines l
        WHERE l.work_order_id = $1
        ORDER BY l.color, l.talla`,
      [woId]
    );

    res.json({ success: true, header, lines: linesRes.rows });
  }));

  // Line-leader INPUT for one work order: what each production line has reported
  // as finished (packing/terminado ops), plus ordered vs produced totals. Lets
  // the Almacén PT operator see "qué entró de cada línea" and judge WHEN a work
  // order has enough finished to build its pre-packing list. Read-only.
  app.get("/api/finished-warehouse/work-orders/:workOrderId/line-production", authenticateToken, withClient(async (req, res, client) => {
    const woId = parseInt(req.params.workOrderId, 10);
    const woRes = await client.query(
      `SELECT id, work_order_no AS po, customer_po AS mo FROM work_orders WHERE id = $1`, [woId]
    );
    if (woRes.rows.length === 0) return res.status(404).json({ success: false, error: "Orden de trabajo no encontrada" });

    // Ordered = sum of the order's size×color lines. Produced = order-level total
    // from the same packing-operation logic the planner uses (single source).
    const ordRes = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS ordered FROM work_order_lines WHERE work_order_id = $1`, [woId]
    );
    const orderedTotal = Number(ordRes.rows[0].ordered) || 0;

    const lines = await workOrders.producedByLineFor(client, woId);   // [{ line_no, finished, last_reported_at }]
    const producedTotal = await workOrders.producedQuantityFor(client, woId);

    res.json({ success: true, workOrder: woRes.rows[0], orderedTotal, producedTotal, lines });
  }));

  // DASHBOARD feed: work orders that have line production, most recently active
  // first, each with ordered/produced totals, the per-line breakdown, and any
  // pre-packing lists already started. This is what the "Entrada de líneas" view
  // reads so the operator can spot which orders are ready to pre-empaque.
  app.get("/api/finished-warehouse/line-input", authenticateToken, withClient(async (req, res, client) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));

    // Candidate orders: any with production runs, not cancelled, newest activity first.
    const woRes = await client.query(
      `SELECT wo.id,
              wo.work_order_no                   AS po,
              wo.customer_po                     AS mo,
              COALESCE(wo.estilo, wo.style_code) AS style,
              wo.customer_id,
              wo.customer_name,
              c.code                             AS customer_code,
              MAX(lr.updated_at)                 AS last_activity
         FROM work_orders wo
         JOIN line_runs lr ON lr.work_order_id = wo.id
         LEFT JOIN customers c ON c.id = wo.customer_id
        WHERE wo.status <> 'cancelled'
        GROUP BY wo.id, c.code
        ORDER BY MAX(lr.updated_at) DESC NULLS LAST
        LIMIT $1`,
      [limit]
    );
    const orders = woRes.rows;
    if (orders.length === 0) return res.json({ success: true, orders: [] });
    const ids = orders.map((o) => o.id);

    // Ordered totals, existing lists, and per-line production — one query each.
    const ordRes = await client.query(
      `SELECT work_order_id, COALESCE(SUM(quantity), 0) AS ordered
         FROM work_order_lines WHERE work_order_id = ANY($1) GROUP BY work_order_id`, [ids]
    );
    const orderedBy = new Map(ordRes.rows.map((r) => [Number(r.work_order_id), Number(r.ordered) || 0]));

    const listRes = await client.query(
      `SELECT work_order_id, list_no, status FROM pre_packing_lists
        WHERE work_order_id = ANY($1) ORDER BY id ASC`, [ids]
    );
    const listsBy = new Map();
    for (const r of listRes.rows) {
      const key = Number(r.work_order_id);
      const arr = listsBy.get(key) || [];
      arr.push({ list_no: r.list_no, status: r.status });
      listsBy.set(key, arr);
    }

    const lineMap = await workOrders.producedByLineForMany(client, ids);

    const result = orders.map((o) => {
      const lines = lineMap.get(Number(o.id)) || [];
      const producedTotal = lines.reduce((s, l) => s + (Number(l.finished) || 0), 0);
      return {
        id: o.id,
        po: o.po,
        mo: o.mo,
        style: o.style,
        customer_id: o.customer_id,
        customer_name: o.customer_name,
        customer_code: o.customer_code,
        orderedTotal: orderedBy.get(Number(o.id)) || 0,
        producedTotal,
        lastActivity: o.last_activity,
        lines,
        lists: listsBy.get(Number(o.id)) || [],
      };
    });

    res.json({ success: true, orders: result });
  }));

  // ======================================================================
  //  PRE-PACKING LISTS
  // ======================================================================

  // List index with box_count + total_qty.
  app.get("/api/pre-packing-lists", authenticateToken, withClient(async (req, res, client) => {
    const { status, customerId, q } = req.query;
    const params = [];
    let where = "WHERE 1=1";
    if (status)     { params.push(status);     where += ` AND l.status = $${params.length}`; }
    if (customerId) { params.push(customerId); where += ` AND l.customer_id = $${params.length}`; }
    if (q)          { params.push(`%${q}%`);   where += ` AND (l.list_no ILIKE $${params.length} OR l.po ILIKE $${params.length} OR l.mo ILIKE $${params.length} OR l.customer_name ILIKE $${params.length})`; }

    const { rows } = await client.query(
      `SELECT l.*,
              COALESCE(b.box_count, 0)  AS box_count,
              COALESCE(b.total_qty, 0)  AS total_qty
         FROM pre_packing_lists l
         LEFT JOIN (
           SELECT list_id, COUNT(*) AS box_count, SUM(quantity) AS total_qty
             FROM pre_packing_boxes GROUP BY list_id
         ) b ON b.list_id = l.id
         ${where}
         ORDER BY l.created_at DESC
         LIMIT 500`,
      params
    );
    res.json({ success: true, lists: rows });
  }));

  // One list with its boxes.
  app.get("/api/pre-packing-lists/:id", authenticateToken, withClient(async (req, res, client) => {
    const id = parseInt(req.params.id, 10);
    const listRes = await client.query(`SELECT * FROM pre_packing_lists WHERE id = $1`, [id]);
    if (listRes.rows.length === 0) return res.status(404).json({ success: false, error: "Lista no encontrada" });
    const boxesRes = await client.query(
      `SELECT * FROM pre_packing_boxes WHERE list_id = $1 ORDER BY id ASC`, [id]
    );
    res.json({ success: true, list: listRes.rows[0], boxes: boxesRes.rows });
  }));

  // (Re)build a draft list's boxes from its work order. Clears existing boxes
  // and regenerates one per size×color line — used to seed older lists or to
  // refresh after the order's lines changed.
  app.post("/api/pre-packing-lists/:id/generate-boxes", authenticateToken, withClient(async (req, res, client) => {
    const id = parseInt(req.params.id, 10);
    await client.query("BEGIN");
    const listRes = await client.query(`SELECT * FROM pre_packing_lists WHERE id = $1 FOR UPDATE`, [id]);
    if (listRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "Lista no encontrada" }); }
    const list = listRes.rows[0];
    if (list.status !== "draft") { await client.query("ROLLBACK"); return res.status(400).json({ success: false, error: "La lista ya fue confirmada" }); }
    if (!list.work_order_id) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, error: "La lista no tiene una orden asociada" }); }

    await client.query(`DELETE FROM pre_packing_boxes WHERE list_id = $1`, [id]);
    const boxes = await generateBoxesFromOrder(client, list, list.mo);
    await client.query("COMMIT");
    res.json({ success: true, boxes, boxesGenerated: boxes.length });
  }));

  // Export a list's boxes as CSV (opens in Excel). One row per box.
  app.get("/api/pre-packing-lists/:id/export", authenticateToken, withClient(async (req, res, client) => {
    const id = parseInt(req.params.id, 10);
    const listRes = await client.query(`SELECT * FROM pre_packing_lists WHERE id = $1`, [id]);
    if (listRes.rows.length === 0) return res.status(404).json({ success: false, error: "Lista no encontrada" });
    const list = listRes.rows[0];
    const boxesRes = await client.query(`SELECT * FROM pre_packing_boxes WHERE list_id = $1 ORDER BY id ASC`, [id]);

    // Exact packing template: header label, value, and cell kind ("num" for
    // numeric cells). Constants per the agreed format: Genero=0, BoxType="no",
    // and BoxNo / GrossWeight / NetWeight / Material box barcode left blank.
    const columns = [
      ["ticket",               (b) => b.po],          // ticket = PO number
      ["Orden Produccion",     (b) => b.mo],
      ["PO",                   (b) => b.po],
      ["Estyle",               (b) => b.style],
      ["Genero",               () => 0, "num"],
      ["Codigo Fabric",        (b) => b.fabric_code],
      ["Size",                 (b) => sizeLabelOf(b.size_code)],
      ["Color",                (b) => b.color_name],
      ["Codigo De Color",      (b) => b.color_code],
      ["Piezas",               (b) => b.quantity, "num"],
      ["BoxType",              () => "no"],
      ["BoxNo",                () => ""],
      ["BoxRegistry",          (b) => b.box_registry],
      ["GrossWeight",          () => ""],
      ["NetWeight",            () => ""],
      ["CustomerCode",         (b) => b.customer_code],
      ["CustomerName",         (b) => b.customer_name],
      ["Material box barcode", () => ""],
    ];

    const cellVal = (col, b) => {
      const v = col[1](b);
      if (col[2] === "num") return Number(v) || 0;
      return v === null || v === undefined ? "" : v;
    };

    const format = String(req.query.format || "xlsx").toLowerCase();
    const base = list.list_no || `pre-empaque-${list.id}`;
    const headerRow = columns.map((c) => c[0]);

    // CSV needs no dependency.
    if (format === "csv") {
      const esc = (v) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const body = boxesRes.rows.map((b) => columns.map((c) => esc(cellVal(c, b))).join(","));
      const csv = "\uFEFF" + [headerRow.join(","), ...body].join("\r\n");   // BOM so Excel reads UTF-8
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.csv"`);
      return res.send(csv);
    }

    // Excel (.xlsx / .xls) via SheetJS.
    if (!XLSX) {
      return res.status(501).json({
        success: false,
        error: "Exportación Excel no disponible: ejecute 'npm install xlsx' en el servidor, o exporte en formato CSV.",
      });
    }

    const aoa = [headerRow, ...boxesRes.rows.map((b) => columns.map((c) => cellVal(c, b)))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = headerRow.map((h) => ({ wch: Math.max(10, h.length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Pre-empaque");

    const bookType = format === "xls" ? "xls" : "xlsx";
    const buf = XLSX.write(wb, { type: "buffer", bookType });
    const mime = bookType === "xls"
      ? "application/vnd.ms-excel"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${base}.${bookType}"`);
    return res.send(buf);
  }));

  // Create a list. Snapshots client + PO/MO from the chosen work order.
  app.post("/api/pre-packing-lists", authenticateToken, withClient(async (req, res, client) => {
    const { customerId, workOrderId, notes } = req.body;
    if (!customerId) return res.status(400).json({ success: false, error: "Seleccione un cliente" });

    await client.query("BEGIN");

    const cRes = await client.query(`SELECT id, code, name FROM customers WHERE id = $1`, [customerId]);
    if (cRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, error: "Cliente no válido" }); }
    const cust = cRes.rows[0];

    let woId = null, po = null, headerMo = null;
    if (workOrderId) {
      const wRes = await client.query(`SELECT id, work_order_no, customer_po FROM work_orders WHERE id = $1`, [workOrderId]);
      if (wRes.rows.length) { woId = wRes.rows[0].id; po = wRes.rows[0].work_order_no; headerMo = wRes.rows[0].customer_po; }
    }

    // One order can carry several PO cliente (customer_po) across its lines. When
    // it does, create ONE pre-packing list per PO cliente, each seeded only with
    // that PO cliente's size×color lines (e.g. PP-000010 → 23456, PP-000011 → po-1234).
    let mos = [];
    if (woId) mos = await distinctLineMos(client, woId, headerMo);
    if (mos.length === 0) mos = [headerMo ? String(headerMo).trim() : null]; // no order / no per-line PO cliente

    const created = [];
    for (const mo of mos) {
      const insRes = await client.query(
        `INSERT INTO pre_packing_lists
           (customer_id, customer_code, customer_name, work_order_id, po, mo, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [cust.id, cust.code, cust.name, woId, po, mo, notes || null, req.user?.id ?? null]
      );
      const listRow = insRes.rows[0];
      const upd = await client.query(
        `UPDATE pre_packing_lists SET list_no = $2 WHERE id = $1 RETURNING *`,
        [listRow.id, `PP-${String(listRow.id).padStart(6, "0")}`]
      );
      // Auto-fill this list from the order, scoped to its PO cliente.
      const boxes = await generateBoxesFromOrder(client, upd.rows[0], mo);
      created.push({ list: upd.rows[0], boxesGenerated: boxes.length });
    }

    await client.query("COMMIT");
    // `lists` is the full set; `list`/`boxesGenerated` (first list) kept for compat.
    res.json({
      success: true,
      lists: created,
      count: created.length,
      list: created[0]?.list ?? null,
      boxesGenerated: created[0]?.boxesGenerated ?? 0,
    });
  }));

  // Update header (only while draft).
  app.patch("/api/pre-packing-lists/:id", authenticateToken, withClient(async (req, res, client) => {
    const id = parseInt(req.params.id, 10);
    const cur = await client.query(`SELECT status FROM pre_packing_lists WHERE id = $1`, [id]);
    if (cur.rows.length === 0) return res.status(404).json({ success: false, error: "Lista no encontrada" });
    if (cur.rows[0].status !== "draft") return res.status(400).json({ success: false, error: "La lista ya fue confirmada" });

    const { notes, workOrderId, customerId } = req.body;
    const sets = [], params = [];
    const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (notes !== undefined) add("notes", notes);
    if (customerId !== undefined) {
      const cRes = await client.query(`SELECT id, code, name FROM customers WHERE id = $1`, [customerId]);
      if (cRes.rows.length) { add("customer_id", cRes.rows[0].id); add("customer_code", cRes.rows[0].code); add("customer_name", cRes.rows[0].name); }
    }
    if (workOrderId !== undefined) {
      const wRes = await client.query(`SELECT id, work_order_no, customer_po FROM work_orders WHERE id = $1`, [workOrderId]);
      if (wRes.rows.length) { add("work_order_id", wRes.rows[0].id); add("po", wRes.rows[0].work_order_no); add("mo", wRes.rows[0].customer_po); }
    }
    if (sets.length === 0) return res.json({ success: true });

    params.push(id);
    const { rows } = await client.query(
      `UPDATE pre_packing_lists SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json({ success: true, list: rows[0] });
  }));

  // Delete a list (drops its boxes; only while draft).
  app.delete("/api/pre-packing-lists/:id", authenticateToken, withClient(async (req, res, client) => {
    const id = parseInt(req.params.id, 10);
    const cur = await client.query(`SELECT status FROM pre_packing_lists WHERE id = $1`, [id]);
    if (cur.rows.length === 0) return res.status(404).json({ success: false, error: "Lista no encontrada" });
    if (cur.rows[0].status !== "draft") return res.status(400).json({ success: false, error: "No se puede eliminar una lista confirmada" });
    await client.query(`DELETE FROM pre_packing_lists WHERE id = $1`, [id]);
    res.json({ success: true });
  }));

  // ======================================================================
  //  BOXES
  // ======================================================================

  const listMustBeDraft = async (client, listId) => {
    const r = await client.query(`SELECT id, status, customer_code, customer_name, po, mo FROM pre_packing_lists WHERE id = $1`, [listId]);
    return r.rows[0] || null;
  };

  // Add a box. Missing fields fall back to list snapshot / defaults.
  app.post("/api/pre-packing-lists/:id/boxes", authenticateToken, withClient(async (req, res, client) => {
    const listId = parseInt(req.params.id, 10);
    const list = await listMustBeDraft(client, listId);
    if (!list) return res.status(404).json({ success: false, error: "Lista no encontrada" });
    if (list.status !== "draft") return res.status(400).json({ success: false, error: "La lista ya fue confirmada" });

    const b = req.body || {};
    const { rows } = await client.query(
      `INSERT INTO pre_packing_boxes
         (list_id, box_qrcode, encasement_qrcode, mo, po, style, fabric_code, sex,
          size_code, color_name, color_code, quantity, box_code, box_registry,
          gross_weight, net_weight, customer_code, customer_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        listId,
        b.box_qrcode || null,
        b.encasement_qrcode || null,            // system field; blank is fine
        b.mo ?? list.mo ?? null,
        b.po ?? list.po ?? null,
        b.style || null,
        b.fabric_code || null,
        b.sex || null,
        b.size_code || null,
        b.color_name || null,
        b.color_code || null,
        Number(b.quantity) || 0,
        b.box_code || DEFAULT_BOX_CODE,
        b.box_registry || null,
        Number(b.gross_weight) || 0,
        Number(b.net_weight) || 0,
        b.customer_code ?? list.customer_code ?? null,
        b.customer_name ?? list.customer_name ?? null,
      ]
    );
    res.json({ success: true, box: rows[0] });
  }));

  // Edit a box (only while its list is draft).
  app.patch("/api/pre-packing-boxes/:id", authenticateToken, withClient(async (req, res, client) => {
    const id = parseInt(req.params.id, 10);
    const cur = await client.query(
      `SELECT b.id, l.status FROM pre_packing_boxes b JOIN pre_packing_lists l ON l.id = b.list_id WHERE b.id = $1`, [id]
    );
    if (cur.rows.length === 0) return res.status(404).json({ success: false, error: "Caja no encontrada" });
    if (cur.rows[0].status !== "draft") return res.status(400).json({ success: false, error: "La lista ya fue confirmada" });

    const editable = ["box_qrcode","encasement_qrcode","mo","po","style","fabric_code","sex","size_code",
      "color_name","color_code","quantity","box_code","box_registry","gross_weight","net_weight","customer_code","customer_name"];
    const numeric = new Set(["quantity","gross_weight","net_weight"]);
    const sets = [], params = [];
    for (const col of editable) {
      if (req.body[col] !== undefined) {
        params.push(numeric.has(col) ? (Number(req.body[col]) || 0) : req.body[col]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (sets.length === 0) return res.json({ success: true });
    params.push(id);
    const { rows } = await client.query(
      `UPDATE pre_packing_boxes SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params
    );
    res.json({ success: true, box: rows[0] });
  }));

  // Delete a box (only while its list is draft).
  app.delete("/api/pre-packing-boxes/:id", authenticateToken, withClient(async (req, res, client) => {
    const id = parseInt(req.params.id, 10);
    const cur = await client.query(
      `SELECT b.id, l.status FROM pre_packing_boxes b JOIN pre_packing_lists l ON l.id = b.list_id WHERE b.id = $1`, [id]
    );
    if (cur.rows.length === 0) return res.status(404).json({ success: false, error: "Caja no encontrada" });
    if (cur.rows[0].status !== "draft") return res.status(400).json({ success: false, error: "La lista ya fue confirmada" });
    await client.query(`DELETE FROM pre_packing_boxes WHERE id = $1`, [id]);
    res.json({ success: true });
  }));

  // ======================================================================
  //  CONFIRM  ->  push boxes into finished_inventory
  // ======================================================================
  app.post("/api/pre-packing-lists/:id/confirm", authenticateToken, withClient(async (req, res, client) => {
    const listId = parseInt(req.params.id, 10);
    await client.query("BEGIN");

    const listRes = await client.query(`SELECT * FROM pre_packing_lists WHERE id = $1 FOR UPDATE`, [listId]);
    if (listRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "Lista no encontrada" }); }
    const list = listRes.rows[0];
    if (list.status !== "draft") { await client.query("ROLLBACK"); return res.status(400).json({ success: false, error: "La lista ya fue confirmada" }); }

    const boxesRes = await client.query(`SELECT * FROM pre_packing_boxes WHERE list_id = $1`, [listId]);
    if (boxesRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, error: "La lista no tiene cajas" }); }

    let piecesAdded = 0;
    for (const box of boxesRes.rows) {
      const sku_key = skuKeyOf(box);
      const qty = Number(box.quantity) || 0;

      const invRes = await client.query(
        `INSERT INTO finished_inventory
           (sku_key, customer_id, customer_code, customer_name, po, mo, style, fabric_code,
            sex, size_code, color_name, color_code, quantity, box_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1)
         ON CONFLICT (sku_key) DO UPDATE SET
           quantity  = finished_inventory.quantity + EXCLUDED.quantity,
           box_count = finished_inventory.box_count + 1,
           updated_at = now()
         RETURNING id`,
        [
          sku_key, list.customer_id, box.customer_code || list.customer_code, box.customer_name || list.customer_name,
          box.po, box.mo, box.style, box.fabric_code, box.sex, box.size_code,
          box.color_name, box.color_code, qty,
        ]
      );
      const inventoryId = invRes.rows[0].id;

      await client.query(
        `INSERT INTO finished_inventory_movements (inventory_id, list_id, box_id, direction, quantity, created_by)
         VALUES ($1,$2,$3,'in',$4,$5)`,
        [inventoryId, listId, box.id, qty, req.user?.id ?? null]
      );
      piecesAdded += qty;
    }

    const upd = await client.query(
      `UPDATE pre_packing_lists SET status = 'confirmed', confirmed_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [listId]
    );

    await client.query("COMMIT");
    res.json({ success: true, list: upd.rows[0], boxes: boxesRes.rows.length, piecesAdded });
  }));

  // ======================================================================
  //  INVENTORY  +  DASHBOARD
  // ======================================================================
  app.get("/api/finished-inventory", authenticateToken, withClient(async (req, res, client) => {
    const { customerId, q } = req.query;
    const params = [];
    let where = "WHERE quantity <> 0";
    if (customerId) { params.push(customerId); where += ` AND customer_id = $${params.length}`; }
    if (q)          { params.push(`%${q}%`);   where += ` AND (style ILIKE $${params.length} OR po ILIKE $${params.length} OR color_name ILIKE $${params.length} OR customer_name ILIKE $${params.length})`; }
    const { rows } = await client.query(
      `SELECT * FROM finished_inventory ${where} ORDER BY customer_name, style, color_name, size_code LIMIT 1000`, params
    );
    const totalPieces = rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
    res.json({ success: true, inventory: rows, totalPieces });
  }));

  app.get("/api/finished-warehouse/dashboard", authenticateToken, withClient(async (req, res, client) => {
    const [lists, boxes, inv, recent] = await Promise.all([
      client.query(`SELECT status, COUNT(*)::int AS n FROM pre_packing_lists GROUP BY status`),
      client.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(quantity),0) AS qty FROM pre_packing_boxes`),
      client.query(`SELECT COALESCE(SUM(quantity),0) AS pieces, COUNT(*)::int AS skus, COALESCE(SUM(box_count),0)::int AS boxes FROM finished_inventory`),
      client.query(`SELECT id, list_no, customer_name, po, mo, status, created_at FROM pre_packing_lists ORDER BY created_at DESC LIMIT 8`),
    ]);
    const byStatus = Object.fromEntries(lists.rows.map((r) => [r.status, r.n]));
    res.json({
      success: true,
      dashboard: {
        lists: { draft: byStatus.draft || 0, confirmed: byStatus.confirmed || 0, total: (byStatus.draft || 0) + (byStatus.confirmed || 0) },
        prePacking: { boxes: boxes.rows[0].n, pieces: Number(boxes.rows[0].qty) || 0 },
        inventory: { pieces: Number(inv.rows[0].pieces) || 0, skus: inv.rows[0].skus, boxes: inv.rows[0].boxes },
        recentLists: recent.rows,
      },
    });
  }));
}

registerFinishedWarehouse.initSchema = initSchema;
module.exports = registerFinishedWarehouse;