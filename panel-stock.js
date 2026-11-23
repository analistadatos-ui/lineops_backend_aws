// panel-stock.js
//
// Stock de paneles del supermercado: se llena ESCANEANDO los tickets que salen
// de inspección de paneles (uno por panel, ver components/cutting/ticketCode.js).
//
//   QR = https://<app>/corte/ticket?t=CORTE-0208|WO|COLOR|TALLA|MARCADA|P1/5|idMarcada|pzs
//
// Cada escaneo:
//   1. se valida contra la orden de corte (existe, no cancelada, la marcada y la
//      talla existen, el número de panel no pasa de los paneles cortados);
//   2. se guarda UNA vez por ticket físico (corte + marcada + talla + panel):
//      el segundo escaneo del mismo ticket se avisa y no cuenta;
//   3. responde con el stock de esa orden: recibidos vs. cortados por marcada y
//      talla, para que el supermercado sepa al momento si le llegó todo.
//
// Registro en server.js:
//   const registerPanelStock = require("./panel-stock");
//   registerPanelStock(app, { authenticateToken, pool, setSchema });
//   await registerPanelStock.initSchema({ pool, setSchema });   // en el arranque

async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS panel_stock_scans (
        id               BIGSERIAL PRIMARY KEY,
        cut_order_id     BIGINT      NOT NULL REFERENCES cut_orders(id) ON DELETE CASCADE,
        work_order_id    BIGINT,
        marker_key       TEXT        NOT NULL,
        marker_name      TEXT,
        talla            TEXT        NOT NULL,
        panel_no         INT         NOT NULL CHECK (panel_no > 0),
        pieces           NUMERIC(12,2),
        color            TEXT,
        ticket_key       TEXT        NOT NULL UNIQUE,
        raw              TEXT,
        scanned_by       INTEGER,
        scanned_by_name  TEXT,
        scanned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_panel_stock_cut ON panel_stock_scans(cut_order_id);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_panel_stock_time ON panel_stock_scans(scanned_at DESC);");
    console.log("\u2705 panel_stock_scans ready");
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Parser del ticket: el MISMO formato que components/cutting/ticketCode.js.
// Acepta el enlace completo o el código solo, y tolera lectores con otra
// distribución de teclado ("|" → "}", "/" → "&").
// ---------------------------------------------------------------------------
function extractCode(input) {
  let s = String(input ?? "").trim();
  try { s = decodeURIComponent(s.replace(/\+/g, " ")); } catch { /* ya venía decodificado */ }
  const m = s.match(/CORTE\W?\d+/i);
  return m ? s.slice(m.index).trim() : s;
}

function parseTicketCode(input) {
  const raw = extractCode(input);
  const head = raw.match(/^CORTE\W?(\d+)(\W)/i) || raw.match(/^CORTE\W?(\d+)$/i);
  if (!head) return null;
  const cutId = Number(head[1]);
  const sep = head[2];
  const empty = { workOrderNo: "", color: "", talla: "", marker: "", markerId: "", panelNo: null, panelCount: null, pieces: null };
  if (!sep) return { cutId, ...empty, raw };
  const parts = raw.split(sep);
  let pIdx = -1;
  for (let i = parts.length - 1; i >= 1; i--) {
    if (/^P\d+(\W\d+)?$/i.test(parts[i].trim())) { pIdx = i; break; }
  }
  const pm = pIdx >= 0 ? parts[pIdx].trim().match(/^P(\d+)(?:\W(\d+))?$/i) : null;
  const pcs = pIdx >= 0 ? Number((parts[pIdx + 2] || "").trim()) : NaN;
  return {
    cutId,
    workOrderNo: (parts[1] || "").trim(),
    color: (parts[2] || "").trim(),
    talla: (parts[3] || "").trim(),
    marker: pIdx > 4 ? parts.slice(4, pIdx).join(sep).trim() : (parts[4] || "").trim(),
    markerId: pIdx >= 0 ? (parts[pIdx + 1] || "").trim() : "",
    panelNo: pm ? Number(pm[1]) : null,
    panelCount: pm && pm[2] ? Number(pm[2]) : null,
    pieces: Number.isFinite(pcs) && pcs > 0 ? pcs : null,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Lo que se cortó: marcadas × tallas con sus paneles. Mismo criterio que la
// verificación de corte (buildMarkers): formato nuevo (m.lines[].panels) o
// viejo (m.panels global para cada talla con piezas por panel).
// ---------------------------------------------------------------------------
const num = (v) => Number(v) || 0;
const asArr = (v) => (Array.isArray(v) ? v : []);
const normTalla = (v) => String(v ?? "").trim().toUpperCase();
const normName = (v) => String(v ?? "").trim().toLowerCase();

function expectedOf(co) {
  return asArr(co.markers).map((m, i) => {
    const key = String(m?.id || m?.name || `M${i + 1}`);
    const lines = asArr(m?.lines)
      .map((l) => {
        const perPanel = num(l?.perPanel);
        const panels = l?.panels != null && l.panels !== "" ? num(l.panels) : perPanel > 0 ? num(m?.panels) : 0;
        return { talla: String(l?.talla ?? "").trim(), panels: Math.round(panels), perPanel };
      })
      .filter((l) => l.talla && l.panels > 0);
    return { key, id: m?.id || null, name: m?.name || `Marcada ${i + 1}`, done: !!m?.done, lines };
  }).filter((m) => m.lines.length > 0);
}

function findMarker(markers, ticket) {
  if (ticket.markerId) {
    const byId = markers.find((m) => m.id && String(m.id) === ticket.markerId);
    if (byId) return byId;
  }
  const byName = markers.filter((m) => normName(m.name) === normName(ticket.marker));
  return byName.length === 1 ? byName[0] : null;
}

const CUT_SELECT = `
  SELECT co.id, co.work_order_id, co.status, co.markers,
         to_char(co.cut_date, 'YYYY-MM-DD') AS cut_date,
         COALESCE(co.color, wo.color) AS color,
         wo.work_order_no, wo.customer_po, wo.customer_name,
         COALESCE(co.style_no, wo.style_code) AS style_no
    FROM cut_orders co
    JOIN work_orders wo ON wo.id = co.work_order_id`;

// Stock de UNA corte: recibidos vs. cortados por marcada × talla.
async function stockOf(client, cutId) {
  const co = (await client.query(`${CUT_SELECT} WHERE co.id = $1`, [cutId])).rows[0];
  if (!co) return null;
  const scans = (await client.query(
    `SELECT id, marker_key, talla, panel_no, pieces, scanned_at, scanned_by_name
       FROM panel_stock_scans WHERE cut_order_id = $1 ORDER BY scanned_at DESC`,
    [cutId]
  )).rows;
  const got = new Map(); // marker|talla → { panels:Set, pieces }
  for (const s of scans) {
    const k = `${s.marker_key}|${normTalla(s.talla)}`;
    if (!got.has(k)) got.set(k, { panels: new Set(), pieces: 0 });
    got.get(k).panels.add(s.panel_no);
    got.get(k).pieces += num(s.pieces);
  }
  let expPanels = 0, expPieces = 0, recPanels = 0, recPieces = 0;
  const markers = expectedOf(co).map((m) => {
    const lines = m.lines.map((l) => {
      const g = got.get(`${m.key}|${normTalla(l.talla)}`);
      const received = g ? g.panels.size : 0;
      const receivedPieces = g ? g.pieces : 0;
      const missing = [];
      for (let p = 1; p <= l.panels; p++) if (!g?.panels.has(p)) missing.push(p);
      expPanels += l.panels; expPieces += l.panels * l.perPanel;
      recPanels += received; recPieces += receivedPieces;
      return { talla: l.talla, expected: l.panels, perPanel: l.perPanel, received, receivedPieces, missing };
    });
    return { key: m.key, name: m.name, lines };
  });
  return {
    cutId: Number(co.id),
    cutNo: `CORTE-${String(co.id).padStart(4, "0")}`,
    status: co.status,
    workOrderId: Number(co.work_order_id),
    workOrderNo: co.work_order_no,
    customerPo: co.customer_po,
    customerName: co.customer_name,
    styleNo: co.style_no,
    color: co.color,
    cutDate: co.cut_date,
    markers,
    totals: { expectedPanels: expPanels, receivedPanels: recPanels, expectedPieces: expPieces, receivedPieces: recPieces },
    complete: expPanels > 0 && recPanels >= expPanels,
    lastScanAt: scans[0]?.scanned_at || null,
  };
}

const userName = (req) => req.user?.full_name || req.user?.username || null;
const userId = (req) => (Number.isFinite(Number(req.user?.id)) ? Number(req.user.id) : null);
const isLineLeader = (req) => String(req.user?.role || "").toLowerCase() === "line_leader";

function registerPanelStock(app, { authenticateToken, pool, setSchema }) {
  // -------------------------------------------------------------------------
  // POST /api/panel-stock/scan   { code }   → registra un ticket
  //   result: "ok" | "duplicate" | "error"   (siempre 200 salvo fallas reales,
  //   para que el escáner responda rápido con el mensaje)
  // -------------------------------------------------------------------------
  app.post("/api/panel-stock/scan", authenticateToken, async (req, res) => {
    if (isLineLeader(req)) return res.status(403).json({ success: false, error: "Sólo el supermercado recibe paneles" });
    const t = parseTicketCode(req.body?.code);
    const fail = (message, extra = {}) => res.json({ success: true, result: "error", message, ticket: t, ...extra });
    if (!t) return fail("No es un ticket de corte. Escanee el QR del ticket del panel.");
    if (!t.talla || !t.panelNo) return fail("El ticket no trae talla o número de panel.");

    const client = await pool.connect();
    try {
      await setSchema(client);
      const co = (await client.query(`${CUT_SELECT} WHERE co.id = $1`, [t.cutId])).rows[0];
      const cutNo = `CORTE-${String(t.cutId).padStart(4, "0")}`;
      if (!co) return fail(`${cutNo} no existe.`);
      if (co.status === "cancelled") return fail(`${cutNo} está cancelada.`);
      if (t.workOrderNo && co.work_order_no && normName(t.workOrderNo) !== normName(co.work_order_no)) {
        return fail(`El ticket dice ${t.workOrderNo}, pero ${cutNo} es de ${co.work_order_no}.`);
      }
      const markers = expectedOf(co);
      const mk = findMarker(markers, t);
      if (!mk) return fail(`La marcada "${t.marker || t.markerId}" no está en ${cutNo}.`, { stock: await stockOf(client, t.cutId) });
      const line = mk.lines.find((l) => normTalla(l.talla) === normTalla(t.talla));
      if (!line) return fail(`La talla ${t.talla} no está en ${mk.name} de ${cutNo}.`, { stock: await stockOf(client, t.cutId) });
      if (t.panelNo > line.panels) {
        return fail(`Panel ${t.panelNo}: ${mk.name} sólo tiene ${line.panels} panel(es) de talla ${t.talla}.`, { stock: await stockOf(client, t.cutId) });
      }

      const ticketKey = [t.cutId, mk.key, normTalla(t.talla), t.panelNo].join("|").toUpperCase();
      const pieces = t.pieces || line.perPanel || null;
      const ins = await client.query(
        `INSERT INTO panel_stock_scans
           (cut_order_id, work_order_id, marker_key, marker_name, talla, panel_no, pieces, color, ticket_key, raw, scanned_by, scanned_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (ticket_key) DO NOTHING
         RETURNING id`,
        [t.cutId, co.work_order_id, mk.key, mk.name, line.talla, t.panelNo, pieces, co.color, ticketKey, t.raw, userId(req), userName(req)]
      );
      const stock = await stockOf(client, t.cutId);
      const panel = { cutNo, marker: mk.name, talla: line.talla, panelNo: t.panelNo, panelCount: line.panels, pieces, color: co.color };
      if (!ins.rows.length) {
        const prev = (await client.query(
          "SELECT scanned_at, scanned_by_name FROM panel_stock_scans WHERE ticket_key = $1", [ticketKey]
        )).rows[0];
        return res.json({ success: true, result: "duplicate", message: "Este panel ya estaba recibido. No se contó otra vez.", previous: prev, panel, stock });
      }
      res.json({ success: true, result: "ok", scanId: Number(ins.rows[0].id), message: "Panel recibido", panel, stock });
    } catch (err) {
      console.error("\u274c POST /api/panel-stock/scan:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/panel-stock/orders?q=   → cortes con paneles recibidos o por
  //   recibir (marcadas verificadas), con su avance; más recientes primero.
  // -------------------------------------------------------------------------
  app.get("/api/panel-stock/orders", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { rows } = await client.query(
        `SELECT co.id
           FROM cut_orders co
           LEFT JOIN LATERAL (SELECT MAX(scanned_at) AS last FROM panel_stock_scans s WHERE s.cut_order_id = co.id) s ON TRUE
          WHERE co.status <> 'cancelled'
            AND jsonb_typeof(co.markers) = 'array' AND jsonb_array_length(co.markers) > 0
            AND (s.last IS NOT NULL OR co.status = 'completed'
                 OR EXISTS (SELECT 1 FROM jsonb_array_elements(co.markers) m WHERE (m->>'done')::boolean IS TRUE))
          ORDER BY s.last DESC NULLS LAST, co.cut_date DESC, co.id DESC
          LIMIT 200`
      );
      const out = [];
      for (const r of rows) {
        const st = await stockOf(client, r.id);
        if (st && st.totals.expectedPanels > 0) out.push(st);
      }
      const q = String(req.query.q || "").trim().toLowerCase();
      const filtered = q
        ? out.filter((o) => `${o.cutNo} ${o.workOrderNo} ${o.customerPo} ${o.color} ${o.styleNo}`.toLowerCase().includes(q))
        : out;
      res.json({ success: true, orders: filtered });
    } catch (err) {
      console.error("\u274c GET /api/panel-stock/orders:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/panel-stock/summary   → stock por ORDEN + COLOR (lo que pinta el
  //   Plan Board del supermercado):
  //     received*  paneles/piezas escaneados (todas las cortes de esa orden+color)
  //     cutPieces  piezas cortadas en marcadas (lo que debería llegar)
  //     sentPieces piezas enviadas a líneas (envíos de solicitudes de paneles)
  //     onHand     received − sent = lo que físicamente está en el supermercado
  // -------------------------------------------------------------------------
  app.get("/api/panel-stock/summary", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const nc = (v) => String(v ?? "").trim().toUpperCase();
      const byKey = new Map();
      const row = (woId, color) => {
        const k = `${woId}|${nc(color)}`;
        if (!byKey.has(k)) byKey.set(k, { workOrderId: Number(woId), color: nc(color), workOrderNo: null,
          receivedPanels: 0, receivedPieces: 0, cutPanels: 0, cutPieces: 0, sentPieces: 0, onHand: 0 });
        return byKey.get(k);
      };
      const rec = await client.query(
        `SELECT s.work_order_id, s.color, COUNT(*)::int AS panels, COALESCE(SUM(s.pieces), 0)::float AS pieces
           FROM panel_stock_scans s
           JOIN cut_orders co ON co.id = s.cut_order_id AND co.status <> 'cancelled'
          GROUP BY s.work_order_id, s.color`
      );
      for (const r of rec.rows) { const x = row(r.work_order_id, r.color); x.receivedPanels += r.panels; x.receivedPieces += r.pieces; }

      // Envíos a líneas (módulo panel-requests; si no está, no se resta nada).
      try {
        const sent = await client.query(
          `SELECT r.work_order_id, r.color, COALESCE(SUM(s.qty), 0)::float AS qty
             FROM panel_shipments s JOIN panel_requests r ON r.id = s.request_id
            WHERE NOT r.cancelled
            GROUP BY r.work_order_id, r.color`
        );
        for (const r of sent.rows) row(r.work_order_id, r.color).sentPieces += r.qty;
      } catch { /* sin solicitudes de paneles */ }

      // Lo cortado, sólo para las órdenes que ya tienen algo.
      const woIds = [...new Set([...byKey.values()].map((x) => x.workOrderId))];
      if (woIds.length) {
        const cuts = await client.query(`${CUT_SELECT} WHERE co.status <> 'cancelled' AND co.work_order_id = ANY($1::bigint[])`, [woIds]);
        for (const co of cuts.rows) {
          const x = row(co.work_order_id, co.color);
          x.workOrderNo = co.work_order_no;
          for (const m of expectedOf(co)) for (const l of m.lines) { x.cutPanels += l.panels; x.cutPieces += l.panels * l.perPanel; }
        }
        const wos = await client.query("SELECT id, work_order_no FROM work_orders WHERE id = ANY($1::bigint[])", [woIds]);
        const noById = new Map(wos.rows.map((w) => [String(w.id), w.work_order_no]));
        for (const x of byKey.values()) x.workOrderNo = x.workOrderNo || noById.get(String(x.workOrderId)) || null;
      }
      for (const x of byKey.values()) x.onHand = Math.max(0, x.receivedPieces - x.sentPieces);
      res.json({ success: true, orders: [...byKey.values()] });
    } catch (err) {
      console.error("\u274c GET /api/panel-stock/summary:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // GET /api/panel-stock/orders/:cutId   → detalle de una corte
  app.get("/api/panel-stock/orders/:cutId", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const st = await stockOf(client, parseInt(req.params.cutId, 10));
      if (!st) return res.status(404).json({ success: false, error: "La corte no existe" });
      res.json({ success: true, stock: st });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // DELETE /api/panel-stock/scans/:id   → deshacer un escaneo equivocado
  app.delete("/api/panel-stock/scans/:id", authenticateToken, async (req, res) => {
    if (isLineLeader(req)) return res.status(403).json({ success: false, error: "Sólo el supermercado" });
    const client = await pool.connect();
    try {
      await setSchema(client);
      const del = await client.query("DELETE FROM panel_stock_scans WHERE id = $1 RETURNING cut_order_id", [parseInt(req.params.id, 10)]);
      if (!del.rows.length) return res.status(404).json({ success: false, error: "El escaneo no existe" });
      res.json({ success: true, stock: await stockOf(client, del.rows[0].cut_order_id) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });
}

registerPanelStock.initSchema = initSchema;
registerPanelStock.parseTicketCode = parseTicketCode;
module.exports = registerPanelStock;