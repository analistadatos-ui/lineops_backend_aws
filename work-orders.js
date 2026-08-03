// ==========================================================================
// work-orders.js  (consolidated)
//
// Register-module (like mechanics-summary.js) that owns BOTH:
//   • the work-order routes  (list / next-number / :id / create) with a
//     per-color breakdown  -> work_order_colors
//   • the production-order routes used by the step-by-step wizard, which
//     create master codes + PO together with a size×color breakdown
//     -> work_order_lines
//
// One require, one initSchema, one register call.
//
// --------------------------------------------------------------------------
// SETUP
// --------------------------------------------------------------------------
// 1. In server.js DELETE the original handlers this module re-registers
//    (Express is first-match-wins, so leaving them shadows these):
//        app.get("/api/work-orders", ...)      (the list route)
//        app.get("/api/work-orders/:id", ...)
//        app.post("/api/work-orders", ...)
//    LEAVE your PUT /:id and status routes as they are.
//
// 2. Near your other requires (~line 946):
//        const registerWorkOrders = require("./work-orders");
//
// 3. In the async startup block (~line 417), so initSchema can await:
//        await registerWorkOrders.initSchema({ pool, setSchema });
//
// 4. Where the other modules register (~line 949):
//        registerWorkOrders(app, {
//          authenticateToken,
//          pool,
//          setSchema,
//          generatePresignedGetUrl,   // presignCache (already required at top)
//          uploadBufferToS3,        // s3-raw (already required at top)
//          makeStylePhotoKey,       // s3-raw (already required at top)
//        });
//
//    The last two are only used by POST /api/production-orders (photo upload);
//    the plain work-order routes ignore them. Gated by authenticateToken only,
//    because requireMerchantAccess is defined lower in server.js than this
//    registration point. created_by uses req.user.id.
// ==========================================================================

