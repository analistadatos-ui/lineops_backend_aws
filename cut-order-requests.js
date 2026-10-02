// cut-order-requests.js
//
// SOLICITUDES DE CORTE: el área de corte pide al planner que le asigne una
// orden (orden de trabajo + color) que todavía no tiene orden de corte.
//
//   Corte  -> "Solicitar orden"  (POST /api/cut-order-requests)
//   Planner -> ve la solicitud en Órdenes de corte, la asigna (crea el corte)
//              o la rechaza con un motivo.
//   Al crear la orden de corte de esa orden+color, cut-orders.js marca la
//   solicitud como 'fulfilled' y guarda el cut_order_id: el cortador ve
//   "Asignada → CORTE-0012" sin que nadie la cierre a mano.
//
// Anti-duplicado: sólo puede haber UNA solicitud pendiente por orden+color
// (índice único parcial). Una segunda solicitud regresa la que ya existe.
//
// WIRING (server.js), junto a registerCutOrders:
//   const registerCutOrderRequests = require("./cut-order-requests");
//   await registerCutOrderRequests.initSchema({ pool, setSchema });   // en el bloque de initSchema, DESPUÉS de registerCutOrders.initSchema
//   registerCutOrderRequests(app, { authenticateToken, pool, setSchema });
//
// Endpoints
//   GET   /api/cut-order-requests/candidates   órdenes+color que se pueden pedir
//   GET   /api/cut-order-requests?scope=open|mine|all
//   POST  /api/cut-order-requests              { workOrderId, color, quantity?, urgency?, note? }
//   PATCH /api/cut-order-requests/:id/reject   { note }      (planner)
//   PATCH /api/cut-order-requests/:id/cancel                 (quien la pidió o planner)
// ---------------------------------------------------------------------------

const URGENCIES = ["urgent", "intermediate", "normal"];
// Roles que NO pueden rechazar solicitudes (sólo piden).
const REQUESTER_ONLY_ROLES = ["corte", "line_leader"];

const normColor = (c) => String(c == null ? "" : c).trim().toUpperCase().slice(0, 50);
const userName = (u) => u?.full_name || u?.username || u?.name || u?.email || (u?.id != null ? String(u.id) : null);

