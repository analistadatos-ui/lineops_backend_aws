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
        quantity NUMERIC(12,2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_wo_line_qty_positive CHECK (quantity > 0)
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_work_order_lines_wo ON work_order_lines(work_order_id);");
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_work_order_lines_unique ON work_order_lines(work_order_id, talla, color);");
    console.log("✅ work_order_lines table ready in prod_db_schema");
  } finally {
    client.release();
  }
}

// The per-color breakdown as a JSON array, reused by both GET routes.
const COLORS_SUBQUERY = `
  COALESCE((
    SELECT json_agg(json_build_object('color', c.color, 'quantity', c.quantity) ORDER BY c.color)
    FROM work_order_colors c WHERE c.work_order_id = wo.id
  ), '[]') AS colors
`;

const up = (v, n) => String(v || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, n);

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
function registerWorkOrders(
  app,
  { authenticateToken, pool, setSchema, generatePresignedGetUrl, uploadBufferToS3, makeStylePhotoKey }
) {
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
          wo.style_code, wo.estilo, wo.line_no, wo.run_date, wo.warehouse_stock,
          wo.extra_quantity, wo.total_to_produce, wo.commitment_date,
          wo.master_code_id, wo.sam_minutes, wo.created_at, wo.updated_at, wo.status,
          ${COLORS_SUBQUERY},
          MAX(mc.photo_filename) as master_code_photo_filename,
          COALESCE(SUM(la.assigned_quantity) FILTER (WHERE la.status NOT IN ('cancelled', 'rejected')), 0) as assigned_quantity
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

  // ---- combined create: master codes + PO -------------------------------
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
        photoKey: incomingPhotoKey,   // browser already uploaded to S3 via presigned PUT
        lines,
        workOrderNo,
        commitmentDate, fabrics, warehouseStock, extraQuantity,
      } = req.body;

      const T = up(tipo, 3), M = up(modelo, 3), C = up(correlativo, 2);
      const CLI = up(clienteCode, 3), EST = up(estilo, 6);

      const cells = Array.isArray(lines)
        ? lines
            .map((l) => ({ talla: up(l.talla, 3), color: up(l.color, 3), quantity: parseFloat(l.quantity) }))
            .filter((l) => l.talla && l.color && !isNaN(l.quantity) && l.quantity > 0)
        : [];

      if (!T || !M || !C || !CLI || !EST || !description || !sam) {
        return res.status(400).json({ success: false, error: "Missing style fields: tipo, modelo, correlativo, clienteCode, estilo, description, sam" });
      }
      if (!customerId) return res.status(400).json({ success: false, error: "customerId is required" });
      if (cells.length === 0) return res.status(400).json({ success: false, error: "Enter at least one size/color quantity" });
      if (!workOrderNo) return res.status(400).json({ success: false, error: "workOrderNo is required" });

      await client.query("BEGIN");

      const dup = await client.query("SELECT id FROM work_orders WHERE work_order_no = $1", [workOrderNo]);
      if (dup.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, error: "PO number already exists" });
      }

      const cust = await client.query("SELECT name FROM customers WHERE id = $1", [parseInt(customerId)]);
      if (cust.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, error: "Customer not found" });
      }
      const customerName = cust.rows[0].name;

      // The browser already uploaded the file straight to S3 via a presigned
      // PUT (POST /api/master-codes/photo-upload-url), so we only receive the key.
      if (incomingPhotoKey) {
        photoKey = incomingPhotoKey;
        photoUrl = generatePresignedGetUrl(photoKey, 3600);
      }

      const samNum = parseFloat(sam) || 0;

      let created = 0, reused = 0;
      const codeToId = {};
      for (const cell of cells) {
        const code = `${T}${M}${C}${cell.talla}${CLI}-${cell.color}-${EST}`;
        const r = await client.query(
          `INSERT INTO master_codes
             (code,type,modelo,correlativo,talla,cliente,color,estilo,description,sam_minutes,photo_url,photo_filename,created_by,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
           ON CONFLICT (code) DO UPDATE SET updated_at = NOW()
           RETURNING id, (xmax = 0) AS inserted`,
          [code, T, M, C, cell.talla, CLI, cell.color, EST, description, samNum, photoUrl, photoKey, req.user.id]
        );
        codeToId[`${cell.talla}|${cell.color}`] = r.rows[0].id;
        if (r.rows[0].inserted) created++; else reused++;
      }

      const orderedQty = cells.reduce((s, c) => s + c.quantity, 0);
      const wStock = parseFloat(warehouseStock) || 0;
      const xtra = parseFloat(extraQuantity) || 0;
      const totalToProduce = Math.max(orderedQty - wStock + xtra, 0);
      const colorSummary = [...new Set(cells.map((c) => c.color))].join(", ");
      const styleCode = `${T}${M}${C}`;
      const primaryMasterCodeId = codeToId[`${cells[0].talla}|${cells[0].color}`];

      const woResult = await client.query(
        `INSERT INTO work_orders (
            work_order_no, quantity, customer_id, customer_name, style_description,
            color, fabric_supplier, style_code, estilo, fabrics, warehouse_stock,
            extra_quantity, total_to_produce, commitment_date, master_code_id,
            sam_minutes, created_at, updated_at, status
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW(),'pending')
         RETURNING *`,
        [
          workOrderNo, orderedQty, parseInt(customerId), customerName, description,
          colorSummary, (Array.isArray(fabrics) ? fabrics[0] : null) || null, styleCode, EST,
          Array.isArray(fabrics) ? fabrics : [], wStock, xtra, totalToProduce,
          commitmentDate || null, primaryMasterCodeId, samNum,
        ]
      );
      const workOrder = woResult.rows[0];

      for (const cell of cells) {
        await client.query(
          `INSERT INTO work_order_lines (work_order_id, master_code_id, talla, color, quantity)
           VALUES ($1,$2,$3,$4,$5)`,
          [workOrder.id, codeToId[`${cell.talla}|${cell.color}`], cell.talla, cell.color, cell.quantity]
        );
      }

      await client.query("COMMIT");

      workOrder.lines = cells;
      if (photoKey) workOrder.master_code_photo_url = generatePresignedGetUrl(photoKey, 3600);

      res.json({
        success: true,
        message: "Production order created",
        workOrder,
        masterCodes: { created, reused, total: cells.length },
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("❌ Error creating production order:", err.message);
      if (err.code === "23505") {
        return res.status(400).json({ success: false, error: "PO number already exists" });
      }
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });
}

registerWorkOrders.initSchema = initSchema;
module.exports = registerWorkOrders;