// --- Startup migration: both breakdown tables ----------------------------
async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);

    // per-color breakdown (used by POST /api/work-orders)
    await client.query(`
      CREATE TABLE IF NOT EXISTS work_order_colors(
        id BIGSERIAL PRIMARY KEY,
        work_order_id BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
        color VARCHAR(50) NOT NULL,
        quantity NUMERIC(12,2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_wo_color_qty_positive CHECK (quantity > 0)
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_work_order_colors_wo ON work_order_colors(work_order_id);");
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_work_order_colors_unique ON work_order_colors(work_order_id, color);");
    console.log("✅ work_order_colors table ready in prod_db_schema");

    // size × color breakdown (used by POST /api/production-orders / wizard)
    await client.query(`
      CREATE TABLE IF NOT EXISTS work_order_lines(
        id BIGSERIAL PRIMARY KEY,
        work_order_id BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
        master_code_id BIGINT REFERENCES master_codes(id) ON DELETE SET NULL,
        talla VARCHAR(3) NOT NULL,
        color VARCHAR(3) NOT NULL,
        estilo VARCHAR(6),
        quantity NUMERIC(12,2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_wo_line_qty_positive CHECK (quantity > 0)
      );
    `);
    // Additive migration for databases created before per-color estilo existed.
    await client.query("ALTER TABLE work_order_lines ADD COLUMN IF NOT EXISTS estilo VARCHAR(6);");
    await client.query("ALTER TABLE work_order_lines ADD COLUMN IF NOT EXISTS customer_po VARCHAR(60);");
    // Delivery date, fabric, fabric code and yield are captured per line in
    // step 2 (one value per color+estilo row) and stored here. work_orders also
    // keeps a representative copy of the first line's values for the list view.
    await client.query("ALTER TABLE work_order_lines ADD COLUMN IF NOT EXISTS commitment_date DATE;");
    await client.query("ALTER TABLE work_order_lines ADD COLUMN IF NOT EXISTS fabric_name VARCHAR(150);");
    await client.query("ALTER TABLE work_order_lines ADD COLUMN IF NOT EXISTS fabric_code VARCHAR(60);");
    await client.query("ALTER TABLE work_order_lines ADD COLUMN IF NOT EXISTS yield_per_piece NUMERIC(10,4);");
    // Full list of telas for the line: [{ name, code, yield }, ...]. The scalar
    // fabric_name/fabric_code/yield_per_piece above are kept as a representative
    // (first-tela) copy for the header and list views.
    await client.query("ALTER TABLE work_order_lines ADD COLUMN IF NOT EXISTS fabrics JSONB NOT NULL DEFAULT '[]'::jsonb;");
    await client.query("CREATE INDEX IF NOT EXISTS idx_work_order_lines_wo ON work_order_lines(work_order_id);");
    // Uniqueness must include estilo: the same color+talla can appear under two
    // different estilos within one PO. Drop the older (wo,talla,color) index and
    // recreate it with estilo so those legitimate rows don't collide.
    await client.query("DROP INDEX IF EXISTS idx_work_order_lines_unique;");
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_work_order_lines_unique ON work_order_lines(work_order_id, talla, color, estilo);");
    console.log("✅ work_order_lines table ready in prod_db_schema");

    // Per-PO customer purchase-order reference (nullable).
    await client.query("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS customer_po VARCHAR(60);");

    // Representative copy of the first line's fabric/yield on the PO header, so
    // the list view and searches don't have to join work_order_lines.
    // commitment_date already exists on work_orders (created in server.js schema).
    await client.query("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS fabric_name VARCHAR(150);");
    await client.query("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS fabric_code VARCHAR(60);");
    await client.query("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS yield_per_piece NUMERIC(10,4);");

    // One-time backfill: POs created while these values were stored per line get
    // the first non-null line value promoted onto the header. Idempotent — it
    // only touches headers that are still empty.
    await client.query(`
      UPDATE work_orders wo
         SET fabric_name     = COALESCE(wo.fabric_name, src.fabric_name),
             fabric_code     = COALESCE(wo.fabric_code, src.fabric_code),
             yield_per_piece = COALESCE(wo.yield_per_piece, src.yield_per_piece),
             commitment_date = COALESCE(wo.commitment_date, src.commitment_date)
        FROM (
          SELECT DISTINCT ON (work_order_id)
                 work_order_id, fabric_name, fabric_code, yield_per_piece, commitment_date
            FROM work_order_lines
           WHERE fabric_name IS NOT NULL
              OR fabric_code IS NOT NULL
              OR yield_per_piece IS NOT NULL
              OR commitment_date IS NOT NULL
           ORDER BY work_order_id, id
        ) src
       WHERE src.work_order_id = wo.id
         AND (wo.fabric_name IS NULL OR wo.fabric_code IS NULL
              OR wo.yield_per_piece IS NULL OR wo.commitment_date IS NULL);
    `);
    console.log("\u2705 work_orders fabric/yield header columns ready in prod_db_schema");
  } finally {
    client.release();
  }

  // Detecta como leer la produccion real desde las corridas del lider de linea.
  await resolveProducedSubquery({ pool, setSchema });
}

// The per-color breakdown as a JSON array, reused by both GET routes.
const COLORS_SUBQUERY = `
  COALESCE((
    SELECT json_agg(json_build_object('color', c.color, 'quantity', c.quantity) ORDER BY c.color)
    FROM work_order_colors c WHERE c.work_order_id = wo.id
  ), '[]') AS colors
`;

// Everything captured per color+estilo row in step 2. The expandable detail in
// WorkOrderTable renders straight from this; wo.fabric_name / fabric_code /
// yield_per_piece / commitment_date are the header-level copies.
const LINES_SUBQUERY = `
  COALESCE((
    SELECT json_agg(json_build_object(
             'talla', l.talla,
             'color', l.color,
             'estilo', l.estilo,
             'customerPo', l.customer_po,
             'commitmentDate', to_char(l.commitment_date, 'YYYY-MM-DD'),
             'fabricName', l.fabric_name,
             'fabricCode', l.fabric_code,
             'fabrics', COALESCE(l.fabrics, '[]'::jsonb),
             'yield', l.yield_per_piece,
             'quantity', l.quantity
           ) ORDER BY l.color, l.talla)
    FROM work_order_lines l WHERE l.work_order_id = wo.id
  ), '[]') AS lines
`;

// --------------------------------------------------------------------------
// PRODUCED QUANTITY (lo realmente cosido en piso)
// --------------------------------------------------------------------------
// La produccion NO se captura aparte: ya vive en la data por hora que el lider
// de linea guarda con POST /api/lineleader/update-sewed/:runId. Aqui solo se
// LEE para que el planeador vea el avance real contra la meta.
//
// Se cuentan unicamente las operaciones de empaque/terminado. Sumar todas las
// operaciones multiplicaria cada pieza por el numero de operaciones de la
// linea. Estas palabras clave son las mismas que usa finishedGarmentsTotal en
// LineLeaderPage.jsx: si cambias una, cambia la otra.
const PACKING_KEYWORDS = ["pack", "emp", "termin", "finish"];

// Se resuelve en initSchema contra el esquema real. Si algo no cuadra queda en
// 0 y la app sigue funcionando (la barra de produccion se queda en cero) en vez
// de tronar cada consulta del planeador.
let PRODUCED_SUBQUERY = "0::numeric AS produced_quantity";

// Tablas reales donde vive la captura por hora del lider de linea:
//   line_runs                (id, ... , enlace a la orden)
//   operator_operations      (id, run_id, operation_name, ...)
//   operation_sewed_entries  (run_id, operation_id, slot_id, sewed_qty)
//
// Lo unico que varia entre instalaciones es COMO line_runs apunta a la orden,
// asi que eso si se detecta. Se prueban en orden; el primero que exista gana.
const RUN_LINK_CANDIDATES = [
  { column: "work_order_id", on: "lr.work_order_id = wo.id" },
  { column: "work_order_no", on: "lr.work_order_no = wo.work_order_no" },
  { column: "work_order",    on: "lr.work_order = wo.work_order_no" },
  { column: "po_id",         on: "lr.po_id = wo.id" },
];

async function tableColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(rows.map((r) => r.column_name));
}

// Construye el subquery de produccion. Se llama una sola vez al arranque.
async function resolveProducedSubquery({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);

    const runCols = await tableColumns(client, "line_runs");
    const sewCols = await tableColumns(client, "operation_sewed_entries");
    const opCols = await tableColumns(client, "operator_operations");

    const missing = [];
    if (runCols.size === 0) missing.push("line_runs");
    if (!sewCols.has("sewed_qty") || !sewCols.has("operation_id")) missing.push("operation_sewed_entries");
    if (!opCols.has("operation_name")) missing.push("operator_operations");

    if (missing.length) {
      console.warn(
        "\u26a0\ufe0f  produced_quantity quedara en 0. Tablas no encontradas o sin las " +
        `columnas esperadas: ${missing.join(", ")}.`
      );
      return;
    }

    const link = RUN_LINK_CANDIDATES.find((c) => runCols.has(c.column));
    if (!link) {
      console.warn(
        "\u26a0\ufe0f  produced_quantity quedara en 0: line_runs no tiene ninguna columna " +
        `conocida hacia la orden (${RUN_LINK_CANDIDATES.map((c) => c.column).join(", ")}). ` +
        "Agrega la correcta a RUN_LINK_CANDIDATES en work-orders.js."
      );
      return;
    }

    const likes = PACKING_KEYWORDS
      .map((k) => `lower(oo.operation_name) LIKE '%${k}%'`)
      .join(" OR ");

    // Solo las operaciones de empaque/terminado. Sumar todas las operaciones
    // contaria cada prenda una vez por operacion de la linea.
    PRODUCED_SUBQUERY = `
      COALESCE((
        SELECT SUM(se.sewed_qty)
          FROM operation_sewed_entries se
          JOIN operator_operations oo ON oo.id = se.operation_id
          JOIN line_runs lr           ON lr.id = se.run_id
         WHERE ${link.on}
           AND (${likes})
      ), 0) AS produced_quantity
    `;

    console.log(`\u2705 produced_quantity resuelto (line_runs.${link.column})`);

    // Aviso temprano: si ninguna operacion capturada coincide con las palabras
    // clave, el total sera 0 aunque la linea si este produciendo.
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM operator_operations oo WHERE ${likes}`
    );
    if (rows[0].n === 0) {
      console.warn(
        "\u26a0\ufe0f  Ninguna operacion coincide con PACKING_KEYWORDS " +
        `[${PACKING_KEYWORDS.join(", ")}]; produced_quantity sera 0. ` +
        "Revisa como se llaman tus operaciones de empaque y ajusta la lista."
      );
    }
  } catch (err) {
    console.warn("\u26a0\ufe0f  resolveProducedSubquery fallo:", err.message);
  } finally {
    client.release();
  }
}

