// ==========================================================================
// bom.js  (Bill of Materials)
//
// Persists a BILL OF MATERIALS per style/product: one header row tied to a
// master_code (the product) plus N material lines (tela, avíos, hilo, etiqueta,
// empaque…). Each line carries a per-garment consumption, merma %, unit and
// unit cost, so the board can compute cost-per-garment for the style.
//
// The header snapshots the style + customer as they were when the BOM was
// built (estilo, style_description, customer_name…), so the list stays readable
// for reporting even if the underlying master_code later changes — same trick
// merchant-plan.js uses.
//
// Register-module in the same shape as merchant-plan.js / work-orders.js: one
// require, one initSchema, one register call.
//
// --------------------------------------------------------------------------
// SETUP  (server1.js)
// --------------------------------------------------------------------------
// 1. Near your other requires (~line 881, next to registerMerchantPlan):
//        const registerBom = require("./bom");
//
// 2. In the async startup block, alongside the other initSchema calls
//    (~line 627). It references master_codes / customers / users, which the
//    base schema already creates, so any position after those is fine:
//        await registerBom.initSchema({ pool, setSchema });
//
// 3. Where the other modules register (~line 882):
//        registerBom(app, { authenticateToken, pool, setSchema });
//
//    Gated by authenticateToken only (mirrors merchant-plan.js). The BOM is
//    ORG-WIDE (not per-user): every merchant sees and edits the same catalog;
//    created_by / updated_by just record who last touched a row.
//
// Endpoints
//   GET    /api/bom                         -> { success, boms:[headers + totals] }
//   GET    /api/bom?masterCodeId=&customerId=   filter the list
//   GET    /api/bom/:id                      -> { success, bom:{...}, lines:[...] }
//   POST   /api/bom                          -> create/replace ONE bom (header+lines)
//   PUT    /api/bom/:id                      -> replace ONE bom (header+lines)
//   DELETE /api/bom/:id                      -> remove a bom (lines cascade)
//
// POST / PUT body (camelCase from the React page):
//   { masterCodeId, styleCode, estilo, styleDescription,
//     customerId, customerName,
//     name, version, currency, status, notes,
//     lines:[ { category, materialName, materialCode, supplier, color,
//               unit, consumption, wastePct, unitCost, notes } ] }
//
//   status ∈ draft | active | archived   category ∈ tela|avio|hilo|etiqueta|empaque|otro
//
// UPSERT POR PRODUCTO
//   Una lista se ata a un master_code (el producto). Solo puede existir UNA
//   lista por (master_code, version): si POST /api/bom llega con un
//   masterCodeId+version que ya tiene lista, se REEMPLAZA en lugar de duplicar.
//   Así la página puede guardar sin preocuparse de si ya existía. Las listas sin
//   master_code (estilo suelto) siempre crean fila nueva.
// ==========================================================================

