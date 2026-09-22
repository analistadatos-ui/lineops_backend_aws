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
// ==========================================================================

// Roles que pueden bloquear / desbloquear. Ajuste a como se llama el rol del
// CEO en su tabla users (o pase `lockerRoles` al registrar el módulo).
const DEFAULT_LOCKER_ROLES = ["ceo", "skyrina", "master"];

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

    console.log("✅ plan_week_locks ready (CEO week lock + line_assignments trigger)");
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

      if (locked) {
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
        await client.query("DELETE FROM plan_week_locks WHERE week_start = $1::date", [monday]);
      }
      await client.query(
        `INSERT INTO plan_week_lock_log (week_start, action, user_id, user_name, note)
         VALUES ($1::date, $2, $3, $4, $5)`,
        [monday, locked ? "lock" : "unlock", req.user.id ?? null, userName, note]
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
}

module.exports = registerPlanWeekLocks;
module.exports.initSchema = initSchema;
module.exports.enforce = enforce;
module.exports.isLockError = isLockError;
module.exports.sendLocked = sendLocked;
module.exports.LOCK_SQLSTATE = LOCK_SQLSTATE;