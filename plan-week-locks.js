// ==========================================================================
// plan-week-locks.js
//
// Bloqueo de semanas del Plan Board por el CEO.
//
//   • El CEO (Analíticas de Planeación → Tablero del planner → vista Semanal)
//     da clic en el candado junto a "Sem N" y esa semana queda CONGELADA.
//   • Mientras esté bloqueada, el planner no puede asignar, mover, insertar,
//     combinar, liquidar ni eliminar nada cuyo día caiga en esa semana
//     (lunes a domingo), ni siquiera por arrastre en cascada desde otra semana.
//   • Sólo el CEO la desbloquea.
//   • Una semana con pre-órdenes (reservas PRE#### en el Plan Board) NO se
//     puede bloquear: primero se convierten, se mueven o se quitan (409
//     WEEK_HAS_PRE_ORDERS con la lista).
//
// Cómo se hace cumplir (servidor = autoridad, el frontend sólo avisa antes):
//   Un trigger en line_assignments rechaza cualquier INSERT / UPDATE / DELETE
//   que toque un día de una semana bloqueada. El trigger es OPT-IN por
//   transacción: sólo actúa cuando la ruta llamó a `enforce(client)` justo
//   después de BEGIN. Así las rutas del planner quedan protegidas y las tareas
//   internas de mantenimiento (consolidación de filas, recálculos) siguen
//   funcionando sin cambios.
//
// SETUP en server1.js
//   1. Arriba, junto a los otros require:
//        const planWeekLocks = require("./plan-week-locks");
//   2. En el bloque async de arranque, junto a los otros initSchema:
//        await planWeekLocks.initSchema({ pool, setSchema });
//   3. Donde se registran los módulos:
//        planWeekLocks(app, { authenticateToken, pool, setSchema });
//   4. En cada ruta del planner que modifica line_assignments, después de
//      BEGIN:   await planWeekLocks.enforce(client);
//      y en su catch, después del ROLLBACK:
//        if (planWeekLocks.isLockError(err)) return planWeekLocks.sendLocked(res, err);
//
// Reservas PRE (pre_order_day_holds): el MISMO candado, con su propio trigger
// (también opt-in con enforce). initSchema debe correr DESPUÉS de
// pre-order-holds.initSchema para que la tabla ya exista (en server1.js ya es así).
//
// Recorridos que reparten piezas día por día (move, move-batch): usan
// lockedWeekSet() + isLockedDay() para BRINCAR las semanas bloqueadas y seguir
// en la siguiente semana libre, en vez de chocar con el trigger.
// ==========================================================================

// Roles que pueden bloquear / desbloquear. Ajuste a como se llama el rol del
// CEO en su tabla users (o pase `lockerRoles` al registrar el módulo).
const DEFAULT_LOCKER_ROLES = ["ceo", "skyrina", "master"];

// 🔔 Aviso al CEO. Cuando un usuario con uno de estos roles REALES
// (req.user.actual_role; factory_director entra como "master" por el alias)
// bloquea o desbloquea una semana, el CEO lo ve en su campana
// (GET /api/ceo/week-lock-events, ver CeoActivityBell.jsx).
const DEFAULT_NOTIFY_ACTOR_ROLES = ["factory_director"];
// Quién recibe esos avisos (por req.user.role, ya con alias). Los que tienen
// un rol de notifyActorRoles quedan fuera aunque su alias sea "master": el
// aviso es para el CEO, no para los directores.
const DEFAULT_CEO_VIEWER_ROLES = ["ceo", "master"];

// SQLSTATE propio para reconocer el rechazo del trigger sin parsear textos.
const LOCK_SQLSTATE = "WKLCK";

