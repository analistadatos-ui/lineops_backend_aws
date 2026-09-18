// ==========================================================================
// style-orders.js  (Style Order + tech-pack auto-fill)
//
// A "style order" is the full pre-production package for a style: header,
// fabrics, trim materials, size spec, workmanship, SAM, colorways, garment vs
// packing trims, and the sew package (SKU → destino / destino de gancho). It
// can be built from scratch in the wizard OR auto-filled by uploading the
// tech-pack PDF (加工指導書). Sending it to the sample room writes a sample
// request row that the muestras team picks up.
//
// Same register-module shape as bom.js / merchant-plan.js.
//
// --------------------------------------------------------------------------
// SETUP  (server1.js)
//   1. const registerStyleOrders = require("./style-orders");
//   2. await registerStyleOrders.initSchema({ pool, setSchema });   // after base schema
//   3. registerStyleOrders(app, { authenticateToken, pool, setSchema });
//
// Dependencies (add to package.json):
//   npm i multer pdfjs-dist
//
// Endpoints
//   POST   /api/style-orders/parse-techpack   (multipart "file") -> { order }  (NOT saved)
//   GET    /api/style-orders                                     -> { orders:[headers] }
//   GET    /api/style-orders/:id                                 -> { order }
//   POST   /api/style-orders                                     -> create  { id }
//   PUT    /api/style-orders/:id                                 -> replace { id }
//   DELETE /api/style-orders/:id                                 -> { deleted }
//   POST   /api/style-orders/:id/send-to-sample                  -> { sampleRequestId }
//
// The 7 sections are stored as one JSONB `data` blob (they're always read and
// written together by the wizard), with a few header columns promoted to
// columns so the list view and filters stay cheap — same snapshot trick bom.js
// uses for style/customer.
// ==========================================================================

const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const { extractRows } = require("./techpack-extract");
const { parseTechPack } = require("./techpack-parser");
const { parseNikeBom } = require("./nikebom-parser");

// Sniff which tech-pack format was uploaded and run the matching parser.
function parseByFormat(pages) {
  const sample = pages.slice(0, 3).flatMap((p) => p.rows.map((r) => r.text)).join(" ");
  if (/BILL OF MATERIALS/i.test(sample) && /@\d{3}/.test(sample)) {
    return { format: "nike_bom", order: parseNikeBom(pages) };
  }
  return { format: "skm_processing_sheet", order: parseTechPack(pages) };
}

// ---- coercion helpers -----------------------------------------------------
const txt = (v, n) => (v == null ? null : String(v).trim().slice(0, n || 200) || null);
const idOr = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null; };
const STATUSES = ["draft", "sent_to_sample", "approved", "in_production", "archived"];
const status = (v) => { const s = String(v || "").trim().toLowerCase(); return STATUSES.includes(s) ? s : "draft"; };

// Pull the promoted header columns out of an incoming body (camelCase from React).
function headerCols(body) {
  const h = body?.header || {};
  return {
    master_code_id: idOr(body?.masterCodeId ?? body?.master_code_id),
    customer_id: idOr(body?.customerId ?? body?.customer_id),
    style_no: txt(h.styleNo, 50),
    order_no: txt(h.orderNo, 50),
    version: txt(h.version, 30),
    style_name: txt(h.styleName, 300),
    customer_name: txt(h.customer, 150),
    season: txt(h.season, 30),
    quantity: Number(String(h.quantity || "").replace(/[^\d.]/g, "")) || 0,
    delivery_date: /^\d{4}-\d{2}-\d{2}$/.test(h.deliveryDate) ? h.deliveryDate : null,
    status: status(body?.status),
  };
}

