// fabric-warehouse.js
// ---------------------------------------------------------------------------
// Almacén de Tela (Fabric warehouse) module.
//
// Same shape as finished-warehouse.js:
//   const registerFabricWarehouse = require("./fabric-warehouse");
//   registerFabricWarehouse(app, { authenticateToken, pool, setSchema });
//   await registerFabricWarehouse.initSchema({ pool, setSchema });   // in runMigrations
//
// Roll life cycle (fabric_rolls.status):
//   requested     → pulled from Skytex and requested by Skyrina
//   assigned      → container chosen (F01, parked on spot A01), waiting for the truck
//   in_stock      → QR scanned on arrival, stored in its container
//   at_inspection → sent to the fabric inspection team
//   returned      → returned to the supplier
//   cancelled     → request cancelled before arrival
//
// Every change writes one row in fabric_roll_movements; the inbound and outbound
// reports are read from there.
//
// Skytex connection (.env):
//   SKYTEX_API_URL      full URL of the endpoint that returns the rolls JSON
//   SKYTEX_API_TOKEN    optional, sent as "Authorization: Bearer <token>"
//   SKYTEX_API_KEY      optional, sent in the header SKYTEX_API_KEY_HEADER (default x-api-key)
//   SKYTEX_PO_PARAM     optional, query param Skytex uses for the PO (default "po")
//
// Push from Skytex (they call us on every transfer to Skyrina):
//   POST https://d23mudpmb3ck8v.cloudfront.net/api/fabric-warehouse/skytex/transfers
//   (CloudFront → API Gateway → Lambda: max ~5 MB per request — Lambda limit)
//   FABRIC_SKYTEX_WEBHOOK_KEY   the key Skytex sends as "X-Api-Key: <key>"
//                               (or "Authorization: Bearer <key>"). Without it
//                               the endpoint answers 503 (not configured).
//   FABRIC_ORIGIN_VERIFY        optional: secret that CloudFront adds as the
//                               custom origin header "X-Origin-Verify". When set,
//                               calls that skip CloudFront (straight to the
//                               API Gateway URL) are rejected with 403.
//   FABRIC_AGING_DAYS   optional, days in stock before a roll is flagged (default 30)
// Until the API is live, the screen also accepts the test JSON pasted or uploaded
// (POST /api/fabric-warehouse/skytex/preview) and runs it through the same mapper.
// ---------------------------------------------------------------------------

const crypto = require("crypto");
const AGING_DAYS = Number(process.env.FABRIC_AGING_DAYS) || 30;

// The fixed set of containers that exist in the yard: F01…F80.
// .env: FABRIC_BOX_PREFIX (default "F"), FABRIC_BOX_COUNT (default 80).
// They are created on startup; no other container code can be placed or hold rolls.
const BOX_PREFIX = String(process.env.FABRIC_BOX_PREFIX || "F").trim().toUpperCase() || "F";
const BOX_COUNT = Math.max(1, Math.min(999, parseInt(process.env.FABRIC_BOX_COUNT, 10) || 80));
const BOX_CODES = Array.from({ length: BOX_COUNT }, (_, i) => `${BOX_PREFIX}${String(i + 1).padStart(BOX_COUNT > 99 ? 3 : 2, "0")}`);
const BOX_CATALOG = { prefix: BOX_PREFIX, count: BOX_COUNT, first: BOX_CODES[0], last: BOX_CODES[BOX_CODES.length - 1] };

// Spots per division: A01…A14, B01…B14 … (.env FABRIC_SPOTS_PER_DIVISION, default 14).
// Used as the default for new divisions and for «Lugares por división».
const SPOTS_PER_DIVISION = Math.max(1, Math.min(99, parseInt(process.env.FABRIC_SPOTS_PER_DIVISION, 10) || 14));

// Maximum rolls one container holds — the same for every container
// (.env FABRIC_BOX_CAPACITY, default 50). Applied to all containers on startup.
const BOX_CAPACITY = Math.max(1, Math.min(1000, parseInt(process.env.FABRIC_BOX_CAPACITY, 10) || 50));

// ---------------------------------------------------------------------------
// Field mapping: the fields agreed with Skytex (23 + Weight Unit + Gramaje). Each field accepts its Excel
// header, its snake_case key and a few likely aliases (English/Spanish), compared
// after removing accents, spaces and punctuation. Unknown keys are ignored but
// the full original object is kept in fabric_rolls.raw.
// ---------------------------------------------------------------------------
const FIELDS = [
  { key: "po_number", label: "Purchase order number", aliases: ["po", "ponumber", "pono", "purchaseorder", "purchaseorderno", "ordendecompra", "oc"] },
  { key: "supplier", label: "Supplier", aliases: ["proveedor", "suppliername", "vendor"] },
  { key: "supplier_code", label: "Supplier Code", aliases: ["codigoproveedor", "vendorcode"] },
  { key: "roll_no", label: "Rollo de tela", aliases: ["roll", "rollno", "rollnumber", "rollo", "rollid", "numerorollo", "norollo", "rollodetela"] },
  { key: "yards", label: "Yardas", aliases: ["yards", "yds", "yd", "yardage"], type: "number" },
  { key: "meters", label: "Metros", aliases: ["meters", "metres", "mts", "mt"], type: "number" },
  { key: "color", label: "Color", aliases: ["colour", "colorname"] },
  { key: "lot", label: "Lote", aliases: ["lot", "lotno", "batch", "dyelot"] },
  { key: "width", label: "Width", aliases: ["ancho"] },
  { key: "width_unit", label: "Width Unit", aliases: ["unidadancho", "widthuom"] },
  { key: "weight", label: "Weight", aliases: ["peso", "rollweight", "pesorollo"] },
  { key: "weight_unit", label: "Weight Unit", aliases: ["unidadpeso", "pesounidad", "weightuom", "uompeso"] },
  { key: "weight_gsm", label: "Gramaje (g/m²)", aliases: ["gsm", "gramaje", "grammage", "gm2", "grm2", "gramsm2"] },
  { key: "composition", label: "Composition", aliases: ["composicion", "content"] },
  { key: "month_buy", label: "Month Buy", aliases: ["mescompra", "buymonth"] },
  { key: "fabric_item_number", label: "Fabric item number", aliases: ["itemnumber", "fabricitem", "fabriccode", "articulo"] },
  { key: "fabric_name", label: "Fabric name", aliases: ["nombretela", "tela", "description"] },
  { key: "fabric_type", label: "Tipo de tela", aliases: ["typedetela", "fabrictype", "tipo"] },
  { key: "customer", label: "Cliente", aliases: ["client"] },
  { key: "arrival_date", label: "Fecha de llegada", aliases: ["arrivaldate", "fechallegada", "eta"], type: "date" },
  { key: "size", label: "Size", aliases: ["talla"] },
  { key: "item_sku_code", label: "Item SKU code", aliases: ["sku", "skucode", "itemsku"] },
  { key: "purchase_term", label: "Término de compra", aliases: ["purchaseterm", "incoterm", "terms"] },
  { key: "import_ref", label: "Importación", aliases: ["import", "pedimento"] },
  { key: "remarks", label: "Remarks", aliases: ["observaciones", "comentarios", "notes", "comments"] },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);

const normKey = (s) =>
  String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

const ALIAS = new Map();
for (const f of FIELDS) {
  for (const a of [f.key, f.label, ...f.aliases]) {
    const k = normKey(a);
    if (k && !ALIAS.has(k)) ALIAS.set(k, f);
  }
}

const str = (v) => {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
};
const numOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
// Accepts YYYY-MM-DD, DD/MM/YYYY (Mexico), ISO timestamps and Excel serial days.
const dateOrNull = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

function normalizeRoll(obj) {
  const out = {};
  for (const k of FIELD_KEYS) out[k] = null;
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const f = ALIAS.get(normKey(k));
    if (!f || out[f.key] != null) continue;
    if (v != null && typeof v === "object") continue;
    out[f.key] = f.type === "number" ? numOrNull(v) : f.type === "date" ? dateOrNull(v) : str(v);
  }
  return out;
}

// Dedup key for a roll: supplier code + roll number.
const rollKeyOf = (r) => `${String(r.supplier_code || r.supplier || "").trim().toUpperCase()}|${String(r.roll_no || "").trim().toUpperCase()}`;

// Find the first array of objects inside whatever Skytex returns.
function extractArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const k of ["data", "rolls", "items", "results", "records", "rows", "value"]) {
    if (Array.isArray(payload[k])) return payload[k];
    if (payload[k] && typeof payload[k] === "object") {
      const inner = extractArray(payload[k]);
      if (inner.length) return inner;
    }
  }
  for (const v of Object.values(payload)) if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
  return [];
}

async function fetchSkytex(po) {
  const base = process.env.SKYTEX_API_URL;
  if (!base) {
    const e = new Error("La conexión con Skytex no está configurada (SKYTEX_API_URL). Mientras tanto, cargue el JSON de prueba.");
    e.status = 503;
    throw e;
  }
  const url = new URL(base);
  if (po) url.searchParams.set(process.env.SKYTEX_PO_PARAM || "po", po);
  const headers = { Accept: "application/json" };
  if (process.env.SKYTEX_API_TOKEN) headers.Authorization = `Bearer ${process.env.SKYTEX_API_TOKEN}`;
  if (process.env.SKYTEX_API_KEY) headers[process.env.SKYTEX_API_KEY_HEADER || "x-api-key"] = process.env.SKYTEX_API_KEY;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) {
      const e = new Error(`Skytex respondió ${r.status}: ${text.slice(0, 200)}`);
      e.status = 502;
      throw e;
    }
    try { return JSON.parse(text); } catch {
      const e = new Error("Skytex no devolvió un JSON válido.");
      e.status = 502;
      throw e;
    }
  } catch (err) {
    if (err.name === "AbortError") {
      const e = new Error("Skytex no respondió en 20 segundos.");
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Text from the roll's QR: JSON, "key:value|key:value", "a|b|c" or the plain roll number.
// What PDA scanners add around a Code 128 label (Skytex rolls: 21521211082608):
//   • control characters: Enter/Tab suffix, GS (FNC1 in GS1-128)
//   • AIM symbology identifier when enabled: "]C0", "]C1" (Code 128), "]Q1" (QR)…
//   • a symbology name some PDA apps prepend: "C128", "CODE128"
// cleanScan() removes them so the same roll is found however the scanner is set up.
function cleanScan(raw) {
  let t = String(raw ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  t = t.replace(/^\][A-Za-z][0-9A-Za-z]/, "");
  // only before a roll number or a spot/container label, never inside other text
  const m = /^(?:C128|CODE[\s_-]?128)[\s:_-]*(\d{6,}|[A-Z]{1,4}[\s-]?\d{1,4})$/i.exec(t);
  if (m) t = m[1];
  return t.trim();
}

// Spot / container labels can be printed in many ways. This returns the
// candidate codes found in what the PDA read, in the order to try them:
//   "A01", "a-01", "LUGAR: A01", "Contenedor F01", "CONT-F01"
//   "https://…/ubicaciones/A01", "https://…?code=F01"
//   {"lugar":"A01","contenedor":"F01"}   (JSON: both are returned)
//   "A01|F01"                             (both are returned)
// expect "box" puts container-looking codes first; otherwise spots first.
const LABEL_WORDS = /^(?:LUGAR|UBICACION|UBICACIÓN|UBIC|LOCATION|LOC|POSICION|POSICIÓN|POS|SPOT|CONTENEDOR|CONTAINER|CONT|BOX|CAJA)\b[\s:#=._-]*/i;
const BOX_KEYS = ["contenedor", "container", "box", "caja", "cont"];
const SPOT_KEYS = ["lugar", "ubicacion", "location", "loc", "spot", "posicion", "pos"];
function labelCandidates(raw, expect) {
  let t = cleanScan(raw);
  if (!t) return [];
  const out = [];
  const push = (v, kind = null) => {
    const x = String(v ?? "").trim().replace(LABEL_WORDS, "").trim();
    if (x && x.length <= 40 && !out.some((o) => o.code === x)) out.push({ code: x, kind });
  };
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      const lower = Object.fromEntries(Object.entries(j || {}).map(([k, v]) => [k.toLowerCase(), v]));
      for (const k of BOX_KEYS) if (typeof lower[k] === "string" || typeof lower[k] === "number") push(lower[k], "box");
      for (const k of SPOT_KEYS) if (typeof lower[k] === "string" || typeof lower[k] === "number") push(lower[k], "spot");
      for (const k of ["code", "codigo", "id", "label", "qr"]) if (typeof lower[k] === "string") push(lower[k]);
    } catch { /* not JSON */ }
  } else if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      for (const k of ["code", "codigo", "c", "box", "contenedor", "lugar", "location", "id"]) {
        const v = u.searchParams.get(k);
        if (v) push(v, BOX_KEYS.includes(k) ? "box" : SPOT_KEYS.includes(k) ? "spot" : null);
      }
      const seg = u.pathname.split("/").filter(Boolean).pop();
      if (seg) push(decodeURIComponent(seg));
    } catch { /* bad URL */ }
  } else if (t.includes("|")) {
    const parts = t.split("|").map((x) => x.trim()).filter(Boolean);
    if (parts.length <= 3 && parts.every((x) => x.replace(LABEL_WORDS, "").length <= 12)) parts.forEach((x) => push(x));
  } else {
    push(t);
  }
  const looksBox = (c) => c.kind === "box" || (c.kind == null && new RegExp(`^${BOX_PREFIX}[\\s-]*\\d{1,3}$`, "i").test(c.code));
  out.sort((a, b) => (expect === "box" ? looksBox(b) - looksBox(a) : looksBox(a) - looksBox(b)));
  return out;
}

