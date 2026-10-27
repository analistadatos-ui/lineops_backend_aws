// ==========================================================================
// it-control-panel.js
//
// IT control panel backend: user activity log, report by role, user report,
// and user creation (username + password + role).
//
// Register-module (same pattern as work-orders.js). It owns:
//   • table user_activity_log  + users.last_login_at / last_seen_at / last_login_ip
//   • an activity tracker middleware that records logins, failed logins,
//     logouts and every change (POST / PUT / PATCH / DELETE) in the whole API
//   • the /api/it/* routes used by ITControlPanel.jsx
//   • POST /api/activity/track  (page views from the frontend, any user)
//
// --------------------------------------------------------------------------
// SETUP in server1.js  (4 steps)
// --------------------------------------------------------------------------
// 1. Near the top requires:
//        const itControlPanel = require("./it-control-panel");
//
// 2. Mount the tracker BEFORE the login route (it must run before every route).
//    Put it right above "// 11. AUTHENTICATION ENDPOINTS" (~line 960):
//        app.use("/api/", itControlPanel.activityTracker({
//          pool,
//          logger,
//          getClientIp: (req) => getClientIp(req),
//          verifyToken: (t) => jwt.verify(t, JWT_SECRET),   // to log /api/logout
//        }));
//
// 3. In runMigrations, right AFTER the main COMMIT (~line 715), so it never
//    waits on a lock the big migration transaction still holds on users:
//        await client.query("COMMIT");
//        logger.info("✅ Migrations completed successfully.");
//        await itControlPanel.initSchema({ pool, setSchema });   // ← add
//
// 4. Where the other modules register (~line 1210):
//        itControlPanel(app, {
//          authenticateToken,
//          pool,
//          setSchema,
//          logger,
//          getClientIp: (req) => getClientIp(req),
//          itRoles: ["soporte_it", "master"],      // who can open the panel
//        });
//
// Servers WITHOUT JWT (base64 "userId:timestamp" token, like server.js):
//          verifyToken: (t) => ({ id: parseInt(Buffer.from(t, "base64").toString("ascii").split(":")[0], 10) })
//
// Optional env:
//   ACTIVITY_LOG_WAIT_MS=500  max ms a response waits for its log row (default 500).
//   IT_ACTIVITY_LOG=off       turn the tracker off (restart only). The panel still opens.
//   ACTIVITY_LOG_READS=true   also log every GET (noisy: screens poll a lot).
//                             By default GETs only refresh users.last_seen_at.
//
// --------------------------------------------------------------------------
// SECURITY RULES
// --------------------------------------------------------------------------
//   • Only itRoles can open /api/it/*.
//   • Only a master (or factory_director, via ROLE_ALIASES) can create, edit
//     or assign the protected roles master / factory_director / ceo. This stops
//     an IT account from promoting itself or anyone else to CEO.
//   • Nobody can deactivate or change the role of their own account.
//   • Passwords are never logged: any body key that looks like
//     password / token / secret / authorization is replaced by "[redacted]".
//   • Deactivating a user logs them out at once, because authenticateToken
//     already rejects inactive users on every request.
//
// LAMBDA NOTE: for changes and logins the log row is written BEFORE the JSON
// response is sent (max 1.5 s wait), so a frozen Lambda container can't lose it.
// ==========================================================================

const bcrypt = require("bcrypt");

const SCHEMA = "prod_db_schema";
const LOG_TABLE = `${SCHEMA}.user_activity_log`;
const USERS_TABLE = `${SCHEMA}.users`;

// Every role used anywhere in server1.js / modules. Label = what the panel shows.
const DEFAULT_ROLES = [
  { value: "master", label: "Master (CEO)" },
  { value: "factory_director", label: "Factory director" },
  { value: "ceo", label: "CEO" },
  { value: "soporte_it", label: "IT support" },
  { value: "engineer", label: "Engineer" },
  { value: "supervisor", label: "Supervisor" },
  { value: "planner", label: "Planner" },
  { value: "line_leader", label: "Line leader" },
  { value: "verificador", label: "Verifier" },
  { value: "quality_head", label: "Quality head" },
  { value: "quality_inspector", label: "Quality inspector" },
  { value: "corte", label: "Cutting" },
  { value: "fabric_warehouse", label: "Fabric warehouse" },
  { value: "finished_warehouse", label: "Finished warehouse" },
  { value: "merchant", label: "Merchant" },
  { value: "supermarcado", label: "Supermarket" },
  { value: "skyrina", label: "Skyrina" },
  { value: "admin", label: "Admin" },
];
const PROTECTED_ROLES = ["master", "factory_director", "ceo"];

// Paths the tracker ignores completely.
const SKIP_PATHS = ["/api/health", "/api/activity/track"];

// SQL fragments shared by the reports.
// A "change" = a successful write. Failed attempts count as errors instead.
const IS_CHANGE = `(method IN ('POST','PUT','PATCH','DELETE') AND action NOT IN ('login','login_failed','logout','page_view') AND status_code < 400)`;
const IS_ERROR = `(status_code >= 400 AND action <> 'login_failed')`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,50}$/;

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------
const SENSITIVE_KEY = /pass|token|secret|authorization|jwt|hash/i;

