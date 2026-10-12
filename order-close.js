// ==========================================================================
// order-close.js — Cierre manual de ordenes (boton "Completar" en Estado de
// Ordenes) con permiso del CEO y alertas.
//
// REGLA
//   pct = producido / asignado * 100
//   • pct >= CLOSE_MIN_PCT  -> el planeador cierra directo y al CEO le llega
//                              una ALERTA (kind = 'alert').
//   • pct <  CLOSE_MIN_PCT  -> el planeador NO puede cerrar: manda una
//     (o nada asignado)        SOLICITUD al CEO (kind = 'request'), que la
//                              aprueba (la orden se cierra) o la rechaza.
//   • CEO / master          -> cierran directo, sin regla ni alerta.
//
// "producido" es el mismo numero que ve el planeador (empaque/terminado,
// producedQuantityFor) y "asignado" la misma suma de line_assignments que usa
// GET /api/work-orders (sin canceladas ni rechazadas).
//
// Una sola tabla guarda solicitudes y alertas, asi el CEO ve un solo historial:
//   kind = 'request'  status: pending | approved | rejected | cancelled
//   kind = 'alert'    status: closed   (acknowledged_at = cuando el CEO la vio)
//
// work_orders.closed_at / closed_by / close_mode marcan un cierre MANUAL. El
// recalculo de estados (POST /api/work-orders/recalculate-status) debe saltarse
// esas ordenes, o volveria a abrir una orden cerrada corta.
//
// SETUP en server1.js (ver las notas de la respuesta):
//   const orderClose = require("./order-close");
//   orderClose(app, { authenticateToken, pool, setSchema });
//   await orderClose.initSchema({ pool, setSchema });   // en runMigrations
// ==========================================================================

// Cambia este numero si la regla es otra (p.ej. 95 = "producido dentro del 5%
// de lo asignado"). Es el UNICO lugar donde vive el umbral; el frontend lo
// recibe del servidor en /close-check.
const CLOSE_MIN_PCT = 5;

// Quien puede cerrar sin regla y quien aprueba solicitudes.
const APPROVER_ROLES = ["ceo", "master"];

const isApprover = (user) => APPROVER_ROLES.includes(String(user?.role || "").toLowerCase());

// --------------------------------------------------------------------------
// Esquema. Se crea en runMigrations Y bajo demanda en la primera peticion,
// porque en Lambda RUN_MIGRATIONS=false y initSchema nunca corre.
// --------------------------------------------------------------------------
async function createSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS work_order_close_requests(
      id BIGSERIAL PRIMARY KEY,
      work_order_id BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
      kind VARCHAR(10) NOT NULL,
      status VARCHAR(12) NOT NULL,
      produced_qty NUMERIC(12,2) NOT NULL DEFAULT 0,
      assigned_qty NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_qty NUMERIC(12,2) NOT NULL DEFAULT 0,
      pct NUMERIC(7,2),
      threshold_pct NUMERIC(5,2) NOT NULL,
      prev_status VARCHAR(20),
      reason TEXT,
      requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      decided_at TIMESTAMPTZ,
      decision_note TEXT,
      acknowledged_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      acknowledged_at TIMESTAMPTZ,
      CONSTRAINT chk_wocr_kind CHECK (kind IN ('request', 'alert')),
      CONSTRAINT chk_wocr_status CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'closed'))
    );
  `);
  await client.query("CREATE INDEX IF NOT EXISTS idx_wocr_wo ON work_order_close_requests(work_order_id);");
  await client.query("CREATE INDEX IF NOT EXISTS idx_wocr_kind_status ON work_order_close_requests(kind, status);");
  // Una sola solicitud pendiente por orden.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wocr_one_pending
      ON work_order_close_requests(work_order_id)
      WHERE kind = 'request' AND status = 'pending';
  `);

  await client.query("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;");
  await client.query("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS closed_by BIGINT REFERENCES users(id) ON DELETE SET NULL;");
  // planner | ceo | ceo_approved
  await client.query("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS close_mode VARCHAR(20);");
}

async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);
    await createSchema(client);
    schemaReady = true;
    console.log("\u2705 work_order_close_requests + work_orders.closed_* ready");
  } finally {
    client.release();
  }
}

