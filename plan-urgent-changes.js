// ==========================================================================
// plan-urgent-changes.js
//
// CAMBIO URGENTE en semanas bloqueadas por el CEO.
//
// Una semana bloqueada congela el tablero: no se asigna, mueve ni borra nada.
// A veces hay una urgencia (falta tela de un color, el cliente adelanta otro
// estilo) y la linea TIENE que coser otra cosa ese dia. Este modulo permite
// cambiar UNA casilla de una semana bloqueada, sin desbloquear la semana:
//
//   • Cambio de COLOR  : misma orden, otro color   (ROJ -> AZU)
//   • Cambio de ESTILO : otra orden / otro estilo  (SKM0012 -> SKM0031)
//
// Reglas:
//   • Solo casillas de HOY en adelante, y nunca una casilla 'completed'.
//   • Solo se cambia lo que NO se ha cosido: lo producido ese dia se queda.
//   • Se pueden cambiar todas las piezas de la casilla o solo una parte; el
//     resto se queda con la orden/color original.
//   • Cambio de estilo: se revalida la capacidad de la linea con el estandar
//     del estilo nuevo (planner_style_params). Mismo estilo = misma capacidad.
//   • La orden destino debe tener piezas sin asignar (la bolsa), o se toman de
//     SALDOS DE DIAS PASADOS de esa orden (casillas que cerraron por debajo de
//     lo asignado). Esas casillas se liquidan igual que settle-day: se bajan a
//     lo que SI se cosio y quedan 'completed'; el saldo vuelve a la bolsa y de
//     ahi sale para la casilla urgente. Lo que sobre se queda en la bolsa.
//   • MOTIVO obligatorio. Todo queda en plan_urgent_changes (quien, cuando,
//     de que a que y por que), y el tablero marca la casilla con ⚡.
//   • El candado de TODO el tablero (plan_board_lock) SI se respeta: la ruta
//     vive bajo /api/line-assignments, asi que el middleware de server1.js la
//     detiene con 423 igual que a las demas.
//
// --------------------------------------------------------------------------
// COMO SE SALTA EL CANDADO DE SEMANA
// --------------------------------------------------------------------------
// El candado lo hace cumplir un trigger en line_assignments. Esta ruta NO
// llama planWeekLocks.enforce(client) y, dentro de SU transaccion, pone:
//
//     SELECT set_config('plan.urgent_override', 'on', true)   -- solo esta txn
//
// El trigger tiene que respetar esa bandera. Agregue estas 3 lineas AL INICIO
// de la funcion del trigger de semanas bloqueadas (en plan-week-locks.js):
//
//     IF COALESCE(current_setting('plan.urgent_override', true), '') = 'on' THEN
//       RETURN COALESCE(NEW, OLD);
//     END IF;
//
// `true` en set_config = LOCAL: la bandera muere con el COMMIT/ROLLBACK, asi
// que ninguna otra peticion la hereda aunque reuse la conexion del pool.
// Si el trigger aun no tiene esas lineas, la ruta responde 423 con
// code = URGENT_OVERRIDE_NOT_INSTALLED en vez de fallar a medias.
//
// --------------------------------------------------------------------------
// SETUP (server1.js)
// --------------------------------------------------------------------------
// 1. Arriba, junto a planWeekLocks:
//        const planUrgentChanges = require("./plan-urgent-changes");
//
// 2. En el bloque de migraciones, DESPUES de planWeekLocks.initSchema (~707):
//        await planUrgentChanges.initSchema({ pool, setSchema });
//
// 3. Justo despues de planWeekLocks(app, {...}) (~1259):
//        planUrgentChanges(app, {
//          authenticateToken, pool, setSchema,
//          planWeekLocks, plannerStyleParams,
//          workOrders: registerWorkOrders,
//          mergeOrInsertAssignment, ensureDraftRunForAssignment, cleanupOrphanDraftRuns,
//          urgentRoles: ["planner", "master", "ceo", "skyrina"],
//        });
// ==========================================================================

const OVERRIDE_GUC = "plan.urgent_override";
const DEFAULT_ROLES = ["planner", "master", "ceo", "skyrina"];
const MIN_REASON = 5;

const normColor = (c) => String(c == null ? "" : c).trim().toUpperCase();
const n2 = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
};