const up = (v, n) => String(v || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, n);

const toTxt = (v) => (v == null ? null : String(v).trim() || null);
const toNum = (v) => (v === "" || v == null || isNaN(parseFloat(v)) ? null : parseFloat(v));

// Normalise a line's telas into [{ name, code, yield }], dropping blank names
// and duplicate name+code pairs. Each tela keeps its OWN yield. Accepts the new
// `fabrics` array or a legacy scalar {fabricName, fabricCode, yield}; `fb`
// supplies order-level fallbacks used by the create route.
const buildLineFabrics = (l, fb = {}) => {
  const out = [];
  const seen = new Set();
  const push = (name, code, y) => {
    const nm = toTxt(name);
    if (!nm) return;
    const cd = toTxt(code);
    const key = `${nm}|${cd || ""}`.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: nm, code: cd, yield: toNum(y) });
  };
  if (Array.isArray(l.fabrics) && l.fabrics.length) {
    for (const f of l.fabrics) push(f?.name, f?.code, f?.yield ?? f?.yieldPerPiece);
  } else {
    push(l.fabricName ?? fb.fabricName, l.fabricCode ?? fb.fabricCode, l.yield ?? fb.yieldPerPiece);
  }
  return out;
};

const VALID_STATUSES = ["pending", "assigned", "in_progress", "completed", "cancelled"];

/**
 * Registers the work-order + production-order routes on the given Express app.
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {import('express').RequestHandler} deps.authenticateToken
 * @param {import('pg').Pool} deps.pool
 * @param {(client: any) => Promise<void>} deps.setSchema
 * @param {(filename: string) => string} deps.generatePresignedGetUrl
 * @param {(buffer: Buffer, key: string, mime: string) => Promise<{url:string}>} [deps.uploadBufferToS3]
 * @param {(filename: string) => string} [deps.makeStylePhotoKey]
 */
