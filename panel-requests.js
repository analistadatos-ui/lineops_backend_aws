// panel-requests.js
//
// Solicitudes de paneles: la línea pide, el supermercado surte, la línea recibe.
//
//   1. El jefe de línea ve las órdenes que su línea tiene planeadas (hoy y los
//      próximos días) con las piezas a producir, y pide esa cantidad de paneles.
//   2. El supermercado ve la solicitud (pulso rojo en el Plan Board) y registra
//      uno o varios envíos hasta cubrirla. Cada envío dice cuánto salió y el
//      saldo que falta.
//   3. El jefe de línea marca cada envío como RECIBIDO cuando le llega.
//
// El estado NO se guarda: se calcula de los envíos, así nunca se desfasa.
//   requested  → nada enviado
//   partial    → enviado < solicitado
//   sent       → enviado completo, falta que la línea confirme recibido
//   received   → enviado completo y todo recibido
//   cancelled  → la línea la canceló antes de cualquier envío
//
// Registro en server.js (junto a los demás módulos):
//   const registerPanelRequests = require("./panel-requests");
//   registerPanelRequests(app, { authenticateToken, pool, setSchema });
// y en el bloque de arranque, junto a los otros initSchema:
//   await registerPanelRequests.initSchema({ pool, setSchema });

const TZ = "America/Mexico_City";

async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS panel_requests (
        id                 BIGSERIAL PRIMARY KEY,
        line_no            TEXT        NOT NULL,
        work_order_id      BIGINT      NOT NULL,
        work_order_no      TEXT,
        color              TEXT,
        customer_po        TEXT,
        request_date       DATE        NOT NULL,
        requested_qty      NUMERIC(12,2) NOT NULL CHECK (requested_qty > 0),
        note               TEXT,
        cancelled          BOOLEAN     NOT NULL DEFAULT FALSE,
        requested_by       INTEGER,
        requested_by_name  TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS panel_shipments (
        id                BIGSERIAL PRIMARY KEY,
        request_id        BIGINT      NOT NULL REFERENCES panel_requests(id) ON DELETE CASCADE,
        qty               NUMERIC(12,2) NOT NULL CHECK (qty > 0),
        note              TEXT,
        sent_by           INTEGER,
        sent_by_name      TEXT,
        sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        received_at       TIMESTAMPTZ,
        received_by       INTEGER,
        received_by_name  TEXT
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_panel_requests_line_date ON panel_requests(line_no, request_date);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_panel_requests_wo ON panel_requests(work_order_id, color);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_panel_shipments_req ON panel_shipments(request_id);");
    console.log("\u2705 panel_requests / panel_shipments ready");
  } finally {
    client.release();
  }
}

// Una solicitud con sus totales, estado calculado y envíos.
const REQUEST_SELECT = `
  SELECT r.id, r.line_no, r.work_order_id, r.work_order_no, r.color, r.customer_po,
         to_char(r.request_date, 'YYYY-MM-DD') AS request_date,
         r.requested_qty::float AS requested_qty,
         r.note, r.cancelled, r.requested_by_name, r.created_at, r.updated_at,
         COALESCE(s.sent, 0)::float     AS sent_qty,
         COALESCE(s.received, 0)::float AS received_qty,
         GREATEST(r.requested_qty - COALESCE(s.sent, 0), 0)::float AS balance_qty,
         COALESCE(s.pending_receipt, 0)::int AS pending_receipt,
         CASE
           WHEN r.cancelled THEN 'cancelled'
           WHEN COALESCE(s.sent, 0) = 0 THEN 'requested'
           WHEN COALESCE(s.sent, 0) < r.requested_qty THEN 'partial'
           WHEN COALESCE(s.pending_receipt, 0) > 0 THEN 'sent'
           ELSE 'received'
         END AS status,
         COALESCE(s.shipments, '[]'::json) AS shipments
    FROM panel_requests r
    LEFT JOIN LATERAL (
      SELECT SUM(x.qty) AS sent,
             SUM(x.qty) FILTER (WHERE x.received_at IS NOT NULL) AS received,
             COUNT(*) FILTER (WHERE x.received_at IS NULL) AS pending_receipt,
             json_agg(json_build_object(
               'id', x.id, 'qty', x.qty::float, 'note', x.note,
               'sent_at', x.sent_at, 'sent_by_name', x.sent_by_name,
               'received_at', x.received_at, 'received_by_name', x.received_by_name
             ) ORDER BY x.sent_at) AS shipments
        FROM panel_shipments x
       WHERE x.request_id = r.id
    ) s ON TRUE
`;

const isYmd = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isLineLeader = (req) => String(req.user?.role || "").toLowerCase() === "line_leader";
const userName = (req) => req.user?.full_name || req.user?.username || null;
const userId = (req) => (Number.isFinite(Number(req.user?.id)) ? Number(req.user.id) : null);