const isYmd = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);
    const schema = (await client.query("SELECT current_schema() AS s")).rows[0].s;

    await client.query(`
      CREATE TABLE IF NOT EXISTS plan_week_locks (
        week_start      DATE PRIMARY KEY,          -- lunes de la semana
        locked_by       INTEGER,
        locked_by_name  TEXT,
        note            TEXT,
        locked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_plan_week_lock_monday CHECK (EXTRACT(ISODOW FROM week_start) = 1)
      );
    `);
    // Bitácora: quién bloqueó / desbloqueó y cuándo.
    await client.query(`
      CREATE TABLE IF NOT EXISTS plan_week_lock_log (
        id          BIGSERIAL PRIMARY KEY,
        week_start  DATE NOT NULL,
        action      TEXT NOT NULL CHECK (action IN ('lock', 'unlock')),
        user_id     INTEGER,
        user_name   TEXT,
        note        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // 🔔 Aviso al CEO: rol real de quien actuó, si se le avisa y si ya lo vio.
    // Las filas viejas quedan con notify_ceo = false (no aparecen de golpe).
    await client.query(`
      ALTER TABLE plan_week_lock_log
        ADD COLUMN IF NOT EXISTS actor_role  TEXT,
        ADD COLUMN IF NOT EXISTS notify_ceo  BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS ceo_seen_at TIMESTAMPTZ;
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plan_week_lock_log_ceo
        ON plan_week_lock_log (created_at DESC) WHERE notify_ceo;
    `);

    // El nombre del esquema se incrusta en la función para que el trigger no
    // dependa del search_path de quien la ejecute.
    await client.query(`
      CREATE OR REPLACE FUNCTION ${schema}.fn_line_assignments_week_lock()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      DECLARE
        wk DATE;
      BEGIN
        -- Opt-in: sólo las transacciones que llamaron a enforce().
        IF COALESCE(current_setting('app.enforce_week_locks', true), '') <> 'on' THEN
          RETURN COALESCE(NEW, OLD);
        END IF;

        -- En UPDATE sólo cuenta si cambia algo que se ve en el tablero:
        -- día, línea, cantidad, orden, color, o si se cancela. Cambios de
        -- estado como planned → released/completed siguen permitidos.
        IF TG_OP = 'UPDATE' THEN
          IF NEW.assigned_date     IS NOT DISTINCT FROM OLD.assigned_date
             AND NEW.line_no           IS NOT DISTINCT FROM OLD.line_no
             AND NEW.assigned_quantity IS NOT DISTINCT FROM OLD.assigned_quantity
             AND NEW.work_order_id     IS NOT DISTINCT FROM OLD.work_order_id
             AND NEW.color             IS NOT DISTINCT FROM OLD.color
             AND NOT (COALESCE(NEW.status, '') IN ('cancelled', 'rejected')
                      AND NEW.status IS DISTINCT FROM OLD.status) THEN
            RETURN NEW;
          END IF;
        END IF;

        -- De dónde sale (UPDATE / DELETE).
        IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.assigned_date IS NOT NULL THEN
          wk := date_trunc('week', OLD.assigned_date)::date;
          IF EXISTS (SELECT 1 FROM ${schema}.plan_week_locks WHERE week_start = wk) THEN
            RAISE EXCEPTION 'La semana del % está bloqueada por el CEO', to_char(wk, 'DD/MM/YYYY')
              USING ERRCODE = '${LOCK_SQLSTATE}', DETAIL = to_char(wk, 'YYYY-MM-DD');
          END IF;
        END IF;

        -- A dónde llega (INSERT / UPDATE).
        IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.assigned_date IS NOT NULL THEN
          wk := date_trunc('week', NEW.assigned_date)::date;
          IF EXISTS (SELECT 1 FROM ${schema}.plan_week_locks WHERE week_start = wk) THEN
            RAISE EXCEPTION 'La semana del % está bloqueada por el CEO', to_char(wk, 'DD/MM/YYYY')
              USING ERRCODE = '${LOCK_SQLSTATE}', DETAIL = to_char(wk, 'YYYY-MM-DD');
          END IF;
        END IF;

        RETURN COALESCE(NEW, OLD);
      END;
      $fn$;
    `);

    await client.query(`DROP TRIGGER IF EXISTS trg_line_assignments_week_lock ON ${schema}.line_assignments;`);
    await client.query(`
      CREATE TRIGGER trg_line_assignments_week_lock
      BEFORE INSERT OR UPDATE OR DELETE ON ${schema}.line_assignments
      FOR EACH ROW EXECUTE FUNCTION ${schema}.fn_line_assignments_week_lock();
    `);

    // Mismo candado para las reservas PRE del Plan Board. Sólo si la tabla ya
    // existe (pre-order-holds.initSchema corre antes en el arranque).
    const holdsReg = (await client.query(
      "SELECT to_regclass($1) AS t", [`${schema}.pre_order_day_holds`]
    )).rows[0].t;
    if (holdsReg) {
      await client.query(`
        CREATE OR REPLACE FUNCTION ${schema}.fn_pre_order_day_holds_week_lock()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $fn$
        DECLARE
          wk DATE;
        BEGIN
          IF COALESCE(current_setting('app.enforce_week_locks', true), '') <> 'on' THEN
            RETURN COALESCE(NEW, OLD);
          END IF;

          -- Un UPDATE que no cambia nada visible (p. ej. sólo updated_at) pasa.
          IF TG_OP = 'UPDATE' THEN
            IF NEW.assigned_date IS NOT DISTINCT FROM OLD.assigned_date
               AND NEW.line_no      IS NOT DISTINCT FROM OLD.line_no
               AND NEW.quantity     IS NOT DISTINCT FROM OLD.quantity
               AND NEW.pre_order_id IS NOT DISTINCT FROM OLD.pre_order_id
               AND NEW.color        IS NOT DISTINCT FROM OLD.color THEN
              RETURN NEW;
            END IF;
          END IF;

          IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.assigned_date IS NOT NULL THEN
            wk := date_trunc('week', OLD.assigned_date)::date;
            IF EXISTS (SELECT 1 FROM ${schema}.plan_week_locks WHERE week_start = wk) THEN
              RAISE EXCEPTION 'La semana del % está bloqueada por el CEO', to_char(wk, 'DD/MM/YYYY')
                USING ERRCODE = '${LOCK_SQLSTATE}', DETAIL = to_char(wk, 'YYYY-MM-DD');
            END IF;
          END IF;

          IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.assigned_date IS NOT NULL THEN
            wk := date_trunc('week', NEW.assigned_date)::date;
            IF EXISTS (SELECT 1 FROM ${schema}.plan_week_locks WHERE week_start = wk) THEN
              RAISE EXCEPTION 'La semana del % está bloqueada por el CEO', to_char(wk, 'DD/MM/YYYY')
                USING ERRCODE = '${LOCK_SQLSTATE}', DETAIL = to_char(wk, 'YYYY-MM-DD');
            END IF;
          END IF;

          RETURN COALESCE(NEW, OLD);
        END;
        $fn$;
      `);
      await client.query(`DROP TRIGGER IF EXISTS trg_pre_order_day_holds_week_lock ON ${schema}.pre_order_day_holds;`);
      await client.query(`
        CREATE TRIGGER trg_pre_order_day_holds_week_lock
        BEFORE INSERT OR UPDATE OR DELETE ON ${schema}.pre_order_day_holds
        FOR EACH ROW EXECUTE FUNCTION ${schema}.fn_pre_order_day_holds_week_lock();
      `);
    } else {
      console.warn("⚠️  pre_order_day_holds no existe aún: el candado de semana no cubre las reservas PRE. Corra planWeekLocks.initSchema después de pre-order-holds.initSchema.");
    }

    console.log("✅ plan_week_locks ready (CEO week lock + line_assignments / pre_order_day_holds triggers)");
  } finally {
    client.release();
  }
}

// Activa el candado para la transacción en curso. Llamar DESPUÉS de BEGIN.
// SET LOCAL se descarta solo en COMMIT/ROLLBACK, así que no contamina la
// conexión cuando regresa al pool.
async function enforce(client) {
  await client.query("SELECT set_config('app.enforce_week_locks', 'on', true)");
}

const isLockError = (err) => !!err && err.code === LOCK_SQLSTATE;

// Lunes ("YYYY-MM-DD") de la semana de un día "YYYY-MM-DD" (sin zona horaria).
function weekStartOf(ymdStr) {
  const [y, m, d] = String(ymdStr).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();                    // 0 = domingo
  dt.setUTCDate(dt.getUTCDate() - ((dow + 6) % 7)); // retrocede al lunes
  return dt.toISOString().slice(0, 10);
}

// Set con el lunes de cada semana bloqueada. Para recorridos día por día.
async function lockedWeekSet(client) {
  const { rows } = await client.query("SELECT to_char(week_start, 'YYYY-MM-DD') AS w FROM plan_week_locks");
  return new Set(rows.map((r) => r.w));
}
const isLockedDay = (set, ymdStr) => !!set && set.size > 0 && set.has(weekStartOf(ymdStr));

// Condición SQL "este día NO cae en semana bloqueada", para limpiezas que deben
// respetar el candado sin abortar toda la operación. `col` = columna DATE.
const notInLockedWeekSql = (col) =>
  `NOT EXISTS (SELECT 1 FROM plan_week_locks wl WHERE wl.week_start = date_trunc('week', ${col})::date)`;

// 423 Locked con un mensaje listo para el toast del tablero.
function sendLocked(res, err) {
  return res.status(423).json({
    success: false,
    locked: true,
    weekStart: err?.detail || null,
    error: `🔒 ${err?.message || "Semana bloqueada por el CEO"}. No se puede mover nada en esa semana hasta que el CEO la desbloquee.`,
  });
}

async function listLocks(client) {
  const { rows } = await client.query(`
    SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start,
           locked_by, locked_by_name, note, locked_at
      FROM plan_week_locks
     ORDER BY week_start
  `);
  return rows;
}

function registerPlanWeekLocks(app, deps) {
  const { authenticateToken, pool, setSchema } = deps;
  const lockerRoles = Array.isArray(deps.lockerRoles) && deps.lockerRoles.length
    ? deps.lockerRoles
    : DEFAULT_LOCKER_ROLES;
  const canLock = (user) => !!user && lockerRoles.includes(user.role);

  const notifyActorRoles = Array.isArray(deps.notifyActorRoles) && deps.notifyActorRoles.length
    ? deps.notifyActorRoles
    : DEFAULT_NOTIFY_ACTOR_ROLES;
  const ceoViewerRoles = Array.isArray(deps.ceoViewerRoles) && deps.ceoViewerRoles.length
    ? deps.ceoViewerRoles
    : DEFAULT_CEO_VIEWER_ROLES;
  const realRole = (user) => user?.actual_role || user?.role || null;
  const isCeoViewer = (user) =>
    !!user && ceoViewerRoles.includes(user.role) && !notifyActorRoles.includes(realRole(user));

  // Cualquier usuario autenticado puede LEER los candados (el planner los
  // necesita para bloquear su tablero). `canLock` le dice al frontend si este
  // usuario puede cambiarlos.
  app.get("/api/plan-week-locks", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      res.json({ success: true, locks: await listLocks(client), canLock: canLock(req.user) });
    } catch (err) {
      console.error("❌ Error listing plan week locks:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // PUT /api/plan-week-locks/:weekStart   body: { locked: boolean, note? }
  // Cualquier día de la semana sirve; se normaliza al lunes.
  app.put("/api/plan-week-locks/:weekStart", authenticateToken, async (req, res) => {
    if (!canLock(req.user)) {
      return res.status(403).json({ success: false, error: "Sólo el CEO puede bloquear o desbloquear semanas." });
    }
    const { weekStart } = req.params;
    if (!isYmd(weekStart)) {
      return res.status(400).json({ success: false, error: "weekStart debe ser YYYY-MM-DD" });
    }
    if (typeof req.body?.locked !== "boolean") {
      return res.status(400).json({ success: false, error: "locked (true/false) es obligatorio" });
    }
    const locked = req.body.locked;
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) || null : null;
    const userName = req.user.full_name || req.user.username || null;

    const client = await pool.connect();
    try {
      await setSchema(client);
      await client.query("BEGIN");
      const monday = (await client.query(
        "SELECT to_char(date_trunc('week', $1::date), 'YYYY-MM-DD') AS d",
        [weekStart]
      )).rows[0].d;

      let wasLocked = false;
      if (locked) {
        // No se bloquea una semana con pre-órdenes. SHARE detiene las altas /
        // bajas de reservas mientras se revisa y se guarda el candado, así nadie
        // mete una PRE entre la revisión y el bloqueo (después, el trigger la
        // rechaza por estar la semana ya bloqueada).
        const holdsReg = (await client.query("SELECT to_regclass('pre_order_day_holds') AS t")).rows[0].t;
        if (holdsReg) {
          await client.query("LOCK TABLE pre_order_day_holds IN SHARE MODE");
          const pre = await client.query(
            `SELECT h.pre_order_id,
                    COALESCE(MAX(h.pre_order_no), 'PRE' || h.pre_order_id) AS pre_order_no,
                    SUM(h.quantity) AS pieces,
                    array_agg(DISTINCT h.line_no ORDER BY h.line_no) AS lines
               FROM pre_order_day_holds h
              WHERE date_trunc('week', h.assigned_date)::date = $1::date
              GROUP BY h.pre_order_id
              ORDER BY 2`,
            [monday]
          );
          if (pre.rows.length) {
            await client.query("ROLLBACK");
            const list = pre.rows.map((r) => r.pre_order_no);
            return res.status(409).json({
              success: false,
              code: "WEEK_HAS_PRE_ORDERS",
              weekStart: monday,
              preOrders: pre.rows.map((r) => ({
                preOrderId: r.pre_order_id,
                preOrderNo: r.pre_order_no,
                pieces: Number(r.pieces) || 0,
                lines: r.lines || [],
              })),
              error: `No se puede bloquear la semana: tiene ${list.length} pre-orden(es) en el Plan Board (${list.join(", ")}). Conviértalas, muévalas o quítelas de esa semana y vuelva a intentar.`,
            });
          }
        }
        // ¿Ya estaba bloqueada? (re-bloquear sólo cambia la nota: no se avisa)
        wasLocked = (await client.query(
          "SELECT 1 FROM plan_week_locks WHERE week_start = $1::date FOR UPDATE",
          [monday]
        )).rowCount > 0;
        await client.query(
          `INSERT INTO plan_week_locks (week_start, locked_by, locked_by_name, note)
           VALUES ($1::date, $2, $3, $4)
           ON CONFLICT (week_start) DO UPDATE
             SET locked_by = EXCLUDED.locked_by,
                 locked_by_name = EXCLUDED.locked_by_name,
                 note = EXCLUDED.note,
                 locked_at = now()`,
          [monday, req.user.id ?? null, userName, note]
        );
      } else {
        wasLocked = (await client.query(
          "DELETE FROM plan_week_locks WHERE week_start = $1::date", [monday]
        )).rowCount > 0;
        // Reservas PRE que se quedaron en esta semana porque estaba bloqueada
        // cuando su pre-orden se convirtió o canceló: al desbloquear ya se sueltan.
        const holdsReg = (await client.query("SELECT to_regclass('pre_order_day_holds') AS t")).rows[0].t;
        if (holdsReg) {
          await client.query(
            `DELETE FROM pre_order_day_holds h
              USING pre_orders p
              WHERE h.pre_order_id = p.id
                AND p.status IN ('converted', 'cancelled')
                AND date_trunc('week', h.assigned_date)::date = $1::date`,
            [monday]
          );
        }
      }
      // 🔔 Se avisa al CEO sólo si quien actuó tiene un rol de notifyActorRoles
      // y el estado de la semana de verdad cambió.
      const actorRole = realRole(req.user);
      const notifyCeo = notifyActorRoles.includes(actorRole) && wasLocked !== locked;
      await client.query(
        `INSERT INTO plan_week_lock_log (week_start, action, user_id, user_name, note, actor_role, notify_ceo)
         VALUES ($1::date, $2, $3, $4, $5, $6, $7)`,
        [monday, locked ? "lock" : "unlock", req.user.id ?? null, userName, note, actorRole, notifyCeo]
      );
      await client.query("COMMIT");

      res.json({ success: true, weekStart: monday, locked, locks: await listLocks(client), canLock: true });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("❌ Error updating plan week lock:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ------------------------------------------------------------------------
  // 🔔 Avisos al CEO: semanas bloqueadas / desbloqueadas por un director.
  // Mismo formato que /api/ceo/urgent-changes para que la campana los mezcle.
  // Ids con prefijo "wl-".
  // ------------------------------------------------------------------------
  const ROLE_LABEL = { factory_director: "Director de fábrica" };

  app.get("/api/ceo/week-lock-events", authenticateToken, async (req, res) => {
    // Quien no es el CEO (p. ej. el propio director, que comparte el panel)
    // recibe lista vacía en vez de 403, para no ensuciar la campana.
    if (!isCeoViewer(req.user)) return res.json({ success: true, items: [], unread: 0 });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { rows } = await client.query(
        `SELECT l.id, l.action, l.user_name, l.actor_role, l.note, l.created_at,
                l.ceo_seen_at IS NULL AS unread,
                to_char(l.week_start, 'YYYY-MM-DD')              AS week_start,
                to_char(l.week_start + 6, 'YYYY-MM-DD')          AS week_end,
                to_char(l.week_start, 'IW')::int                 AS iso_week,
                to_char(l.week_start, 'DD/MM')                   AS from_dm,
                to_char(l.week_start + 6, 'DD/MM/YYYY')          AS to_dmy,
                EXISTS (SELECT 1 FROM plan_week_locks k WHERE k.week_start = l.week_start) AS locked_now
           FROM plan_week_lock_log l
          WHERE l.notify_ceo
          ORDER BY l.created_at DESC
          LIMIT $1`,
        [limit]
      );
      const unread = Number((await client.query(
        "SELECT COUNT(*)::int AS n FROM plan_week_lock_log WHERE notify_ceo AND ceo_seen_at IS NULL"
      )).rows[0].n) || 0;
      const items = rows.map((r) => ({
        id: `wl-${r.id}`,
        action: r.action === "lock" ? "week_lock" : "week_unlock",
        summary: `${r.action === "lock" ? "🔒 Bloqueó" : "🔓 Desbloqueó"} la Sem ${r.iso_week} (${r.from_dm} – ${r.to_dmy})`,
        user_name: r.user_name,
        created_at: r.created_at,
        unread: r.unread,
        details: {
          weekStart: r.week_start,
          weekEnd: r.week_end,
          isoWeek: r.iso_week,
          note: r.note,
          actorRole: r.actor_role,
          actorRoleLabel: ROLE_LABEL[r.actor_role] || r.actor_role,
          lockedNow: r.locked_now,
        },
      }));
      res.json({ success: true, items, unread });
    } catch (err) {
      console.error("❌ Error listing week lock events:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // Marcar todo como visto.
  app.post("/api/ceo/week-lock-events/seen", authenticateToken, async (req, res) => {
    if (!isCeoViewer(req.user)) return res.status(403).json({ success: false, error: "Sólo el CEO." });
    const client = await pool.connect();
    try {
      await setSchema(client);
      const r = await client.query(
        "UPDATE plan_week_lock_log SET ceo_seen_at = now() WHERE notify_ceo AND ceo_seen_at IS NULL"
      );
      res.json({ success: true, updated: r.rowCount });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // Marcar uno como visto.
  app.post("/api/ceo/week-lock-events/:id/seen", authenticateToken, async (req, res) => {
    if (!isCeoViewer(req.user)) return res.status(403).json({ success: false, error: "Sólo el CEO." });
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: "id inválido" });
    const client = await pool.connect();
    try {
      await setSchema(client);
      await client.query(
        "UPDATE plan_week_lock_log SET ceo_seen_at = COALESCE(ceo_seen_at, now()) WHERE id = $1 AND notify_ceo",
        [id]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });
}

module.exports = registerPlanWeekLocks;
module.exports.initSchema = initSchema;
module.exports.enforce = enforce;
module.exports.isLockError = isLockError;
module.exports.sendLocked = sendLocked;
module.exports.LOCK_SQLSTATE = LOCK_SQLSTATE;
module.exports.weekStartOf = weekStartOf;
module.exports.lockedWeekSet = lockedWeekSet;
module.exports.isLockedDay = isLockedDay;
module.exports.notInLockedWeekSql = notInLockedWeekSql;