function registerWorkOrders(app, deps) {
  const { authenticateToken, pool, setSchema, uploadBufferToS3, makeStylePhotoKey } = deps;
  // Different server files inject the presigned-GET helper under different names:
  //   server1.js → generatePresignedGetUrl (from s3-raw)
  //   server.js  → getCachedPresignedUrl   (from presignCache)
  // Accept whichever is provided so this module works with either.
  const generatePresignedGetUrl = deps.generatePresignedGetUrl || deps.getCachedPresignedUrl;
  // =====================================================================
  //  WORK-ORDER ROUTES (per-color breakdown)
  // =====================================================================

  // ---- GET /api/work-orders  (list) -------------------------------------
  app.get("/api/work-orders", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { status, lineNo, startDate, endDate } = req.query;

      let query = `
        SELECT
          wo.id, wo.work_order_no, wo.quantity, wo.customer_id, wo.customer_name,
          wo.style_description, wo.color, wo.fabric_supplier, wo.fabrics,
          wo.style_code, wo.estilo, wo.line_no,
          to_char(wo.run_date, 'YYYY-MM-DD') AS run_date, wo.warehouse_stock,
          wo.extra_quantity, wo.total_to_produce,
          to_char(wo.commitment_date, 'YYYY-MM-DD') AS commitment_date,
          wo.master_code_id, wo.sam_minutes, wo.customer_po,
          wo.fabric_name, wo.fabric_code, wo.yield_per_piece,
          wo.created_at, wo.updated_at,wo.season,wo.status,
          ${COLORS_SUBQUERY},
          ${LINES_SUBQUERY},
          MAX(mc.photo_filename) as master_code_photo_filename,
          COALESCE(SUM(la.assigned_quantity) FILTER (WHERE la.status NOT IN ('cancelled', 'rejected')), 0) as assigned_quantity,
          ${PRODUCED_SUBQUERY}
        FROM work_orders wo
        LEFT JOIN line_assignments la ON la.work_order_id = wo.id
        LEFT JOIN master_codes mc ON mc.id = wo.master_code_id
        WHERE 1=1
      `;

      const params = [];
      let i = 1;
      if (status)    { query += ` AND wo.status = $${i++}`;     params.push(status); }
      if (lineNo)    { query += ` AND wo.line_no = $${i++}`;    params.push(lineNo); }
      if (startDate) { query += ` AND wo.run_date >= $${i++}`;  params.push(startDate); }
      if (endDate)   { query += ` AND wo.run_date <= $${i++}`;  params.push(endDate); }

      query += ` GROUP BY wo.id ORDER BY wo.created_at DESC`;

      const result = await client.query(query, params);
      const workOrders = result.rows.map((row) => {
        const url = row.master_code_photo_filename
          ? generatePresignedGetUrl(row.master_code_photo_filename, 3600)
          : null;
        delete row.master_code_photo_filename;
        return { ...row, master_code_photo_url: url };
      });

      res.json({ success: true, workOrders });
    } catch (err) {
      console.error("❌ Error fetching work orders:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---- GET /api/work-orders/next-number ---------------------------------
  // MUST be registered before /:id so "next-number" isn't captured as an id.
  app.get("/api/work-orders/next-number", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const year = new Date().getFullYear();
      const prefix = `OP-${year}-`;
      const result = await client.query(
        `SELECT work_order_no FROM work_orders
         WHERE work_order_no LIKE $1
         ORDER BY work_order_no DESC LIMIT 1`,
        [`${prefix}%`]
      );
      let next = 1;
      if (result.rows.length > 0) {
        const last = parseInt(result.rows[0].work_order_no.split("-").pop(), 10);
        if (!isNaN(last)) next = last + 1;
      }
      res.json({ success: true, nextWorkOrderNo: `${prefix}${String(next).padStart(4, "0")}` });
    } catch (err) {
      console.error("❌ Error getting next work order number:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---- GET /api/work-orders/:id -----------------------------------------
  app.get("/api/work-orders/:id", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { id } = req.params;

      const result = await client.query(
        `
        SELECT
          wo.*,
          ${COLORS_SUBQUERY},
          ${PRODUCED_SUBQUERY},
          mc.code as master_code,
          mc.photo_filename as master_code_photo_filename,
          json_agg(
            json_build_object(
              'id', la.id, 'line_no', la.line_no, 'assigned_date', la.assigned_date,
              'assigned_quantity', la.assigned_quantity, 'status', la.status,
              'planned_start_date', la.planned_start_date, 'planned_end_date', la.planned_end_date
            )
          ) FILTER (WHERE la.id IS NOT NULL) as assignments
        FROM work_orders wo
        LEFT JOIN line_assignments la ON wo.id = la.work_order_id
        LEFT JOIN master_codes mc ON mc.id = wo.master_code_id
        WHERE wo.id = $1
        GROUP BY wo.id, mc.code, mc.photo_filename
        `,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Work order not found" });
      }

      const workOrder = result.rows[0];
      workOrder.master_code_photo_url = workOrder.master_code_photo_filename
        ? generatePresignedGetUrl(workOrder.master_code_photo_filename, 3600)
        : null;
      delete workOrder.master_code_photo_filename;

      res.json({ success: true, workOrder });
    } catch (err) {
      console.error("❌ Error fetching work order:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---- POST /api/work-orders --------------------------------------------
  app.post("/api/work-orders", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);

      const {
        workOrderNo, warehouseStock, extraQuantity, totalToProduce, totalQuantity,
        commitmentDate, customerId, styleDescription, styleCode, estilo, color,
        fabricSupplier, fabrics, lineNo, runDate, masterCodeId, samMinutes,
        colors,
      } = req.body;

      const colorRows = Array.isArray(colors)
        ? colors
            .map((c) => ({ color: String(c.color || "").trim().toUpperCase(), quantity: parseFloat(c.quantity) }))
            .filter((c) => c.color && !isNaN(c.quantity) && c.quantity > 0)
        : [];

      const orderedQty = colorRows.reduce((s, c) => s + c.quantity, 0);
      const resolvedQuantity =
        orderedQty > 0 ? orderedQty : parseFloat(totalQuantity) || parseFloat(totalToProduce);

      const wStock = parseFloat(warehouseStock) || 0;
      const xtra = parseFloat(extraQuantity) || 0;
      const resolvedTotalToProduce =
        totalToProduce != null && totalToProduce !== ""
          ? parseFloat(totalToProduce)
          : Math.max(resolvedQuantity - wStock + xtra, 0);

      if (!workOrderNo || !customerId || !styleDescription) {
        return res.status(400).json({ success: false, error: "Missing required fields: workOrderNo, customerId, styleDescription" });
      }
      if (colorRows.length === 0 && !resolvedQuantity) {
        return res.status(400).json({ success: false, error: "Provide at least one color with a quantity (or a total quantity)." });
      }

      await client.query("BEGIN");

      const existingCheck = await client.query("SELECT id FROM work_orders WHERE work_order_no = $1", [workOrderNo]);
      if (existingCheck.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, error: "Work order number already exists" });
      }

      const customerResult = await client.query("SELECT name FROM customers WHERE id = $1", [parseInt(customerId)]);
      if (customerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, error: "Customer not found" });
      }
      const customerName = customerResult.rows[0].name;

      let resolvedSamMinutes = samMinutes ? parseFloat(samMinutes) : null;
      if (masterCodeId && resolvedSamMinutes === null) {
        const mc = await client.query("SELECT sam_minutes FROM master_codes WHERE id = $1", [parseInt(masterCodeId)]);
        if (mc.rows.length > 0) resolvedSamMinutes = parseFloat(mc.rows[0].sam_minutes);
      }

      const colorSummary = colorRows.length > 0 ? colorRows.map((c) => c.color).join(", ") : color || null;

      const result = await client.query(
        `
        INSERT INTO work_orders (
          work_order_no, quantity, customer_id, customer_name, style_description,
          color, fabric_supplier, style_code, estilo, fabrics, line_no, run_date,
          warehouse_stock, extra_quantity, total_to_produce, commitment_date,
          master_code_id, sam_minutes, created_at, updated_at, status
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),NOW(),'pending')
        RETURNING *
        `,
        [
          workOrderNo, resolvedQuantity, parseInt(customerId), customerName, styleDescription,
          colorSummary, fabricSupplier || (Array.isArray(fabrics) ? fabrics[0] : null) || null,
          styleCode || null, estilo || null, Array.isArray(fabrics) ? fabrics : [], lineNo || null,
          runDate || null, wStock, xtra, resolvedTotalToProduce, commitmentDate || null,
          masterCodeId ? parseInt(masterCodeId) : null, resolvedSamMinutes,
        ]
      );

      const workOrder = result.rows[0];

      for (const c of colorRows) {
        await client.query(
          `INSERT INTO work_order_colors (work_order_id, color, quantity) VALUES ($1, $2, $3)`,
          [workOrder.id, c.color, c.quantity]
        );
      }

      await client.query("COMMIT");

      workOrder.colors = colorRows;
      if (workOrder.master_code_id) {
        const mcResult = await client.query("SELECT photo_filename FROM master_codes WHERE id = $1", [workOrder.master_code_id]);
        workOrder.master_code_photo_url = mcResult.rows[0]?.photo_filename
          ? generatePresignedGetUrl(mcResult.rows[0].photo_filename, 3600)
          : null;
      }

      res.json({ success: true, message: "Work order created successfully", workOrder });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("❌ Error creating work order:", err.message);
      if (err.code === "23505") {
        return res.status(400).json({ success: false, error: "Work order number already exists" });
      }
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // =====================================================================
  //  PRODUCTION-ORDER ROUTES (wizard: master codes + PO, size×color grid)
  // =====================================================================

  // ---- next PO number: SKM#### sequence ---------------------------------
  app.get("/api/production-orders/next-number", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const result = await client.query(
        `SELECT COALESCE(MAX((substring(work_order_no from '^SKM([0-9]+)'))::int), 0) AS maxseq
         FROM work_orders WHERE work_order_no LIKE 'SKM%'`
      );
      const next = (result.rows[0]?.maxseq || 0) + 1;
      res.json({ success: true, sequence: `SKM${String(next).padStart(4, "0")}` });
    } catch (err) {
      console.error("❌ Error getting next PO number:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---- combined create: master codes + one or more POs ----------------
  // Accepts EITHER:
  //   • { ...style, lines, commitmentDate, workOrderNo? }       → 1 PO (legacy)
  //   • { ...style, orders: [{ lines, commitmentDate }, ...] }  → N POs
  // The wizard groups color rows by (color+estilo): distinct rows go into one
  // PO; each REPEATED (color+estilo) row is sent as its own entry in `orders`
  // and becomes its own auto-numbered PO. Same customer for all.
  app.post("/api/production-orders", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    let photoUrl = null;
    let photoKey = null;
    try {
      await setSchema(client);

      const {
        tipo, modelo, correlativo,
        clienteCode, customerId, estilo,
        description, sam,
        photoKey: incomingPhotoKey,   // browser uploaded the image straight to S3 (presigned PUT)
        lines, orders, workOrderNo,
        commitmentDate, season, fabrics, warehouseStock, extraQuantity, customerPo,
        // PO-header fabric/yield (legacy single-PO payload; per-order values
        // inside `orders` win when present).
        fabricName: bodyFabricName, fabricCode: bodyFabricCode, yield: bodyYield,
      } = req.body;

      const T = up(tipo, 3), M = up(modelo, 3), C = up(correlativo, 2);
      const CLI = up(clienteCode, 3), EST = up(estilo, 6); // fallback default only
      const styleCode = `${T}${M}${C}`;
      const multi = Array.isArray(orders) && orders.length > 0;

      const txt = (v) => (v == null ? null : String(v).trim() || null);
      const num = (v) =>
        v === "" || v == null || isNaN(parseFloat(v)) ? null : parseFloat(v);

      // Each line carries its own customer PO, delivery date, fabric, fabric
      // code and yield (entered per color+estilo row in step 2). The order-level
      // values are used as a fallback for lines that leave them blank.
      const parseCells = (arr, fb = {}) =>
        (Array.isArray(arr) ? arr : [])
          .map((l) => {
            // Each line may carry several telas, each with its own code and yield.
            const fabrics = buildLineFabrics(l, fb);
            const primary = fabrics[0] || {};
            return {
              talla: up(l.talla, 3),
              color: up(l.color, 3),
              estilo: up(l.estilo, 6) || EST,
              customerPo: txt(l.customerPo),
              commitmentDate: (l.commitmentDate || fb.commitmentDate || "").toString().slice(0, 10) || null,
              fabrics,
              // Representative (first-tela) scalars for the header/list views.
              fabricName: primary.name || fb.fabricName || null,
              fabricCode: primary.code || fb.fabricCode || null,
              yieldPerPiece: primary.yield ?? fb.yieldPerPiece ?? null,
              quantity: parseFloat(l.quantity),
            };
          })
          .filter((l) => l.talla && l.color && !isNaN(l.quantity) && l.quantity > 0);

      // Normalise into a list of PO specs.
      const rawOrders = multi
        ? orders
        : [{ lines, commitmentDate, fabricName: bodyFabricName, fabricCode: bodyFabricCode, yield: bodyYield }];
      const orderSpecs = rawOrders
        .map((o) => {
          const fb = {
            commitmentDate: (o.commitmentDate || commitmentDate || "").toString().slice(0, 10) || null,
            fabricName: txt(o.fabricName ?? bodyFabricName),
            fabricCode: txt(o.fabricCode ?? bodyFabricCode),
            yieldPerPiece: num(o.yield ?? bodyYield),
          };
          return { cells: parseCells(o.lines, fb), ...fb };
        })
        .filter((o) => o.cells.length > 0);

      if (!T || !M || !C || !CLI || !description || !sam) {
        return res.status(400).json({ success: false, error: "Missing style fields: tipo, modelo, correlativo, clienteCode, description, sam" });
      }
      if (!customerId) return res.status(400).json({ success: false, error: "customerId is required" });
      if (orderSpecs.length === 0) return res.status(400).json({ success: false, error: "Enter at least one size/color quantity" });

      // Every cell needs a 6-char estilo (per-color estilo cliente).
      for (const o of orderSpecs) {
        const bad = o.cells.find((c) => !c.estilo || c.estilo.length !== 6);
        if (bad) return res.status(400).json({ success: false, error: `Falta el estilo cliente (6 caracteres) para el color ${bad.color || "?"}` });
      }

      await client.query("BEGIN");

      const cust = await client.query("SELECT name FROM customers WHERE id = $1", [parseInt(customerId)]);
      if (cust.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, error: "Customer not found" });
      }
      const customerName = cust.rows[0].name;

      // Photo was uploaded straight to S3 by the browser (presigned PUT); the
      // request carries only its key. Shared across every PO in this submission.
      if (incomingPhotoKey) {
        photoKey = incomingPhotoKey;
        photoUrl = generatePresignedGetUrl(photoKey, 3600);
      }

      const samNum = parseFloat(sam) || 0;

      // For multi-PO submissions we assign sequential SKM#### numbers ourselves.
      let seq = 0;
      if (multi) {
        const maxRes = await client.query(
          `SELECT COALESCE(MAX((substring(work_order_no from '^SKM([0-9]+)'))::int), 0) AS maxseq
             FROM work_orders WHERE work_order_no LIKE 'SKM%'`
        );
        seq = parseInt(maxRes.rows[0].maxseq, 10);
      }

      const codeToId = {};           // code -> master_code id (shared across POs)
      let created = 0, reused = 0;
      const createdOrders = [];

      for (let i = 0; i < orderSpecs.length; i++) {
        const { cells, commitmentDate: specDate, fabricName: specFabricName,
                fabricCode: specFabricCode, yieldPerPiece: specYield } = orderSpecs[i];
        // A PO may carry several customer POs (one per line). Store a distinct,
        // comma-joined summary on the header for display/search; the authoritative
        // per-line values live in work_order_lines.customer_po.
        const cPo = [...new Set(cells.map((c) => c.customerPo).filter(Boolean))].join(", ") || null;
        // Delivery date, fabric, code and yield are per line. The header keeps a
        // representative copy — the first line that has a value — so the PO list
        // can show them without joining work_order_lines. fabrics[] collects the
        // distinct fabric names across this PO's lines.
        const firstOf = (k) => cells.find((c) => c[k] != null && c[k] !== "")?.[k] ?? null;
        const headerDate = firstOf("commitmentDate") || specDate || null;
        const hFabricName = firstOf("fabricName") || specFabricName || null;
        const hFabricCode = firstOf("fabricCode") || specFabricCode || null;
        const hYield = firstOf("yieldPerPiece") ?? specYield ?? null;
        const fabricNamesArr = [...new Set(
          cells.flatMap((c) => (c.fabrics || []).map((f) => f.name)).filter(Boolean)
        )];
        const fabricSupplier = hFabricName || fabricNamesArr[0] || null;

        // Upsert the master codes this PO needs (deduped across the whole request).
        for (const cell of cells) {
          const code = `${T}${M}${C}${cell.talla}${CLI}-${cell.color}-${cell.estilo}`;
          if (codeToId[code] === undefined) {
            const r = await client.query(
              `INSERT INTO master_codes
                 (code,type,modelo,correlativo,talla,cliente,color,estilo,description,sam_minutes,photo_url,photo_filename,created_by,created_at,updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
               ON CONFLICT (code) DO UPDATE SET updated_at = NOW()
               RETURNING id, (xmax = 0) AS inserted`,
              [code, T, M, C, cell.talla, CLI, cell.color, cell.estilo, description, samNum, photoUrl, photoKey, req.user.id]
            );
            codeToId[code] = r.rows[0].id;
            if (r.rows[0].inserted) created++; else reused++;
          }
        }

        // PO number: auto sequence for multi; provided number for the legacy case.
        let woNo;
        if (multi) {
          seq += 1;
          woNo = `SKM${String(seq).padStart(4, "0")}-${CLI}-${styleCode}`;
        } else {
          woNo = workOrderNo;
          if (!woNo) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, error: "workOrderNo is required" }); }
        }

        const dup = await client.query("SELECT id FROM work_orders WHERE work_order_no = $1", [woNo]);
        if (dup.rows.length > 0) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, error: `PO number already exists: ${woNo}` }); }

        const orderedQty = cells.reduce((s, c) => s + c.quantity, 0);
        // Warehouse stock / extras apply to the first PO only.
        const wStock = i === 0 ? (parseFloat(warehouseStock) || 0) : 0;
        const xtra = i === 0 ? (parseFloat(extraQuantity) || 0) : 0;
        const totalToProduce = Math.max(orderedQty - wStock + xtra, 0);
        const colorSummary = [...new Set(cells.map((c) => c.color))].join(", ");
        const estiloSummary = [...new Set(cells.map((c) => c.estilo))].join(", ");
        const primaryEstilo = cells[0].estilo;
        const firstCode = `${T}${M}${C}${cells[0].talla}${CLI}-${cells[0].color}-${cells[0].estilo}`;
        const primaryMasterCodeId = codeToId[firstCode];

        const woResult = await client.query(
          `INSERT INTO work_orders (
              work_order_no, quantity, customer_id, customer_name, style_description,
              color, fabric_supplier, style_code, estilo, fabrics, warehouse_stock,
              extra_quantity, total_to_produce, commitment_date, master_code_id,
              sam_minutes, season, customer_po, fabric_name, fabric_code,
              yield_per_piece, created_at, updated_at, status
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW(),NOW(),'pending')
           RETURNING *`,
          [
            woNo, orderedQty, parseInt(customerId), customerName, description,
            colorSummary, fabricSupplier, styleCode, primaryEstilo,
            fabricNamesArr.length ? fabricNamesArr : (Array.isArray(fabrics) ? fabrics : []),
            wStock, xtra, totalToProduce,
            headerDate, primaryMasterCodeId, samNum, season || null, cPo || null,
            hFabricName, hFabricCode, hYield,
          ]
        );
        const workOrder = woResult.rows[0];

        for (const cell of cells) {
          const code = `${T}${M}${C}${cell.talla}${CLI}-${cell.color}-${cell.estilo}`;
          await client.query(
            `INSERT INTO work_order_lines
               (work_order_id, master_code_id, talla, color, estilo, customer_po,
                commitment_date, fabric_name, fabric_code, yield_per_piece, quantity, fabrics)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [workOrder.id, codeToId[code], cell.talla, cell.color, cell.estilo,
             cell.customerPo || null, cell.commitmentDate || null, cell.fabricName || null,
             cell.fabricCode || null, cell.yieldPerPiece, cell.quantity,
             JSON.stringify(cell.fabrics || [])]
          );
        }

        workOrder.lines = cells;
        workOrder.estilos = estiloSummary;
        if (photoKey) workOrder.master_code_photo_url = generatePresignedGetUrl(photoKey, 3600);
        createdOrders.push(workOrder);
      }

      await client.query("COMMIT");

      res.json({
        success: true,
        message: createdOrders.length > 1 ? `${createdOrders.length} production orders created` : "Production order created",
        workOrder: createdOrders[0],      // backward-compat: first PO
        workOrders: createdOrders,        // all POs created in this request
        masterCodes: { created, reused, total: Object.keys(codeToId).length },
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("❌ Error creating production order:", err.message);
      if (err.code === "23505") return res.status(400).json({ success: false, error: "PO number already exists" });
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---- full update: header + size/color breakdown -----------------------
  // PUT /api/production-orders/:id
  //
  // Unlike PUT /api/work-orders/:id (header columns only), this rewrites
  // work_order_lines, so the edit modal can change colors, estilos, tallas,
  // quantities, PO cliente, delivery date, fabric, code and yield. Body:
  //   { customerId?, styleDescription?, status?, season?, samMinutes?,
  //     warehouseStock?, extraQuantity?, totalToProduce?, customerPo?,
  //     commitmentDate?, fabricName?, fabricCode?, yield?,
  //     lines?: [{ talla, color, estilo, customerPo, commitmentDate,
  //                fabricName, fabricCode, yield, quantity }] }
  // Omit `lines` to leave the breakdown untouched. When `lines` IS sent it
  // replaces the whole set, and quantity / color / estilo / master_code_id /
  // total_to_produce plus the header fabric+date copies are recomputed.
  app.put("/api/production-orders/:id", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { id } = req.params;
      const {
        customerId, styleDescription, status, season, samMinutes,
        warehouseStock, extraQuantity, totalToProduce,
        customerPo, commitmentDate, fabricName, fabricCode, yield: yieldPerPiece,
        lines,
      } = req.body;

      const txt = (v) => (v == null ? null : String(v).trim() || null);
      const num = (v) =>
        v === "" || v == null || isNaN(parseFloat(v)) ? null : parseFloat(v);

      if (status !== undefined && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
      }

      await client.query("BEGIN");

      const cur = await client.query("SELECT * FROM work_orders WHERE id = $1 FOR UPDATE", [id]);
      if (cur.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, error: "Work order not found" });
      }
      const wo = cur.rows[0];

      const set = {};   // column -> value

      // -------- header fields the caller sent explicitly -------------------
      if (customerId !== undefined) {
        const c = await client.query("SELECT name FROM customers WHERE id = $1", [parseInt(customerId)]);
        if (c.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, error: "Customer not found" });
        }
        set.customer_id = parseInt(customerId);
        set.customer_name = c.rows[0].name;
      }
      if (styleDescription !== undefined) set.style_description = txt(styleDescription) || wo.style_description;
      if (status !== undefined) set.status = status;
      if (season !== undefined) set.season = txt(season);
      if (samMinutes !== undefined) set.sam_minutes = num(samMinutes);

      const wStock = warehouseStock !== undefined ? (parseFloat(warehouseStock) || 0) : parseFloat(wo.warehouse_stock) || 0;
      const xtra = extraQuantity !== undefined ? (parseFloat(extraQuantity) || 0) : parseFloat(wo.extra_quantity) || 0;
      if (warehouseStock !== undefined) set.warehouse_stock = wStock;
      if (extraQuantity !== undefined) set.extra_quantity = xtra;

      // -------- breakdown ---------------------------------------------------
      if (Array.isArray(lines)) {
        // Each line may carry several telas, each with its own code and yield.
        // The scalars below stay as the representative (first-tela) header copy.
        const cells = lines
          .map((l) => {
            const fabrics = buildLineFabrics(l);
            const primary = fabrics[0] || {};
            return {
              talla: up(l.talla, 3),
              color: up(l.color, 3),
              estilo: up(l.estilo, 6),
              customerPo: txt(l.customerPo),
              commitmentDate: (l.commitmentDate || "").toString().slice(0, 10) || null,
              fabrics,
              fabricName: primary.name || null,
              fabricCode: primary.code || null,
              yieldPerPiece: primary.yield ?? null,
              quantity: parseFloat(l.quantity),
            };
          })
          .filter((l) => l.talla && l.color && !isNaN(l.quantity) && l.quantity > 0);

        if (cells.length === 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, error: "Enter at least one size/color quantity" });
        }
        const badEstilo = cells.find((c) => !c.estilo || c.estilo.length !== 6);
        if (badEstilo) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, error: `Falta el estilo cliente (6 caracteres) para el color ${badEstilo.color || "?"}` });
        }
        // One PO cannot hold the same talla+color+estilo twice (unique index).
        const dupKey = new Set();
        for (const c of cells) {
          const k = `${c.talla}|${c.color}|${c.estilo}`;
          if (dupKey.has(k)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, error: `Línea repetida: ${c.color} · ${c.estilo} · talla ${c.talla}. Un color+estilo repetido necesita su propia orden.` });
          }
          dupKey.add(k);
        }

        // Master codes for the (possibly new) combinations. The style prefix is
        // fixed for this PO; the 3-letter customer code comes from an existing
        // master code, falling back to customers.code.
        const styleCode = wo.style_code || "";
        let CLI = null;
        let photoUrl = null, photoKey = null;   // reuse the style photo for new codes
        if (wo.master_code_id) {
          const mc = await client.query(
            "SELECT cliente, photo_url, photo_filename FROM master_codes WHERE id = $1",
            [wo.master_code_id]
          );
          CLI = mc.rows[0]?.cliente || null;
          photoUrl = mc.rows[0]?.photo_url || null;
          photoKey = mc.rows[0]?.photo_filename || null;
        }
        if (!CLI) {
          const cid = set.customer_id ?? wo.customer_id;
          const cc = await client.query("SELECT code FROM customers WHERE id = $1", [cid]);
          CLI = up(cc.rows[0]?.code, 3) || null;
        }
        if (!styleCode || !CLI) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, error: "No se pudo resolver el código de estilo o el código de cliente de esta orden" });
        }

        const T = styleCode.slice(0, 3), M = styleCode.slice(3, 6), C = styleCode.slice(6, 8);
        const description = set.style_description ?? wo.style_description;
        const samNum = set.sam_minutes ?? (parseFloat(wo.sam_minutes) || 0);
        const codeToId = {};
        for (const cell of cells) {
          const code = `${styleCode}${cell.talla}${CLI}-${cell.color}-${cell.estilo}`;
          if (codeToId[code] === undefined) {
            const r = await client.query(
              `INSERT INTO master_codes
                 (code,type,modelo,correlativo,talla,cliente,color,estilo,description,sam_minutes,photo_url,photo_filename,created_by,created_at,updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
               ON CONFLICT (code) DO UPDATE SET updated_at = NOW()
               RETURNING id`,
              [code, T, M, C, cell.talla, CLI, cell.color, cell.estilo, description, samNum, photoUrl, photoKey, req.user.id]
            );
            codeToId[code] = r.rows[0].id;
          }
        }

        // Replace the whole breakdown.
        await client.query("DELETE FROM work_order_lines WHERE work_order_id = $1", [id]);
        for (const cell of cells) {
          const code = `${styleCode}${cell.talla}${CLI}-${cell.color}-${cell.estilo}`;
          await client.query(
            `INSERT INTO work_order_lines
               (work_order_id, master_code_id, talla, color, estilo, customer_po,
                commitment_date, fabric_name, fabric_code, yield_per_piece, quantity, fabrics)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [id, codeToId[code], cell.talla, cell.color, cell.estilo,
             cell.customerPo, cell.commitmentDate, cell.fabricName,
             cell.fabricCode, cell.yieldPerPiece, cell.quantity,
             JSON.stringify(cell.fabrics || [])]
          );
        }

        // Recompute everything the breakdown owns.
        const orderedQty = cells.reduce((s, c) => s + c.quantity, 0);
        const firstOf = (k) => cells.find((c) => c[k] != null && c[k] !== "")?.[k] ?? null;
        set.quantity = orderedQty;
        set.color = [...new Set(cells.map((c) => c.color))].join(", ");
        set.estilo = cells[0].estilo;
        set.master_code_id = codeToId[`${styleCode}${cells[0].talla}${CLI}-${cells[0].color}-${cells[0].estilo}`];
        set.total_to_produce = Math.max(orderedQty - wStock + xtra, 0);
        set.customer_po = [...new Set(cells.map((c) => c.customerPo).filter(Boolean))].join(", ") || null;
        set.commitment_date = firstOf("commitmentDate");
        set.fabric_name = firstOf("fabricName");
        set.fabric_code = firstOf("fabricCode");
        set.yield_per_piece = firstOf("yieldPerPiece");
        set.fabrics = [...new Set(
          cells.flatMap((c) => (c.fabrics || []).map((f) => f.name)).filter(Boolean)
        )];
        set.fabric_supplier = set.fabric_name;
      }

      // Explicit header values win over the ones derived from the lines.
      if (customerPo !== undefined) set.customer_po = txt(customerPo);
      if (commitmentDate !== undefined) set.commitment_date = commitmentDate || null;
      if (fabricName !== undefined) {
        set.fabric_name = txt(fabricName);
        set.fabric_supplier = txt(fabricName);
      }
      if (fabricCode !== undefined) set.fabric_code = txt(fabricCode);
      if (yieldPerPiece !== undefined) set.yield_per_piece = num(yieldPerPiece);
      if (totalToProduce !== undefined && totalToProduce !== "") set.total_to_produce = parseFloat(totalToProduce) || 0;
      else if (!Array.isArray(lines) && (warehouseStock !== undefined || extraQuantity !== undefined)) {
        set.total_to_produce = Math.max((parseFloat(wo.quantity) || 0) - wStock + xtra, 0);
      }

      const cols = Object.keys(set);
      if (cols.length === 0 && !Array.isArray(lines)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, error: "No fields to update" });
      }

      let workOrder = wo;
      if (cols.length > 0) {
        const assigns = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
        const upd = await client.query(
          `UPDATE work_orders SET ${assigns}, updated_at = NOW() WHERE id = $${cols.length + 1} RETURNING *`,
          [...cols.map((c) => set[c]), id]
        );
        workOrder = upd.rows[0];
      }

      await client.query("COMMIT");

      // Return the saved row with its fresh breakdown.
      const back = await client.query(
        `SELECT wo.*, to_char(wo.commitment_date, 'YYYY-MM-DD') AS commitment_date,
                ${LINES_SUBQUERY}, mc.photo_filename AS master_code_photo_filename
           FROM work_orders wo
           LEFT JOIN master_codes mc ON mc.id = wo.master_code_id
          WHERE wo.id = $1`,
        [id]
      );
      const row = back.rows[0] || workOrder;
      if (row.master_code_photo_filename) {
        row.master_code_photo_url = generatePresignedGetUrl(row.master_code_photo_filename, 3600);
        delete row.master_code_photo_filename;
      }

      res.json({ success: true, message: "Production order updated", workOrder: row });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("❌ Error updating production order:", err.message);
      if (err.code === "23505") return res.status(400).json({ success: false, error: "Línea duplicada para esta orden (talla+color+estilo)" });
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });
}


// Produced (producido) total for a single work order, using the same packing-
// operation subquery the planner uses. Order-level only — production is not
// captured per talla/color. Other modules (e.g. finished-warehouse) reuse this
// so the logic lives in exactly one place.
async function producedQuantityFor(client, workOrderId) {
  const { rows } = await client.query(
    `SELECT ${PRODUCED_SUBQUERY} FROM work_orders wo WHERE wo.id = $1`,
    [workOrderId]
  );
  return Number(rows[0]?.produced_quantity) || 0;
}

registerWorkOrders.initSchema = initSchema;
registerWorkOrders.producedQuantityFor = producedQuantityFor;
module.exports = registerWorkOrders;