async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS cut_order_requests(
        id               BIGSERIAL PRIMARY KEY,
        work_order_id    BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
        color            VARCHAR(50) NOT NULL DEFAULT '',
        quantity         NUMERIC(12,2),
        urgency          VARCHAR(20) NOT NULL DEFAULT 'normal',
        note             TEXT,
        status           VARCHAR(20) NOT NULL DEFAULT 'pending',
        requested_by     BIGINT,
        requested_by_name VARCHAR(150),
        cut_order_id     BIGINT REFERENCES cut_orders(id) ON DELETE SET NULL,
        response_note    TEXT,
        resolved_by_name VARCHAR(150),
        resolved_at      TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_cut_req_status CHECK (status IN ('pending','fulfilled','rejected','cancelled')),
        CONSTRAINT chk_cut_req_urgency CHECK (urgency IN ('urgent','intermediate','normal'))
      );
    `);
    // Una sola solicitud PENDIENTE por orden+color.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_cut_req_pending
        ON cut_order_requests (work_order_id, color) WHERE status = 'pending';
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_cut_req_status ON cut_order_requests(status, created_at DESC);");
    console.log("\u2705 cut_order_requests table ready in prod_db_schema");
  } finally {
    client.release();
  }
}

const SELECT_REQ = `
  SELECT r.id, r.work_order_id, r.color, r.quantity, r.urgency, r.note, r.status,
         r.requested_by, r.requested_by_name, r.cut_order_id, r.response_note,
         r.resolved_by_name, r.resolved_at, r.created_at, r.updated_at,
         wo.work_order_no, wo.customer_name, wo.customer_po, wo.style_code,
         to_char(wo.commitment_date, 'YYYY-MM-DD') AS commitment_date
    FROM cut_order_requests r
    JOIN work_orders wo ON wo.id = r.work_order_id`;

// Orden+color con piezas SIN orden de corte (lo mismo que la cola del planner).
const CANDIDATES_SQL = `
  WITH l AS (
    SELECT work_order_id, UPPER(TRIM(color)) AS color, SUM(quantity) AS qty,
           string_agg(DISTINCT estilo, ', ') AS estilo
      FROM work_order_lines
     GROUP BY 1, 2
  ), c AS (
    SELECT work_order_id, UPPER(TRIM(COALESCE(color, ''))) AS color, SUM(quantity) AS qty
      FROM cut_orders
     WHERE status <> 'cancelled'
     GROUP BY 1, 2
  )
  SELECT wo.id AS work_order_id, wo.work_order_no, wo.customer_name, wo.customer_po,
         wo.style_code, l.color, l.estilo, l.qty AS color_qty,
         COALESCE(c.qty, 0) AS assigned,
         l.qty - COALESCE(c.qty, 0) AS remaining,
         to_char(wo.commitment_date, 'YYYY-MM-DD') AS commitment_date,
         r.id AS pending_request_id, r.requested_by_name AS pending_requested_by
    FROM work_orders wo
    JOIN l ON l.work_order_id = wo.id
    LEFT JOIN c ON c.work_order_id = wo.id AND c.color = l.color
    LEFT JOIN cut_order_requests r
           ON r.work_order_id = wo.id AND r.color = l.color AND r.status = 'pending'
   WHERE COALESCE(wo.status, '') NOT IN ('completed', 'cancelled')
     AND l.qty - COALESCE(c.qty, 0) > 0`;

function registerCutOrderRequests(app, { authenticateToken, pool, setSchema }) {
  const withClient = (handler) => async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      await handler(client, req, res);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`\u274c ${req.method} ${req.path}:`, err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  };

  // ---- órdenes que corte puede pedir -------------------------------------
  app.get("/api/cut-order-requests/candidates", authenticateToken, withClient(async (client, req, res) => {
    const { rows } = await client.query(
      `${CANDIDATES_SQL} ORDER BY wo.commitment_date NULLS LAST, wo.work_order_no, l.color`
    );
    res.json({ success: true, candidates: rows });
  }));

  // ---- lista --------------------------------------------------------------
  //   open (default): pendientes + resueltas en los últimos 7 días
  //   mine:           las del usuario (últimos 30 días)
  //   all:            todas (últimos 90 días)
  app.get("/api/cut-order-requests", authenticateToken, withClient(async (client, req, res) => {
    const scope = String(req.query.scope || "open");
    let where, params = [];
    if (scope === "mine") {
      params.push(req.user?.id ?? -1);
      where = `r.requested_by = $1 AND r.created_at > now() - interval '30 days'`;
    } else if (scope === "all") {
      where = `r.created_at > now() - interval '90 days'`;
    } else {
      where = `(r.status = 'pending' OR r.resolved_at > now() - interval '7 days')`;
    }
    const { rows } = await client.query(
      `${SELECT_REQ} WHERE ${where}
        ORDER BY (r.status = 'pending') DESC,
                 CASE r.urgency WHEN 'urgent' THEN 0 WHEN 'intermediate' THEN 1 ELSE 2 END,
                 r.created_at DESC
        LIMIT 300`,
      params
    );
    res.json({ success: true, requests: rows, pendingCount: rows.filter((r) => r.status === "pending").length });
  }));

  // ---- crear solicitud ---------------------------------------------------
  app.post("/api/cut-order-requests", authenticateToken, withClient(async (client, req, res) => {
    const b = req.body || {};
    const workOrderId = parseInt(b.workOrderId ?? b.work_order_id, 10);
    const color = normColor(b.color);
    const urgency = URGENCIES.includes(b.urgency) ? b.urgency : "normal";
    const note = b.note ? String(b.note).trim().slice(0, 500) : null;
    const qtyIn = b.quantity === "" || b.quantity == null ? null : Number(b.quantity);
    if (!workOrderId) return res.status(400).json({ success: false, error: "workOrderId es obligatorio" });
    if (qtyIn != null && !(qtyIn > 0)) return res.status(400).json({ success: false, error: "La cantidad debe ser mayor a 0" });

    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cut|${workOrderId}|${color}`]);

    // ¿Todavía tiene piezas sin corte?
    const cand = await client.query(
      `${CANDIDATES_SQL} AND wo.id = $1 AND l.color = $2`,
      [workOrderId, color]
    );
    if (cand.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false, code: "NOTHING_TO_REQUEST",
        error: "Esa orden y color ya tienen orden de corte completa (o la orden está cerrada).",
      });
    }
    const remaining = Number(cand.rows[0].remaining) || 0;
    if (qtyIn != null && qtyIn > remaining + 0.001) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, error: `Solo quedan ${Math.round(remaining)} pzas sin orden de corte.` });
    }

    const ins = await client.query(
      `INSERT INTO cut_order_requests
         (work_order_id, color, quantity, urgency, note, requested_by, requested_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (work_order_id, color) WHERE status = 'pending' DO NOTHING
       RETURNING id`,
      [workOrderId, color, qtyIn, urgency, note, req.user?.id ?? null, userName(req.user)]
    );
    if (ins.rows.length === 0) {
      await client.query("ROLLBACK");
      const ex = await client.query(`${SELECT_REQ} WHERE r.work_order_id = $1 AND r.color = $2 AND r.status = 'pending'`, [workOrderId, color]);
      const e = ex.rows[0];
      return res.status(409).json({
        success: false, code: "ALREADY_REQUESTED", request: e || null,
        error: `Ya hay una solicitud pendiente para ${e?.work_order_no || "esta orden"}${color ? ` ${color}` : ""}${e?.requested_by_name ? ` (de ${e.requested_by_name})` : ""}.`,
      });
    }
    await client.query("COMMIT");
    const { rows } = await client.query(`${SELECT_REQ} WHERE r.id = $1`, [ins.rows[0].id]);
    res.json({ success: true, request: rows[0] });
  }));

  // ---- rechazar (planner) ------------------------------------------------
  app.patch("/api/cut-order-requests/:id/reject", authenticateToken, withClient(async (client, req, res) => {
    if (REQUESTER_ONLY_ROLES.includes(req.user?.role)) {
      return res.status(403).json({ success: false, error: "Sólo planeación puede rechazar una solicitud." });
    }
    const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;
    if (!note) return res.status(400).json({ success: false, error: "Indique el motivo del rechazo." });
    const { rows } = await client.query(
      `UPDATE cut_order_requests
          SET status = 'rejected', response_note = $2, resolved_by_name = $3,
              resolved_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING id`,
      [parseInt(req.params.id, 10), note, userName(req.user)]
    );
    if (!rows.length) return res.status(409).json({ success: false, error: "La solicitud ya no está pendiente." });
    res.json({ success: true });
  }));

  // ---- cancelar (quien la pidió, o planeación) ---------------------------
  app.patch("/api/cut-order-requests/:id/cancel", authenticateToken, withClient(async (client, req, res) => {
    const id = parseInt(req.params.id, 10);
    const cur = await client.query("SELECT requested_by, status FROM cut_order_requests WHERE id = $1", [id]);
    if (!cur.rows.length) return res.status(404).json({ success: false, error: "Solicitud no encontrada" });
    const own = String(cur.rows[0].requested_by) === String(req.user?.id);
    if (!own && REQUESTER_ONLY_ROLES.includes(req.user?.role)) {
      return res.status(403).json({ success: false, error: "Sólo quien hizo la solicitud puede cancelarla." });
    }
    const { rows } = await client.query(
      `UPDATE cut_order_requests
          SET status = 'cancelled', resolved_by_name = $2, resolved_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING id`,
      [id, userName(req.user)]
    );
    if (!rows.length) return res.status(409).json({ success: false, error: "La solicitud ya no está pendiente." });
    res.json({ success: true });
  }));
}

// Lo llama cut-orders.js DENTRO de su transacción al crear un corte: cierra la
// solicitud pendiente de esa orden+color. Si la tabla aún no existe, no hace nada.
async function fulfillPendingRequests(client, { workOrderId, color, cutOrderId, user }) {
  const t = await client.query("SELECT to_regclass('cut_order_requests') AS t");
  if (!t.rows[0]?.t) return 0;
  const { rowCount } = await client.query(
    `UPDATE cut_order_requests
        SET status = 'fulfilled', cut_order_id = $3, resolved_by_name = $4,
            resolved_at = now(), updated_at = now()
      WHERE work_order_id = $1 AND color = $2 AND status = 'pending'`,
    [parseInt(workOrderId, 10), normColor(color), cutOrderId, userName(user)]
  );
  return rowCount;
}

registerCutOrderRequests.initSchema = initSchema;
registerCutOrderRequests.fulfillPendingRequests = fulfillPendingRequests;
module.exports = registerCutOrderRequests;