// Error con status HTTP: se lanza dentro de la transaccion y el catch hace
// ROLLBACK + responde. Evita repetir ROLLBACK en cada validacion.
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS plan_urgent_changes(
        id BIGSERIAL PRIMARY KEY,
        change_type VARCHAR(10) NOT NULL,              -- 'color' | 'style'
        line_no VARCHAR(20) NOT NULL,
        assigned_date DATE NOT NULL,
        week_start DATE,
        source_assignment_id BIGINT,
        source_work_order_id BIGINT,
        source_work_order_no VARCHAR(80),
        source_style VARCHAR(60),
        source_color VARCHAR(50),
        source_qty_before NUMERIC(12,2),
        source_qty_after NUMERIC(12,2),
        moved_qty NUMERIC(12,2) NOT NULL,
        target_assignment_id BIGINT,
        target_work_order_id BIGINT,
        target_work_order_no VARCHAR(80),
        target_style VARCHAR(60),
        target_color VARCHAR(50),
        reason TEXT NOT NULL,
        warnings JSONB NOT NULL DEFAULT '[]',
        changed_by BIGINT,
        changed_by_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // Aviso al CEO (campana): visto / quien lo vio. NULL = sin ver.
    await client.query("ALTER TABLE plan_urgent_changes ADD COLUMN IF NOT EXISTS ceo_seen_at TIMESTAMPTZ;");
    await client.query("ALTER TABLE plan_urgent_changes ADD COLUMN IF NOT EXISTS ceo_seen_by BIGINT;");
    // Saldos de dias pasados que se liquidaron para tomar sus piezas.
    await client.query("ALTER TABLE plan_urgent_changes ADD COLUMN IF NOT EXISTS settled_balances JSONB NOT NULL DEFAULT '[]';");
    await client.query("CREATE INDEX IF NOT EXISTS idx_plan_urgent_changes_unseen ON plan_urgent_changes(created_at DESC) WHERE ceo_seen_at IS NULL;");
    await client.query("CREATE INDEX IF NOT EXISTS idx_plan_urgent_changes_day ON plan_urgent_changes(assigned_date);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_plan_urgent_changes_target ON plan_urgent_changes(target_assignment_id);");
    console.log("\u2705 plan_urgent_changes table ready");
  } finally {
    client.release();
  }
}

// Piezas por color de una orden (lines -> colors -> cabecera).
async function colorQuantities(client, workOrderId, header) {
  const out = {};
  const lines = await client.query(
    "SELECT color, SUM(quantity) AS q FROM work_order_lines WHERE work_order_id = $1 GROUP BY color",
    [workOrderId]
  ).catch(() => ({ rows: [] }));
  if (lines.rows.length) {
    for (const r of lines.rows) out[normColor(r.color)] = (out[normColor(r.color)] || 0) + (Number(r.q) || 0);
    return out;
  }
  const cols = await client.query(
    "SELECT color, quantity FROM work_order_colors WHERE work_order_id = $1",
    [workOrderId]
  ).catch(() => ({ rows: [] }));
  if (cols.rows.length) {
    for (const r of cols.rows) out[normColor(r.color)] = (out[normColor(r.color)] || 0) + (Number(r.quantity) || 0);
    return out;
  }
  // Sin desglose: la cabecera puede traer "ROJ, AZU". Se acepta cualquiera de
  // esos colores; la cantidad por color no se conoce.
  for (const c of String(header.color || "").split(",").map(normColor).filter(Boolean)) out[c] = null;
  return out;
}

async function assignedActive(client, workOrderId, color) {
  const params = [workOrderId];
  let colorSql = "";
  if (color !== undefined) {
    params.push(color);
    colorSql = " AND UPPER(TRIM(COALESCE(color, ''))) = $2";
  }
  const r = await client.query(
    `SELECT COALESCE(SUM(assigned_quantity), 0) AS q
       FROM line_assignments
      WHERE work_order_id = $1 AND status NOT IN ('cancelled', 'rejected')${colorSql}`,
    params
  );
  return Number(r.rows[0].q) || 0;
}

// Liquida UNA casilla pasada (orden + linea + dia) por lo que realmente se
// cosio. Misma regla que settle-day (work-orders.js): reparto proporcional
// entre colores, residuo a la fila mas grande, filas en 0 se borran.
// Devuelve el saldo liberado (0 si el dia ya cumplio).
async function settlePastCell(client, { workOrderId, lineNo, date, produced }) {
  const cell = await client.query(
    `SELECT id, color, assigned_quantity
       FROM line_assignments
      WHERE work_order_id = $1 AND line_no = $2 AND assigned_date = $3::date
        AND assigned_date < CURRENT_DATE
        AND status NOT IN ('cancelled', 'rejected')
      ORDER BY id
      FOR UPDATE`,
    [workOrderId, String(lineNo), date]
  );
  if (!cell.rows.length) return { balance: 0, assigned: 0 };
  const parts = cell.rows.map((r) => ({ id: r.id, color: r.color, assigned: Number(r.assigned_quantity) || 0 }));
  const assigned = parts.reduce((t, r) => t + r.assigned, 0);
  const balance = Math.max(assigned - produced, 0);
  if (balance <= 0) {
    await client.query("UPDATE line_assignments SET status = 'completed', updated_at = now() WHERE id = ANY($1)", [parts.map((r) => r.id)]);
    return { balance: 0, assigned };
  }
  let given = 0;
  parts.forEach((r) => { r.keep = assigned > 0 ? Math.floor((r.assigned / assigned) * produced) : 0; given += r.keep; });
  const rest = produced - given;
  if (rest > 0) parts.slice().sort((x, y) => y.assigned - x.assigned)[0].keep += rest;
  for (const r of parts.filter((x) => x.keep > 0)) {
    await client.query(
      "UPDATE line_assignments SET assigned_quantity = $2, status = 'completed', updated_at = now() WHERE id = $1",
      [r.id, r.keep]
    );
  }
  const del = parts.filter((x) => x.keep <= 0).map((x) => x.id);
  if (del.length) await client.query("DELETE FROM line_assignments WHERE id = ANY($1)", [del]);
  return { balance, assigned, colors: parts.map((r) => r.color).filter(Boolean) };
}