let schemaReady = false;
let schemaPromise = null;
async function ensureSchema(client) {
  if (schemaReady) return;
  if (!schemaPromise) {
    schemaPromise = createSchema(client)
      .then(() => { schemaReady = true; })
      .catch((err) => {
        // No tumbar la peticion (p.ej. dos Lambdas creando la tabla a la vez):
        // se reintenta en la siguiente. Si la tabla de verdad falta, la
        // consulta que sigue lo dira con su propio error.
        console.warn("\u26a0\ufe0f  order-close ensureSchema:", err.message);
      })
      .finally(() => { if (!schemaReady) schemaPromise = null; });
  }
  await schemaPromise;
}

// --------------------------------------------------------------------------
// Regla
// --------------------------------------------------------------------------

// Lectura lazy para evitar el require circular (work-orders.js tambien
// requiere este modulo). Para cuando se llama, los dos ya cargaron.
const producedQuantityFor = (client, id) => require("./work-orders").producedQuantityFor(client, id);

/**
 * Numeros del cierre para UNA orden. No abre transaccion; si el caller esta
 * en una, pasa lock = true para bloquear la fila de work_orders.
 */
async function evaluateClose(client, workOrderId, { lock = false } = {}) {
  const id = Number(workOrderId);
  if (!Number.isFinite(id)) return null;

  const woRes = await client.query(
    `SELECT id, work_order_no, status, COALESCE(total_to_produce, quantity, 0) AS total
       FROM work_orders WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [id]
  );
  const wo = woRes.rows[0];
  if (!wo) return null;

  const asRes = await client.query(
    `SELECT COALESCE(SUM(assigned_quantity), 0) AS assigned
       FROM line_assignments
      WHERE work_order_id = $1 AND status NOT IN ('cancelled', 'rejected')`,
    [id]
  );
  const assigned = Number(asRes.rows[0]?.assigned) || 0;
  const produced = await producedQuantityFor(client, id);
  const pct = assigned > 0 ? (produced / assigned) * 100 : null;

  return {
    workOrderId: id,
    workOrderNo: wo.work_order_no,
    status: wo.status,
    total: Number(wo.total) || 0,
    assigned,
    produced,
    pct: pct == null ? null : Math.round(pct * 100) / 100,
    thresholdPct: CLOSE_MIN_PCT,
    // Sin nada asignado no hay contra que medir: siempre pide permiso.
    meetsRule: pct != null && pct >= CLOSE_MIN_PCT,
  };
}

async function pendingRequestFor(client, workOrderId) {
  const { rows } = await client.query(
    `SELECT id, reason, requested_at, requested_by
       FROM work_order_close_requests
      WHERE work_order_id = $1 AND kind = 'request' AND status = 'pending'`,
    [workOrderId]
  );
  return rows[0] || null;
}

/**
 * Marca la orden como completada y deja la traza. Debe correr DENTRO de una
 * transaccion del caller, con la fila ya bloqueada.
 *   mode = 'planner'       -> ademas inserta la alerta para el CEO
 *   mode = 'ceo'           -> cierre directo del CEO, sin alerta
 *   mode = 'ceo_approved'  -> la solicitud ya guarda la traza
 */
async function applyClose(client, { ev, user, reason = null, mode }) {
  await client.query(
    `UPDATE work_orders
        SET status = 'completed', closed_at = now(), closed_by = $2,
            close_mode = $3, updated_at = now()
      WHERE id = $1`,
    [ev.workOrderId, user?.id ?? null, mode]
  );

  // Una solicitud pendiente sobra si la orden se cierra por otro camino.
  await client.query(
    `UPDATE work_order_close_requests
        SET status = 'cancelled', decided_by = $2, decided_at = now(),
            decision_note = COALESCE(decision_note, 'Orden cerrada por otro camino')
      WHERE work_order_id = $1 AND kind = 'request' AND status = 'pending'`,
    [ev.workOrderId, user?.id ?? null]
  );

  let alert = null;
  if (mode === "planner") {
    const { rows } = await client.query(
      `INSERT INTO work_order_close_requests
         (work_order_id, kind, status, produced_qty, assigned_qty, total_qty,
          pct, threshold_pct, prev_status, reason, requested_by)
       VALUES ($1, 'alert', 'closed', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [ev.workOrderId, ev.produced, ev.assigned, ev.total, ev.pct,
       ev.thresholdPct, ev.status, reason, user?.id ?? null]
    );
    alert = rows[0];
  }
  return alert;
}