async function loadRequest(client, id) {
  const { rows } = await client.query(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
  return rows[0] || null;
}

function registerPanelRequests(app, deps) {
  const { authenticateToken, pool, setSchema } = deps;

  // Un jefe de línea sólo ve y pide para SU línea, diga lo que diga la URL.
  const lineFor = (req) => (isLineLeader(req) ? String(req.user.line_number ?? "") : (req.query.line ? String(req.query.line) : null));

  // ---------------------------------------------------------------------
  // GET /api/panel-requests?scope=open|recent&line=
  //   open   → lo que el supermercado tiene que atender o la línea recibir
  //            (todo lo que no está recibido ni cancelado)
  //   recent → además lo cerrado de los últimos 14 días
  // ---------------------------------------------------------------------
  app.get("/api/panel-requests", authenticateToken, async (req, res) => {
    const scope = req.query.scope === "recent" ? "recent" : "open";
    const line = lineFor(req);
    if (isLineLeader(req) && !line) return res.status(400).json({ success: false, error: "Tu usuario no tiene línea asignada" });
    const client = await pool.connect();
    try {
      await setSchema(client);
      const params = [];
      const where = [];
      if (line) { params.push(line); where.push(`r.line_no = $${params.length}`); }
      const base = `${REQUEST_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
      const { rows } = await client.query(
        `SELECT * FROM (${base}) q
          WHERE ${scope === "open"
            ? "q.status IN ('requested','partial','sent')"
            : `(q.status IN ('requested','partial','sent') OR q.updated_at >= NOW() - INTERVAL '14 days')`}
          ORDER BY (q.status IN ('requested','partial')) DESC, q.request_date, q.created_at`,
        params
      );
      res.json({ success: true, requests: rows });
    } catch (err) {
      console.error("\u274c GET /api/panel-requests:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------
  // GET /api/panel-requests/line-orders?line=&days=
  //   Órdenes planeadas para la línea desde hoy, una fila por día/orden/color,
  //   con las piezas a producir y cuánto ya se pidió para esa fila.
  // ---------------------------------------------------------------------
  app.get("/api/panel-requests/line-orders", authenticateToken, async (req, res) => {
    const line = lineFor(req);
    if (!line) return res.status(400).json({ success: false, error: "Falta la línea" });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 60);
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { rows } = await client.query(
        `WITH today AS (SELECT (NOW() AT TIME ZONE '${TZ}')::date AS d)
         SELECT to_char(la.assigned_date, 'YYYY-MM-DD') AS date,
                la.work_order_id,
                wo.work_order_no,
                wo.customer_po,
                la.color,
                SUM(la.assigned_quantity)::float AS planned_qty,
                COALESCE((
                  SELECT SUM(r.requested_qty) FROM panel_requests r
                   WHERE NOT r.cancelled
                     AND r.line_no = $1
                     AND r.work_order_id = la.work_order_id
                     AND COALESCE(r.color, '') = COALESCE(la.color, '')
                     AND r.request_date = la.assigned_date
                ), 0)::float AS requested_qty
           FROM line_assignments la
           JOIN work_orders wo ON wo.id = la.work_order_id
          CROSS JOIN today
          WHERE la.line_no::text = $1
            AND la.assigned_date BETWEEN today.d AND today.d + $2::int
            AND la.status NOT IN ('cancelled', 'rejected')
          GROUP BY la.assigned_date, la.work_order_id, wo.work_order_no, wo.customer_po, la.color
          ORDER BY la.assigned_date, wo.work_order_no`,
        [line, days]
      );
      res.json({ success: true, line, orders: rows });
    } catch (err) {
      console.error("\u274c GET /api/panel-requests/line-orders:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------
  // POST /api/panel-requests   (jefe de línea)
  //   { workOrderId, color, date, qty, note }
  // ---------------------------------------------------------------------
  app.post("/api/panel-requests", authenticateToken, async (req, res) => {
    const line = isLineLeader(req) ? String(req.user.line_number ?? "") : String(req.body.lineNo ?? "");
    const { workOrderId, color = null, date, note = null } = req.body || {};
    const qty = Number(req.body?.qty);
    if (!line) return res.status(400).json({ success: false, error: "Falta la línea" });
    if (!workOrderId || !isYmd(date)) return res.status(400).json({ success: false, error: "Faltan la orden o la fecha" });
    if (!(qty > 0)) return res.status(400).json({ success: false, error: "La cantidad debe ser mayor a 0" });

    const client = await pool.connect();
    try {
      await setSchema(client);
      const wo = await client.query("SELECT id, work_order_no, customer_po FROM work_orders WHERE id = $1", [workOrderId]);
      if (!wo.rows.length) return res.status(404).json({ success: false, error: "La orden no existe" });
      // La orden debe estar planeada en esa línea ese día: se pide lo del plan.
      const planned = await client.query(
        `SELECT 1 FROM line_assignments
          WHERE line_no::text = $1 AND work_order_id = $2 AND assigned_date = $3
            AND COALESCE(color, '') = COALESCE($4, '')
            AND status NOT IN ('cancelled', 'rejected')
          LIMIT 1`,
        [line, workOrderId, date, color]
      );
      if (!planned.rows.length) {
        return res.status(409).json({ success: false, error: `La orden no está planeada en la línea ${line} el ${date}` });
      }
      const ins = await client.query(
        `INSERT INTO panel_requests
           (line_no, work_order_id, work_order_no, color, customer_po, request_date, requested_qty, note, requested_by, requested_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [line, workOrderId, wo.rows[0].work_order_no, color, wo.rows[0].customer_po, date, qty, note, userId(req), userName(req)]
      );
      res.json({ success: true, request: await loadRequest(client, ins.rows[0].id) });
    } catch (err) {
      console.error("\u274c POST /api/panel-requests:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------
  // POST /api/panel-requests/:id/shipments   (supermercado)
  //   { qty, note } — no puede pasar del saldo pendiente.
  // ---------------------------------------------------------------------
  app.post("/api/panel-requests/:id/shipments", authenticateToken, async (req, res) => {
    if (isLineLeader(req)) return res.status(403).json({ success: false, error: "Sólo el supermercado registra envíos" });
    const id = parseInt(req.params.id, 10);
    const qty = Number(req.body?.qty);
    if (!(qty > 0)) return res.status(400).json({ success: false, error: "La cantidad debe ser mayor a 0" });
    const client = await pool.connect();
    try {
      await setSchema(client);
      await client.query("BEGIN");
      // Bloquear la solicitud: dos envíos simultáneos no pueden pasarse del saldo.
      const lock = await client.query("SELECT id, cancelled FROM panel_requests WHERE id = $1 FOR UPDATE", [id]);
      if (!lock.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "La solicitud no existe" }); }
      if (lock.rows[0].cancelled) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, error: "La solicitud fue cancelada" }); }
      const cur = await loadRequest(client, id);
      if (qty > cur.balance_qty + 1e-9) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, error: `Sólo faltan ${cur.balance_qty} por enviar` });
      }
      await client.query(
        `INSERT INTO panel_shipments (request_id, qty, note, sent_by, sent_by_name) VALUES ($1,$2,$3,$4,$5)`,
        [id, qty, req.body?.note || null, userId(req), userName(req)]
      );
      await client.query("UPDATE panel_requests SET updated_at = NOW() WHERE id = $1", [id]);
      await client.query("COMMIT");
      res.json({ success: true, request: await loadRequest(client, id) });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("\u274c POST /api/panel-requests/:id/shipments:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------
  // POST /api/panel-requests/shipments/:sid/receive   (jefe de línea)
  // ---------------------------------------------------------------------
  app.post("/api/panel-requests/shipments/:sid/receive", authenticateToken, async (req, res) => {
    const sid = parseInt(req.params.sid, 10);
    const client = await pool.connect();
    try {
      await setSchema(client);
      const cur = await client.query(
        `SELECT s.id, s.received_at, r.id AS request_id, r.line_no
           FROM panel_shipments s JOIN panel_requests r ON r.id = s.request_id
          WHERE s.id = $1`,
        [sid]
      );
      if (!cur.rows.length) return res.status(404).json({ success: false, error: "El envío no existe" });
      const row = cur.rows[0];
      if (isLineLeader(req) && String(row.line_no) !== String(req.user.line_number)) {
        return res.status(403).json({ success: false, error: "Ese envío es de otra línea" });
      }
      if (!row.received_at) {
        await client.query(
          `UPDATE panel_shipments SET received_at = NOW(), received_by = $2, received_by_name = $3 WHERE id = $1`,
          [sid, userId(req), userName(req)]
        );
        await client.query("UPDATE panel_requests SET updated_at = NOW() WHERE id = $1", [row.request_id]);
      }
      res.json({ success: true, request: await loadRequest(client, row.request_id) });
    } catch (err) {
      console.error("\u274c POST /api/panel-requests/shipments/:sid/receive:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------
  // POST /api/panel-requests/:id/cancel   (la línea, sólo si nada se ha enviado)
  // ---------------------------------------------------------------------
  app.post("/api/panel-requests/:id/cancel", authenticateToken, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const client = await pool.connect();
    try {
      await setSchema(client);
      const cur = await loadRequest(client, id);
      if (!cur) return res.status(404).json({ success: false, error: "La solicitud no existe" });
      if (isLineLeader(req) && String(cur.line_no) !== String(req.user.line_number)) {
        return res.status(403).json({ success: false, error: "Esa solicitud es de otra línea" });
      }
      if (cur.sent_qty > 0) return res.status(409).json({ success: false, error: "Ya hay envíos registrados; no se puede cancelar" });
      await client.query("UPDATE panel_requests SET cancelled = TRUE, updated_at = NOW() WHERE id = $1", [id]);
      res.json({ success: true, request: await loadRequest(client, id) });
    } catch (err) {
      console.error("\u274c POST /api/panel-requests/:id/cancel:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });
}

registerPanelRequests.initSchema = initSchema;
module.exports = registerPanelRequests;