/**
 * @param {import('express').Express} app
 * @param {object} deps
 */
function registerPlanUrgentChanges(app, deps) {
  const {
    authenticateToken, pool, setSchema,
    planWeekLocks, plannerStyleParams, workOrders,
    mergeOrInsertAssignment, ensureDraftRunForAssignment, cleanupOrphanDraftRuns,
  } = deps;
  const urgentRoles = deps.urgentRoles || DEFAULT_ROLES;
  const canUrgent = (user) => urgentRoles.includes(user?.role);
  // Quien recibe el aviso en la campana del CEO.
  const notifyRoles = deps.notifyRoles || ["ceo", "skyrina", "master"];
  const canSeeNotices = (user) => notifyRoles.includes(user?.role);

  // Lo cosido de una orden en una linea/dia (empaque/terminado). Usa la misma
  // deteccion que el resto del planeador (work-orders.js).
  const producedOnCell = async (client, workOrderId, lineNo, day) => {
    if (typeof workOrders?.producedByLineDayForMany !== "function") return 0;
    const rows = await workOrders.producedByLineDayForMany(client, { workOrderIds: [workOrderId], from: day, to: day });
    return rows
      .filter((r) => String(r.line_no) === String(lineNo) && r.day === day)
      .reduce((s, r) => s + (Number(r.produced) || 0), 0);
  };

  // ---- GET /api/plan-urgent-changes?from=YYYY-MM-DD&to=YYYY-MM-DD ---------
  // Historial para pintar ⚡ en el tablero. Por defecto: 30 dias atras a 180
  // adelante. canUrgent le dice al tablero si muestra el boton.
  app.get("/api/plan-urgent-changes", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : null;
      const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? req.query.to : null;
      const { rows } = await client.query(
        `SELECT id, change_type, line_no,
                to_char(assigned_date, 'YYYY-MM-DD') AS assigned_date,
                to_char(week_start, 'YYYY-MM-DD') AS week_start,
                source_assignment_id, source_work_order_id, source_work_order_no, source_style,
                source_color, source_qty_before, source_qty_after, moved_qty,
                target_assignment_id, target_work_order_id, target_work_order_no, target_style,
                target_color, reason, warnings, changed_by, changed_by_name, created_at
           FROM plan_urgent_changes
          WHERE assigned_date >= COALESCE($1::date, CURRENT_DATE - 30)
            AND assigned_date <= COALESCE($2::date, CURRENT_DATE + 180)
          ORDER BY created_at DESC
          LIMIT 1000`,
        [from, to]
      );
      res.json({ success: true, canUrgent: canUrgent(req.user), changes: rows });
    } catch (err) {
      // Tabla aun no creada: el tablero sigue funcionando, solo sin ⚡.
      res.json({ success: true, canUrgent: canUrgent(req.user), changes: [], warning: err.message });
    } finally {
      client.release();
    }
  });

  // =====================================================================
  //  AVISOS PARA LA CAMPANA DEL CEO (CeoActivityBell.jsx)
  // =====================================================================
  // Misma forma que /api/ceo/verificador-activity para que la campana los
  // mezcle: { success, unread, items: [{ id, action, summary, user_name,
  // created_at, unread, details }] }. El id lleva prefijo "u-" para no chocar
  // con los ids del verificador.
  const toNotice = (r) => {
    const src = `${r.source_work_order_no || "—"}${r.source_color ? ` ${r.source_color}` : ""}`;
    const tgt = `${r.target_work_order_no || "—"}${r.target_color ? ` ${r.target_color}` : ""}`;
    const kind = r.change_type === "style" ? "Estilo" : "Color";
    return {
      id: `u-${r.id}`,
      action: "urgent_change",
      summary: `${kind} cambiado en semana bloqueada · Línea ${r.line_no} ${r.assigned_date}: ${src} → ${tgt} (${Math.round(Number(r.moved_qty) || 0)} pzas)`,
      user_name: r.changed_by_name || null,
      created_at: r.created_at,
      unread: r.ceo_seen_at == null,
      details: {
        changeType: r.change_type,
        lineNo: r.line_no,
        day: r.assigned_date,
        weekStart: r.week_start,
        from: { workOrderNo: r.source_work_order_no, style: r.source_style, color: r.source_color },
        to: { workOrderNo: r.target_work_order_no, style: r.target_style, color: r.target_color },
        movedQty: Number(r.moved_qty) || 0,
        sourceLeft: Number(r.source_qty_after) || 0,
        reason: r.reason,
        warnings: r.warnings || [],
        settledBalances: r.settled_balances || [],
      },
    };
  };

  app.get("/api/ceo/urgent-changes", authenticateToken, async (req, res) => {
    if (!canSeeNotices(req.user)) return res.status(403).json({ success: false, error: "Sin acceso a los avisos." });
    const client = await pool.connect();
    try {
      await setSchema(client);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 200);
      const { rows } = await client.query(
        `SELECT id, change_type, line_no, to_char(assigned_date, 'YYYY-MM-DD') AS assigned_date,
                to_char(week_start, 'YYYY-MM-DD') AS week_start,
                source_work_order_no, source_style, source_color, source_qty_after, moved_qty,
                target_work_order_no, target_style, target_color, reason, warnings,
                settled_balances, changed_by_name, created_at, ceo_seen_at
           FROM plan_urgent_changes
          ORDER BY created_at DESC
          LIMIT $1`,
        [limit]
      );
      const unread = (await client.query(
        "SELECT COUNT(*)::int AS n FROM plan_urgent_changes WHERE ceo_seen_at IS NULL"
      )).rows[0].n;
      res.json({ success: true, unread, items: rows.map(toNotice) });
    } catch (err) {
      // Tabla aun no creada: la campana sigue con lo del verificador.
      res.json({ success: true, unread: 0, items: [], warning: err.message });
    } finally {
      client.release();
    }
  });

  app.post("/api/ceo/urgent-changes/seen", authenticateToken, async (req, res) => {
    if (!canSeeNotices(req.user)) return res.status(403).json({ success: false, error: "Sin acceso a los avisos." });
    const client = await pool.connect();
    try {
      await setSchema(client);
      const r = await client.query(
        "UPDATE plan_urgent_changes SET ceo_seen_at = now(), ceo_seen_by = $1 WHERE ceo_seen_at IS NULL",
        [req.user?.id ?? null]
      );
      res.json({ success: true, updated: r.rowCount });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  app.post("/api/ceo/urgent-changes/:id/seen", authenticateToken, async (req, res) => {
    if (!canSeeNotices(req.user)) return res.status(403).json({ success: false, error: "Sin acceso a los avisos." });
    const id = parseInt(String(req.params.id).replace(/^u-/, ""), 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: "id inválido" });
    const client = await pool.connect();
    try {
      await setSchema(client);
      const r = await client.query(
        "UPDATE plan_urgent_changes SET ceo_seen_at = now(), ceo_seen_by = $2 WHERE id = $1 AND ceo_seen_at IS NULL",
        [id, req.user?.id ?? null]
      );
      res.json({ success: true, updated: r.rowCount });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---- GET /api/line-assignments/urgent-options?assignmentId=N ------------
  // Lo que el modal de cambio urgente necesita, calculado aqui y no con las
  // listas del tablero (que pueden no traer ordenes ya asignadas):
  //   sameStyleOrders  ordenes activas del MISMO estilo y cliente que la
  //                    casilla (incluida la suya), con lo libre por color.
  // Los saldos de dias pasados los pide el modal a /day-balances.
  app.get("/api/line-assignments/urgent-options", authenticateToken, async (req, res) => {
    const assignmentId = parseInt(req.query.assignmentId, 10);
    if (!Number.isInteger(assignmentId)) return res.status(400).json({ success: false, error: "assignmentId requerido" });
    const client = await pool.connect();
    try {
      await setSchema(client);
      const STYLE = "UPPER(TRIM(COALESCE(NULLIF(TRIM(w.style_code), ''), w.estilo, '')))";
      const CUST = "COALESCE(w.customer_id::text, UPPER(TRIM(COALESCE(w.customer_name, ''))))";
      const src = (await client.query(
        `SELECT w.id, ${STYLE} AS style_key, ${CUST} AS cust_key
           FROM line_assignments la JOIN work_orders w ON w.id = la.work_order_id
          WHERE la.id = $1`,
        [assignmentId]
      )).rows[0];
      if (!src) return res.status(404).json({ success: false, error: "La casilla ya no existe." });

      const { rows: orders } = await client.query(
        `SELECT w.id, w.work_order_no, w.customer_po, w.customer_name, w.status, w.color,
                w.style_code, w.estilo, w.style_description,
                COALESCE(NULLIF(w.total_to_produce, 0), w.quantity, 0) AS target
           FROM work_orders w
          WHERE (w.id = $1
                 OR (${STYLE} = $2 AND $2 <> '' AND ${CUST} = $3
                     AND COALESCE(w.status, '') NOT IN ('completed', 'cancelled', 'canceled', 'closed')))
          ORDER BY (w.id = $1) DESC, w.work_order_no
          LIMIT 60`,
        [src.id, src.style_key, src.cust_key]
      );
      const out = [];
      for (const o of orders) {
        const colors = await colorQuantities(client, o.id, o);
        const assigned = await assignedActive(client, o.id);
        const byColor = (await client.query(
          `SELECT UPPER(TRIM(COALESCE(color, ''))) AS c, SUM(assigned_quantity) AS q
             FROM line_assignments WHERE work_order_id = $1 AND status NOT IN ('cancelled', 'rejected')
            GROUP BY 1`, [o.id]
        )).rows.reduce((m, r) => ((m[r.c] = Number(r.q) || 0), m), {});
        out.push({
          id: Number(o.id),
          work_order_no: o.work_order_no,
          customer_po: o.customer_po,
          customer_name: o.customer_name,
          style: o.style_code || o.estilo || null,
          status: o.status,
          own: Number(o.id) === Number(src.id),
          target: Number(o.target) || 0,
          assigned,
          free: Math.max((Number(o.target) || 0) - assigned, 0),
          colors: Object.entries(colors).map(([color, qty]) => ({
            color,
            qty,
            assigned: byColor[color] || 0,
            free: qty == null ? null : Math.max(qty - (byColor[color] || 0), 0),
          })),
        });
      }
      res.json({ success: true, styleKey: src.style_key, sameStyleOrders: out });
    } catch (err) {
      console.error("\u274c Error en urgent-options:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---- POST /api/line-assignments/urgent-change ---------------------------
  // Body:
  //   assignmentId   casilla (line_assignments.id) en una semana bloqueada
  //   mode           'color' | 'style'
  //   newColor       color destino (obligatorio en 'color'; en 'style' si la
  //                  orden destino tiene mas de un color)
  //   newWorkOrderId orden destino (solo 'style')
  //   quantity       piezas a cambiar (default: todo lo no cosido)
  //   reason         motivo (obligatorio)
  //   balanceCells   [{ lineNo, date }] casillas PASADAS de la orden destino
  //                  con saldo: se liquidan y su saldo se usa para el cambio.
  //   sendToLines    true/false: crear el borrador para el lider de linea.
  //                  Default: true si la casilla original ya se habia enviado.
  app.post("/api/line-assignments/urgent-change", authenticateToken, async (req, res) => {
    if (!canUrgent(req.user)) {
      return res.status(403).json({ success: false, error: "Su rol no puede hacer cambios urgentes en semanas bloqueadas." });
    }
    const body = req.body || {};
    const assignmentId = parseInt(body.assignmentId, 10);
    const mode = body.mode === "style" ? "style" : body.mode === "color" ? "color" : null;
    const reason = String(body.reason || "").trim();
    if (!Number.isInteger(assignmentId) || !mode) {
      return res.status(400).json({ success: false, error: "assignmentId y mode ('color' | 'style') son obligatorios." });
    }
    if (reason.length < MIN_REASON) {
      return res.status(400).json({ success: false, error: "Escriba el motivo del cambio urgente." });
    }

    const client = await pool.connect();
    try {
      await setSchema(client);
      await client.query("BEGIN");
      // 🔓 Solo esta transaccion. NO se llama planWeekLocks.enforce().
      await client.query("SELECT set_config($1, 'on', true)", [OVERRIDE_GUC]);

      // ---- casilla origen ---------------------------------------------------
      const src = (await client.query(
        `SELECT la.id, la.work_order_id, la.line_no, la.assigned_quantity, la.color, la.status,
                la.line_run_id, to_char(la.assigned_date, 'YYYY-MM-DD') AS day,
                (la.assigned_date < CURRENT_DATE) AS is_past,
                wo.work_order_no
           FROM line_assignments la
           JOIN work_orders wo ON wo.id = la.work_order_id
          WHERE la.id = $1
          FOR UPDATE OF la`,
        [assignmentId]
      )).rows[0];
      if (!src) throw new HttpError(404, "La casilla ya no existe. Recargue el tablero.");
      if (["cancelled", "rejected"].includes(src.status)) throw new HttpError(409, "La casilla está cancelada.");
      if (src.status === "completed") throw new HttpError(409, "La casilla ya está terminada: no se puede cambiar.");
      if (src.is_past) throw new HttpError(409, "Ese día ya pasó: solo se cambian casillas de hoy en adelante.");

      const lockedWeeks = await planWeekLocks.lockedWeekSet(client);
      if (!planWeekLocks.isLockedDay(lockedWeeks, src.day)) {
        throw new HttpError(409, "Esta semana no está bloqueada: haga el cambio normal en el tablero.", { code: "WEEK_NOT_LOCKED" });
      }
      const weekStart = typeof planWeekLocks.weekStartOf === "function" ? planWeekLocks.weekStartOf(src.day) : null;

      const srcQty = Number(src.assigned_quantity) || 0;
      const srcColor = normColor(src.color);
      const srcStyle = await plannerStyleParams.styleOfWorkOrder(client, src.work_order_id);

      // Lo cosido ese dia se queda donde esta.
      const produced = await producedOnCell(client, src.work_order_id, src.line_no, src.day);
      const movable = n2(Math.max(srcQty - produced, 0));
      if (movable <= 0) throw new HttpError(409, `Esa casilla ya tiene ${Math.round(produced)} pzas cosidas: no queda nada por cambiar.`);

      const qty = body.quantity == null || body.quantity === "" ? movable : n2(body.quantity);
      if (!(qty > 0)) throw new HttpError(400, "La cantidad a cambiar debe ser mayor que cero.");
      if (qty > movable) {
        throw new HttpError(400, `Solo se pueden cambiar ${Math.floor(movable)} pzas de esta casilla${produced > 0 ? ` (${Math.round(produced)} ya están cosidas)` : ""}.`, { maxQuantity: Math.floor(movable) });
      }

      // ---- destino ------------------------------------------------------------
      // 'color': por defecto la misma orden; tambien puede ser otra orden del
      // MISMO estilo y cliente (otro PO con el color disponible).
      const pickedWo = body.newWorkOrderId == null || body.newWorkOrderId === "" ? null : parseInt(body.newWorkOrderId, 10);
      const targetWoId = mode === "style" ? pickedWo : pickedWo ?? Number(src.work_order_id);
      if (!Number.isInteger(targetWoId)) throw new HttpError(400, "Elija la orden del nuevo estilo.");

      const tgt = (await client.query(
        `SELECT id, work_order_no, status, color, total_to_produce, quantity, customer_id, customer_name
           FROM work_orders WHERE id = $1 FOR UPDATE`,
        [targetWoId]
      )).rows[0];
      if (!tgt) throw new HttpError(404, "La orden destino no existe.");
      if (["cancelled", "completed"].includes(tgt.status)) throw new HttpError(409, `La orden ${tgt.work_order_no} está ${tgt.status === "cancelled" ? "cancelada" : "terminada"}.`);

      const tgtColors = await colorQuantities(client, targetWoId, tgt);
      const colorList = Object.keys(tgtColors);
      let newColor = normColor(body.newColor);
      if (!newColor && mode === "style" && colorList.length === 1) newColor = colorList[0];
      if (!newColor && colorList.length > 0) throw new HttpError(400, `Elija el color de la orden ${tgt.work_order_no}.`);
      if (newColor && colorList.length > 0 && !colorList.includes(newColor)) {
        throw new HttpError(400, `La orden ${tgt.work_order_no} no tiene el color ${newColor} (tiene: ${colorList.join(", ")}).`);
      }
      if (targetWoId === Number(src.work_order_id) && newColor === srcColor) {
        throw new HttpError(400, "El destino es igual a la casilla actual: elija otro color u otra orden.");
      }
      const tgtStyle = targetWoId === Number(src.work_order_id) ? srcStyle : await plannerStyleParams.styleOfWorkOrder(client, targetWoId);
      if (mode === "color" && targetWoId !== Number(src.work_order_id)) {
        const normS = (v) => String(v || "").trim().toUpperCase();
        if (normS(tgtStyle) !== normS(srcStyle)) {
          throw new HttpError(400, `La orden ${tgt.work_order_no} es de otro estilo (${tgtStyle || "—"}): use "Cambiar estilo".`);
        }
        const custOf = async (id) => (await client.query(
          "SELECT COALESCE(customer_id::text, UPPER(TRIM(customer_name))) AS c FROM work_orders WHERE id = $1", [id]
        )).rows[0]?.c || null;
        const [cs, ct] = [await custOf(src.work_order_id), await custOf(targetWoId)];
        if (cs && ct && cs !== ct) {
          throw new HttpError(400, `La orden ${tgt.work_order_no} es de otro cliente: use "Cambiar estilo".`);
        }
      }
      const changeType = mode === "style" && String(tgtStyle || "") !== String(srcStyle || "") ? "style" : mode;

      // ---- saldos de dias pasados de la orden destino -------------------------
      const settled = [];
      const wanted = Array.isArray(body.balanceCells) ? body.balanceCells.slice(0, 60) : [];
      if (wanted.length) {
        const dates = wanted.map((c) => String(c?.date || "").slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
        if (dates.length !== wanted.length) throw new HttpError(400, "Fecha de saldo inválida.");
        const minD = dates.reduce((m, d) => (d < m ? d : m)), maxD = dates.reduce((m, d) => (d > m ? d : m));
        const prodRows = typeof workOrders?.producedByLineDayForMany === "function"
          ? await workOrders.producedByLineDayForMany(client, { workOrderIds: [targetWoId], from: minD, to: maxD })
          : [];
        const seen = new Set();
        for (const c of wanted) {
          const lineNo = String(c.lineNo), date = String(c.date).slice(0, 10);
          const k = `${lineNo}|${date}`;
          if (seen.has(k)) continue;
          seen.add(k);
          if (lineNo === String(src.line_no) && date === src.day) continue; // la casilla urgente no
          const produced = prodRows
            .filter((r) => String(r.line_no) === lineNo && r.day === date)
            .reduce((t, r) => t + (Number(r.produced) || 0), 0);
          const r = await settlePastCell(client, { workOrderId: targetWoId, lineNo, date, produced });
          if (r.assigned === 0) throw new HttpError(409, `La casilla Línea ${lineNo} ${date} de ${tgt.work_order_no} ya no tiene saldo (o no es de un día pasado). Recargue el tablero.`);
          settled.push({ lineNo, date, assigned: r.assigned, produced, balance: r.balance });
        }
      }

      // ---- la orden destino debe tener piezas en la bolsa --------------------
      const sameOrder = targetWoId === Number(src.work_order_id);
      const target = Number(tgt.total_to_produce) || Number(tgt.quantity) || 0;
      const assignedAll = await assignedActive(client, targetWoId);
      const orderFree = n2(target - (sameOrder ? assignedAll - qty : assignedAll));
      if (target > 0 && qty > orderFree) {
        throw new HttpError(400,
          `La orden ${tgt.work_order_no} solo tiene ${Math.max(Math.floor(orderFree), 0)} pzas disponibles` +
          (settled.length ? " (incluyendo los saldos elegidos)." : ". Elija saldos de días pasados para tomar más."),
          { maxQuantity: Math.max(Math.floor(orderFree), 0) });
      }
      const warnings = [];
      const colorTarget = newColor ? tgtColors[newColor] : null;
      if (colorTarget != null) {
        const colorFree = n2(colorTarget - (await assignedActive(client, targetWoId, newColor)));
        if (qty > colorFree) {
          warnings.push(`El color ${newColor} queda ${Math.ceil(qty - Math.max(colorFree, 0))} pzas por encima de lo pedido en la orden.`);
        }
      }

      // ---- 1. quitar las piezas de la casilla origen -------------------------
      const srcLeft = n2(srcQty - qty);
      if (srcLeft > 0) {
        await client.query(
          "UPDATE line_assignments SET assigned_quantity = $2, updated_at = now() WHERE id = $1",
          [src.id, srcLeft]
        );
      } else {
        await client.query("DELETE FROM line_assignments WHERE id = $1", [src.id]);
      }

      // ---- 2. capacidad del estilo nuevo en esa linea/dia --------------------
      // Ya sin las piezas de origen, asi que el hueco liberado cuenta.
      const cap = await plannerStyleParams.cellCapacity(client, { lineNo: String(src.line_no), date: src.day, style: tgtStyle });
      if (!cap.params) {
        await client.query("ROLLBACK");
        return plannerStyleParams.styleParamsRequired(res, tgtStyle);
      }
      if (changeType === "style" && qty > cap.available + 0.0001) {
        throw new HttpError(400,
          `La Línea ${src.line_no} solo tiene capacidad para ${Math.max(Math.floor(cap.available), 0)} pzas del estilo ${tgtStyle || "nuevo"} el ${src.day}.`,
          { maxQuantity: Math.max(Math.floor(cap.available), 0) });
      }

      // ---- 3. poner las piezas del destino -----------------------------------
      const newRow = await mergeOrInsertAssignment(client, {
        workOrderId: targetWoId,
        lineRunId: null,
        lineNo: String(src.line_no),
        assignedDate: src.day,
        quantity: qty,
        availableMinutes: cap.availableMinutes,
        requiredRate: cap.target,
        startDate: src.day,
        endDate: src.day,
        status: "planned",
        color: newColor || null,
      });

      // ---- 4. lideres de linea -----------------------------------------------
      const wasSent = src.status === "released" || src.line_run_id != null;
      const sendToLines = body.sendToLines == null ? wasSent : !!body.sendToLines;
      let runId = null;
      if (sendToLines && typeof ensureDraftRunForAssignment === "function") {
        const r = await ensureDraftRunForAssignment(client, {
          lineNo: String(src.line_no), runDate: src.day, workOrderId: targetWoId, style: null,
        });
        runId = r?.runId || null;
      }
      // Borrador viejo del estilo que salio, si ya nadie de ese estilo queda
      // en la casilla y nunca se capturo nada en el. Los confirmados no se tocan.
      const runStyleOf = async (woId) => (await client.query(
        "SELECT COALESCE(NULLIF(style_code, ''), estilo) AS s FROM work_orders WHERE id = $1", [woId]
      )).rows[0]?.s || null;
      const srcRunStyle = changeType === "style" ? await runStyleOf(src.work_order_id) : null;
      if (srcRunStyle) {
        // SAVEPOINT: si la limpieza falla, no debe abortar el cambio urgente.
        await client.query("SAVEPOINT urgent_draft_cleanup");
        await client.query(
          `DELETE FROM line_runs lr
            WHERE lr.line_no = $1 AND lr.run_date = $2::date AND lr.style = $3 AND lr.is_draft = true
              AND NOT EXISTS (
                SELECT 1 FROM line_assignments la JOIN work_orders w ON w.id = la.work_order_id
                 WHERE la.line_no = lr.line_no AND la.assigned_date = lr.run_date
                   AND la.status NOT IN ('cancelled', 'rejected')
                   AND COALESCE(NULLIF(w.style_code, ''), w.estilo) = $3)
              AND NOT EXISTS (SELECT 1 FROM operation_sewed_entries se WHERE se.run_id = lr.id)`,
          [String(src.line_no), src.day, srcRunStyle]
        ).then(
          () => client.query("RELEASE SAVEPOINT urgent_draft_cleanup"),
          async (e) => {
            await client.query("ROLLBACK TO SAVEPOINT urgent_draft_cleanup");
            warnings.push(`No se limpió el borrador del estilo anterior: ${e.message}`);
          }
        );
      }
      if (typeof cleanupOrphanDraftRuns === "function") {
        await cleanupOrphanDraftRuns(client, String(src.line_no), src.day);
      }

      // ---- 5. estado de las ordenes ------------------------------------------
      await client.query(
        "UPDATE work_orders SET status = CASE WHEN status = 'pending' THEN 'assigned' ELSE status END, updated_at = now() WHERE id = $1",
        [targetWoId]
      );
      if (!sameOrder && (await assignedActive(client, src.work_order_id)) <= 0) {
        await client.query(
          "UPDATE work_orders SET status = CASE WHEN status = 'assigned' THEN 'pending' ELSE status END, updated_at = now() WHERE id = $1",
          [src.work_order_id]
        );
      }

      // ---- 6. bitacora --------------------------------------------------------
      const who = req.user?.full_name || req.user?.username || null;
      const log = (await client.query(
        `INSERT INTO plan_urgent_changes
           (change_type, line_no, assigned_date, week_start, source_assignment_id, source_work_order_id,
            source_work_order_no, source_style, source_color, source_qty_before, source_qty_after, moved_qty,
            target_assignment_id, target_work_order_id, target_work_order_no, target_style, target_color,
            reason, warnings, changed_by, changed_by_name, settled_balances)
         VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22::jsonb)
         RETURNING id, created_at`,
        [changeType, String(src.line_no), src.day, weekStart, src.id, src.work_order_id,
         src.work_order_no, srcStyle || null, srcColor || null, srcQty, srcLeft, qty,
         newRow?.id || null, targetWoId, tgt.work_order_no, tgtStyle || null, newColor || null,
         reason, JSON.stringify(warnings), req.user?.id ?? null, who, JSON.stringify(settled)]
      )).rows[0];

      await client.query("COMMIT");
      console.log(`⚡ Cambio urgente #${log.id} L${src.line_no} ${src.day}: ${src.work_order_no}/${srcColor} -> ${tgt.work_order_no}/${newColor} (${qty} pzas) por ${who}`);

      res.json({
        success: true,
        changeId: Number(log.id),
        changeType,
        movedQty: qty,
        sourceLeft: srcLeft,
        assignment: newRow,
        sentToLines: !!runId,
        settledBalances: settled,
        warnings,
        message:
          `⚡ ${changeType === "style" ? "Estilo" : "Color"} cambiado en Línea ${src.line_no} (${src.day}): ` +
          `${src.work_order_no}${srcColor ? ` ${srcColor}` : ""} → ${tgt.work_order_no}${newColor ? ` ${newColor}` : ""}, ${Math.round(qty)} pzas.` +
          (srcLeft > 0 ? ` Quedan ${Math.round(srcLeft)} pzas de la orden original.` : "") +
          (settled.length ? ` Se liquidaron ${settled.length} día(s) pasados (${Math.round(settled.reduce((t, x) => t + x.balance, 0))} pzas de saldo).` : ""),
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err instanceof HttpError) {
        return res.status(err.status).json({ success: false, error: err.message, ...err.extra });
      }
      if (planWeekLocks?.isLockError?.(err)) {
        // El trigger rechazo aun con la bandera: le faltan las 3 lineas.
        return res.status(423).json({
          success: false,
          code: "URGENT_OVERRIDE_NOT_INSTALLED",
          error: "🔒 La base de datos rechazó el cambio urgente: falta habilitar 'plan.urgent_override' en el trigger de semanas bloqueadas. Avise a sistemas.",
        });
      }
      console.error("\u274c Error en urgent-change:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });
}

registerPlanUrgentChanges.initSchema = initSchema;
module.exports = registerPlanUrgentChanges;