// Small, safe copy of a request body for the log: no secrets, no photos.
function sanitize(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return value.length > 200 ? `[${value.length} chars]` : value;
  if (typeof value !== "object") return value;
  if (depth >= 3) return Array.isArray(value) ? `[array ${value.length}]` : "[object]";
  if (Array.isArray(value)) {
    const out = value.slice(0, 10).map((v) => sanitize(v, depth + 1));
    if (value.length > 10) out.push(`… +${value.length - 10} more`);
    return out;
  }
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(value)) {
    if (n++ >= 30) { out["…"] = "more keys omitted"; break; }
    out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : sanitize(v, depth + 1);
  }
  return out;
}

function moduleFromPath(path) {
  const m = /^\/api\/([^/?]+)/.exec(path || "");
  return m ? m[1].slice(0, 60) : null;
}

function actionFromMethod(method) {
  switch (method) {
    case "POST": return "create";
    case "PUT":
    case "PATCH": return "update";
    case "DELETE": return "delete";
    default: return "view";
  }
}

// One pg client runs one query at a time; run report queries in order.
const inSeq = async (fns) => {
  const out = [];
  for (const fn of fns) out.push(await fn());
  return out;
};

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((resolve) => setTimeout(resolve, ms))]);

// Range from ?from=YYYY-MM-DD&to=YYYY-MM-DD (factory time zone). Default: last 7 days.
function parseRange(q) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
  let to = DATE_RE.test(q.to || "") ? q.to : today;
  let from = DATE_RE.test(q.from || "") ? q.from : null;
  if (!from) {
    const d = new Date(`${to}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 6);
    from = d.toISOString().slice(0, 10);
  }
  if (from > to) [from, to] = [to, from];
  const days = (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (days > 366) {
    const d = new Date(`${to}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 365);
    from = d.toISOString().slice(0, 10);
  }
  return { from, to };
}

// Dates are factory-local (Mexico City) no matter what the session time zone is.
const TZ = "America/Mexico_City";
const LOCAL_DAY = `(created_at AT TIME ZONE '${TZ}')::date`;
const RANGE_SQL = (a, b) =>
  `created_at >= ($${a}::date::timestamp AT TIME ZONE '${TZ}') AND created_at < (($${b}::date + 1)::timestamp AT TIME ZONE '${TZ}')`;

// --------------------------------------------------------------------------
// writing log rows
// --------------------------------------------------------------------------
const INSERT_COLS = `user_id, username, role, action, module, method, path, status_code, success, ip, user_agent, duration_ms, details`;