async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS style_orders(
        id             BIGSERIAL PRIMARY KEY,
        master_code_id BIGINT REFERENCES master_codes(id) ON DELETE SET NULL,
        customer_id    BIGINT REFERENCES customers(id) ON DELETE SET NULL,
        style_no       VARCHAR(50),
        order_no       VARCHAR(50),
        version        VARCHAR(30),
        style_name     VARCHAR(300),
        customer_name  VARCHAR(150),
        season         VARCHAR(30),
        quantity       INTEGER      NOT NULL DEFAULT 0,
        delivery_date  DATE,
        status         VARCHAR(24)  NOT NULL DEFAULT 'draft',
        data           JSONB        NOT NULL DEFAULT '{}'::jsonb,
        created_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
        updated_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
        CONSTRAINT chk_so_status CHECK (status IN ('draft','sent_to_sample','approved','in_production','archived'))
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_so_master ON style_orders(master_code_id);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_so_style ON style_orders(style_no);");
    console.log("\u2705 style_orders table ready in prod_db_schema");

    await client.query(`
      CREATE TABLE IF NOT EXISTS sample_requests(
        id              BIGSERIAL PRIMARY KEY,
        style_order_id  BIGINT REFERENCES style_orders(id) ON DELETE CASCADE,
        style_no        VARCHAR(50),
        order_no        VARCHAR(50),
        buyer           VARCHAR(150),
        season          VARCHAR(30),
        stage           VARCHAR(40),
        size            VARCHAR(16),
        qty             INTEGER NOT NULL DEFAULT 1,
        requester       VARCHAR(150),
        payload         JSONB   NOT NULL DEFAULT '{}'::jsonb,
        status          VARCHAR(24) NOT NULL DEFAULT 'requested',
        created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_sr_order ON sample_requests(style_order_id);");
    console.log("\u2705 sample_requests table ready in prod_db_schema");
  } finally {
    client.release();
  }
}

function registerStyleOrders(app, deps) {
  const { authenticateToken, pool, setSchema } = deps;

  const shapeHeader = (r) => ({
    id: Number(r.id),
    masterCodeId: r.master_code_id != null ? Number(r.master_code_id) : null,
    customerId: r.customer_id != null ? Number(r.customer_id) : null,
    styleNo: r.style_no,
    orderNo: r.order_no,
    version: r.version,
    styleName: r.style_name,
    customerName: r.customer_name,
    season: r.season,
    quantity: Number(r.quantity) || 0,
    deliveryDate: r.delivery_date,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  // ---- PARSE a tech-pack PDF -> structured order (not persisted) ----------
  app.post("/api/style-orders/parse-techpack", authenticateToken, upload.single("file"), async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ success: false, error: "Sube el PDF del tech pack en el campo 'file'." });
      }
      const pages = await extractRows(req.file.buffer);
      const { format, order } = parseByFormat(pages);
      res.json({ success: true, format, order });
    } catch (err) {
      console.error("\u274c parse-techpack:", err.message);
      res.status(500).json({ success: false, error: "No pude leer el PDF: " + err.message });
    }
  });

  // ---- LIST ---------------------------------------------------------------
  app.get("/api/style-orders", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const where = []; const params = [];
      const mc = idOr(req.query.masterCodeId);
      if (mc) { params.push(mc); where.push(`master_code_id = $${params.length}`); }
      if (req.query.status) { params.push(status(req.query.status)); where.push(`status = $${params.length}`); }
      const sql =
        `SELECT id, master_code_id, customer_id, style_no, order_no, version, style_name,
                customer_name, season, quantity, delivery_date, status, created_at, updated_at
           FROM style_orders` +
        (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
        ` ORDER BY updated_at DESC`;
      const { rows } = await client.query(sql, params);
      res.json({ success: true, orders: rows.map(shapeHeader) });
    } catch (err) {
      console.error("\u274c GET /api/style-orders:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
  });

  // ---- READ one (with full data) -----------------------------------------
  app.get("/api/style-orders/:id", authenticateToken, async (req, res) => {
    const id = idOr(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: "id inválido" });
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { rows } = await client.query("SELECT * FROM style_orders WHERE id=$1", [id]);
      if (!rows.length) return res.status(404).json({ success: false, error: "Orden no encontrada" });
      const r = rows[0];
      res.json({ success: true, order: { ...shapeHeader(r), ...r.data } });
    } catch (err) {
      console.error("\u274c GET /api/style-orders/:id:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
  });

  const SECTIONS = ["header", "fabrics", "trimMaterials", "spec", "workmanship", "sam", "colorways", "garmentTrims", "packingTrims", "skus", "packing"];
  const dataBlob = (body) => {
    const d = {};
    SECTIONS.forEach((k) => { if (body[k] !== undefined) d[k] = body[k]; });
    return d;
  };

  // ---- CREATE -------------------------------------------------------------
  app.post("/api/style-orders", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const h = headerCols(req.body || {});
      const data = dataBlob(req.body || {});
      const { rows } = await client.query(
        `INSERT INTO style_orders
           (master_code_id, customer_id, style_no, order_no, version, style_name,
            customer_name, season, quantity, delivery_date, status, data, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
         RETURNING id`,
        [h.master_code_id, h.customer_id, h.style_no, h.order_no, h.version, h.style_name,
         h.customer_name, h.season, h.quantity, h.delivery_date, h.status, data, req.user?.id ?? null]
      );
      res.json({ success: true, id: Number(rows[0].id) });
    } catch (err) {
      console.error("\u274c POST /api/style-orders:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
  });

  // ---- REPLACE ------------------------------------------------------------
  app.put("/api/style-orders/:id", authenticateToken, async (req, res) => {
    const id = idOr(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: "id inválido" });
    const client = await pool.connect();
    try {
      await setSchema(client);
      const h = headerCols(req.body || {});
      const data = dataBlob(req.body || {});
      const { rowCount } = await client.query(
        `UPDATE style_orders SET
           master_code_id=$2, customer_id=$3, style_no=$4, order_no=$5, version=$6, style_name=$7,
           customer_name=$8, season=$9, quantity=$10, delivery_date=$11, status=$12, data=$13,
           updated_by=$14, updated_at=now()
         WHERE id=$1`,
        [id, h.master_code_id, h.customer_id, h.style_no, h.order_no, h.version, h.style_name,
         h.customer_name, h.season, h.quantity, h.delivery_date, h.status, data, req.user?.id ?? null]
      );
      if (!rowCount) return res.status(404).json({ success: false, error: "Orden no encontrada" });
      res.json({ success: true, id });
    } catch (err) {
      console.error("\u274c PUT /api/style-orders/:id:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
  });

  // ---- DELETE -------------------------------------------------------------
  app.delete("/api/style-orders/:id", authenticateToken, async (req, res) => {
    const id = idOr(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: "id inválido" });
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { rowCount } = await client.query("DELETE FROM style_orders WHERE id=$1", [id]);
      res.json({ success: true, deleted: rowCount });
    } catch (err) {
      console.error("\u274c DELETE /api/style-orders/:id:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
  });

  // ---- SEND TO SAMPLE ROOM ------------------------------------------------
  app.post("/api/style-orders/:id/send-to-sample", authenticateToken, async (req, res) => {
    const id = idOr(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: "id inválido" });
    const s = req.body?.sample || {};
    if (!txt(s.requester, 150)) return res.status(400).json({ success: false, error: "Falta quién solicita la muestra (MR)." });
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { rows } = await client.query("SELECT * FROM style_orders WHERE id=$1", [id]);
      if (!rows.length) return res.status(404).json({ success: false, error: "Orden no encontrada" });
      const o = rows[0];
      const data = o.data || {};
      const payload = {
        buyer: o.customer_name,
        season: o.season,
        styleNo: o.style_no,
        orderNo: o.order_no,
        styleName: o.style_name,
        stage: txt(s.stage, 40),
        size: txt(s.size, 16),
        qty: Number(s.qty) || 1,
        costingMarker: !!s.costingMarker,
        sizeMarker: !!s.sizeMarker,
        clientPatterns: !!s.clientPatterns,
        remark: txt(s.remark, 500),
        shellFabric: (data.fabrics || []).map((f) => ({ fabric: f.code, cutWidth: f.width, position: f.position })),
        trims: [...(data.garmentTrims || []), ...(data.packingTrims || [])].map((t) => ({ item: t.code, description: t.desc, position: t.placement, qty: t.qty })),
      };
      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO sample_requests
           (style_order_id, style_no, order_no, buyer, season, stage, size, qty, requester, payload, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [id, o.style_no, o.order_no, o.customer_name, o.season, payload.stage, payload.size,
         payload.qty, txt(s.requester, 150), payload, req.user?.id ?? null]
      );
      await client.query("UPDATE style_orders SET status='sent_to_sample', updated_at=now() WHERE id=$1", [id]);
      await client.query("COMMIT");
      res.json({ success: true, sampleRequestId: Number(ins.rows[0].id), payload });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("\u274c send-to-sample:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
  });
}

registerStyleOrders.initSchema = initSchema;
module.exports = registerStyleOrders;