function parseRollScan(raw) {
  const text = cleanScan(raw);
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      const n = normalizeRoll(JSON.parse(text));
      if (n.roll_no) return { roll_no: n.roll_no, supplier_code: n.supplier_code, raw: text };
    } catch { /* not JSON */ }
  }
  if (text.includes(":") && text.includes("|")) {
    const obj = {};
    for (const part of text.split("|")) {
      const i = part.indexOf(":");
      if (i > 0) obj[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    const n = normalizeRoll(obj);
    if (n.roll_no) return { roll_no: n.roll_no, supplier_code: n.supplier_code, raw: text };
  }
  return { roll_no: text, supplier_code: null, raw: text };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fabric_containers(
        id BIGSERIAL PRIMARY KEY,
        code VARCHAR(40) UNIQUE NOT NULL,
        name VARCHAR(120),
        notes TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fabric_locations(
        id BIGSERIAL PRIMARY KEY,
        container_id BIGINT NOT NULL REFERENCES fabric_containers(id) ON DELETE CASCADE,
        code VARCHAR(40) NOT NULL,
        capacity INT,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (container_id, code)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fabric_rolls(
        id BIGSERIAL PRIMARY KEY,
        skytex_key VARCHAR(200) UNIQUE NOT NULL,
        po_number VARCHAR(80),
        supplier VARCHAR(150),
        supplier_code VARCHAR(60),
        roll_no VARCHAR(80) NOT NULL,
        yards NUMERIC(12,2),
        meters NUMERIC(12,2),
        color VARCHAR(80),
        lot VARCHAR(80),
        width VARCHAR(40),
        width_unit VARCHAR(20),
        weight VARCHAR(40),
        weight_unit VARCHAR(20),
        weight_gsm VARCHAR(40),
        composition TEXT,
        month_buy VARCHAR(40),
        fabric_item_number VARCHAR(80),
        fabric_name VARCHAR(200),
        fabric_type VARCHAR(80),
        customer VARCHAR(150),
        arrival_date DATE,
        size VARCHAR(40),
        item_sku_code VARCHAR(120),
        purchase_term VARCHAR(80),
        import_ref VARCHAR(120),
        remarks TEXT,
        raw JSONB,
        status VARCHAR(20) NOT NULL DEFAULT 'requested',
        container_id BIGINT REFERENCES fabric_containers(id) ON DELETE SET NULL,
        location_id BIGINT REFERENCES fabric_locations(id) ON DELETE SET NULL,
        inspection_result VARCHAR(20),
        requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        location_set_at TIMESTAMPTZ,
        received_at TIMESTAMPTZ,
        received_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        out_at TIMESTAMPTZ,
        out_reason TEXT,
        out_reference VARCHAR(120),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_fabric_roll_status CHECK (status IN
          ('requested','assigned','in_stock','at_inspection','returned','cancelled'))
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_fabric_rolls_status ON fabric_rolls(status);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_fabric_rolls_roll_no ON fabric_rolls(UPPER(roll_no));");
    await client.query("CREATE INDEX IF NOT EXISTS idx_fabric_rolls_po ON fabric_rolls(po_number);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_fabric_rolls_location ON fabric_rolls(location_id);");
    // source = 'skytex' (requested from Skytex) or 'scan' (scanned on arrival
    // without a request; linked to Skytex data later when it is requested).
    await client.query("ALTER TABLE fabric_rolls ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'skytex';");
    // Optional: the exact text of a position's QR label when it is not just its code.
    await client.query("ALTER TABLE fabric_locations ADD COLUMN IF NOT EXISTS qr_code VARCHAR(120);");

    // Yard layout:
    //   fabric_containers → the DIVISIONS of the yard (A, B, C, D, E). The table
    //                       keeps its old name so existing data and FKs still work.
    //   fabric_locations  → the SPOTS of each division (A01…A30).
    //   fabric_boxes      → the physical CONTAINERS (F01…F80), see below.
    // fabric_locations.box_code is only read once, to migrate the first version
    // (container code stored on the spot) into fabric_boxes.
    await client.query("ALTER TABLE fabric_locations ADD COLUMN IF NOT EXISTS box_code VARCHAR(40);");

    // Weight Unit and Gramaje (added after the first 23 fields). Rolls loaded
    // before keep their Skytex data in «raw», so their values are filled in here.
    // Reconciliation: a roll received without a Skytex request (source = 'scan')
    // stays on the dashboard until it is requested (it is then linked) or
    // someone marks it as reviewed with a note.
    await client.query("ALTER TABLE fabric_rolls ADD COLUMN IF NOT EXISTS unrequested_reviewed_at TIMESTAMPTZ;");
    await client.query("ALTER TABLE fabric_rolls ADD COLUMN IF NOT EXISTS unrequested_reviewed_by BIGINT;");
    await client.query("ALTER TABLE fabric_rolls ADD COLUMN IF NOT EXISTS unrequested_note TEXT;");
    // Transfers pushed by Skytex (one row per transfer_id; resends update it).
    await client.query(`
      CREATE TABLE IF NOT EXISTS fabric_skytex_transfers(
        transfer_id VARCHAR(120) PRIMARY KEY,
        event VARCHAR(40),
        first_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        times_received INT NOT NULL DEFAULT 1,
        roll_count INT NOT NULL DEFAULT 0,
        payload JSONB,
        last_result JSONB
      );
    `);
    await client.query("ALTER TABLE fabric_rolls ADD COLUMN IF NOT EXISTS transfer_id VARCHAR(120);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_fabric_rolls_transfer ON fabric_rolls(transfer_id);");
    await client.query("ALTER TABLE fabric_rolls ADD COLUMN IF NOT EXISTS weight_unit VARCHAR(20);");
    await client.query("ALTER TABLE fabric_rolls ADD COLUMN IF NOT EXISTS weight_gsm VARCHAR(40);");
    await client.query(`
      UPDATE fabric_rolls r SET
        weight_unit = COALESCE(r.weight_unit, (
          SELECT LEFT(NULLIF(TRIM(e.value #>> '{}'), ''), 20) FROM jsonb_each(r.raw) e
           WHERE jsonb_typeof(e.value) IN ('string','number')
             AND regexp_replace(lower(e.key), '[^a-z0-9]', '', 'g') IN ('weightunit','unidadpeso','pesounidad','weightuom','uompeso')
           LIMIT 1)),
        weight_gsm = COALESCE(r.weight_gsm, (
          SELECT LEFT(NULLIF(TRIM(e.value #>> '{}'), ''), 40) FROM jsonb_each(r.raw) e
           WHERE jsonb_typeof(e.value) IN ('string','number')
             AND regexp_replace(lower(e.key), '[^a-z0-9]', '', 'g') IN ('weightgsm','gramajegm','gsm','gramaje','grammage','gm2','grm2','gramsm2')
           LIMIT 1))
       WHERE jsonb_typeof(r.raw) = 'object' AND (r.weight_unit IS NULL OR r.weight_gsm IS NULL)
    `);
    await client.query("DROP INDEX IF EXISTS uq_fabric_locations_box;");

    await client.query(`
      CREATE TABLE IF NOT EXISTS fabric_roll_movements(
        id BIGSERIAL PRIMARY KEY,
        roll_id BIGINT NOT NULL REFERENCES fabric_rolls(id) ON DELETE CASCADE,
        type VARCHAR(30) NOT NULL,
        from_location_id BIGINT REFERENCES fabric_locations(id) ON DELETE SET NULL,
        to_location_id BIGINT REFERENCES fabric_locations(id) ON DELETE SET NULL,
        reference VARCHAR(120),
        reason TEXT,
        user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_fabric_moves_type_date ON fabric_roll_movements(type, created_at);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_fabric_moves_roll ON fabric_roll_movements(roll_id);");
    // Container on the from/to spot at the time of the move (containers can be moved later).
    await client.query("ALTER TABLE fabric_roll_movements ADD COLUMN IF NOT EXISTS from_box_code VARCHAR(40);");
    await client.query("ALTER TABLE fabric_roll_movements ADD COLUMN IF NOT EXISTS to_box_code VARCHAR(40);");

    // Containers F01…F80. A container is parked on at most one spot and a spot
    // holds at most one container (unique location_id). location_id = NULL means
    // the container was moved and its new spot has not been scanned yet; it keeps
    // its rolls. capacity = rolls the container holds (NULL = no limit).
    await client.query(`
      CREATE TABLE IF NOT EXISTS fabric_boxes(
        id BIGSERIAL PRIMARY KEY,
        code VARCHAR(40) NOT NULL,
        location_id BIGINT REFERENCES fabric_locations(id) ON DELETE SET NULL,
        capacity INT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        placed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_fabric_boxes_code ON fabric_boxes(UPPER(code));");
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_fabric_boxes_location ON fabric_boxes(location_id) WHERE location_id IS NOT NULL;");
    await client.query("ALTER TABLE fabric_rolls ADD COLUMN IF NOT EXISTS box_id BIGINT REFERENCES fabric_boxes(id) ON DELETE SET NULL;");
    await client.query("CREATE INDEX IF NOT EXISTS idx_fabric_rolls_box ON fabric_rolls(box_id);");
    // Migration from the first version (container code stored on the spot).
    await client.query(`
      INSERT INTO fabric_boxes (code, location_id, capacity, placed_at)
      SELECT UPPER(l.box_code), l.id, l.capacity, now() FROM fabric_locations l
       WHERE l.box_code IS NOT NULL
      ON CONFLICT DO NOTHING;
    `);
    await client.query(`
      UPDATE fabric_rolls r SET box_id = b.id
        FROM fabric_boxes b
       WHERE r.box_id IS NULL AND r.location_id = b.location_id
         AND r.status IN ('assigned','in_stock','at_inspection');
    `);
    await client.query("UPDATE fabric_locations SET box_code = NULL WHERE box_code IS NOT NULL;");

    // The container catalog (F01…F80): create the missing ones (without a spot)
    // and make sure they are active.
    await client.query(
      `INSERT INTO fabric_boxes (code, capacity)
       SELECT c, $2 FROM unnest($1::text[]) AS c
        WHERE NOT EXISTS (SELECT 1 FROM fabric_boxes b WHERE UPPER(b.code) = c)`,
      [BOX_CODES, BOX_CAPACITY]
    );
    // One capacity for every container (and the spots, used as fallback).
    await client.query(`UPDATE fabric_boxes SET capacity = $1 WHERE capacity IS DISTINCT FROM $1`, [BOX_CAPACITY]);
    await client.query(`UPDATE fabric_locations SET capacity = $1 WHERE capacity IS DISTINCT FROM $1`, [BOX_CAPACITY]);
    await client.query(`UPDATE fabric_boxes SET is_active = TRUE WHERE UPPER(code) = ANY($1::text[]) AND NOT is_active`, [BOX_CODES]);
    // Codes outside the catalog (typed by mistake earlier) are retired when they
    // hold no rolls. Ones that still hold rolls stay until the rolls are moved.
    await client.query(
      `UPDATE fabric_boxes b SET is_active = FALSE, location_id = NULL
        WHERE b.is_active AND NOT (UPPER(b.code) = ANY($1::text[]))
          AND NOT EXISTS (SELECT 1 FROM fabric_rolls r WHERE r.box_id = b.id AND r.status IN ('assigned','in_stock','at_inspection'))`,
      [BOX_CODES]
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS fabric_inspection_requests(
        id BIGSERIAL PRIMARY KEY,
        request_no VARCHAR(20) UNIQUE,
        status VARCHAR(20) NOT NULL DEFAULT 'open',
        notes TEXT,
        requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        requested_by_name VARCHAR(120),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        sent_at TIMESTAMPTZ,
        CONSTRAINT chk_fabric_insp_status CHECK (status IN ('open','partial','sent','cancelled'))
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS fabric_inspection_request_items(
        request_id BIGINT NOT NULL REFERENCES fabric_inspection_requests(id) ON DELETE CASCADE,
        roll_id BIGINT NOT NULL REFERENCES fabric_rolls(id) ON DELETE CASCADE,
        sent_at TIMESTAMPTZ,
        PRIMARY KEY (request_id, roll_id)
      );
    `);

    console.log("✅ fabric-warehouse tables ready in prod_db_schema");
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
function registerFabricWarehouse(app, deps) {
  const { authenticateToken, pool, setSchema } = deps;
  const BASE = "/api/fabric-warehouse";

  // Tables are created on first use (CREATE TABLE IF NOT EXISTS), so the module
  // works even when the server does not run migrations at startup (Lambda).
  // Runs once per process; retried on the next request if it fails.
  let schemaReady = null;
  const ensureSchema = () => {
    if (!schemaReady) {
      schemaReady = initSchema({ pool, setSchema }).catch((e) => { schemaReady = null; throw e; });
    }
    return schemaReady;
  };

  const withClient = (handler) => async (req, res) => {
    try {
      await ensureSchema();
    } catch (err) {
      console.error("❌ fabric-warehouse schema:", err.message);
      return res.status(500).json({ success: false, error: `No se pudieron crear las tablas del almacén de tela: ${err.message}` });
    }
    const client = await pool.connect();
    try {
      await setSchema(client);
      await handler(req, res, client);
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch {}
      console.error("❌ fabric-warehouse:", err.message);
      if (!res.headersSent) res.status(err.status || 500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  };

  const fail = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });
  const idList = (v) =>
    Array.isArray(v) ? [...new Set(v.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0))] : [];

  // Container codes are saved with each movement (containers move later).
  // fromBox defaults to the container on the from-spot; toBox to the roll's
  // current container (movements are logged after the roll is updated).
  const logMove = (client, { rollId, type, from = null, to = null, reference = null, reason = null, userId = null, fromBox = null, toBox = null }) =>
    client.query(
      `INSERT INTO fabric_roll_movements (roll_id, type, from_location_id, to_location_id, reference, reason, user_id,
                                          from_box_code, to_box_code)
       VALUES ($1::bigint, $2, $3::bigint, $4::bigint, $5, $6, $7,
               COALESCE($8::text, (SELECT code FROM fabric_boxes WHERE location_id = $3::bigint)),
               COALESCE($9::text, CASE WHEN $4::bigint IS NOT NULL THEN
                 (SELECT b.code FROM fabric_rolls r JOIN fabric_boxes b ON b.id = r.box_id WHERE r.id = $1::bigint) END))`,
      [rollId, type, from, to, reference, reason, userId, fromBox, toBox]
    );

  // "f1", "F-01", "f 01" → "F01"
  const normBox = (v) => {
    const t = String(v ?? "").trim().toUpperCase().replace(/[\s-]+/g, "");
    if (!t) return null;
    const m = /^([A-Z]+)(\d+)$/.exec(t);
    if (!m) return t;
    const width = m[1] === BOX_PREFIX ? BOX_CODES[0].length - BOX_PREFIX.length : 2;
    return `${m[1]}${String(Number(m[2])).padStart(width, "0")}`;
  };

  // Shared SELECT for a roll with its container, location and days in stock.
  const ROLL_SELECT = `
    SELECT r.*,
           to_char(r.arrival_date, 'YYYY-MM-DD') AS arrival_date,
           c.code AS container_code, c.name AS container_name,   -- division (A–E)
           c.code AS division_code,
           l.code AS location_code,                              -- spot (A01)
           b.code AS box_code,                                   -- container (F01)
           CASE WHEN r.received_at IS NOT NULL
                THEN FLOOR(EXTRACT(EPOCH FROM (COALESCE(r.out_at, now()) - r.received_at)) / 86400)::int
           END AS days_in_stock,
           (SELECT ir.request_no
              FROM fabric_inspection_request_items it
              JOIN fabric_inspection_requests ir ON ir.id = it.request_id
             WHERE it.roll_id = r.id AND ir.status IN ('open','partial')
             ORDER BY ir.id DESC LIMIT 1) AS open_inspection_request
      FROM fabric_rolls r
      LEFT JOIN fabric_containers c ON c.id = r.container_id
      LEFT JOIN fabric_locations  l ON l.id = r.location_id
      LEFT JOIN fabric_boxes      b ON b.id = r.box_id`;

  // Marks Skytex rows that Skyrina already requested.
  async function withRequestStatus(client, rows) {
    const keys = rows.map(rollKeyOf);
    const { rows: found } = await client.query(
      `SELECT skytex_key, status, id FROM fabric_rolls WHERE skytex_key = ANY($1::text[])`,
      [keys]
    );
    const byKey = new Map(found.map((r) => [r.skytex_key, r]));
    return rows.map((r) => {
      const hit = byKey.get(rollKeyOf(r));
      return { ...r, _key: rollKeyOf(r), local_status: hit ? hit.status : null, local_id: hit ? hit.id : null };
    });
  }

  function filterRows(rows, query) {
    const active = FIELD_KEYS.filter((k) => str(query[k]));
    if (!active.length) return rows;
    return rows.filter((r) =>
      active.every((k) => String(r[k] ?? "").toLowerCase().includes(String(query[k]).trim().toLowerCase()))
    );
  }

  // ======================================================================
  //  SKYTEX
  // ======================================================================

  app.get(`${BASE}/fields`, authenticateToken, (req, res) => {
    res.json({ success: true, fields: FIELDS.map(({ key, label, type }) => ({ key, label, type: type || "text" })), agingDays: AGING_DAYS });
  });

  // Live pull. Any of the agreed field keys can be passed as a filter (contains match).
  app.get(`${BASE}/skytex/rolls`, authenticateToken, withClient(async (req, res, client) => {
    const payload = await fetchSkytex(str(req.query.po_number));
    const source = extractArray(payload);
    const rows = source.map((o) => ({ ...normalizeRoll(o), _raw: o })).filter((r) => r.roll_no);
    const filtered = filterRows(rows, req.query);
    res.json({ success: true, source: "skytex", total: rows.length, rolls: await withRequestStatus(client, filtered) });
  }));

  // Test JSON (pasted or uploaded) through the same mapper. Body: { data, filters? }
  app.post(`${BASE}/skytex/preview`, authenticateToken, withClient(async (req, res, client) => {
    let data = req.body?.data;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch { return fail(res, 400, "El texto no es un JSON válido."); }
    }
    const source = extractArray(data);
    if (!source.length) return fail(res, 400, "No se encontró una lista de rollos en el JSON.");
    const rows = source.map((o) => ({ ...normalizeRoll(o), _raw: o }));
    const missing = rows.filter((r) => !r.roll_no).length;
    const valid = rows.filter((r) => r.roll_no);
    // transfer_id / event belong to the push envelope, not to the roll fields.
    const ENVELOPE = new Set(["transferid", "idtransfer", "idtransferencia", "transferencia", "transfer", "folio", "foliotransferencia", "event", "type"]);
    const unmapped = [...new Set(source.flatMap((o) => Object.keys(o || {}))
      .filter((k) => !ALIAS.has(normKey(k)) && !ENVELOPE.has(normKey(k))))];
    res.json({
      success: true,
      source: "file",
      total: valid.length,
      skippedWithoutRoll: missing,
      unmappedKeys: unmapped,
      rolls: await withRequestStatus(client, filterRows(valid, req.body?.filters || {})),
    });
  }));

  // Request the selected rolls. Body: { rolls: [normalized rows (+ _raw)] }
  app.post(`${BASE}/requests`, authenticateToken, withClient(async (req, res, client) => {
    const input = Array.isArray(req.body?.rolls) ? req.body.rolls : [];
    if (!input.length) return fail(res, 400, "Seleccione al menos un rollo.");
    if (input.length > 2000) return fail(res, 400, "Máximo 2000 rollos por solicitud.");

    await client.query("BEGIN");
    const created = [];
    const duplicates = [];
    const linked = [];
    for (const item of input) {
      const r = normalizeRoll(item);
      if (!r.roll_no) continue;
      const key = rollKeyOf(r);

      // Already scanned on arrival without a request → fill in its Skytex data.
      const scanned = await client.query(
        `SELECT id FROM fabric_rolls WHERE source = 'scan' AND UPPER(roll_no) = UPPER($1) LIMIT 1`, [r.roll_no]
      );
      if (scanned.rows.length) {
        const sets = FIELD_KEYS.map((k, i) => `${k} = COALESCE($${i + 3}, ${k})`).join(", ");
        await client.query(
          `UPDATE fabric_rolls SET skytex_key = $2, ${sets}, source = 'skytex',
                  raw = $${FIELD_KEYS.length + 3}, updated_at = now()
            WHERE id = $1`,
          [scanned.rows[0].id, key, ...FIELD_KEYS.map((k) => r[k]), JSON.stringify(item._raw ?? item)]
        );
        linked.push(r.roll_no);
        continue;
      }

      const cols = ["skytex_key", ...FIELD_KEYS, "raw", "requested_by"];
      const vals = [key, ...FIELD_KEYS.map((k) => r[k]), JSON.stringify(item._raw ?? item), req.user?.id ?? null];
      const ins = await client.query(
        `INSERT INTO fabric_rolls (${cols.join(",")})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})
         ON CONFLICT (skytex_key) DO NOTHING
         RETURNING id, roll_no`,
        vals
      );
      if (ins.rows.length) {
        created.push(ins.rows[0]);
        await logMove(client, { rollId: ins.rows[0].id, type: "requested", reference: r.po_number, userId: req.user?.id });
      } else {
        // A cancelled request can be requested again.
        const again = await client.query(
          `UPDATE fabric_rolls
              SET status = 'requested', container_id = NULL, location_id = NULL, box_id = NULL, location_set_at = NULL,
                  requested_by = $2, requested_at = now(), updated_at = now()
            WHERE skytex_key = $1 AND status = 'cancelled'
            RETURNING id, roll_no`,
          [key, req.user?.id ?? null]
        );
        if (again.rows.length) {
          created.push(again.rows[0]);
          await logMove(client, { rollId: again.rows[0].id, type: "requested", reference: r.po_number, userId: req.user?.id });
        } else {
          duplicates.push(r.roll_no);
        }
      }
    }
    await client.query("COMMIT");
    res.json({ success: true, created: created.length, duplicates, linked });
  }));

  // ======================================================================
  //  PUSH FROM SKYTEX: POST /skytex/transfers
  // ======================================================================
  // Skytex calls this every time it registers a transfer to Skyrina, with the
  // same JSON as the sample (the 25 agreed fields) plus a transfer_id:
  //   { "transfer_id": "TR-2026-000123", "event": "transfer", "data": [ {roll}, … ] }
  // (transfer_id may also come inside each roll.)
  //
  // Auth: header "X-Api-Key: <FABRIC_SKYTEX_WEBHOOK_KEY>" (or Authorization: Bearer).
  //
  // Idempotent — sending the same transfer_id again (retry or correction):
  //   • rolls already registered are UPDATED with the new data (never duplicated)
  //   • new rolls are added (status «En Skytex», ready to reserve a container)
  //   • rolls of that transfer that are no longer in the resend and have not
  //     arrived yet are cancelled (reported in the reply); rolls already
  //     received are never touched
  //   • a roll scanned on arrival before its data came is linked to it
  //
  // Replies: 200 ok (also for resends) · 400 invalid JSON / no transfer_id ·
  //   401 wrong key · 422 no valid rolls · 503 not configured · 500 our error.
  //   Retry only on 5xx / network errors; 4xx means the payload must be fixed.
  const webhookKey = () => String(process.env.FABRIC_SKYTEX_WEBHOOK_KEY || "").trim();
  const sameKey = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const TRANSFER_KEYS = ["transferid", "idtransfer", "idtransferencia", "transferencia", "transfer", "folio", "foliotransferencia"];
  const findTransferId = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    for (const [k, v] of Object.entries(obj)) {
      if (TRANSFER_KEYS.includes(normKey(k)) && (typeof v === "string" || typeof v === "number") && String(v).trim()) {
        return String(v).trim().slice(0, 120);
      }
    }
    return null;
  };

  app.post(`${BASE}/skytex/transfers`, withClient(async (req, res, client) => {
    // Only through CloudFront (which adds X-Origin-Verify), never straight to API Gateway.
    const originSecret = String(process.env.FABRIC_ORIGIN_VERIFY || "").trim();
    if (originSecret && !sameKey(String(req.get("x-origin-verify") || ""), originSecret)) {
      return res.status(403).json({ success: false, code: "forbidden", error: "Use the published URL." });
    }
    const key = webhookKey();
    if (!key) return res.status(503).json({ success: false, code: "not_configured", error: "Webhook not configured on Skyrina side (FABRIC_SKYTEX_WEBHOOK_KEY)." });
    const sent = String(req.get("x-api-key") || "").trim() || String(req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!sent || !sameKey(sent, key)) return res.status(401).json({ success: false, code: "unauthorized", error: "Invalid or missing API key." });

    const body = req.body;
    if (!body || typeof body !== "object") return res.status(400).json({ success: false, code: "invalid_payload", error: "Body must be JSON." });
    const rows = extractArray(body);
    if (!rows.length) return res.status(400).json({ success: false, code: "invalid_payload", error: "No rolls found (expected an array in \"data\")." });
    const topId = findTransferId(body);
    const event = String(body.event || body.type || "transfer").slice(0, 40);

    // Group by transfer_id (top level, or per roll)
    const groups = new Map();
    const skipped = [];
    rows.forEach((raw, index) => {
      const tid = topId || findTransferId(raw);
      if (!tid) return skipped.push({ index, reason: "missing transfer_id" });
      const r = normalizeRoll(raw);
      if (!r.roll_no) return skipped.push({ index, reason: "missing roll number (Rollo de tela / roll_no)" });
      if (!groups.has(tid)) groups.set(tid, []);
      groups.get(tid).push({ r, raw, index });
    });
    if (!groups.size) {
      const status = skipped.every((x) => x.reason === "missing transfer_id") ? 400 : 422;
      return res.status(status).json({
        success: false, code: status === 400 ? "invalid_payload" : "no_valid_rolls",
        error: status === 400 ? "transfer_id is required." : "No valid rolls in the payload.", skipped,
      });
    }

    const results = [];
    await client.query("BEGIN");
    for (const [tid, items] of groups) {
      const out = { transfer_id: tid, received: items.length, created: 0, updated: 0, linked: 0, cancelled: [], warnings: [] };
      const keys = [];
      const seen = new Set();
      for (const { r, raw, index } of items) {
        const k = rollKeyOf(r);
        if (seen.has(k)) { out.warnings.push({ index, roll_no: r.roll_no, warning: "duplicated in this payload; last one kept" }); }
        seen.add(k);
        keys.push(k);
        const vals = FIELD_KEYS.map((f) => r[f]);
        const rawJson = JSON.stringify(raw);

        const existing = (await client.query(`SELECT id, status FROM fabric_rolls WHERE skytex_key = $1 FOR UPDATE`, [k])).rows[0];
        if (existing) {
          const sets = FIELD_KEYS.map((f, i) => `${f} = COALESCE($${i + 4}, ${f})`).join(", ");
          await client.query(
            `UPDATE fabric_rolls
                SET ${sets}, raw = $2, transfer_id = $3, source = 'skytex',
                    status = CASE WHEN status = 'cancelled' THEN 'requested' ELSE status END,
                    requested_at = CASE WHEN status = 'cancelled' THEN now() ELSE requested_at END,
                    updated_at = now()
              WHERE id = $1`,
            [existing.id, rawJson, tid, ...vals]
          );
          if (existing.status === "cancelled") {
            await logMove(client, { rollId: existing.id, type: "requested", reference: `Transferencia ${tid}`, reason: "Reenviado por Skytex" });
          }
          out.updated++;
          continue;
        }
        // Scanned on arrival before Skytex sent its data → link it.
        const scanned = (await client.query(
          `SELECT id FROM fabric_rolls WHERE source = 'scan' AND UPPER(roll_no) = UPPER($1) LIMIT 1 FOR UPDATE`, [r.roll_no]
        )).rows[0];
        if (scanned) {
          const sets = FIELD_KEYS.map((f, i) => `${f} = COALESCE($${i + 5}, ${f})`).join(", ");
          await client.query(
            `UPDATE fabric_rolls SET skytex_key = $2, ${sets}, source = 'skytex', raw = $3, transfer_id = $4, updated_at = now()
              WHERE id = $1`,
            [scanned.id, k, rawJson, tid, ...vals]
          );
          out.linked++;
          continue;
        }
        const cols = ["skytex_key", ...FIELD_KEYS, "raw", "transfer_id"];
        const ins = await client.query(
          `INSERT INTO fabric_rolls (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
          [k, ...vals, rawJson, tid]
        );
        await logMove(client, { rollId: ins.rows[0].id, type: "requested", reference: `Transferencia ${tid}`, reason: "Recibido de Skytex" });
        out.created++;
      }

      // Correction: rolls of this transfer missing from the resend
      const gone = await client.query(
        `SELECT id, roll_no, status, location_id FROM fabric_rolls
          WHERE transfer_id = $1 AND NOT (skytex_key = ANY($2::text[])) AND status <> 'cancelled' FOR UPDATE`,
        [tid, keys]
      );
      for (const g of gone.rows) {
        if (["requested", "assigned"].includes(g.status)) {
          await client.query(
            `UPDATE fabric_rolls SET status = 'cancelled', box_id = NULL, location_id = NULL, container_id = NULL, updated_at = now() WHERE id = $1`,
            [g.id]
          );
          await logMove(client, { rollId: g.id, type: "cancelled", from: g.location_id, reference: `Transferencia ${tid}`, reason: "Ya no viene en el reenvío de Skytex" });
          out.cancelled.push(g.roll_no);
        } else {
          out.warnings.push({ roll_no: g.roll_no, warning: `not in the resend but already ${g.status} at Skyrina; kept` });
        }
      }

      const t = await client.query(
        `INSERT INTO fabric_skytex_transfers (transfer_id, event, roll_count, payload, last_result)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (transfer_id) DO UPDATE
           SET event = EXCLUDED.event, roll_count = EXCLUDED.roll_count, payload = EXCLUDED.payload,
               last_result = EXCLUDED.last_result, last_received_at = now(),
               times_received = fabric_skytex_transfers.times_received + 1
         RETURNING times_received`,
        [tid, event, items.length, JSON.stringify(body), JSON.stringify(out)]
      );
      out.resend = t.rows[0].times_received > 1;
      results.push(out);
    }
    await client.query("COMMIT");
    const one = results.length === 1 ? results[0] : null;
    res.json({ success: true, ...(one || { transfers: results }), skipped });
  }));

  // Body errors (invalid JSON, too large) happen in the server's JSON parser
  // before the route: answer them in JSON too, so Skytex can read the reason.
  app.use(`${BASE}/skytex/transfers`, (err, req, res, next) => {
    if (!err) return next();
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ success: false, code: "invalid_payload", error: "Body is not valid JSON." });
    }
    if (err.type === "entity.too.large") {
      return res.status(413).json({ success: false, code: "payload_too_large", error: "Payload too large (max 5 MB per request). Please contact Skyrina." });
    }
    return next(err);
  });

  // Log of transfers pushed by Skytex (for the warehouse / support).
  app.get(`${BASE}/skytex/transfers`, authenticateToken, withClient(async (req, res, client) => {
    const { rows } = await client.query(
      `SELECT transfer_id, event, first_received_at, last_received_at, times_received, roll_count, last_result
         FROM fabric_skytex_transfers ORDER BY last_received_at DESC LIMIT 200`
    );
    res.json({ success: true, transfers: rows });
  }));

  // ======================================================================
  //  ROLLS
  // ======================================================================

  // GET /rolls?status=in_stock,assigned&q=&containerId=&locationId=&minDays=&inspection=rejected
  app.get(`${BASE}/rolls`, authenticateToken, withClient(async (req, res, client) => {
    const params = [];
    const where = [];
    const statuses = String(req.query.status || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length) { params.push(statuses); where.push(`r.status = ANY($${params.length}::text[])`); }
    if (req.query.containerId) { params.push(req.query.containerId); where.push(`r.container_id = $${params.length}`); }
    if (req.query.locationId) { params.push(req.query.locationId); where.push(`r.location_id = $${params.length}`); }
    if (req.query.box) {
      params.push(normBox(req.query.box));
      where.push(`UPPER(b.code) = $${params.length}`);
    }
    if (req.query.inspection) { params.push(req.query.inspection); where.push(`r.inspection_result = $${params.length}`); }
    if (req.query.minDays) {
      params.push(Number(req.query.minDays) || 0);
      where.push(`r.received_at IS NOT NULL AND r.received_at <= now() - ($${params.length} || ' days')::interval`);
    }
    if (str(req.query.q)) {
      params.push(`%${String(req.query.q).trim()}%`);
      const p = `$${params.length}`;
      where.push(`(r.roll_no ILIKE ${p} OR r.po_number ILIKE ${p} OR r.supplier ILIKE ${p} OR r.color ILIKE ${p}
                   OR r.lot ILIKE ${p} OR r.fabric_name ILIKE ${p} OR r.customer ILIKE ${p} OR r.item_sku_code ILIKE ${p}
                   OR b.code ILIKE ${p} OR l.code ILIKE ${p})`);
    }
    const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 1500));
    const { rows } = await client.query(
      `${ROLL_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY r.updated_at DESC, r.id DESC LIMIT ${limit}`,
      params
    );
    res.json({ success: true, rolls: rows, agingDays: AGING_DAYS });
  }));

  app.get(`${BASE}/rolls/:id/history`, authenticateToken, withClient(async (req, res, client) => {
    const { rows } = await client.query(
      `SELECT m.*,
              NULLIF(concat_ws(' · ', m.from_box_code, lf.code), '') AS from_location,
              NULLIF(concat_ws(' · ', m.to_box_code, lt.code), '') AS to_location,
              u.full_name AS user_name
         FROM fabric_roll_movements m
         LEFT JOIN fabric_locations lf ON lf.id = m.from_location_id
         LEFT JOIN fabric_locations lt ON lt.id = m.to_location_id
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.roll_id = $1 ORDER BY m.created_at DESC, m.id DESC`,
      [req.params.id]
    );
    res.json({ success: true, history: rows });
  }));

  // Cancel requests that have not arrived yet. Body: { ids }
  app.post(`${BASE}/rolls/cancel`, authenticateToken, withClient(async (req, res, client) => {
    const ids = idList(req.body?.ids);
    if (!ids.length) return fail(res, 400, "Seleccione al menos un rollo.");
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE fabric_rolls SET status = 'cancelled', updated_at = now()
        WHERE id = ANY($1::bigint[]) AND status IN ('requested','assigned')
        RETURNING id, location_id`,
      [ids]
    );
    for (const r of rows) await logMove(client, { rollId: r.id, type: "cancelled", from: r.location_id, userId: req.user?.id });
    await client.query("COMMIT");
    res.json({ success: true, cancelled: rows.length, skipped: ids.length - rows.length });
  }));

  // ======================================================================
  //  CONTAINERS (F01…F80) — shared helpers
  // ======================================================================
  // A container (fabric_boxes) is parked on at most one spot and a spot holds
  // at most one container. Rolls belong to the container (fabric_rolls.box_id);
  // fabric_rolls.location_id / container_id are kept equal to the container's
  // current spot / division so filters and reports keep working.

  const BOX_SELECT = `
    SELECT b.id, b.code, b.location_id, b.placed_at,
           COALESCE(b.capacity, l.capacity) AS capacity,
           l.code AS location_code, l.container_id, c.code AS division_code, c.code AS container_code,
           (SELECT COUNT(*)::int FROM fabric_rolls r WHERE r.box_id = b.id AND r.status = 'in_stock') AS stored,
           (SELECT COUNT(*)::int FROM fabric_rolls r WHERE r.box_id = b.id AND r.status = 'assigned') AS reserved,
           (SELECT COUNT(*)::int FROM fabric_rolls r WHERE r.box_id = b.id AND r.status = 'at_inspection') AS inspection,
           (SELECT COALESCE(SUM(r.yards),0) FROM fabric_rolls r WHERE r.box_id = b.id AND r.status = 'in_stock') AS yards
      FROM fabric_boxes b
      LEFT JOIN fabric_locations  l ON l.id = b.location_id
      LEFT JOIN fabric_containers c ON c.id = l.container_id`;

  const boxInfo = async (client, id) =>
    id ? (await client.query(`${BOX_SELECT} WHERE b.id = $1`, [id])).rows[0] || null : null;

  // Is there room for these rolls in the container? (excludeIds = the rolls being placed)
  async function roomInBox(client, boxId, excludeIds = [], adding = 1) {
    const { rows } = await client.query(
      `SELECT b.id, b.code, COALESCE(b.capacity, l.capacity) AS capacity, b.location_id,
              l.code AS location_code, l.container_id,
              (SELECT COUNT(*)::int FROM fabric_rolls r
                WHERE r.box_id = b.id AND r.status IN ('assigned','in_stock')
                  AND NOT (r.id = ANY($2::bigint[]))) AS used
         FROM fabric_boxes b LEFT JOIN fabric_locations l ON l.id = b.location_id
        WHERE b.id = $1 AND b.is_active`,
      [boxId, excludeIds]
    );
    const B = rows[0];
    if (!B) return { error: "Contenedor no encontrado.", status: 404, code: "no_box" };
    if (!B.location_id) {
      return { error: `${B.code} no tiene lugar registrado. Escanee el lugar donde está y después ${B.code}.`, status: 409, code: "box_unplaced", B };
    }
    if (B.capacity != null && B.used + adding > B.capacity) {
      const free = Math.max(0, B.capacity - B.used);
      return {
        error: free ? `${B.code} solo tiene espacio para ${free} rollo(s).` : `${B.code} está lleno (${B.used}/${B.capacity} rollos). Escanee otro contenedor.`,
        status: 409, code: "location_full", B,
      };
    }
    return { B };
  }

  // Old clients send a spot (locationId); new ones send the container (boxId).
  async function boxIdFrom(client, body) {
    const boxId = parseInt(body?.boxId, 10);
    if (boxId) return boxId;
    const locationId = parseInt(body?.locationId, 10);
    if (!locationId) return null;
    const r = await client.query(`SELECT id FROM fabric_boxes WHERE location_id = $1 AND is_active`, [locationId]);
    return r.rows[0]?.id || null;
  }

  // Reserve (requested/assigned) or relocate (in_stock) rolls into a container.
  // Runs its own transaction. Throws { status } errors.
  async function assignRolls(client, { ids, boxId, userId, inTx = false }) {
    const room = await roomInBox(client, boxId, ids, ids.length);
    if (room.error) throw Object.assign(new Error(room.error), { status: room.status, code: room.code });
    const B = room.B;
    if (!inTx) await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE fabric_rolls r
          SET box_id = $2, location_id = $3, container_id = $4,
              status = CASE WHEN r.status = 'requested' THEN 'assigned' ELSE r.status END,
              location_set_at = now(), updated_at = now()
         FROM (SELECT id, location_id AS old_loc, box_id AS old_box, status AS old_status
                 FROM fabric_rolls WHERE id = ANY($1::bigint[]) FOR UPDATE) prev
        WHERE r.id = prev.id AND prev.old_status IN ('requested','assigned','in_stock')
        RETURNING r.id, prev.old_loc, prev.old_status,
                  (SELECT code FROM fabric_boxes WHERE id = prev.old_box) AS old_box_code`,
      [ids, B.id, B.location_id, B.container_id]
    );
    for (const r of rows) {
      await logMove(client, {
        rollId: r.id,
        type: r.old_status === "in_stock" ? "relocated" : "location_set",
        from: r.old_loc, to: B.location_id, fromBox: r.old_box_code, toBox: B.code, userId,
      });
    }
    if (!inTx) await client.query("COMMIT");
    return { updated: rows.length, skipped: ids.length - rows.length, B };
  }

  // Set (or change) the container of rolls. Body: { ids, boxId } (or legacy { ids, locationId })
  // requested/assigned rolls get reserved there; in_stock rolls are relocated.
  app.post(`${BASE}/rolls/assign-location`, authenticateToken, withClient(async (req, res, client) => {
    const ids = idList(req.body?.ids);
    const boxId = await boxIdFrom(client, req.body);
    if (!ids.length || !boxId) return fail(res, 400, "Seleccione rollos y un contenedor.");
    const r = await assignRolls(client, { ids, boxId, userId: req.user?.id });
    res.json({
      success: true, updated: r.updated, skipped: r.skipped,
      box: await boxInfo(client, boxId),
      location: { id: r.B.location_id, code: r.B.location_code, box_id: r.B.id, box_code: r.B.code },
    });
  }));

  // ======================================================================
  //  SCANNING: Lugar (A01) → Contenedor (F33) → Rollos
  // ======================================================================

  // Spot label → spot id. Accepts "A01", "a-01", division+code or a custom qr_code.
  async function resolveLocation(client, text, norm) {
    const { rows } = await client.query(
      `SELECT l.id
         FROM fabric_locations l
         JOIN fabric_containers c ON c.id = l.container_id AND c.is_active
        WHERE UPPER(l.qr_code) = UPPER($1)
           OR regexp_replace(UPPER(l.code), '[^A-Z0-9]', '', 'g') = $2
           OR regexp_replace(UPPER(c.code || l.code), '[^A-Z0-9]', '', 'g') = $2
        ORDER BY (UPPER(l.qr_code) = UPPER($1)) DESC NULLS LAST, l.id
        LIMIT 1`,
      [text, norm]
    );
    return rows[0]?.id || null;
  }

  async function locationInfo(client, id) {
    const { rows } = await client.query(
      `SELECT l.id, l.code, l.container_id, c.code AS container_code, c.code AS division_code, c.name AS container_name,
              b.id AS box_id, b.code AS box_code, COALESCE(b.capacity, l.capacity) AS capacity,
              (SELECT COUNT(*)::int FROM fabric_rolls r WHERE r.location_id = l.id AND r.status = 'in_stock') AS stored,
              (SELECT COUNT(*)::int FROM fabric_rolls r WHERE r.location_id = l.id AND r.status = 'assigned') AS reserved,
              (SELECT COALESCE(SUM(r.yards),0) FROM fabric_rolls r WHERE r.location_id = l.id AND r.status = 'in_stock') AS yards
         FROM fabric_locations l
         JOIN fabric_containers c ON c.id = l.container_id
         LEFT JOIN fabric_boxes b ON b.location_id = l.id AND b.is_active
        WHERE l.id = $1`,
      [id]
    );
    return rows[0] || null;
  }

  // What is this code? → { kind: "box", box } | { kind: "location", location }
  //                     | { kind: "unknown_box", code } (only when expect = "box")
  //                     | null (treat it as a roll barcode)
  async function classifyCode(client, raw, expect) {
    // A label printed with a custom QR text (fabric_locations.qr_code) wins.
    const whole = cleanScan(raw);
    if (whole && whole.length <= 120) {
      const q = await client.query(`SELECT id FROM fabric_locations WHERE UPPER(qr_code) = UPPER($1) LIMIT 1`, [whole]);
      if (q.rows.length) return { kind: "location", location: await locationInfo(client, q.rows[0].id) };
    }
    const cands = labelCandidates(raw, expect);
    for (const c of cands) {
      const text = c.code;
      const norm = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!norm || /^\d{6,}$/.test(norm)) continue; // long numbers are roll barcodes
      const code = normBox(text);
      if (c.kind !== "spot") {
        const b = await client.query(
          `SELECT id FROM fabric_boxes
            WHERE is_active AND (UPPER(code) = $1 OR regexp_replace(UPPER(code), '[^A-Z0-9]', '', 'g') = $2)
            LIMIT 1`,
          [code, norm]
        );
        if (b.rows.length) return { kind: "box", box: await boxInfo(client, b.rows[0].id) };
      }
      if (c.kind !== "box") {
        const loc = await resolveLocation(client, text, norm);
        if (loc) return { kind: "location", location: await locationInfo(client, loc) };
      }
    }
    if (expect === "box") {
      const c = cands.find((x) => /^[A-Z]{1,4}\d{1,4}$/.test(normBox(x.code) || ""));
      if (c) {
        const code = normBox(c.code);
        return { kind: "invalid_box", code, error: `${code} no es uno de los ${BOX_COUNT} contenedores (${BOX_CATALOG.first}–${BOX_CATALOG.last}).` };
      }
    }
    return null;
  }

  // Scanner test: what did the PDA send and what does the system understand?
  // Nothing is saved. Body: { raw, expect? }
  app.post(`${BASE}/scan-test`, authenticateToken, withClient(async (req, res, client) => {
    const raw = String(req.body?.raw ?? "");
    const hit = await classifyCode(client, raw, req.body?.expect);
    let roll = null;
    if (!hit) {
      const f = await findScannedRoll(client, raw);
      roll = f.error ? { error: f.error } : { roll_no: f.scan.roll_no, found: f.rows.length, status: f.rows[0]?.status || null };
    }
    res.json({
      success: true,
      cleaned: cleanScan(raw),
      candidates: labelCandidates(raw, req.body?.expect).map((c) => c.code),
      kind: hit?.kind || (roll && !roll.error ? "roll" : "unknown"),
      box: hit?.box ? { code: hit.box.code, location_code: hit.box.location_code } : null,
      location: hit?.location ? { code: hit.location.code, box_code: hit.location.box_code } : null,
      invalid: hit?.kind === "invalid_box" ? hit.error : null,
      roll,
    });
  }));

  // Finds the roll behind a scanned barcode. → { scan, rows } | { error }
  async function findScannedRoll(client, raw, statusSql = `r.status <> 'cancelled'`) {
    const scan = parseRollScan(raw);
    if (!scan) return { error: "No se pudo leer el código del rollo.", status: 400 };
    const params = [scan.roll_no.toUpperCase()];
    let extra = "";
    if (scan.supplier_code) { params.push(scan.supplier_code.toUpperCase()); extra = ` AND (UPPER(r.supplier_code) = $2 OR r.source = 'scan')`; }
    const found = await client.query(
      `${ROLL_SELECT} WHERE UPPER(r.roll_no) = $1${extra} AND ${statusSql} ORDER BY r.id DESC`,
      params
    );
    return { scan, rows: found.rows };
  }

  // Receive one scanned roll into the active container. Returns { status, body }.
  async function receiveRoll(client, { raw, boxId, allowUnrequested, userId, inTx = false }) {
    const f = await findScannedRoll(client, raw);
    if (f.error) return { status: f.status, body: { success: false, error: f.error } };
    const { scan } = f;
    if (!boxId) {
      return { status: 409, body: { success: false, code: "no_box", error: "Escanee primero el lugar (A01) y después el contenedor (F01)." } };
    }

    // Not requested from Skytex: register it right here if allowed.
    if (!f.rows.length) {
      if (!allowUnrequested) {
        return { status: 404, body: { success: false, code: "not_requested", rollNo: scan.roll_no,
          error: `El rollo ${scan.roll_no} no fue solicitado a Skytex.` } };
      }
      const room = await roomInBox(client, boxId);
      if (room.error) return { status: room.status, body: { success: false, code: room.code, error: room.error } };
      if (!inTx) await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO fabric_rolls (skytex_key, roll_no, supplier_code, raw, status, source, box_id, container_id, location_id,
                                   received_at, received_by, requested_by, location_set_at)
         VALUES ($1, $2, $3, $4, 'in_stock', 'scan', $5, $6, $7, now(), $8, $8, now())
         ON CONFLICT (skytex_key) DO UPDATE
           SET status = 'in_stock', box_id = EXCLUDED.box_id, container_id = EXCLUDED.container_id,
               location_id = EXCLUDED.location_id, received_at = now(), received_by = EXCLUDED.received_by, updated_at = now()
         RETURNING id`,
        [`SCAN|${scan.roll_no.toUpperCase()}`, scan.roll_no, scan.supplier_code, JSON.stringify({ scanned: scan.raw }),
         room.B.id, room.B.container_id, room.B.location_id, userId ?? null]
      );
      await logMove(client, { rollId: ins.rows[0].id, type: "received", to: room.B.location_id, toBox: room.B.code, reason: "Sin solicitud a Skytex", userId });
      if (!inTx) await client.query("COMMIT");
      const fresh = await client.query(`${ROLL_SELECT} WHERE r.id = $1`, [ins.rows[0].id]);
      return { status: 200, body: { success: true, duplicate: false, unrequested: true, roll: fresh.rows[0] } };
    }

    const pending = f.rows.filter((r) => ["requested", "assigned"].includes(r.status));
    if (!pending.length) {
      const r = f.rows[0];
      const where = r.box_code ? ` en ${r.box_code}${r.location_code ? ` (${r.location_code})` : ""}` : r.location_code ? ` en ${r.location_code}` : "";
      return { status: 200, body: { success: true, duplicate: true, roll: r,
        message: r.status === "in_stock" ? `Este rollo ya está guardado${where}.` : `El rollo ya está en estado «${r.status}».` } };
    }
    if (pending.length > 1) {
      return { status: 409, body: { success: false, error: `Hay ${pending.length} rollos ${scan.roll_no} de distintos proveedores. Escanee el código completo.` } };
    }
    const roll = pending[0];
    const room = await roomInBox(client, boxId, [roll.id]);
    if (room.error) return { status: room.status, body: { success: false, code: room.code, error: room.error } };

    if (!inTx) await client.query("BEGIN");
    await client.query(
      `UPDATE fabric_rolls
          SET status = 'in_stock', box_id = $2, location_id = $3, container_id = $4,
              received_at = now(), received_by = $5, updated_at = now()
        WHERE id = $1`,
      [roll.id, room.B.id, room.B.location_id, room.B.container_id, userId ?? null]
    );
    const moved = !!(roll.box_id && String(roll.box_id) !== String(room.B.id));
    await logMove(client, {
      rollId: roll.id, type: "received",
      from: moved ? roll.location_id : null, fromBox: moved ? roll.box_code : null,
      to: room.B.location_id, toBox: room.B.code, reference: roll.po_number, userId,
    });
    if (!inTx) await client.query("COMMIT");
    const fresh = await client.query(`${ROLL_SELECT} WHERE r.id = $1`, [roll.id]);
    return { status: 200, body: { success: true, duplicate: false, roll: fresh.rows[0], movedFromAssigned: moved, reservedIn: moved ? roll.box_code : null } };
  }

  // Reserve one scanned (requested) roll in the active container.
  async function reserveRoll(client, { raw, boxId, userId, inTx = false }) {
    const f = await findScannedRoll(client, raw);
    if (f.error) return { status: f.status, body: { success: false, error: f.error } };
    if (!boxId) {
      return { status: 409, body: { success: false, code: "no_box", error: "Escanee primero el lugar (A01) y después el contenedor (F01)." } };
    }
    if (!f.rows.length) {
      return { status: 404, body: { success: false, code: "not_requested", rollNo: f.scan.roll_no,
        error: `El rollo ${f.scan.roll_no} no ha sido solicitado a Skytex.` } };
    }
    const pending = f.rows.filter((r) => ["requested", "assigned"].includes(r.status));
    if (!pending.length) {
      const r = f.rows[0];
      return { status: 200, body: { success: true, duplicate: true, roll: r,
        message: r.status === "in_stock"
          ? `${r.roll_no} ya llegó y está guardado en ${r.box_code || r.location_code || "—"}.`
          : `El rollo ya está en estado «${r.status}».` } };
    }
    if (pending.length > 1) {
      return { status: 409, body: { success: false, error: `Hay ${pending.length} rollos ${f.scan.roll_no} de distintos proveedores. Escanee el código completo.` } };
    }
    const roll = pending[0];
    if (roll.status === "assigned" && String(roll.box_id) === String(boxId)) {
      return { status: 200, body: { success: true, duplicate: true, roll, message: `${roll.roll_no} ya está reservado en ${roll.box_code}.` } };
    }
    let r;
    try {
      r = await assignRolls(client, { ids: [roll.id], boxId, userId, inTx });
    } catch (e) {
      if (!e.status) throw e;
      return { status: e.status, body: { success: false, code: e.code, error: e.message } };
    }
    if (!r.updated) return { status: 409, body: { success: false, error: "El rollo cambió de estado. Actualice e intente de nuevo." } };
    const fresh = await client.query(`${ROLL_SELECT} WHERE r.id = $1`, [roll.id]);
    return { status: 200, body: { success: true, duplicate: false, roll: fresh.rows[0], changedFrom: roll.status === "assigned" ? roll.box_code : null } };
  }

  // One endpoint for every label the PDA reads.
  //   Body: { raw, boxId?, expect?, allowUnrequested?, check? }
  //   • spot label (A01)      → { kind: "location", location }
  //   • container label (F33) → { kind: "box", box }   (unknown code + expect "box" → { kind: "unknown_box", code })
  //   • roll barcode          → roll received into boxId → { kind: "roll", roll, box }
  //     With check: true nothing is saved: the roll is validated exactly as it
  //     would be saved (same code, rolled back) so the PDA can build a list and
  //     save it with /scan-batch.
  // /reserve-scan is the same, but a roll is RESERVED in boxId (before arrival).
  const MAX_BATCH = 40;
  const runRoll = (client, mode, { raw, boxId, allowUnrequested, userId, inTx }) =>
    mode === "reserve"
      ? reserveRoll(client, { raw, boxId, userId, inTx })
      : receiveRoll(client, { raw, boxId, allowUnrequested, userId, inTx });

  const scanHandler = (mode) => withClient(async (req, res, client) => {
    const raw = str(req.body?.raw);
    if (!raw) return fail(res, 400, "Código vacío.");
    const hit = await classifyCode(client, raw, req.body?.expect);
    if (hit) return res.json({ success: true, ...hit });
    const boxId = await boxIdFrom(client, req.body);
    const args = { raw, boxId, allowUnrequested: req.body?.allowUnrequested === true, userId: req.user?.id };
    let r;
    if (req.body?.check === true) {
      await client.query("BEGIN");
      try { r = await runRoll(client, mode, { ...args, inTx: true }); }
      finally { await client.query("ROLLBACK"); }
      r.body.check = true;
      // Already counted in this container (reserved/stored there)? Then saving it
      // does not take extra space.
      if (r.body.roll?.id) {
        const before = await client.query(`SELECT box_id, status FROM fabric_rolls WHERE id = $1`, [r.body.roll.id]);
        const b0 = before.rows[0];
        r.body.takesSpace = !(b0 && String(b0.box_id) === String(boxId) && ["assigned", "in_stock"].includes(b0.status));
      }
    } else {
      r = await runRoll(client, mode, args);
      if (r.body.success && r.body.roll?.box_id) r.body.box = await boxInfo(client, r.body.roll.box_id);
    }
    res.status(r.status).json({ kind: "roll", ...r.body });
  });
  app.post(`${BASE}/scan`, authenticateToken, scanHandler("receive"));
  app.post(`${BASE}/reserve-scan`, authenticateToken, scanHandler("reserve"));

  // Save a list of scanned rolls (1–40) into one container, all together.
  //   Body: { mode: "receive"|"reserve", boxId, rolls: [{ raw, allowUnrequested? }] }
  //   All or nothing: if any roll fails, nothing is saved and every roll comes
  //   back with its own result so the PDA can show which ones to fix.
  //   Rolls that were already saved there count as duplicates, not errors.
  app.post(`${BASE}/scan-batch`, authenticateToken, withClient(async (req, res, client) => {
    const mode = req.body?.mode === "reserve" ? "reserve" : "receive";
    const items = (Array.isArray(req.body?.rolls) ? req.body.rolls : [])
      .map((x) => (typeof x === "string" ? { raw: x } : x))
      .map((x) => ({ raw: str(x?.raw), allowUnrequested: x?.allowUnrequested === true }))
      .filter((x) => x.raw);
    if (!items.length) return fail(res, 400, "No hay rollos que guardar.");
    if (items.length > MAX_BATCH) return fail(res, 400, `Máximo ${MAX_BATCH} rollos por guardado.`);
    const boxId = await boxIdFrom(client, req.body);
    if (!boxId) return fail(res, 400, "Escanee primero el lugar y el contenedor.");

    await client.query("BEGIN");
    const results = [];
    const seen = new Set();
    for (const it of items) {
      const r = await runRoll(client, mode, { raw: it.raw, boxId, allowUnrequested: it.allowUnrequested, userId: req.user?.id, inTx: true });
      const b = r.body;
      const key = b.roll?.id;
      const repeated = key && seen.has(String(key));
      if (key) seen.add(String(key));
      results.push({
        raw: it.raw,
        ok: !!b.success && !b.duplicate,
        duplicate: !!b.duplicate || repeated,
        error: b.success ? null : b.error,
        code: b.code || null,
        message: b.message || null,
        roll: b.roll || null,
      });
    }
    const failed = results.filter((x) => x.error);
    if (failed.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        error: `${failed.length} rollo(s) con problema. No se guardó ninguno: quítelos de la lista o corríjalos y vuelva a guardar.`,
        results,
      });
    }
    await client.query("COMMIT");
    res.json({
      success: true,
      saved: results.filter((x) => x.ok).length,
      duplicates: results.filter((x) => x.duplicate).length,
      results,
      box: await boxInfo(client, boxId),
    });
  }));

  // Roll-only receive (kept for compatibility). Body: { raw, boxId | locationId, allowUnrequested? }
  app.post(`${BASE}/scan-in`, authenticateToken, withClient(async (req, res, client) => {
    const r = await receiveRoll(client, {
      raw: req.body?.raw,
      boxId: await boxIdFrom(client, req.body),
      allowUnrequested: req.body?.allowUnrequested === true,
      userId: req.user?.id,
    });
    res.status(r.status).json(r.body);
  }));

  // Rolls in one container (newest first) + its counters.
  // ?include=inspection also lists its rolls that are out at inspection.
  app.get(`${BASE}/boxes/:id/rolls`, authenticateToken, withClient(async (req, res, client) => {
    const info = await boxInfo(client, req.params.id);
    if (!info) return fail(res, 404, "Contenedor no encontrado.");
    const statuses = req.query.include === "inspection" ? ["in_stock", "assigned", "at_inspection"] : ["in_stock", "assigned"];
    const { rows } = await client.query(
      `${ROLL_SELECT} WHERE r.box_id = $1 AND r.status = ANY($2::text[])
       ORDER BY (r.status = 'in_stock') DESC, COALESCE(r.received_at, r.location_set_at) DESC NULLS LAST, r.id DESC`,
      [req.params.id, statuses]
    );
    res.json({ success: true, box: info, rolls: rows, agingDays: AGING_DAYS });
  }));

  // Rolls stored on one spot (kept for compatibility).
  app.get(`${BASE}/locations/:id/rolls`, authenticateToken, withClient(async (req, res, client) => {
    const info = await locationInfo(client, req.params.id);
    if (!info) return fail(res, 404, "Ubicación no encontrada.");
    const { rows } = await client.query(
      `${ROLL_SELECT} WHERE r.location_id = $1 AND r.status IN ('in_stock','assigned')
       ORDER BY (r.status = 'in_stock') DESC, r.received_at DESC NULLS LAST, r.id DESC`,
      [req.params.id]
    );
    res.json({ success: true, location: info, rolls: rows });
  }));

  // Undo a receipt scanned by mistake (only while still in stock).
  app.post(`${BASE}/rolls/:id/undo-receive`, authenticateToken, withClient(async (req, res, client) => {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE fabric_rolls SET status = 'assigned', received_at = NULL, received_by = NULL, updated_at = now()
        WHERE id = $1 AND status = 'in_stock' RETURNING id, location_id`,
      [req.params.id]
    );
    if (!rows.length) { await client.query("ROLLBACK"); return fail(res, 409, "Solo se puede deshacer un rollo que sigue en inventario."); }
    await logMove(client, { rollId: rows[0].id, type: "receive_undone", from: rows[0].location_id, userId: req.user?.id });
    await client.query("COMMIT");
    res.json({ success: true });
  }));

  // Resolve a scanned code to a roll (used by the inspection send screen).
  app.post(`${BASE}/lookup`, authenticateToken, withClient(async (req, res, client) => {
    const scan = parseRollScan(req.body?.raw);
    if (!scan) return fail(res, 400, "No se pudo leer el código.");
    const params = [scan.roll_no.toUpperCase()];
    let extra = "";
    if (scan.supplier_code) { params.push(scan.supplier_code.toUpperCase()); extra = ` AND UPPER(r.supplier_code) = $2`; }
    const { rows } = await client.query(
      `${ROLL_SELECT} WHERE UPPER(r.roll_no) = $1${extra} AND r.status <> 'cancelled' ORDER BY r.id DESC`,
      params
    );
    if (!rows.length) return fail(res, 404, `No existe el rollo ${scan.roll_no}.`);
    res.json({ success: true, rolls: rows });
  }));

  // ======================================================================
  //  CONTAINERS + LOCATIONS
  // ======================================================================

  app.get(`${BASE}/containers`, authenticateToken, withClient(async (req, res, client) => {
    const { rows } = await client.query(`
      SELECT c.*,
             COALESCE((
               SELECT json_agg(json_build_object(
                        'id', l.id, 'code', l.code, 'capacity', COALESCE(b.capacity, l.capacity),
                        'box_id', b.id, 'box_code', b.code,
                        'reserved', s.reserved, 'stored', s.stored, 'inspection', s.inspection,
                        'yards', s.yards, 'meters', s.meters,
                        'aged', s.aged, 'oldest_days', s.oldest_days,
                        'main_fabric', s.main_fabric, 'fabrics', s.fabrics)
                      ORDER BY l.sort_order, l.code)
                 FROM fabric_locations l
                 LEFT JOIN fabric_boxes b ON b.location_id = l.id AND b.is_active
                 CROSS JOIN LATERAL (
                   SELECT COUNT(*) FILTER (WHERE r.status = 'assigned')::int      AS reserved,
                          COUNT(*) FILTER (WHERE r.status = 'in_stock')::int      AS stored,
                          COUNT(*) FILTER (WHERE r.status = 'at_inspection')::int AS inspection,
                          COALESCE(SUM(r.yards)  FILTER (WHERE r.status = 'in_stock'), 0) AS yards,
                          COALESCE(SUM(r.meters) FILTER (WHERE r.status = 'in_stock'), 0) AS meters,
                          COUNT(*) FILTER (WHERE r.status = 'in_stock' AND r.received_at <= now() - make_interval(days => $1))::int AS aged,
                          MAX(FLOOR(EXTRACT(EPOCH FROM (now() - r.received_at)) / 86400))
                            FILTER (WHERE r.status = 'in_stock')::int AS oldest_days,
                          mode() WITHIN GROUP (ORDER BY r.fabric_name)
                            FILTER (WHERE r.status IN ('in_stock','assigned','at_inspection')) AS main_fabric,
                          COUNT(DISTINCT r.fabric_name)
                            FILTER (WHERE r.status IN ('in_stock','assigned','at_inspection'))::int AS fabrics
                     FROM fabric_rolls r WHERE r.location_id = l.id
                 ) s
                WHERE l.container_id = c.id
             ), '[]'::json) AS locations
        FROM fabric_containers c
       WHERE c.is_active = TRUE
       ORDER BY c.code`, [AGING_DAYS]);
    // Containers that are not on any spot right now (moved, waiting to be scanned).
    const unplaced = await client.query(`${BOX_SELECT} WHERE b.is_active AND b.location_id IS NULL ORDER BY b.code`);
    res.json({
      success: true, containers: rows, unplacedBoxes: unplaced.rows, boxCatalog: BOX_CATALOG,
      agingDays: AGING_DAYS, spotsPerDivision: SPOTS_PER_DIVISION, boxCapacity: BOX_CAPACITY,
    });
  }));

  // Body: { code, name?, notes?, locations?: ["A-01", ...] | count?, prefix?, capacity? }
  app.post(`${BASE}/containers`, authenticateToken, withClient(async (req, res, client) => {
    const code = str(req.body?.code);
    if (!code) return fail(res, 400, "Escriba el código del contenedor.");
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO fabric_containers (code, name, notes) VALUES ($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET is_active = TRUE, name = COALESCE(EXCLUDED.name, fabric_containers.name)
       RETURNING *`,
      [code.toUpperCase(), str(req.body?.name), str(req.body?.notes)]
    );
    const added = await addLocations(client, ins.rows[0].id, req.body || {});
    await client.query("COMMIT");
    res.json({ success: true, container: ins.rows[0], locationsAdded: added });
  }));

  // Set how many spots a division has: exactly A01…A14 (count = 14).
  //   Body: { count, dryRun?, capacity?, releaseEmpty = true }
  //   • missing spots (A01…A14) are created
  //   • spots outside that range (A15…A30, or odd codes) are removed when they
  //     hold no rolls. An EMPTY container on one of them is taken off the spot
  //     (it becomes free, «sin lugar»). A spot whose container holds rolls
  //     blocks the change: nothing changes and the reply lists it ("blocked"),
  //     because those rolls must be moved physically first.
  //   dryRun: only returns what would change.
  app.post(`${BASE}/containers/:id/spots`, authenticateToken, withClient(async (req, res, client) => {
    const count = parseInt(req.body?.count, 10);
    if (!(count >= 1 && count <= 99)) return fail(res, 400, "El número de lugares debe estar entre 1 y 99.");
    const div = (await client.query(`SELECT id, code FROM fabric_containers WHERE id = $1 AND is_active`, [req.params.id])).rows[0];
    if (!div) return fail(res, 404, "División no encontrada.");
    const prefix = String(div.code).toUpperCase();
    const target = Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);
    const { rows: spots } = await client.query(
      `SELECT l.id, l.code, l.capacity, b.code AS box_code,
              (SELECT COUNT(*)::int FROM fabric_rolls r
                WHERE r.location_id = l.id AND r.status IN ('assigned','in_stock','at_inspection')) AS rolls
         FROM fabric_locations l
         LEFT JOIN fabric_boxes b ON b.location_id = l.id AND b.is_active
        WHERE l.container_id = $1
        ORDER BY l.code`,
      [div.id]
    );
    const key = (c) => normBox(c);
    const have = new Set(spots.map((x) => key(x.code)));
    const add = target.filter((c) => !have.has(c));
    const removeRows = spots.filter((x) => !target.includes(key(x.code)));
    const releaseEmpty = req.body?.releaseEmpty !== false;
    const blocked = removeRows.filter((x) => x.rolls > 0 || (x.box_code && !releaseEmpty))
      .map((x) => ({ code: x.code, box_code: x.box_code, rolls: x.rolls }));
    const release = removeRows.filter((x) => x.box_code && x.rolls === 0 && releaseEmpty).map((x) => x.box_code);
    const summary = {
      division: div.code, count, current: spots.length,
      add, remove: removeRows.map((x) => x.code), blocked, release,
    };
    if (req.body?.dryRun) return res.json({ success: true, ...summary });
    if (blocked.length) {
      return res.status(409).json({
        success: false, ...summary,
        error: `División ${div.code}: ${blocked.map((b) => b.box_code ? `${b.code} (${b.box_code})` : b.code).join(", ")} ` +
          `todavía tiene${blocked.length > 1 ? "n" : ""} rollos. Mueva ese contenedor a un lugar entre ${target[0]} y ${target[target.length - 1]} primero.`,
      });
    }
    const capacity = BOX_CAPACITY;
    await client.query("BEGIN");
    if (removeRows.length) {
      // empty containers on the removed spots become free (no spot)
      await client.query(`UPDATE fabric_boxes SET location_id = NULL, placed_at = now() WHERE location_id = ANY($1::bigint[])`, [removeRows.map((x) => x.id)]);
      await client.query(`DELETE FROM fabric_locations WHERE id = ANY($1::bigint[])`, [removeRows.map((x) => x.id)]);
    }
    for (const c of add) {
      await client.query(
        `INSERT INTO fabric_locations (container_id, code, capacity, sort_order) VALUES ($1, $2, $3, 0)
         ON CONFLICT (container_id, code) DO NOTHING`,
        [div.id, c, capacity]
      );
    }
    // keep A01, A02 … in order
    await client.query(
      `UPDATE fabric_locations l SET sort_order = x.rn
         FROM (SELECT id, row_number() OVER (ORDER BY code) AS rn FROM fabric_locations WHERE container_id = $1) x
        WHERE l.id = x.id`,
      [div.id]
    );
    await client.query("COMMIT");
    res.json({ success: true, ...summary });
  }));

  app.post(`${BASE}/containers/:id/locations`, authenticateToken, withClient(async (req, res, client) => {
    await client.query("BEGIN");
    const added = await addLocations(client, req.params.id, req.body || {});
    await client.query("COMMIT");
    res.json({ success: true, locationsAdded: added });
  }));

  async function addLocations(client, containerId, body) {
    let codes = Array.isArray(body.locations) ? body.locations.map(str).filter(Boolean) : [];
    const count = Math.min(500, parseInt(body.count, 10) || 0);
    if (!codes.length && count > 0) {
      const cont = (await client.query(`SELECT code FROM fabric_containers WHERE id = $1`, [containerId])).rows[0];
      const prefix = str(body.prefix) || cont?.code || "P";
      const sep = body.separator != null ? String(body.separator) : "";
      const start = (await client.query(
        `SELECT COUNT(*)::int AS n FROM fabric_locations WHERE container_id = $1`, [containerId]
      )).rows[0].n;
      codes = Array.from({ length: count }, (_, i) => `${prefix}${sep}${String(start + i + 1).padStart(2, "0")}`);
    }
    const capacity = BOX_CAPACITY; // same for every container
    let added = 0;
    for (const [i, c] of codes.entries()) {
      const r = await client.query(
        `INSERT INTO fabric_locations (container_id, code, capacity, sort_order)
         VALUES ($1, $2, $3, (SELECT COALESCE(MAX(sort_order),0) + 1 + $4 FROM fabric_locations WHERE container_id = $1))
         ON CONFLICT (container_id, code) DO NOTHING`,
        [containerId, c.toUpperCase(), capacity, i]
      );
      added += r.rowCount;
    }
    return added;
  }

  app.delete(`${BASE}/locations/:id`, authenticateToken, withClient(async (req, res, client) => {
    const used = await client.query(
      `SELECT COUNT(*)::int AS n FROM fabric_rolls WHERE location_id = $1 AND status IN ('assigned','in_stock','at_inspection')`,
      [req.params.id]
    );
    if (used.rows[0].n > 0) return fail(res, 409, "La ubicación tiene rollos. Muévalos primero.");
    const box = await client.query(
      `SELECT l.code, b.code AS box_code FROM fabric_locations l JOIN fabric_boxes b ON b.location_id = l.id WHERE l.id = $1`,
      [req.params.id]
    );
    if (box.rows[0]?.box_code) {
      return fail(res, 409, `En ${box.rows[0].code} está el contenedor ${box.rows[0].box_code}. Quítelo o muévalo primero.`);
    }
    await client.query(`DELETE FROM fabric_locations WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  }));

  // ---- Containers (F01…F80) on the spots (A01…E30) ------------------------
  // GET /boxes → every active container, placed or not.
  app.get(`${BASE}/boxes`, authenticateToken, withClient(async (req, res, client) => {
    const { rows } = await client.query(`${BOX_SELECT} WHERE b.is_active ORDER BY b.code`);
    res.json({ success: true, boxes: rows, catalog: BOX_CATALOG });
  }));

  // Body: { pairs: [{ locationId, boxCode }], allowMove = true, displace = false }
  //   • container without a spot      → placed on the spot
  //   • code that is not one of the catalog containers (F01…F80) → error
  //   • container on another spot     → it MOVES here with all its rolls (needs allowMove)
  //   • spot already has a container  → error, or with displace the old one stays
  //                                     "sin lugar" (keeps its rolls) until it is scanned
  //                                     on its new spot
  //   • empty boxCode                 → the container is taken off the spot (keeps its rolls)
  // All pairs run in one transaction: any error undoes the whole batch.
  app.post(`${BASE}/boxes/place`, authenticateToken, withClient(async (req, res, client) => {
    const pairs = Array.isArray(req.body?.pairs) ? req.body.pairs : [];
    if (!pairs.length) return fail(res, 400, "No hay contenedores que colocar.");
    if (pairs.length > 500) return fail(res, 400, "Máximo 500 contenedores por operación.");
    const allowMove = req.body?.allowMove !== false;
    const displace = req.body?.displace === true;
    const userId = req.user?.id;
    const stop = (status, msg) => Object.assign(new Error(msg), { status });
    const ACTIVE = `('assigned','in_stock','at_inspection')`;

    // Take a container off its spot; its rolls stay in it, without a spot.
    const unplace = async (box, spot) => {
      await client.query(`UPDATE fabric_boxes SET location_id = NULL, placed_at = now() WHERE id = $1`, [box.id]);
      const r = await client.query(
        `UPDATE fabric_rolls SET location_id = NULL, container_id = NULL, updated_at = now()
          WHERE box_id = $1 AND status IN ${ACTIVE} RETURNING id`, [box.id]
      );
      for (const x of r.rows) await logMove(client, { rollId: x.id, type: "box_moved", from: spot.id, fromBox: box.code, toBox: box.code, userId });
    };

    await client.query("BEGIN");
    const done = [];
    const touched = [];
    for (const p of pairs) {
      const locId = parseInt(p?.locationId, 10);
      const code = normBox(p?.boxCode);
      if (code && code.length > 40) throw stop(400, `Código de contenedor demasiado largo: ${code}.`);
      const spot = (await client.query(
        `SELECT id, code, container_id, capacity FROM fabric_locations WHERE id = $1 FOR UPDATE`, [locId]
      )).rows[0];
      if (!spot) throw stop(404, "Lugar no encontrado.");
      const here = (await client.query(
        `SELECT id, code FROM fabric_boxes WHERE location_id = $1 FOR UPDATE`, [spot.id]
      )).rows[0];

      if (!code) {
        if (!here) continue;
        await unplace(here, spot);
        done.push({ action: "removed", box: here.code, from: spot.code });
        continue;
      }
      if (here && here.code.toUpperCase() === code) { touched.push(here.id); continue; }
      if (here) {
        if (!displace) throw stop(409, `En ${spot.code} está el contenedor ${here.code}. Quítelo o muévalo primero.`);
        await unplace(here, spot);
        done.push({ action: "displaced", box: here.code, from: spot.code });
      }

      let box = (await client.query(
        `SELECT b.id, b.code, b.location_id, b.is_active, l.code AS location_code
           FROM fabric_boxes b LEFT JOIN fabric_locations l ON l.id = b.location_id
          WHERE UPPER(b.code) = $1 AND b.is_active FOR UPDATE OF b`, [code]
      )).rows[0];
      if (!box) throw stop(409, `${code} no es uno de los ${BOX_COUNT} contenedores (${BOX_CATALOG.first}–${BOX_CATALOG.last}).`);
      if (box && box.location_id && !allowMove) throw stop(409, `${code} ya está en ${box.location_code}.`);

      {
        const fromId = box.location_id;
        await client.query(`UPDATE fabric_boxes SET location_id = $2, is_active = TRUE, placed_at = now() WHERE id = $1`, [box.id, spot.id]);
        const moved = await client.query(
          `UPDATE fabric_rolls SET location_id = $2, container_id = $3, updated_at = now()
            WHERE box_id = $1 AND status IN ${ACTIVE} RETURNING id`,
          [box.id, spot.id, spot.container_id]
        );
        for (const x of moved.rows) {
          await logMove(client, { rollId: x.id, type: "box_moved", from: fromId, to: spot.id, fromBox: code, toBox: code, userId });
        }
        done.push({ action: fromId ? "moved" : "placed", box: code, from: box.location_code || null, to: spot.code, rolls: moved.rowCount });
      }
      // Rolls registered on this spot before it had a container go into it.
      await client.query(
        `UPDATE fabric_rolls SET box_id = $1, updated_at = now()
          WHERE location_id = $2 AND box_id IS NULL AND status IN ${ACTIVE}`,
        [box.id, spot.id]
      );
      touched.push(box.id);
    }
    await client.query("COMMIT");
    const boxes = [];
    for (const id of touched) boxes.push(await boxInfo(client, id));
    res.json({ success: true, done, boxes });
  }));

  app.delete(`${BASE}/containers/:id`, authenticateToken, withClient(async (req, res, client) => {
    const used = await client.query(
      `SELECT COUNT(*)::int AS n FROM fabric_rolls WHERE container_id = $1 AND status IN ('assigned','in_stock','at_inspection')`,
      [req.params.id]
    );
    if (used.rows[0].n > 0) return fail(res, 409, "Los contenedores de la división tienen rollos. Muévalos primero.");
    await client.query(
      `UPDATE fabric_boxes SET location_id = NULL WHERE location_id IN (SELECT id FROM fabric_locations WHERE container_id = $1)`,
      [req.params.id]
    );
    await client.query(`UPDATE fabric_containers SET is_active = FALSE WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  }));

  // ======================================================================
  //  FABRIC INSPECTION
  // ======================================================================

  app.get(`${BASE}/inspection-requests`, authenticateToken, withClient(async (req, res, client) => {
    const statuses = String(req.query.status || "open,partial").split(",").map((s) => s.trim()).filter(Boolean);
    const { rows } = await client.query(
      `SELECT ir.*,
              COALESCE((
                SELECT json_agg(json_build_object(
                         'id', r.id, 'roll_no', r.roll_no, 'po_number', r.po_number, 'supplier', r.supplier,
                         'fabric_name', r.fabric_name, 'color', r.color, 'lot', r.lot, 'yards', r.yards,
                         'meters', r.meters, 'status', r.status, 'sent_at', it.sent_at,
                         'container_code', c.code, 'location_code', l.code, 'box_code', b.code)
                       ORDER BY b.code, l.code, r.roll_no)
                  FROM fabric_inspection_request_items it
                  JOIN fabric_rolls r ON r.id = it.roll_id
                  LEFT JOIN fabric_containers c ON c.id = r.container_id
                  LEFT JOIN fabric_locations l ON l.id = r.location_id
                  LEFT JOIN fabric_boxes b ON b.id = r.box_id
                 WHERE it.request_id = ir.id
              ), '[]'::json) AS rolls
         FROM fabric_inspection_requests ir
        WHERE ir.status = ANY($1::text[])
        ORDER BY ir.created_at DESC
        LIMIT 200`,
      [statuses]
    );
    res.json({ success: true, requests: rows });
  }));

  // Inspection team asks for rolls. Body: { rollIds, notes }
  app.post(`${BASE}/inspection-requests`, authenticateToken, withClient(async (req, res, client) => {
    const ids = idList(req.body?.rollIds);
    if (!ids.length) return fail(res, 400, "Seleccione al menos un rollo.");
    const check = await client.query(
      `SELECT r.id, r.roll_no, r.status,
              EXISTS (SELECT 1 FROM fabric_inspection_request_items it
                        JOIN fabric_inspection_requests ir ON ir.id = it.request_id
                       WHERE it.roll_id = r.id AND it.sent_at IS NULL AND ir.status IN ('open','partial')) AS busy
         FROM fabric_rolls r WHERE r.id = ANY($1::bigint[])`,
      [ids]
    );
    const bad = check.rows.filter((r) => r.status !== "in_stock" || r.busy);
    if (bad.length) {
      return fail(res, 409, `Estos rollos no están disponibles: ${bad.map((r) => r.roll_no).join(", ")}`);
    }
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO fabric_inspection_requests (notes, requested_by, requested_by_name)
       VALUES ($1,$2,$3) RETURNING id`,
      [str(req.body?.notes), req.user?.id ?? null, req.user?.full_name || req.user?.username || null]
    );
    const id = ins.rows[0].id;
    await client.query(
      `UPDATE fabric_inspection_requests SET request_no = 'INS-' || LPAD(id::text, 5, '0') WHERE id = $1`, [id]
    );
    for (const rollId of ids) {
      await client.query(`INSERT INTO fabric_inspection_request_items (request_id, roll_id) VALUES ($1,$2)`, [id, rollId]);
    }
    await client.query("COMMIT");
    const { rows } = await client.query(`SELECT * FROM fabric_inspection_requests WHERE id = $1`, [id]);
    res.json({ success: true, request: rows[0] });
  }));

  // Warehouse sends the rolls. Body: { rollIds? }  (default: every unsent roll)
  app.post(`${BASE}/inspection-requests/:id/send`, authenticateToken, withClient(async (req, res, client) => {
    const reqId = parseInt(req.params.id, 10);
    const head = await client.query(`SELECT * FROM fabric_inspection_requests WHERE id = $1`, [reqId]);
    if (!head.rows.length) return fail(res, 404, "Solicitud no encontrada.");
    if (!["open", "partial"].includes(head.rows[0].status)) return fail(res, 409, "La solicitud ya fue cerrada.");

    const wanted = idList(req.body?.rollIds);
    await client.query("BEGIN");
    const items = await client.query(
      `SELECT it.roll_id, r.location_id, r.status
         FROM fabric_inspection_request_items it JOIN fabric_rolls r ON r.id = it.roll_id
        WHERE it.request_id = $1 AND it.sent_at IS NULL
          ${wanted.length ? "AND it.roll_id = ANY($2::bigint[])" : ""}
        FOR UPDATE OF r`,
      wanted.length ? [reqId, wanted] : [reqId]
    );
    let sent = 0;
    const skipped = [];
    for (const it of items.rows) {
      if (it.status !== "in_stock") { skipped.push(it.roll_id); continue; }
      await client.query(
        `UPDATE fabric_rolls SET status = 'at_inspection', out_at = now(), updated_at = now() WHERE id = $1`, [it.roll_id]
      );
      await client.query(
        `UPDATE fabric_inspection_request_items SET sent_at = now() WHERE request_id = $1 AND roll_id = $2`, [reqId, it.roll_id]
      );
      await logMove(client, { rollId: it.roll_id, type: "inspection_out", from: it.location_id, reference: head.rows[0].request_no, userId: req.user?.id });
      sent++;
    }
    const left = await client.query(
      `SELECT COUNT(*)::int AS n FROM fabric_inspection_request_items WHERE request_id = $1 AND sent_at IS NULL`, [reqId]
    );
    const status = left.rows[0].n === 0 ? "sent" : sent > 0 || head.rows[0].status === "partial" ? "partial" : "open";
    await client.query(
      `UPDATE fabric_inspection_requests
          SET status = $2::varchar, sent_at = CASE WHEN $2::varchar = 'sent' THEN now() ELSE sent_at END
        WHERE id = $1`,
      [reqId, status]
    );
    await client.query("COMMIT");
    res.json({ success: true, sent, skipped, status });
  }));

  app.post(`${BASE}/inspection-requests/:id/cancel`, authenticateToken, withClient(async (req, res, client) => {
    const { rowCount } = await client.query(
      `UPDATE fabric_inspection_requests SET status = 'cancelled' WHERE id = $1 AND status = 'open'`, [req.params.id]
    );
    if (!rowCount) return fail(res, 409, "Solo se puede cancelar una solicitud que no se ha enviado.");
    res.json({ success: true });
  }));

  // Rolls come back from inspection. Body: { ids, result: 'approved'|'rejected', boxId? }
  // Without boxId each roll goes back to its own container (wherever it is now).
  app.post(`${BASE}/rolls/return-from-inspection`, authenticateToken, withClient(async (req, res, client) => {
    const ids = idList(req.body?.ids);
    const result = ["approved", "rejected"].includes(req.body?.result) ? req.body.result : null;
    if (!ids.length || !result) return fail(res, 400, "Seleccione rollos y el resultado de la inspección.");
    const boxId = await boxIdFrom(client, req.body);
    if (boxId) {
      const room = await roomInBox(client, boxId, ids, ids.length);
      if (room.error) return fail(res, room.status, room.error);
    } else if (req.body?.locationId) {
      return fail(res, 409, "En ese lugar no hay contenedor.");
    }
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE fabric_rolls r
          SET status = 'in_stock', inspection_result = $2, out_at = NULL,
              box_id = COALESCE($3::bigint, r.box_id),
              location_id = COALESCE(nb.location_id, r.location_id),
              container_id = COALESCE(nl.container_id, r.container_id),
              updated_at = now()
         FROM fabric_rolls r0
         LEFT JOIN fabric_boxes nb ON nb.id = COALESCE($3::bigint, r0.box_id)
         LEFT JOIN fabric_locations nl ON nl.id = nb.location_id
        WHERE r.id = r0.id AND r.id = ANY($1::bigint[]) AND r.status = 'at_inspection'
        RETURNING r.id, r.location_id`,
      [ids, result, boxId]
    );
    for (const r of rows) {
      await logMove(client, { rollId: r.id, type: "inspection_back", to: r.location_id, reason: result, userId: req.user?.id });
    }
    await client.query("COMMIT");
    res.json({ success: true, updated: rows.length, skipped: ids.length - rows.length });
  }));

  // ======================================================================
  //  RETURN TO SUPPLIER
  // ======================================================================

  // Body: { ids, reason, reference }
  app.post(`${BASE}/rolls/return-to-supplier`, authenticateToken, withClient(async (req, res, client) => {
    const ids = idList(req.body?.ids);
    const reason = str(req.body?.reason);
    if (!ids.length) return fail(res, 400, "Seleccione al menos un rollo.");
    if (!reason) return fail(res, 400, "Escriba el motivo de la devolución.");
    const reference = str(req.body?.reference);
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE fabric_rolls
          SET status = 'returned', out_at = now(), out_reason = $2, out_reference = $3, updated_at = now()
        WHERE id = ANY($1::bigint[]) AND status IN ('in_stock','at_inspection')
        RETURNING id, location_id`,
      [ids, reason, reference]
    );
    for (const r of rows) {
      await logMove(client, { rollId: r.id, type: "supplier_return", from: r.location_id, reference, reason, userId: req.user?.id });
    }
    await client.query("COMMIT");
    res.json({ success: true, returned: rows.length, skipped: ids.length - rows.length });
  }));

  // ======================================================================
  //  REPORTS + DASHBOARD
  // ======================================================================

  const MOVE_COLS = `
    m.id AS movement_id, m.type, m.reference, m.reason, m.created_at AS moved_at,
    u.full_name AS user_name,
    COALESCE(lt.code, lf.code) AS location_code,
    COALESCE(ct.code, cf.code) AS container_code,
    COALESCE(m.to_box_code, m.from_box_code) AS box_code,
    r.id AS roll_id, r.roll_no, r.po_number, r.supplier, r.supplier_code, r.yards, r.meters,
    r.color, r.lot, r.width, r.width_unit, r.weight, r.weight_unit, r.weight_gsm, r.composition, r.fabric_item_number,
    r.fabric_name, r.fabric_type, r.customer, r.item_sku_code, r.status, r.inspection_result,
    to_char(r.arrival_date, 'YYYY-MM-DD') AS arrival_date`;
  const MOVE_JOINS = `
    FROM fabric_roll_movements m
    JOIN fabric_rolls r ON r.id = m.roll_id
    LEFT JOIN fabric_locations lt ON lt.id = m.to_location_id
    LEFT JOIN fabric_containers ct ON ct.id = lt.container_id
    LEFT JOIN fabric_locations lf ON lf.id = m.from_location_id
    LEFT JOIN fabric_containers cf ON cf.id = lf.container_id
    LEFT JOIN users u ON u.id = m.user_id`;

  const dateRange = (req) => {
    const today = new Date().toISOString().slice(0, 10);
    const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
    const from = ok(req.query.from) ? req.query.from : today;
    const to = ok(req.query.to) ? req.query.to : from;
    return { from, to };
  };

  // Inbound: rolls received and stored, grouped by container in the summary.
  app.get(`${BASE}/reports/inbound`, authenticateToken, withClient(async (req, res, client) => {
    const { from, to } = dateRange(req);
    const { rows } = await client.query(
      `SELECT ${MOVE_COLS} ${MOVE_JOINS}
        WHERE m.type = 'received' AND m.created_at::date BETWEEN $1 AND $2
          AND NOT EXISTS (SELECT 1 FROM fabric_roll_movements u2
                           WHERE u2.roll_id = m.roll_id AND u2.type = 'receive_undone' AND u2.created_at > m.created_at)
        ORDER BY m.created_at DESC`,
      [from, to]
    );
    // byContainer = per division (A–E); byBox = per container (F01…).
    const byContainer = {};
    const byBox = {};
    for (const r of rows) {
      const k = r.container_code || "—";
      byContainer[k] = byContainer[k] || { container_code: k, rolls: 0, yards: 0, meters: 0 };
      byContainer[k].rolls++;
      byContainer[k].yards += Number(r.yards) || 0;
      byContainer[k].meters += Number(r.meters) || 0;
      const b = r.box_code || "Sin contenedor";
      byBox[b] = byBox[b] || { box_code: b, location_code: r.location_code, rolls: 0, yards: 0, meters: 0 };
      byBox[b].rolls++;
      byBox[b].yards += Number(r.yards) || 0;
      byBox[b].meters += Number(r.meters) || 0;
    }
    res.json({
      success: true, from, to, rows,
      totals: {
        rolls: rows.length,
        yards: rows.reduce((s, r) => s + (Number(r.yards) || 0), 0),
        meters: rows.reduce((s, r) => s + (Number(r.meters) || 0), 0),
      },
      byContainer: Object.values(byContainer),
      byBox: Object.values(byBox).sort((a, b) => b.rolls - a.rolls),
    });
  }));

  // Outbound: sent to inspection and returned to supplier. ?type=inspection_out|supplier_return
  app.get(`${BASE}/reports/outbound`, authenticateToken, withClient(async (req, res, client) => {
    const { from, to } = dateRange(req);
    const types = ["inspection_out", "supplier_return"].includes(req.query.type) ? [req.query.type] : ["inspection_out", "supplier_return"];
    const { rows } = await client.query(
      `SELECT ${MOVE_COLS} ${MOVE_JOINS}
        WHERE m.type = ANY($3::text[]) AND m.created_at::date BETWEEN $1 AND $2
        ORDER BY m.created_at DESC`,
      [from, to, types]
    );
    const byType = {};
    for (const r of rows) {
      byType[r.type] = byType[r.type] || { type: r.type, rolls: 0, yards: 0, meters: 0 };
      byType[r.type].rolls++;
      byType[r.type].yards += Number(r.yards) || 0;
      byType[r.type].meters += Number(r.meters) || 0;
    }
    res.json({
      success: true, from, to, rows,
      totals: {
        rolls: rows.length,
        yards: rows.reduce((s, r) => s + (Number(r.yards) || 0), 0),
        meters: rows.reduce((s, r) => s + (Number(r.meters) || 0), 0),
      },
      byType: Object.values(byType),
    });
  }));

  // ======================================================================
  //  RECONCILIATION: requested from Skytex  vs  received (scanned)
  // ======================================================================
  // GET /reconciliation?days=60&po=
  //   Scope: every roll requested from Skytex that is still pending, plus the
  //   ones requested in the last `days` days (received or not).
  //   • byPo        per PO: requested / received / pending / overdue
  //   • pending     requested but not received yet (oldest arrival first)
  //   • unrequested received in the warehouse WITHOUT a Skytex request
  //                 (open = not reviewed yet; reviewed = with a note)
  // A roll counts as received once it was scanned in (in_stock, at
  // inspection or already returned to the supplier).
  app.get(`${BASE}/reconciliation`, authenticateToken, withClient(async (req, res, client) => {
    const days = Math.max(1, Math.min(3650, parseInt(req.query.days, 10) || 60));
    const po = str(req.query.po);
    const params = [days];
    let poSql = "";
    if (po) { params.push(po); poSql = ` AND COALESCE(r.po_number, 'Sin PO') = $${params.length}`; }
    const scope = `r.source = 'skytex' AND r.status <> 'cancelled'
                   AND (r.status IN ('requested','assigned') OR r.requested_at >= now() - make_interval(days => $1))${poSql}`;
    const RECEIVED = `r.status IN ('in_stock','at_inspection','returned')`;

    const byPo = await client.query(
      `SELECT COALESCE(r.po_number, 'Sin PO') AS po_number,
              COUNT(*)::int AS requested,
              COUNT(*) FILTER (WHERE ${RECEIVED})::int AS received,
              COUNT(*) FILTER (WHERE r.status IN ('requested','assigned'))::int AS pending,
              COUNT(*) FILTER (WHERE r.status IN ('requested','assigned') AND r.arrival_date < CURRENT_DATE)::int AS overdue,
              COALESCE(SUM(r.yards), 0) AS yards_requested,
              COALESCE(SUM(r.yards) FILTER (WHERE ${RECEIVED}), 0) AS yards_received,
              MIN(r.arrival_date) FILTER (WHERE r.status IN ('requested','assigned')) AS next_arrival,
              MAX(r.received_at) AS last_received_at,
              MIN(r.requested_at) AS first_requested_at
         FROM fabric_rolls r
        WHERE ${scope}
        GROUP BY 1
        ORDER BY COUNT(*) FILTER (WHERE r.status IN ('requested','assigned')) DESC, MAX(r.requested_at) DESC`,
      params
    );
    const pending = await client.query(
      `${ROLL_SELECT}
        WHERE ${scope} AND r.status IN ('requested','assigned')
        ORDER BY r.arrival_date NULLS LAST, r.po_number, r.roll_no
        LIMIT 2000`,
      params
    );
    const unreq = await client.query(
      `${ROLL_SELECT.replace("FROM fabric_rolls r", `,
              ru.full_name AS received_by_name, rv.full_name AS reviewed_by_name
         FROM fabric_rolls r
         LEFT JOIN users ru ON ru.id = r.received_by
         LEFT JOIN users rv ON rv.id = r.unrequested_reviewed_by`)}
        WHERE r.source = 'scan' AND r.status <> 'cancelled'
        ORDER BY (r.unrequested_reviewed_at IS NULL) DESC, r.received_at DESC NULLS LAST
        LIMIT 1000`
    );
    const rows = byPo.rows.map((x) => ({
      ...x, yards_requested: Number(x.yards_requested), yards_received: Number(x.yards_received),
    }));
    const sum = (k) => rows.reduce((a, x) => a + Number(x[k] || 0), 0);
    const open = unreq.rows.filter((r) => !r.unrequested_reviewed_at);
    res.json({
      success: true, days,
      totals: {
        requested: sum("requested"), received: sum("received"), pending: sum("pending"), overdue: sum("overdue"),
        yardsRequested: sum("yards_requested"), yardsReceived: sum("yards_received"),
        unrequested: open.length, unrequestedReviewed: unreq.rows.length - open.length,
      },
      byPo: rows,
      pending: pending.rows,
      unrequested: unreq.rows,
    });
  }));

  // Mark a roll received without request as reviewed (with a note), or undo it.
  // Body: { note, undo? }
  app.post(`${BASE}/rolls/:id/review-unrequested`, authenticateToken, withClient(async (req, res, client) => {
    const undo = req.body?.undo === true;
    const note = str(req.body?.note);
    if (!undo && !note) return fail(res, 400, "Escriba qué se revisó (por ejemplo: «Skytex confirma que pertenece a la PO 1218108»).");
    const { rows } = await client.query(
      `UPDATE fabric_rolls
          SET unrequested_reviewed_at = CASE WHEN $2 THEN NULL ELSE now() END,
              unrequested_reviewed_by = CASE WHEN $2 THEN NULL ELSE $3::bigint END,
              unrequested_note        = CASE WHEN $2 THEN NULL ELSE $4 END,
              updated_at = now()
        WHERE id = $1 AND source = 'scan'
        RETURNING id`,
      [req.params.id, undo, req.user?.id ?? null, note || null]
    );
    if (!rows.length) return fail(res, 404, "Rollo no encontrado o ya fue solicitado a Skytex.");
    res.json({ success: true });
  }));

  app.get(`${BASE}/dashboard`, authenticateToken, withClient(async (req, res, client) => {
    // One connection, so the queries run one after another.
    const status = await client.query(
      `SELECT status, COUNT(*)::int AS rolls, COALESCE(SUM(yards),0) AS yards, COALESCE(SUM(meters),0) AS meters
         FROM fabric_rolls GROUP BY status`
    );
    const aging = await client.query(
      `SELECT COUNT(*)::int AS rolls, COALESCE(SUM(yards),0) AS yards FROM fabric_rolls
        WHERE status = 'in_stock' AND received_at <= now() - ($1 || ' days')::interval`,
      [AGING_DAYS]
    );
    const insp = await client.query(
      `SELECT COUNT(*)::int AS n FROM fabric_inspection_requests WHERE status IN ('open','partial')`
    );
    const today = await client.query(
      `SELECT type, COUNT(*)::int AS n FROM fabric_roll_movements
        WHERE created_at::date = CURRENT_DATE AND type IN ('received','inspection_out','supplier_return')
        GROUP BY type`
    );
    const recon = await client.query(
      `SELECT COUNT(*) FILTER (WHERE source = 'scan' AND status <> 'cancelled' AND unrequested_reviewed_at IS NULL)::int AS unrequested,
              COUNT(*) FILTER (WHERE source = 'skytex' AND status IN ('requested','assigned')
                                 AND arrival_date IS NOT NULL AND arrival_date < CURRENT_DATE)::int AS overdue
         FROM fabric_rolls`
    );
    const by = Object.fromEntries(status.rows.map((r) => [r.status, { rolls: r.rolls, yards: Number(r.yards), meters: Number(r.meters) }]));
    const t = Object.fromEntries(today.rows.map((r) => [r.type, r.n]));
    res.json({
      success: true,
      agingDays: AGING_DAYS,
      dashboard: {
        byStatus: by,
        aging: { rolls: aging.rows[0].rolls, yards: Number(aging.rows[0].yards) },
        openInspectionRequests: insp.rows[0].n,
        today: { received: t.received || 0, toInspection: t.inspection_out || 0, returned: t.supplier_return || 0 },
        unrequested: recon.rows[0].unrequested,
        overdue: recon.rows[0].overdue,
      },
    });
  }));
}

registerFabricWarehouse.initSchema = initSchema;
registerFabricWarehouse.normalizeRoll = normalizeRoll;
registerFabricWarehouse.parseRollScan = parseRollScan;
registerFabricWarehouse.cleanScan = cleanScan;
registerFabricWarehouse.labelCandidates = labelCandidates;
registerFabricWarehouse.BOX_CODES = BOX_CODES;
registerFabricWarehouse.FIELDS = FIELDS;
module.exports = registerFabricWarehouse;