async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);

    // ---- header: one per style/product ------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS bom_headers(
        id                BIGSERIAL PRIMARY KEY,
        master_code_id    BIGINT REFERENCES master_codes(id) ON DELETE SET NULL,
        style_code        VARCHAR(50),
        estilo            VARCHAR(20),
        style_description TEXT,
        customer_id       BIGINT REFERENCES customers(id) ON DELETE SET NULL,
        customer_name     VARCHAR(150),
        name              VARCHAR(150) NOT NULL DEFAULT '',
        version           VARCHAR(20)  NOT NULL DEFAULT '1',
        currency          VARCHAR(8)   NOT NULL DEFAULT 'MXN',
        status            VARCHAR(20)  NOT NULL DEFAULT 'draft',
        notes             TEXT,
        created_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
        updated_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
        CONSTRAINT chk_bom_status CHECK (status IN ('draft','active','archived'))
      );
    `);
    // One BOM per (product, version). Partial: rows without a master_code
    // (estilo suelto) are free to repeat.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_headers_product_version
        ON bom_headers (master_code_id, version)
        WHERE master_code_id IS NOT NULL;
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_bom_headers_master ON bom_headers(master_code_id);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_bom_headers_customer ON bom_headers(customer_id);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_bom_headers_estilo ON bom_headers(estilo);");
    console.log("\u2705 bom_headers table ready in prod_db_schema");

    // ---- lines: the material list -----------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS bom_lines(
        id            BIGSERIAL PRIMARY KEY,
        bom_id        BIGINT NOT NULL REFERENCES bom_headers(id) ON DELETE CASCADE,
        position      INT           NOT NULL DEFAULT 0,
        category      VARCHAR(30)   NOT NULL DEFAULT 'tela',
        material_name VARCHAR(150)  NOT NULL,
        material_code VARCHAR(60),
        supplier      VARCHAR(150),
        color         VARCHAR(60),
        unit          VARCHAR(16)   NOT NULL DEFAULT 'pza',
        consumption   NUMERIC(14,4) NOT NULL DEFAULT 0,  -- per garment
        waste_pct     NUMERIC(6,2)  NOT NULL DEFAULT 0,  -- merma %
        unit_cost     NUMERIC(14,4) NOT NULL DEFAULT 0,
        notes         TEXT,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
        CONSTRAINT chk_bom_line_consumption CHECK (consumption >= 0),
        CONSTRAINT chk_bom_line_waste CHECK (waste_pct >= 0),
        CONSTRAINT chk_bom_line_unit_cost CHECK (unit_cost >= 0)
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_bom_lines_bom ON bom_lines(bom_id);");
    console.log("\u2705 bom_lines table ready in prod_db_schema");
  } finally {
    client.release();
  }
}

// --- coercion helpers (same style as merchant-plan.js) --------------------
const txt = (v, n) => (v == null ? null : String(v).trim().slice(0, n || 200) || null);
const numOr = (v, d = 0) => { const n = Number(v); return isNaN(n) ? d : n; };
const idOr = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null; };

const CATEGORIES = ["tela", "avio", "hilo", "etiqueta", "empaque", "otro"];
const STATUSES = ["draft", "active", "archived"];
const cat = (v) => { const c = String(v || "").trim().toLowerCase(); return CATEGORIES.includes(c) ? c : "otro"; };
const status = (v) => { const s = String(v || "").trim().toLowerCase(); return STATUSES.includes(s) ? s : "draft"; };
const unit = (v) => String(v == null ? "pza" : v).trim().slice(0, 16) || "pza";

// Clean the incoming lines array into positional insert rows. Drops lines with
// no material name (an empty draft row the merchant never filled in).
function cleanLines(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  v.forEach((l, i) => {
    const name = txt(l?.materialName ?? l?.material_name, 150);
    if (!name) return; // skip blank rows
    out.push({
      position: Number.isFinite(Number(l?.position)) ? Math.trunc(Number(l.position)) : i,
      category: cat(l?.category),
      material_name: name,
      material_code: txt(l?.materialCode ?? l?.material_code, 60),
      supplier: txt(l?.supplier, 150),
      color: txt(l?.color, 60),
      unit: unit(l?.unit),
      consumption: numOr(l?.consumption),
      waste_pct: numOr(l?.wastePct ?? l?.waste_pct),
      unit_cost: numOr(l?.unitCost ?? l?.unit_cost),
      notes: txt(l?.notes, 2000),
    });
  });
  return out;
}

// Header params for INSERT / UPDATE. Returns the value object (not positional)
// so both paths can share it.
function headerValues(body) {
  return {
    master_code_id: idOr(body?.masterCodeId ?? body?.master_code_id),
    style_code: txt(body?.styleCode ?? body?.style_code, 50),
    estilo: txt(body?.estilo, 20),
    style_description: txt(body?.styleDescription ?? body?.style_description, 4000),
    customer_id: idOr(body?.customerId ?? body?.customer_id),
    customer_name: txt(body?.customerName ?? body?.customer_name, 150),
    name: txt(body?.name, 150) || "",
    version: txt(body?.version, 20) || "1",
    currency: (txt(body?.currency, 8) || "MXN").toUpperCase(),
    status: status(body?.status),
    notes: txt(body?.notes, 4000),
  };
}

const LINE_COLS =
  "(bom_id, position, category, material_name, material_code, supplier, color, unit, consumption, waste_pct, unit_cost, notes)";

async function insertLines(client, bomId, lines) {
  for (const l of lines) {
    await client.query(
      `INSERT INTO bom_lines ${LINE_COLS}
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [bomId, l.position, l.category, l.material_name, l.material_code, l.supplier,
       l.color, l.unit, l.consumption, l.waste_pct, l.unit_cost, l.notes]
    );
  }
}