function insertLog(pool, e) {
  return pool.query(
    `INSERT INTO ${LOG_TABLE} (${INSERT_COLS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      e.user_id ?? null, e.username ?? null, e.role ?? null, e.action, e.module ?? null,
      e.method ?? null, (e.path || "").slice(0, 300) || null, e.status_code ?? null,
      e.success ?? null, e.ip ?? null, (e.user_agent || "").slice(0, 300) || null,
      e.duration_ms ?? null, e.details ? JSON.stringify(e.details) : null,
    ]
  );
}

// Login rows look the user up by username; a successful login also stamps users.
function insertLoginLog(pool, e, ok) {
  const userCte = ok
    ? `UPDATE ${USERS_TABLE}
          SET last_login_at = now(), last_seen_at = now(), last_login_ip = $3
        WHERE username = $1::varchar AND is_active = TRUE
        RETURNING id, role`
    : `SELECT id, role FROM ${USERS_TABLE} WHERE username = $1::varchar`;
  return pool.query(
    `WITH u AS (${userCte})
     INSERT INTO ${LOG_TABLE} (${INSERT_COLS})
     SELECT (SELECT id FROM u LIMIT 1), $1::varchar, (SELECT role FROM u LIMIT 1), $2::varchar, 'auth', 'POST', '/api/login',
            $4::int, $5::boolean, $3::varchar, $6::varchar, $7::int, $8::jsonb`,
    [
      String(e.username || "").slice(0, 50) || null, ok ? "login" : "login_failed", e.ip ?? null,
      e.status_code, ok, (e.user_agent || "").slice(0, 300) || null, e.duration_ms,
      e.details ? JSON.stringify(e.details) : null,
    ]
  );
}

// Explicit audit row from a route (user created, password reset…).
function auditEvent(pool, req, getClientIp, { action, module = "it", details, status_code = 200 }) {
  req.skipActivityLog = true; // the tracker must not write a second generic row
  return insertLog(pool, {
    user_id: req.user?.id,
    username: req.user?.username,
    role: req.user?.actual_role || req.user?.role,
    action, module, method: req.method,
    path: (req.originalUrl || "").split("?")[0],
    status_code, success: status_code < 400,
    ip: getClientIp(req), user_agent: req.headers["user-agent"], details,
  });
}

// --------------------------------------------------------------------------
// schema
// --------------------------------------------------------------------------
async function initSchema({ pool, setSchema, roles = DEFAULT_ROLES }) {
  const client = await pool.connect();
  try {
    await setSchema(client);
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_activity_log(
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
        username VARCHAR(50) NULL,
        role VARCHAR(30) NULL,
        action VARCHAR(40) NOT NULL,
        module VARCHAR(60) NULL,
        method VARCHAR(10) NULL,
        path VARCHAR(300) NULL,
        status_code INT NULL,
        success BOOLEAN NULL,
        ip VARCHAR(64) NULL,
        user_agent VARCHAR(300) NULL,
        duration_ms INT NULL,
        details JSONB NULL
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_ual_created ON user_activity_log(created_at DESC);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_ual_user_created ON user_activity_log(user_id, created_at DESC);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_ual_role_created ON user_activity_log(role, created_at DESC);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_ual_action_created ON user_activity_log(action, created_at DESC);");

    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ NULL;");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NULL;");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(64) NULL;");

    // The original chk_role only allows 6 roles, but the app also uses planner,
    // ceo, verificador, factory_director… Rebuild it with every known role PLUS
    // every role already stored, so no existing user can ever break it.
    const existing = await client.query("SELECT DISTINCT role FROM users WHERE role IS NOT NULL");
    // ...and every role the current chk_role already allows (never take a role away).
    const cur = await client.query(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.conname = 'chk_role' AND t.relname = 'users' AND n.nspname = current_schema()`);
    const allowedNow = cur.rows.length ? [...cur.rows[0].def.matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
    const all = [...new Set([...roles.map((r) => r.value), ...existing.rows.map((r) => r.role), ...allowedNow])];
    const list = all.map((r) => `'${String(r).replace(/'/g, "''")}'`).join(", ");
    await client.query("ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_role;");
    await client.query(`ALTER TABLE users ADD CONSTRAINT chk_role CHECK (role IN (${list}));`);

    await client.query("COMMIT");
    console.log("✅ IT control panel: user_activity_log ready, chk_role =", all.join(", "));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// --------------------------------------------------------------------------
// tracker middleware  (mount with app.use("/api/", ...) BEFORE the routes)
// --------------------------------------------------------------------------
function activityTracker({ pool, logger = console, getClientIp = (req) => req.ip, verifyToken, logReads } = {}) {
  // Kill switch: IT_ACTIVITY_LOG=off makes the tracker a no-op (just restart, no code change).
  if (process.env.IT_ACTIVITY_LOG === "off") {
    logger.warn("IT control panel: activity tracker is OFF (IT_ACTIVITY_LOG=off)");
    return (req, res, next) => next();
  }
  const LOG_READS = logReads ?? process.env.ACTIVITY_LOG_READS === "true";
  // Max time a response waits for its log row (Lambda-safe but never slow).
  const WAIT_MS = Math.max(0, Number(process.env.ACTIVITY_LOG_WAIT_MS ?? 500));
  const lastTouch = new Map(); // userId -> ms, throttles last_seen_at updates

  // If the table/columns don't exist yet (migrations not run), stop trying at once
  // instead of making every request wait on a failing insert. A new container
  // (after the migration) starts logging again.
  let schemaMissing = false;
  const onDbError = (err, where) => {
    if (err && (err.code === "42P01" || err.code === "42703")) {
      if (!schemaMissing) {
        logger.error("IT control panel: user_activity_log / users columns missing — run it-control-panel migration. Activity logging paused.", { error: err.message });
      }
      schemaMissing = true;
      return;
    }
    logger.warn(`activity log ${where} failed`, { error: err?.message });
  };

  const touchLastSeen = (userId) => {
    const now = Date.now();
    if (!userId || now - (lastTouch.get(userId) || 0) < 60000) return;
    lastTouch.set(userId, now);
    pool.query(`UPDATE ${USERS_TABLE} SET last_seen_at = now() WHERE id = $1`, [userId])
      .catch((err) => onDbError(err, "last_seen_at"));
  };

  return (req, res, next) => {
    const path = (req.originalUrl || req.url || "").split("?")[0];
    if (schemaMissing || req.method === "OPTIONS" || SKIP_PATHS.some((p) => path.startsWith(p))) return next();

    const started = Date.now();
    let done = false;

    const write = () => {
      if (done) return null;
      done = true;
      if (req.skipActivityLog) return null;

      const base = {
        method: req.method, path, status_code: res.statusCode, success: res.statusCode < 400,
        ip: getClientIp(req), user_agent: req.headers["user-agent"], duration_ms: Date.now() - started,
      };

      if (path === "/api/login") {
        const ok = res.statusCode < 400;
        return insertLoginLog(pool, { ...base, username: req.body?.username }, ok);
      }

      let user = req.user;
      if (path === "/api/logout" && !user && verifyToken) {
        try {
          const t = (req.headers.authorization || "").split(" ")[1];
          if (t) user = verifyToken(t);
        } catch (_) { /* expired token: log anonymously */ }
        const uid = Number(user?.id);
        if (Number.isFinite(uid) && uid > 0 && !user.username) {
          return pool.query(
            `INSERT INTO ${LOG_TABLE} (${INSERT_COLS})
             SELECT u.id, u.username, u.role, 'logout', 'auth', 'POST', '/api/logout',
                    $2::int, TRUE, $3::varchar, $4::varchar, $5::int, NULL
               FROM ${USERS_TABLE} u WHERE u.id = $1::bigint`,
            [uid, base.status_code, base.ip ?? null, (base.user_agent || "").slice(0, 300) || null, base.duration_ms]
          );
        }
        return insertLog(pool, {
          ...base, user_id: Number.isFinite(uid) && uid > 0 ? uid : null, username: user?.username, role: user?.role,
          action: "logout", module: "auth",
        });
      }

      if (user) touchLastSeen(user.id);
      const isRead = req.method === "GET" || req.method === "HEAD";
      if (isRead && (!LOG_READS || !user)) return null;

      const details = {};
      if (req.params && Object.keys(req.params).length) details.params = req.params;
      if (req.query && Object.keys(req.query).length) details.query = sanitize(req.query);
      if (!isRead && req.body && Object.keys(req.body).length) {
        const size = Number(req.headers["content-length"] || 0);
        details.body = size > 50000 ? `[${Math.round(size / 1024)} KB body]` : sanitize(req.body);
      }

      return insertLog(pool, {
        ...base,
        user_id: user?.id, username: user?.username, role: user?.actual_role || user?.role,
        action: actionFromMethod(req.method), module: moduleFromPath(path),
        details: Object.keys(details).length ? details : null,
      });
    };

    const safeWrite = () => {
      try {
        const p = write();
        return p ? p.catch((err) => onDbError(err, "write")) : null;
      } catch (err) {
        logger.warn("activity log build failed", { error: err.message, path });
        return null;
      }
    };

    // Write the row before the JSON leaves (Lambda-safe), max 1.5 s.
    const origJson = res.json.bind(res);
    res.json = (body) => {
      const p = safeWrite();
      if (!p) return origJson(body);
      withTimeout(p, WAIT_MS)
        .then(() => { if (!res.headersSent) origJson(body); })
        .catch((err) => logger.error("activity tracker: sending response failed", { error: err?.message, path }));
      return res;
    };
    // Responses not sent with res.json (CSV, send, end…)
    res.on("finish", safeWrite);
    next();
  };
}

// --------------------------------------------------------------------------
// routes
// --------------------------------------------------------------------------
function registerItControlPanel(app, deps) {
  const {
    authenticateToken, pool, setSchema, logger = console,
    getClientIp = (req) => req.ip,
    itRoles = ["soporte_it", "master"],
    roles = DEFAULT_ROLES,
    timeZone = "America/Mexico_City",
  } = deps;

  const requireIt = (req, res, next) => {
    const r = req.user?.role, a = req.user?.actual_role;
    if (itRoles.includes(r) || itRoles.includes(a)) return next();
    return res.status(403).json({ success: false, error: "IT control panel access requires an IT role." });
  };
  const isMaster = (req) => req.user?.role === "master"; // factory_director is aliased to master

  // Each panel request runs in its own transaction with SET LOCAL TIME ZONE, so
  // days are counted in factory time even when setSchema doesn't set the zone,
  // and the zone never leaks to other routes that reuse the pooled connection.
  const withClient = (handler) => async (req, res, next) => {
    let client;
    let inTx = false;
    // Hold the JSON reply until COMMIT, so the next request already sees the change.
    const sendJson = res.json.bind(res);
    let pending;
    res.json = (body) => { pending = body; return res; };
    const flush = () => { res.json = sendJson; if (pending !== undefined && !res.headersSent) sendJson(pending); };
    try {
      client = await pool.connect();
      await setSchema(client);
      await client.query("BEGIN");
      inTx = true;
      await client.query(`SET LOCAL TIME ZONE '${String(timeZone).replace(/'/g, "")}'`);
      await handler(req, res, client);
      await client.query("COMMIT"); // after a caught error (e.g. duplicate) this just ends the aborted tx
      inTx = false;
      flush();
    } catch (err) {
      if (inTx) await client.query("ROLLBACK").catch(() => {});
      res.json = sendJson;
      logger.error("IT panel error", { error: err.message, path: req.originalUrl });
      if (!res.headersSent) res.status(500).json({ success: false, error: "IT panel error: " + err.message });
    } finally {
      if (client) client.release();
    }
  };

  const allRoleValues = async (client) => {
    const r = await client.query("SELECT DISTINCT role FROM users WHERE role IS NOT NULL");
    return [...new Set([...roles.map((x) => x.value), ...r.rows.map((x) => x.role)])];
  };

  // ---------------- roles ----------------
  app.get("/api/it/roles", authenticateToken, requireIt, withClient(async (req, res, client) => {
    const values = await allRoleValues(client);
    const labels = Object.fromEntries(roles.map((r) => [r.value, r.label]));
    res.json({
      success: true,
      roles: values.map((v) => ({
        value: v,
        label: labels[v] || v,
        protected: PROTECTED_ROLES.includes(v),
        assignable: isMaster(req) || !PROTECTED_ROLES.includes(v),
      })),
      canManageProtected: isMaster(req),
    });
  }));

  // ---------------- overview ----------------
  app.get("/api/it/overview", authenticateToken, requireIt, withClient(async (req, res, client) => {
    const { from, to } = parseRange(req.query);
    const R = RANGE_SQL(1, 2);
    const [kpi, users, byDay, byModule, online, failed] = await inSeq([
      () => client.query(
        `SELECT COUNT(*) FILTER (WHERE action = 'login')::int        AS logins,
                COUNT(*) FILTER (WHERE action = 'login_failed')::int AS failed_logins,
                COUNT(*) FILTER (WHERE ${IS_CHANGE})::int            AS changes,
                COUNT(*) FILTER (WHERE ${IS_ERROR})::int             AS errors,
                COUNT(DISTINCT user_id)::int                         AS active_users
           FROM user_activity_log WHERE ${R}`, [from, to]),
      () => client.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE is_active)::int AS active,
                COUNT(*) FILTER (WHERE is_active AND last_seen_at > now() - interval '15 minutes')::int AS online
           FROM users`),
      () => client.query(
        `SELECT to_char(d, 'YYYY-MM-DD') AS day,
                COALESCE(a.logins, 0)::int AS logins,
                COALESCE(a.changes, 0)::int AS changes,
                COALESCE(a.failed, 0)::int AS failed_logins,
                COALESCE(a.users, 0)::int AS active_users
           FROM generate_series($1::date, $2::date, interval '1 day') d
           LEFT JOIN (
             SELECT ${LOCAL_DAY} AS day,
                    COUNT(*) FILTER (WHERE action = 'login') AS logins,
                    COUNT(*) FILTER (WHERE ${IS_CHANGE}) AS changes,
                    COUNT(*) FILTER (WHERE action = 'login_failed') AS failed,
                    COUNT(DISTINCT user_id) AS users
               FROM user_activity_log WHERE ${R} GROUP BY 1
           ) a ON a.day = d::date
          ORDER BY d`, [from, to]),
      () => client.query(
        `SELECT module, COUNT(*)::int AS changes, COUNT(DISTINCT user_id)::int AS users
           FROM user_activity_log WHERE ${R} AND ${IS_CHANGE} AND module IS NOT NULL
          GROUP BY module ORDER BY changes DESC LIMIT 10`, [from, to]),
      () => client.query(
        `SELECT id, username, full_name, role, line_number, last_seen_at
           FROM users WHERE is_active AND last_seen_at > now() - interval '15 minutes'
          ORDER BY last_seen_at DESC LIMIT 50`),
      () => client.query(
        `SELECT created_at, username, ip, user_agent, (user_id IS NULL) AS unknown_user
           FROM user_activity_log WHERE ${R} AND action = 'login_failed'
          ORDER BY created_at DESC LIMIT 10`, [from, to]),
    ]);
    res.json({
      success: true, from, to,
      kpis: { ...kpi.rows[0], users_total: users.rows[0].total, users_active: users.rows[0].active, online_now: users.rows[0].online },
      byDay: byDay.rows, byModule: byModule.rows, online: online.rows, failedLogins: failed.rows,
    });
  }));

  // ---------------- report by role ----------------
  app.get("/api/it/report/roles", authenticateToken, requireIt, withClient(async (req, res, client) => {
    const { from, to } = parseRange(req.query);
    const R = RANGE_SQL(1, 2);
    const [rows, mods] = await inSeq([
      () => client.query(
        `SELECT COALESCE(u.role, a.role) AS role,
                COALESCE(u.users_total, 0)::int  AS users_total,
                COALESCE(u.users_active, 0)::int AS users_active,
                COALESCE(u.online, 0)::int       AS online_now,
                COALESCE(a.active_users, 0)::int AS active_in_period,
                COALESCE(a.logins, 0)::int       AS logins,
                COALESCE(a.failed, 0)::int       AS failed_logins,
                COALESCE(a.changes, 0)::int      AS changes,
                COALESCE(a.page_views, 0)::int   AS page_views,
                COALESCE(a.errors, 0)::int       AS errors,
                GREATEST(a.last_activity, u.last_seen) AS last_activity
           FROM (SELECT role, COUNT(*) AS users_total,
                        COUNT(*) FILTER (WHERE is_active) AS users_active,
                        COUNT(*) FILTER (WHERE is_active AND last_seen_at > now() - interval '15 minutes') AS online,
                        MAX(last_seen_at) AS last_seen
                   FROM users GROUP BY role) u
           FULL JOIN (
                 SELECT role, COUNT(DISTINCT user_id) AS active_users,
                        COUNT(*) FILTER (WHERE action = 'login') AS logins,
                        COUNT(*) FILTER (WHERE action = 'login_failed') AS failed,
                        COUNT(*) FILTER (WHERE ${IS_CHANGE}) AS changes,
                        COUNT(*) FILTER (WHERE action = 'page_view') AS page_views,
                        COUNT(*) FILTER (WHERE ${IS_ERROR}) AS errors,
                        MAX(created_at) AS last_activity
                   FROM user_activity_log WHERE ${R} AND role IS NOT NULL GROUP BY role) a
             ON a.role = u.role
          ORDER BY changes DESC, logins DESC, role`, [from, to]),
      () => client.query(
        `SELECT role, module, COUNT(*)::int AS changes
           FROM user_activity_log WHERE ${R} AND ${IS_CHANGE} AND role IS NOT NULL AND module IS NOT NULL
          GROUP BY role, module ORDER BY changes DESC`, [from, to]),
    ]);
    const topModules = {};
    for (const m of mods.rows) {
      (topModules[m.role] ||= []);
      if (topModules[m.role].length < 3) topModules[m.role].push({ module: m.module, changes: m.changes });
    }
    res.json({ success: true, from, to, roles: rows.rows.map((r) => ({ ...r, top_modules: topModules[r.role] || [] })) });
  }));

  // ---------------- users list with activity ----------------
  app.get("/api/it/users", authenticateToken, requireIt, withClient(async (req, res, client) => {
    const { from, to } = parseRange(req.query);
    const r = await client.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.line_number, u.is_active, u.created_at,
              u.last_login_at, u.last_seen_at, u.last_login_ip,
              COALESCE(u.is_active AND u.last_seen_at > now() - interval '15 minutes', FALSE) AS online,
              COALESCE(a.logins, 0)::int AS logins,
              COALESCE(a.changes, 0)::int AS changes,
              COALESCE(a.failed, 0)::int AS failed_logins,
              a.last_activity
         FROM users u
         LEFT JOIN (
           SELECT user_id,
                  COUNT(*) FILTER (WHERE action = 'login') AS logins,
                  COUNT(*) FILTER (WHERE ${IS_CHANGE}) AS changes,
                  COUNT(*) FILTER (WHERE action = 'login_failed') AS failed,
                  MAX(created_at) AS last_activity
             FROM user_activity_log WHERE ${RANGE_SQL(1, 2)} AND user_id IS NOT NULL GROUP BY user_id
         ) a ON a.user_id = u.id
        ORDER BY u.is_active DESC, u.role, u.line_number NULLS FIRST, u.username`, [from, to]);
    res.json({ success: true, from, to, users: r.rows });
  }));

  // ---------------- one user report ----------------
  app.get("/api/it/users/:id/report", authenticateToken, requireIt, withClient(async (req, res, client) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: "Invalid user id" });
    const { from, to } = parseRange(req.query);
    const R = RANGE_SQL(2, 3);
    const u = await client.query(
      `SELECT id, username, full_name, role, line_number, is_active, created_at, updated_at,
              last_login_at, last_seen_at, last_login_ip,
              COALESCE(is_active AND last_seen_at > now() - interval '15 minutes', FALSE) AS online
         FROM users WHERE id = $1`, [id]);
    if (!u.rows.length) return res.status(404).json({ success: false, error: "User not found" });

    const [byDay, byModule, byAction, recent] = await inSeq([
      () => client.query(
        `SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(a.logins,0)::int AS logins, COALESCE(a.changes,0)::int AS changes
           FROM generate_series($2::date, $3::date, interval '1 day') d
           LEFT JOIN (SELECT ${LOCAL_DAY} AS day,
                             COUNT(*) FILTER (WHERE action = 'login') AS logins,
                             COUNT(*) FILTER (WHERE ${IS_CHANGE}) AS changes
                        FROM user_activity_log WHERE user_id = $1 AND ${R} GROUP BY 1) a ON a.day = d::date
          ORDER BY d`, [id, from, to]),
      () => client.query(
        `SELECT module, COUNT(*)::int AS changes FROM user_activity_log
          WHERE user_id = $1 AND ${R} AND ${IS_CHANGE} AND module IS NOT NULL
          GROUP BY module ORDER BY changes DESC LIMIT 12`, [id, from, to]),
      () => client.query(
        `SELECT action, COUNT(*)::int AS total FROM user_activity_log
          WHERE user_id = $1 AND ${R} GROUP BY action ORDER BY total DESC`, [id, from, to]),
      () => client.query(
        `SELECT id, created_at, action, module, method, path, status_code, success, ip, duration_ms, details
           FROM user_activity_log WHERE user_id = $1 AND ${R}
          ORDER BY created_at DESC LIMIT 100`, [id, from, to]),
    ]);
    res.json({ success: true, from, to, user: u.rows[0], byDay: byDay.rows, byModule: byModule.rows, byAction: byAction.rows, recent: recent.rows });
  }));

  // ---------------- logs (filters + pagination + CSV) ----------------
  const buildLogFilter = (q) => {
    const { from, to } = parseRange(q);
    const where = [RANGE_SQL(1, 2)];
    const vals = [from, to];
    const add = (sql, v) => { vals.push(v); where.push(sql.replace("?", `$${vals.length}`)); };
    if (q.role) add("role = ?", String(q.role));
    if (q.user_id && /^\d+$/.test(q.user_id)) add("user_id = ?", Number(q.user_id));
    if (q.module) add("module = ?", String(q.module));
    if (q.action === "change") where.push(IS_CHANGE);
    else if (q.action === "error") where.push(IS_ERROR);
    else if (q.action) add("action = ?", String(q.action));
    if (q.q) add("(username ILIKE ? OR path ILIKE $X OR module ILIKE $X OR ip ILIKE $X)".replace(/\$X/g, () => `$${vals.length + 1}`), `%${String(q.q).slice(0, 80)}%`);
    return { from, to, where: where.join(" AND "), vals };
  };

  app.get("/api/it/logs", authenticateToken, requireIt, withClient(async (req, res, client) => {
    const { from, to, where, vals } = buildLogFilter(req.query);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const [rows, count, modules] = await inSeq([
      () => client.query(
        `SELECT id, created_at, user_id, username, role, action, module, method, path,
                status_code, success, ip, user_agent, duration_ms, details
           FROM user_activity_log WHERE ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit} OFFSET ${offset}`, vals),
      () => client.query(`SELECT COUNT(*)::int AS total FROM user_activity_log WHERE ${where}`, vals),
      () => client.query(
        `SELECT DISTINCT module FROM user_activity_log WHERE ${RANGE_SQL(1, 2)} AND module IS NOT NULL ORDER BY module`,
        [from, to]),
    ]);
    res.json({ success: true, from, to, total: count.rows[0].total, limit, offset, logs: rows.rows, modules: modules.rows.map((m) => m.module) });
  }));

  app.get("/api/it/logs.csv", authenticateToken, requireIt, withClient(async (req, res, client) => {
    const { from, to, where, vals } = buildLogFilter(req.query);
    const r = await client.query(
      `SELECT to_char(created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD HH24:MI:SS') AS time, username, role, action, module,
              method, path, status_code, ip, duration_ms, details::text AS details
         FROM user_activity_log WHERE ${where}
        ORDER BY created_at DESC LIMIT 20000`, vals);
    const cols = ["time", "username", "role", "action", "module", "method", "path", "status_code", "ip", "duration_ms", "details"];
    const esc = (v) => {
      if (v == null) return "";
      let s = String(v);
      if (/^[=+\-@]/.test(s)) s = `'${s}`; // no spreadsheet formula injection
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = "\uFEFF" + [cols.join(","), ...r.rows.map((row) => cols.map((c) => esc(row[c])).join(","))].join("\r\n");
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="user-activity_${from}_${to}.csv"`);
    res.send(csv);
  }));

  // ---------------- create user ----------------
  app.post("/api/it/users", authenticateToken, requireIt, withClient(async (req, res, client) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const role = String(req.body.role || "");
    const full_name = String(req.body.full_name || "").trim().slice(0, 100) || username;
    const lineRaw = req.body.line_number;
    const line_number = lineRaw === "" || lineRaw == null ? null : parseInt(lineRaw, 10);

    if (!USERNAME_RE.test(username))
      return res.status(400).json({ success: false, field: "username", error: "Username must be 3–50 characters: letters, numbers, dot, dash or underscore." });
    if (password.length < 8 || password.length > 72)
      return res.status(400).json({ success: false, field: "password", error: "Password must be 8–72 characters." });
    if (!(await allRoleValues(client)).includes(role))
      return res.status(400).json({ success: false, field: "role", error: "Choose a valid role." });
    if (PROTECTED_ROLES.includes(role) && !isMaster(req))
      return res.status(403).json({ success: false, field: "role", error: `Only a master account can create ${role} users.` });
    if (role === "line_leader" && !(line_number >= 1 && line_number <= 26))
      return res.status(400).json({ success: false, field: "line_number", error: "A line leader needs a line from 1 to 26." });
    if (line_number != null && !(line_number >= 1 && line_number <= 26))
      return res.status(400).json({ success: false, field: "line_number", error: "Line must be from 1 to 26." });

    if (role === "line_leader") {
      const taken = await client.query(
        "SELECT username FROM users WHERE role = 'line_leader' AND line_number = $1 AND is_active = TRUE", [line_number]);
      if (taken.rows.length)
        return res.status(400).json({ success: false, field: "line_number", error: `Line ${line_number} already has a line leader: ${taken.rows[0].username}.` });
    }

    try {
      const hash = await bcrypt.hash(password, 10);
      const r = await client.query(
        `INSERT INTO users (username, password_hash, role, line_number, full_name, is_active)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING id, username, full_name, role, line_number, is_active, created_at`,
        [username, hash, role, line_number, full_name]);
      await auditEvent(pool, req, getClientIp, {
        action: "user_created",
        details: { target_user_id: r.rows[0].id, target_username: username, role, line_number },
      });
      logger.info("IT panel: user created", { username, role, by: req.user.username });
      res.json({ success: true, message: `User ${username} created.`, user: r.rows[0] });
    } catch (err) {
      if (err.code === "23505") return res.status(400).json({ success: false, field: "username", error: "That username already exists." });
      if (err.code === "23514") return res.status(400).json({ success: false, field: "role", error: "The database rejected this role. Run the migrations so chk_role includes it." });
      throw err;
    }
  }));

  // ---------------- edit user (role, status, name, line, password reset) ----------------
  app.put("/api/it/users/:id", authenticateToken, requireIt, withClient(async (req, res, client) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: "Invalid user id" });
    const cur = await client.query("SELECT id, username, full_name, role, line_number, is_active FROM users WHERE id = $1", [id]);
    if (!cur.rows.length) return res.status(404).json({ success: false, error: "User not found" });
    const before = cur.rows[0];
    const self = String(id) === String(req.user.id); // pg returns BIGINT ids as strings

    if (PROTECTED_ROLES.includes(before.role) && !isMaster(req))
      return res.status(403).json({ success: false, error: "Only a master account can edit this user." });

    const b = req.body || {};
    const sets = [], vals = [], changes = {};
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

    if (b.full_name !== undefined) {
      const v = String(b.full_name).trim().slice(0, 100);
      if (v !== before.full_name) { set("full_name", v); changes.full_name = { from: before.full_name, to: v }; }
    }
    let newRole = before.role;
    if (b.role !== undefined && b.role !== before.role) {
      if (self) return res.status(400).json({ success: false, field: "role", error: "You can't change your own role." });
      if (!(await allRoleValues(client)).includes(b.role))
        return res.status(400).json({ success: false, field: "role", error: "Choose a valid role." });
      if (PROTECTED_ROLES.includes(b.role) && !isMaster(req))
        return res.status(403).json({ success: false, field: "role", error: `Only a master account can assign ${b.role}.` });
      newRole = b.role;
      set("role", b.role); changes.role = { from: before.role, to: b.role };
    }
    let newLine = before.line_number;
    if (b.line_number !== undefined) {
      const v = b.line_number === "" || b.line_number == null ? null : parseInt(b.line_number, 10);
      if (v != null && !(v >= 1 && v <= 26)) return res.status(400).json({ success: false, field: "line_number", error: "Line must be from 1 to 26." });
      if (v !== before.line_number) { newLine = v; set("line_number", v); changes.line_number = { from: before.line_number, to: v }; }
    }
    if (newRole === "line_leader" && !(newLine >= 1)) return res.status(400).json({ success: false, field: "line_number", error: "A line leader needs a line from 1 to 26." });
    if (newRole === "line_leader" && (changes.role || changes.line_number)) {
      const taken = await client.query(
        "SELECT username FROM users WHERE role = 'line_leader' AND line_number = $1 AND is_active = TRUE AND id <> $2", [newLine, id]);
      if (taken.rows.length) return res.status(400).json({ success: false, field: "line_number", error: `Line ${newLine} already has a line leader: ${taken.rows[0].username}.` });
    }
    if (b.is_active !== undefined && Boolean(b.is_active) !== before.is_active) {
      if (self && !b.is_active) return res.status(400).json({ success: false, error: "You can't deactivate your own account." });
      set("is_active", Boolean(b.is_active)); changes.is_active = { from: before.is_active, to: Boolean(b.is_active) };
    }
    if (b.password !== undefined && b.password !== "") {
      const p = String(b.password);
      if (p.length < 8 || p.length > 72) return res.status(400).json({ success: false, field: "password", error: "Password must be 8–72 characters." });
      set("password_hash", await bcrypt.hash(p, 10)); changes.password = "reset";
    }

    if (!sets.length) return res.status(400).json({ success: false, error: "Nothing changed." });
    vals.push(id);
    const r = await client.query(
      `UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length}
       RETURNING id, username, full_name, role, line_number, is_active, created_at, updated_at, last_login_at, last_seen_at`, vals);

    const keys = Object.keys(changes);
    const action = keys.length === 1 && changes.password ? "password_reset"
      : keys.length === 1 && changes.is_active ? (changes.is_active.to ? "user_activated" : "user_deactivated")
      : keys.length === 1 && changes.role ? "role_changed"
      : "user_updated";
    await auditEvent(pool, req, getClientIp, {
      action, details: { target_user_id: id, target_username: before.username, changes },
    });
    logger.info("IT panel: user updated", { id, action, by: req.user.username });
    res.json({ success: true, message: "Changes saved.", user: r.rows[0] });
  }));

  // ---------------- purge old logs (master only) ----------------
  app.post("/api/it/logs/purge", authenticateToken, requireIt, withClient(async (req, res, client) => {
    if (!isMaster(req)) return res.status(403).json({ success: false, error: "Only a master account can delete logs." });
    const days = parseInt(req.body.older_than_days, 10);
    if (!(days >= 30)) return res.status(400).json({ success: false, error: "Keep at least 30 days of logs." });
    const r = await client.query(`DELETE FROM user_activity_log WHERE created_at < now() - ($1 || ' days')::interval`, [String(days)]);
    await auditEvent(pool, req, getClientIp, { action: "logs_purged", details: { older_than_days: days, deleted: r.rowCount } });
    res.json({ success: true, deleted: r.rowCount });
  }));

  // ---------------- page views from the frontend (any logged user) ----------------
  app.post("/api/activity/track", authenticateToken, async (req, res) => {
    const action = req.body?.action === "page_view" ? "page_view" : null;
    const page = String(req.body?.page || "").slice(0, 100);
    if (!action || !page) return res.status(400).json({ success: false, error: "Send { action: 'page_view', page }." });
    try {
      await auditEvent(pool, req, getClientIp, { action, module: "ui", details: { page } });
    } catch (err) {
      logger.warn("page_view log failed", { error: err.message });
    }
    res.json({ success: true });
  });
}

registerItControlPanel.initSchema = initSchema;
registerItControlPanel.activityTracker = activityTracker;
registerItControlPanel.DEFAULT_ROLES = DEFAULT_ROLES;
registerItControlPanel.PROTECTED_ROLES = PROTECTED_ROLES;
module.exports = registerItControlPanel;