/**
 * Cierre completo con su propia transaccion. Lo usan POST /close y el
 * PUT /api/work-orders/:id/status de server1.js cuando piden 'completed'.
 * Regresa { httpStatus, body } listo para res.status().json().
 */
async function closeOrRefuse(client, { workOrderId, user, reason }) {
  await ensureSchema(client);
  await client.query("BEGIN");
  try {
    const ev = await evaluateClose(client, workOrderId, { lock: true });
    if (!ev) {
      await client.query("ROLLBACK");
      return { httpStatus: 404, body: { success: false, error: "Orden no encontrada" } };
    }
    if (ev.status === "completed") {
      await client.query("ROLLBACK");
      return { httpStatus: 409, body: { success: false, error: "La orden ya está completada." } };
    }
    if (ev.status === "cancelled") {
      await client.query("ROLLBACK");
      return { httpStatus: 409, body: { success: false, error: "La orden está cancelada." } };
    }

    const approver = isApprover(user);
    if (!approver && !ev.meetsRule) {
      await client.query("ROLLBACK");
      return {
        httpStatus: 403,
        body: {
          success: false,
          needsApproval: true,
          check: ev,
          error:
            ev.assigned > 0
              ? `Producido ${ev.pct}% de lo asignado (mínimo ${ev.thresholdPct}%). Se necesita permiso del CEO para cerrar.`
              : "La orden no tiene nada asignado. Se necesita permiso del CEO para cerrar.",
        },
      };
    }

    const alert = await applyClose(client, {
      ev, user, reason: (reason || "").trim() || null, mode: approver ? "ceo" : "planner",
    });
    await client.query("COMMIT");
    return {
      httpStatus: 200,
      body: {
        success: true,
        closed: true,
        alerted: !!alert,
        check: ev,
        message: alert
          ? "Orden completada. Se avisó al CEO."
          : "Orden completada.",
      },
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

// --------------------------------------------------------------------------
// Rutas
// --------------------------------------------------------------------------
function registerOrderClose(app, { authenticateToken, pool, setSchema }) {
  const withClient = (handler) => async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      await ensureSchema(client);
      await handler(req, res, client);
    } catch (err) {
      // Si el handler murio a media transaccion, no devolver el client al pool
      // con un BEGIN abierto.
      await client.query("ROLLBACK").catch(() => {});
      console.error("\u274c order-close:", err.message);
      if (err.code === "23505") {
        return res.status(409).json({ success: false, error: "Ya hay una solicitud de cierre pendiente para esta orden." });
      }
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  };

  const requireApprover = (req, res, next) => {
    if (!isApprover(req.user)) {
      return res.status(403).json({ success: false, error: "Solo el CEO puede hacer esto." });
    }
    next();
  };

  // ---- GET /api/work-orders/:id/close-check -----------------------------
  // Lo que el modal necesita para decidir: cerrar directo o pedir permiso.
  app.get("/api/work-orders/:id/close-check", authenticateToken, withClient(async (req, res, client) => {
    const ev = await evaluateClose(client, req.params.id);
    if (!ev) return res.status(404).json({ success: false, error: "Orden no encontrada" });
    const pending = await pendingRequestFor(client, ev.workOrderId);
    const approver = isApprover(req.user);
    res.json({
      success: true,
      check: {
        ...ev,
        isApprover: approver,
        canCloseDirectly: approver || ev.meetsRule,
        willAlertCeo: !approver && ev.meetsRule,
        pendingRequest: pending,
      },
    });
  }));

  // ---- POST /api/work-orders/:id/close  { reason? } ---------------------
  app.post("/api/work-orders/:id/close", authenticateToken, withClient(async (req, res, client) => {
    const r = await closeOrRefuse(client, {
      workOrderId: req.params.id, user: req.user, reason: req.body?.reason,
    });
    res.status(r.httpStatus).json(r.body);
  }));

  // ---- POST /api/work-orders/:id/close-requests  { reason } -------------
  // El planeador pide permiso al CEO (orden por debajo del umbral).
  app.post("/api/work-orders/:id/close-requests", authenticateToken, withClient(async (req, res, client) => {
    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 5) {
      return res.status(400).json({ success: false, error: "Escribe el motivo para el CEO (mínimo 5 caracteres)." });
    }

    await client.query("BEGIN");
    const ev = await evaluateClose(client, req.params.id, { lock: true });
    if (!ev) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, error: "Orden no encontrada" });
    }
    if (["completed", "cancelled"].includes(ev.status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, error: `La orden ya está ${ev.status === "completed" ? "completada" : "cancelada"}.` });
    }
    if (ev.meetsRule) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, error: "Esta orden cumple la regla; ciérrala directamente.", check: ev });
    }

    const { rows } = await client.query(
      `INSERT INTO work_order_close_requests
         (work_order_id, kind, status, produced_qty, assigned_qty, total_qty,
          pct, threshold_pct, prev_status, reason, requested_by)
       VALUES ($1, 'request', 'pending', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [ev.workOrderId, ev.produced, ev.assigned, ev.total, ev.pct,
       ev.thresholdPct, ev.status, reason, req.user?.id ?? null]
    );
    await client.query("COMMIT");
    res.json({ success: true, request: rows[0], message: "Solicitud enviada al CEO." });
  }));

  // ---- GET /api/work-order-close-requests?kind=&status=&workOrderId= ----
  app.get("/api/work-order-close-requests", authenticateToken, withClient(async (req, res, client) => {
    const { kind, status, workOrderId, unacknowledged } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const params = [];
    const where = [];
    if (kind)        { params.push(kind);                 where.push(`r.kind = $${params.length}`); }
    if (status)      { params.push(String(status).split(",")); where.push(`r.status = ANY($${params.length})`); }
    if (workOrderId) { params.push(Number(workOrderId));   where.push(`r.work_order_id = $${params.length}`); }
    if (unacknowledged === "true") where.push("r.kind = 'alert' AND r.acknowledged_at IS NULL");
    params.push(limit);

    const name = (col) => `(SELECT COALESCE(NULLIF(TRIM(u.full_name), ''), u.username) FROM users u WHERE u.id = ${col})`;
    const { rows } = await client.query(
      `SELECT r.*,
              wo.work_order_no, wo.customer_name, wo.customer_po, wo.style_code,
              wo.style_description, wo.status AS work_order_status,
              to_char(wo.commitment_date, 'YYYY-MM-DD') AS commitment_date,
              ${name("r.requested_by")}    AS requested_by_name,
              ${name("r.decided_by")}      AS decided_by_name,
              ${name("r.acknowledged_by")} AS acknowledged_by_name
         FROM work_order_close_requests r
         JOIN work_orders wo ON wo.id = r.work_order_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY (r.kind = 'request' AND r.status = 'pending') DESC,
                 (r.kind = 'alert' AND r.acknowledged_at IS NULL) DESC,
                 r.requested_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, thresholdPct: CLOSE_MIN_PCT, items: rows });
  }));

  // ---- GET /api/work-order-close-requests/summary -----------------------
  // Para el contador de la pestaña del CEO.
  app.get("/api/work-order-close-requests/summary", authenticateToken, withClient(async (req, res, client) => {
    const { rows } = await client.query(
      `SELECT COUNT(*) FILTER (WHERE kind = 'request' AND status = 'pending')::int AS pending_requests,
              COUNT(*) FILTER (WHERE kind = 'alert' AND acknowledged_at IS NULL)::int AS unread_alerts
         FROM work_order_close_requests`
    );
    res.json({
      success: true,
      pendingRequests: rows[0].pending_requests,
      unreadAlerts: rows[0].unread_alerts,
      thresholdPct: CLOSE_MIN_PCT,
    });
  }));

  // ---- POST /api/work-order-close-requests/:id/approve  { note? } -------
  app.post("/api/work-order-close-requests/:id/approve", authenticateToken, requireApprover, withClient(async (req, res, client) => {
    await client.query("BEGIN");
    const reqRes = await client.query(
      `SELECT * FROM work_order_close_requests WHERE id = $1 AND kind = 'request' FOR UPDATE`,
      [req.params.id]
    );
    const r = reqRes.rows[0];
    if (!r) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "Solicitud no encontrada" }); }
    if (r.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, error: "La solicitud ya fue atendida." });
    }

    const ev = await evaluateClose(client, r.work_order_id, { lock: true });
    if (!ev || ev.status === "cancelled") {
      await client.query(
        `UPDATE work_order_close_requests SET status = 'cancelled', decided_by = $2, decided_at = now(),
                decision_note = 'La orden ya no existe o fue cancelada' WHERE id = $1`,
        [r.id, req.user?.id ?? null]
      );
      await client.query("COMMIT");
      return res.status(409).json({ success: false, error: "La orden fue cancelada; la solicitud se descartó." });
    }

    // Primero se marca aprobada, para que applyClose no la cancele.
    await client.query(
      `UPDATE work_order_close_requests
          SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3
        WHERE id = $1`,
      [r.id, req.user?.id ?? null, String(req.body?.note || "").trim() || null]
    );
    if (ev.status !== "completed") {
      await applyClose(client, { ev, user: req.user, mode: "ceo_approved" });
    }
    await client.query("COMMIT");
    res.json({ success: true, message: `Orden ${ev.workOrderNo} completada con permiso del CEO.` });
  }));

  // ---- POST /api/work-order-close-requests/:id/reject  { note } ---------
  app.post("/api/work-order-close-requests/:id/reject", authenticateToken, requireApprover, withClient(async (req, res, client) => {
    const { rows } = await client.query(
      `UPDATE work_order_close_requests
          SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
        WHERE id = $1 AND kind = 'request' AND status = 'pending'
        RETURNING id`,
      [req.params.id, req.user?.id ?? null, String(req.body?.note || "").trim() || null]
    );
    if (!rows.length) return res.status(409).json({ success: false, error: "La solicitud no está pendiente." });
    res.json({ success: true, message: "Solicitud rechazada." });
  }));

  // ---- DELETE /api/work-order-close-requests/:id ------------------------
  // Quien la pidio (o el CEO) la retira mientras siga pendiente.
  app.delete("/api/work-order-close-requests/:id", authenticateToken, withClient(async (req, res, client) => {
    const { rows } = await client.query(
      `UPDATE work_order_close_requests
          SET status = 'cancelled', decided_by = $2, decided_at = now(),
              decision_note = 'Retirada por el solicitante'
        WHERE id = $1 AND kind = 'request' AND status = 'pending'
          AND (requested_by = $2 OR $3)
        RETURNING id`,
      [req.params.id, req.user?.id ?? null, isApprover(req.user)]
    );
    if (!rows.length) return res.status(409).json({ success: false, error: "No se puede retirar esta solicitud." });
    res.json({ success: true, message: "Solicitud retirada." });
  }));

  // ---- POST /api/work-order-close-requests/:id/ack ----------------------
  app.post("/api/work-order-close-requests/:id/ack", authenticateToken, requireApprover, withClient(async (req, res, client) => {
    await client.query(
      `UPDATE work_order_close_requests
          SET acknowledged_by = $2, acknowledged_at = now()
        WHERE id = $1 AND kind = 'alert' AND acknowledged_at IS NULL`,
      [req.params.id, req.user?.id ?? null]
    );
    res.json({ success: true });
  }));

  // ---- POST /api/work-order-close-requests/ack-all ----------------------
  app.post("/api/work-order-close-requests/ack-all", authenticateToken, requireApprover, withClient(async (req, res, client) => {
    const { rowCount } = await client.query(
      `UPDATE work_order_close_requests
          SET acknowledged_by = $1, acknowledged_at = now()
        WHERE kind = 'alert' AND acknowledged_at IS NULL`,
      [req.user?.id ?? null]
    );
    res.json({ success: true, acknowledged: rowCount });
  }));
}

registerOrderClose.initSchema = initSchema;
registerOrderClose.ensureSchema = ensureSchema;
registerOrderClose.evaluateClose = evaluateClose;
registerOrderClose.applyClose = applyClose;
registerOrderClose.closeOrRefuse = closeOrRefuse;
registerOrderClose.isApprover = isApprover;
registerOrderClose.CLOSE_MIN_PCT = CLOSE_MIN_PCT;
module.exports = registerOrderClose;