// Header + rolled-up totals for the list view. line net = consumption*(1+waste),
// line cost = net*unit_cost; total_cost is the cost per garment.
const LIST_SQL = `
  SELECT h.id, h.master_code_id, h.style_code, h.estilo, h.style_description,
         h.customer_id, h.customer_name, h.name, h.version, h.currency, h.status,
         h.notes, h.created_by, h.updated_by, h.created_at, h.updated_at,
         mc.code AS master_code, mc.photo_filename,
         COALESCE(agg.line_count, 0)  AS line_count,
         COALESCE(agg.total_cost, 0)  AS total_cost
    FROM bom_headers h
    LEFT JOIN master_codes mc ON mc.id = h.master_code_id
    LEFT JOIN (
      SELECT bom_id,
             COUNT(*) AS line_count,
             SUM(consumption * (1 + waste_pct/100.0) * unit_cost) AS total_cost
        FROM bom_lines GROUP BY bom_id
    ) agg ON agg.bom_id = h.id
`;

function registerBom(app, deps) {
  const { authenticateToken, pool, setSchema } = deps;
  // Optional: sign a photo URL if the server injected the helper (server1.js does).
  const presign = deps.generatePresignedGetUrl || deps.getCachedPresignedUrl || null;

  const shapeHeader = (r) => ({
    id: Number(r.id),
    masterCodeId: r.master_code_id != null ? Number(r.master_code_id) : null,
    masterCode: r.master_code || null,
    styleCode: r.style_code,
    estilo: r.estilo,
    styleDescription: r.style_description,
    customerId: r.customer_id != null ? Number(r.customer_id) : null,
    customerName: r.customer_name,
    name: r.name,
    version: r.version,
    currency: r.currency,
    status: r.status,
    notes: r.notes,
    lineCount: Number(r.line_count) || 0,
    totalCost: Number(r.total_cost) || 0,
    photoUrl: presign && r.photo_filename ? presign(r.photo_filename, 3600) : null,
    createdBy: r.created_by != null ? Number(r.created_by) : null,
    updatedBy: r.updated_by != null ? Number(r.updated_by) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  const shapeLine = (r) => {
    const consumption = Number(r.consumption) || 0;
    const wastePct = Number(r.waste_pct) || 0;
    const unitCost = Number(r.unit_cost) || 0;
    const netConsumption = consumption * (1 + wastePct / 100);
    return {
      id: Number(r.id),
      position: Number(r.position) || 0,
      category: r.category,
      materialName: r.material_name,
      materialCode: r.material_code,
      supplier: r.supplier,
      color: r.color,
      unit: r.unit,
      consumption,
      wastePct,
      unitCost,
      notes: r.notes,
      netConsumption,           // consumo con merma
      lineCost: netConsumption * unitCost,
    };
  };

  // ---- GET: list of BOMs (+ totals) --------------------------------------
  app.get("/api/bom", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const where = [];
      const params = [];
      const masterCodeId = idOr(req.query.masterCodeId);
      const customerId = idOr(req.query.customerId);
      const st = req.query.status ? status(req.query.status) : null;
      if (masterCodeId) { params.push(masterCodeId); where.push(`h.master_code_id = $${params.length}`); }
      if (customerId) { params.push(customerId); where.push(`h.customer_id = $${params.length}`); }
      if (st) { params.push(st); where.push(`h.status = $${params.length}`); }
      const sql =
        LIST_SQL +
        (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
        ` ORDER BY h.updated_at DESC`;
      const { rows } = await client.query(sql, params);
      res.json({ success: true, boms: rows.map(shapeHeader) });
    } catch (err) {
      console.error("\u274c GET /api/bom:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---- GET: one BOM with its lines ---------------------------------------
  app.get("/api/bom/:id", authenticateToken, async (req, res) => {
    const id = idOr(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: "id inválido" });
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { rows } = await client.query(LIST_SQL + ` WHERE h.id = $1`, [id]);
      if (!rows.length) return res.status(404).json({ success: false, error: "Lista no encontrada" });
      const lines = await client.query(
        `SELECT * FROM bom_lines WHERE bom_id = $1 ORDER BY position, id`,
        [id]
      );
      res.json({ success: true, bom: shapeHeader(rows[0]), lines: lines.rows.map(shapeLine) });
    } catch (err) {
      console.error("\u274c GET /api/bom/:id:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // Shared writer for POST (create-or-replace) and PUT (replace by id).
  // Runs in a transaction: upsert the header, wipe its lines, re-insert them.
  async function saveBom(client, { id, body, userId }) {
    const h = headerValues(body);
    const lines = cleanLines(body?.lines);

    await client.query("BEGIN");
    let bomId = id;

    if (bomId) {
      // PUT: update existing header in place.
      const { rowCount } = await client.query(
        `UPDATE bom_headers SET
           master_code_id=$2, style_code=$3, estilo=$4, style_description=$5,
           customer_id=$6, customer_name=$7, name=$8, version=$9, currency=$10,
           status=$11, notes=$12, updated_by=$13, updated_at=now()
         WHERE id=$1`,
        [bomId, h.master_code_id, h.style_code, h.estilo, h.style_description,
         h.customer_id, h.customer_name, h.name, h.version, h.currency,
         h.status, h.notes, userId]
      );
      if (!rowCount) { await client.query("ROLLBACK"); return { notFound: true }; }
    } else if (h.master_code_id) {
      // POST for a product: create-or-replace the (product, version) row so the
      // page can "save" without worrying whether one already exists.
      const existing = await client.query(
        `SELECT id FROM bom_headers WHERE master_code_id=$1 AND version=$2`,
        [h.master_code_id, h.version]
      );
      if (existing.rows.length) {
        bomId = Number(existing.rows[0].id);
        await client.query(
          `UPDATE bom_headers SET
             style_code=$2, estilo=$3, style_description=$4, customer_id=$5,
             customer_name=$6, name=$7, currency=$8, status=$9, notes=$10,
             updated_by=$11, updated_at=now()
           WHERE id=$1`,
          [bomId, h.style_code, h.estilo, h.style_description, h.customer_id,
           h.customer_name, h.name, h.currency, h.status, h.notes, userId]
        );
      }
    }

    if (!bomId) {
      // Fresh insert (no product, or product without an existing version).
      const ins = await client.query(
        `INSERT INTO bom_headers
           (master_code_id, style_code, estilo, style_description, customer_id,
            customer_name, name, version, currency, status, notes,
            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
         RETURNING id`,
        [h.master_code_id, h.style_code, h.estilo, h.style_description, h.customer_id,
         h.customer_name, h.name, h.version, h.currency, h.status, h.notes, userId]
      );
      bomId = Number(ins.rows[0].id);
    }

    await client.query("DELETE FROM bom_lines WHERE bom_id = $1", [bomId]);
    await insertLines(client, bomId, lines);
    await client.query("COMMIT");
    return { id: bomId, lineCount: lines.length };
  }

  // ---- POST: create (or replace by product+version) ----------------------
  app.post("/api/bom", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const out = await saveBom(client, { id: null, body: req.body || {}, userId: req.user?.id ?? null });
      res.json({ success: true, id: out.id, lineCount: out.lineCount });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("\u274c POST /api/bom:", err.message);
      if (err.code === "23505") {
        return res.status(400).json({ success: false, error: "Ya existe una lista para ese producto y versión" });
      }
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---- PUT: replace one BOM by id ----------------------------------------
  app.put("/api/bom/:id", authenticateToken, async (req, res) => {
    const id = idOr(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: "id inválido" });
    const client = await pool.connect();
    try {
      await setSchema(client);
      const out = await saveBom(client, { id, body: req.body || {}, userId: req.user?.id ?? null });
      if (out.notFound) return res.status(404).json({ success: false, error: "Lista no encontrada" });
      res.json({ success: true, id: out.id, lineCount: out.lineCount });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("\u274c PUT /api/bom/:id:", err.message);
      if (err.code === "23505") {
        return res.status(400).json({ success: false, error: "Ya existe una lista para ese producto y versión" });
      }
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---- DELETE: remove a BOM (lines cascade) ------------------------------
  app.delete("/api/bom/:id", authenticateToken, async (req, res) => {
    const id = idOr(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: "id inválido" });
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { rowCount } = await client.query("DELETE FROM bom_headers WHERE id = $1", [id]);
      res.json({ success: true, deleted: rowCount });
    } catch (err) {
      console.error("\u274c DELETE /api/bom/:id:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });
}

registerBom.initSchema = initSchema;
module.exports = registerBom;