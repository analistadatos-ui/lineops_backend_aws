// ==========================================================================
// reporting-lambda.js
//
// READ-ONLY reporting API for Claude (CEO reports, Excel, presentations).
//
// It lives in the SAME repo / ECR image as LineOps, but runs as its OWN Lambda
// (same image, different CMD: "reporting-lambda.handler"). It does NOT load
// server1.js, so none of the write routes exist in this process.
//
// What it serves
//   1. The existing analytics modules, unchanged (their initSchema is NEVER called):
//        GET /api/cut-orders/analytics              cut-order-analytics.js
//        GET /api/cut-orders/analytics/breakdown
//        GET /api/finished-warehouse/analytics      finished-warehouse-analytics.js
//        GET /api/finished-warehouse/analytics/breakdown
//        GET /api/merchant/analytics                merchant-analytics.js
//        GET /api/mechanics-summary                 mechanics-summary.js (optional)
//   2. Reports written here, read-only SQL:
//        GET /reports/catalog                       list of reports + parameters
//        GET /reports/line-efficiency               produced / target / efficiency per line-day
//        GET /reports/work-orders                   order status, produced %, late orders
//        GET /reports/customer-production           produced per order / line / day for a customer
//        GET /reports/plan-load                     planned pieces per line-day + blocked days
//        GET /reports/pending-approvals             pending cut requests + close requests
//        GET /reports/sam-compliance                planning: merchant SAM vs production SAM
//        GET /reports/delivery-plan                 planning: plan finish vs merchant delivery date
//
// Security layers (each one stops what the others miss)
//   1. API Gateway: API key + usage plan (rate limit / daily quota)
//   2. Here, x-api-key checked again (constant-time) — fails closed if unset
//   3. GET only; exact route allowlist; every query param validated; unknown
//      params rejected; date ranges capped
//   4. Database: read-only role, SELECT on listed tables only, statement_timeout
//   5. Startup verifier: refuses to serve if the DB user CAN write
//   6. Responses: 5xx bodies sanitised (no SQL errors leak), size capped
//   7. Audit: one JSON log line per request -> CloudWatch metric filters/alarms
//
// Env vars
//   REPORT_API_KEYS        comma-separated keys (2 allowed for rotation)  REQUIRED
//   REPORT_PG_HOST         Aurora READER endpoint (cluster-ro-...)          REQUIRED
//   REPORT_PG_PORT         5432
//   REPORT_PG_DB           database name                                    REQUIRED
//   REPORT_PG_USER         claude_reporting                                 REQUIRED
//   REPORT_PG_PASSWORD     password of the read-only role                   REQUIRED
//   REPORT_PG_CA_CERT      /app/global-bundle.pem (default)
//   REPORT_MAX_RANGE_DAYS  366 (default)
//   MECHANICS_FUNCTION_NAME  skyrina-backend (optional; enables /api/mechanics-summary)
// ==========================================================================

"use strict";

const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

// Existing read-only analytics modules (only their GET routes are registered).
const registerCutOrderAnalytics = require("./cut-order-analytics");
const registerFinishedWarehouseAnalytics = require("./finished-warehouse-analytics");
const registerMerchantAnalytics = require("./merchant-analytics");
// Only the read helpers are used (producedByLineForMany / producedByLineDayForMany).
// registerWorkOrders(app) is NEVER called here, so none of its routes exist.
const workOrders = require("./work-orders");

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------
const PLANT_TZ = "America/Mexico_City";
const API_KEYS = (process.env.REPORT_API_KEYS || "")
  .split(",").map((s) => s.trim()).filter((s) => s.length >= 32);
const MAX_RANGE_DAYS = Number(process.env.REPORT_MAX_RANGE_DAYS) || 366;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // Lambda response limit is 6 MB
const MAX_ROWS = 2000;

// The identity every module sees. 'master' passes the role gates in
// cut-order-analytics (ALLOWED_ROLES) and merchant-analytics (READ_ROLES).
const REPORT_USER = Object.freeze({
  id: null, username: "claude-reporting", full_name: "Claude (reportes)", role: "master",
});

// --------------------------------------------------------------------------
// Database: read-only role on the Aurora READER endpoint
// --------------------------------------------------------------------------
const pool = new Pool({
  host: process.env.REPORT_PG_HOST,
  port: Number(process.env.REPORT_PG_PORT) || 5432,
  database: process.env.REPORT_PG_DB,
  user: process.env.REPORT_PG_USER,
  password: process.env.REPORT_PG_PASSWORD,
  ssl: {
    rejectUnauthorized: true,
    ca: fs.readFileSync(process.env.REPORT_PG_CA_CERT || "/app/global-bundle.pem").toString(),
  },
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  keepAlive: true,
});

// Same search_path / time zone as server1.js, plus per-session safety nets
// (the role already has these defaults; repeating them costs nothing).
const setSchema = async (client) => {
  await client.query("SET search_path TO prod_db_schema");
  await client.query(`SET TIME ZONE '${PLANT_TZ}'`);
  await client.query("SET statement_timeout = '30s'");
  await client.query("SET default_transaction_read_only = on");
};

// --------------------------------------------------------------------------
// Verifier: refuse to serve if this DB user is able to write.
// Cached once it gets a definite answer; connection errors are retried.
// --------------------------------------------------------------------------
let readOnlyVerdict = null; // null = unknown, true = safe, string = reason it is unsafe

async function checkReadOnly() {
  if (readOnlyVerdict !== null) return readOnlyVerdict;
  const client = await pool.connect();
  try {
    await setSchema(client);
    const { rows } = await client.query(`
      SELECT r.rolsuper,
             (SELECT pg_has_role(current_user, x.oid, 'MEMBER')
                FROM pg_roles x WHERE x.rolname = 'rds_superuser')       AS is_rds_superuser,
             has_table_privilege(current_user, 'work_orders', 'INSERT')   AS can_insert,
             has_table_privilege(current_user, 'work_orders', 'UPDATE')   AS can_update,
             has_table_privilege(current_user, 'work_orders', 'DELETE')   AS can_delete,
             has_table_privilege(current_user, 'work_orders', 'TRUNCATE') AS can_truncate,
             has_table_privilege(current_user, 'users', 'SELECT')         AS can_read_all_users,
             has_schema_privilege(current_user, 'prod_db_schema', 'CREATE') AS can_create
        FROM pg_roles r
       WHERE r.rolname = current_user`);
    const p = rows[0] || {};
    const bad = Object.entries(p).filter(([, v]) => v === true).map(([k]) => k);
    readOnlyVerdict = bad.length ? `DB user is not read-only (${bad.join(", ")})` : true;
    if (readOnlyVerdict !== true) console.error(JSON.stringify({ type: "report_unsafe_db_user", reason: readOnlyVerdict }));
    return readOnlyVerdict;
  } finally {
    client.release();
  }
}

// --------------------------------------------------------------------------
// Parameter validators
// --------------------------------------------------------------------------
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const P = {
  ymd: (doc) => ({ doc, check: isYmd }),
  month: (doc) => ({ doc, check: (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v) }),
  int: (doc) => ({ doc, check: (v) => /^\d{1,12}$/.test(v) }),
  flag: (doc) => ({ doc, check: (v) => v === "0" || v === "1" }),
  oneOf: (values, doc) => ({ doc: `${doc} (${values.join(" | ")})`, check: (v) => values.includes(v) }),
  // Free text: length cap, no control characters. Every query is parameterised,
  // so this is about bounds, not escaping.
  text: (max, doc, { allowEmpty = false } = {}) => ({
    doc, check: (v) => (allowEmpty || v.length > 0) && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v),
  }),
  custom: (doc, check) => ({ doc, check }),
};

const RANGE = {
  startDate: P.ymd("Fecha inicial YYYY-MM-DD"),
  endDate: P.ymd("Fecha final YYYY-MM-DD"),
};

// --------------------------------------------------------------------------
// ROUTE ALLOWLIST — anything not listed here returns 404 before any handler.
// --------------------------------------------------------------------------
const ROUTES = {
  // ---- existing analytics modules --------------------------------------
  "/api/cut-orders/analytics": {
    desc: "Órdenes de corte: etapa, piezas planeadas/cortadas, tallas, marcadas, eficiencia de marcada.",
    params: {
      ...RANGE,
      status: P.oneOf(["all", "pending", "in_progress", "awaiting_verification", "completed", "cancelled"], "Status"),
      stage: P.oneOf(["planning", "ready", "cutting", "verification", "verified", "cancelled"], "Etapa"),
      slim: P.flag("1 = respuesta reducida"),
      q: P.text(100, "Buscar por orden, PO cliente o id de corte"),
      allDates: P.flag("1 = ignorar fechas al buscar con q"),
      dateBy: P.oneOf(["completed"], "Filtrar por día en que se completó la marcada"),
    },
  },
  "/api/cut-orders/analytics/breakdown": {
    desc: "Detalle de un corte: por talla y por marcada.",
    params: { id: P.int("Id del corte") },
    required: ["id"],
  },
  "/api/finished-warehouse/analytics": {
    desc: "Almacén PT: recibido vs asignado vs producido, por orden, línea, día y cliente.",
    params: { ...RANGE, customerId: P.int("Id de cliente"), q: P.text(100, "Buscar orden / PO / cliente / color / estilo") },
  },
  "/api/finished-warehouse/analytics/breakdown": {
    desc: "Almacén PT: desglose por talla de una orden.",
    params: {
      ...RANGE,
      workOrder: P.text(50, "Número de orden (ej. SKM0156-NIK-DAMTSH06)"),
      po: P.text(80, "PO cliente ('__ALL__' = todos)", { allowEmpty: true }),
    },
    required: ["workOrder"],
  },
  "/api/merchant/analytics": {
    desc: "Merchants: POs creados, semana del plan, asignación del planner y producido.",
    params: {
      ...RANGE,
      merchant: P.custom("Id de usuario merchant o 'all'", (v) => v === "all" || /^\d{1,12}$/.test(v)),
      status: P.oneOf(["all", "pending", "assigned", "in_progress", "completed", "cancelled"], "Status"),
      weekBasis: P.oneOf(["plan", "created"], "Semana en la que cuenta el PO"),
    },
  },
  "/api/mechanics-summary": {
    optional: true, // only when MECHANICS_FUNCTION_NAME is set
    desc: "Mecánicos: tickets asignados/cerrados, bono, tiempo de cierre (semana, mes o año).",
    params: {
      tipo: P.oneOf(["semana", "mes", "anio"], "Periodo"),
      valor: P.custom("YYYY-MM-DD (lunes) | YYYY-MM | YYYY", (v) => isYmd(v) || /^\d{4}-\d{2}$/.test(v) || /^\d{4}$/.test(v)),
      semana: P.ymd("Lunes de la semana (compatibilidad)"),
    },
  },

  // ---- reports defined in this file -------------------------------------
  "/reports/catalog": {
    desc: "Lista de reportes disponibles y sus parámetros. Llámelo primero.",
    params: {},
  },
  "/reports/line-efficiency": {
    desc: "Eficiencia por línea y día: producido (empaque), meta, minutos SAM, minutos disponibles. Misma fórmula que la TV de línea.",
    params: { ...RANGE, lineNo: P.text(20, "Línea (ej. L8)") },
    required: ["startDate", "endDate"],
    maxDays: 92,
  },
  "/reports/work-orders": {
    desc: "Estado de órdenes: cantidad, producido, % avance, fecha compromiso, atrasadas.",
    params: {
      status: P.oneOf(["open", "all", "pending", "assigned", "in_progress", "completed", "cancelled"], "Status (open = no completadas ni canceladas)"),
      customer: P.text(100, "Cliente (exacto, sin distinguir mayúsculas)"),
      dueFrom: P.ymd("Fecha compromiso desde"),
      dueTo: P.ymd("Fecha compromiso hasta"),
      q: P.text(50, "Buscar número de orden o PO cliente"),
    },
  },
  "/reports/customer-production": {
    desc: "Producción de un cliente por orden, línea y día.",
    params: { customer: P.text(100, "Cliente"), startDate: P.ymd("Desde"), endDate: P.ymd("Hasta") },
    required: ["customer"],
  },
  "/reports/plan-load": {
    desc: "Carga del plan: piezas asignadas por línea y día, y días bloqueados.",
    params: { ...RANGE, lineNo: P.text(20, "Línea") },
    required: ["startDate", "endDate"],
    maxDays: 120,
  },
  "/reports/sam-compliance": {
    desc: "Planeación — SAM: SAM del merchant vs SAM de producción (debe ser MENOR). Por estilo, línea u orden. Misma lógica que Analíticas de planeación.",
    params: {
      grain: P.oneOf(["style", "line", "order"], "Nivel de detalle"),
      only: P.oneOf(["all", "ok", "bad", "nodata"], "Filtrar por resultado (ok = cumple, bad = incumple, nodata = sin dato)"),
      customer: P.text(100, "Cliente (exacto, sin distinguir mayúsculas)"),
      q: P.text(50, "Buscar estilo, orden, PO o color"),
    },
  },
  "/reports/delivery-plan": {
    desc: "Planeación — Entregas: fin de plan (último día asignado) vs fecha de entrega del merchant. A tiempo, atrasada, por planear, sin fecha. Misma lógica que Analíticas de planeación.",
    params: {
      status: P.oneOf(["all", "open"], "all = todas menos canceladas (como la pantalla); open = sin completadas"),
      verdict: P.oneOf(["all", "ontime", "late", "sinplan", "nofecha"], "Filtrar por resultado de entrega"),
      customer: P.text(100, "Cliente (exacto, sin distinguir mayúsculas)"),
      q: P.text(50, "Buscar número de orden, PO o estilo"),
    },
  },
  "/reports/pending-approvals": {
    desc: "Pendientes: solicitudes de corte por urgencia y solicitudes/alertas de cierre de órdenes.",
    params: {},
  },
};

const MECHANICS_ENABLED = !!process.env.MECHANICS_FUNCTION_NAME;
for (const [path, r] of Object.entries(ROUTES)) {
  if (r.optional && !MECHANICS_ENABLED) delete ROUTES[path];
}

// --------------------------------------------------------------------------
// App
// --------------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
app.set("etag", false); // no framework fingerprint; reports are never cached anyway
app.set("query parser", "simple"); // no nested objects; repeated keys become arrays (rejected below)

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const keyMatches = (given) =>
  typeof given === "string" && API_KEYS.some((k) => crypto.timingSafeEqual(sha(k), sha(given)));

// ---- 1. request id, response sanitising, size cap, audit log ------------
app.use((req, res, next) => {
  const started = Date.now();
  const reqId = crypto.randomUUID();
  res.locals.reqId = reqId;
  res.set("Cache-Control", "no-store");
  res.set("X-Request-Id", reqId);

  const sendJson = res.json.bind(res);
  res.json = (body) => {
    // Never return SQL / stack details to the caller; keep them in the log.
    if (res.statusCode >= 500 && !res.locals.safeError) {
      console.error(JSON.stringify({
        type: "report_error", reqId, path: req.path,
        error: body && (body.error || body.message), detail: body && body.detail,
      }));
      body = { success: false, error: "Error interno al generar el reporte.", requestId: reqId };
    }
    let payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > MAX_RESPONSE_BYTES) {
      res.status(413);
      payload = JSON.stringify({
        success: false, requestId: reqId,
        error: "El reporte es demasiado grande. Reduzca el rango de fechas o agregue filtros.",
      });
    }
    res.locals.bytes = Buffer.byteLength(payload);
    res.type("application/json");
    return res.send(payload);
  };

  res.on("finish", () => {
    console.log(JSON.stringify({
      type: res.statusCode < 400 ? "report_audit" : "report_denied",
      reqId, method: req.method, path: req.path, query: req.query,
      status: res.statusCode, ms: Date.now() - started, bytes: res.locals.bytes || 0,
      sourceIp: req.get("x-forwarded-for") || null,
    }));
  });
  next();
});

// ---- 2. gatekeeper: key, method, allowlist, parameters ------------------
app.use((req, res, next) => {
  const deny = (status, error) => {
    res.locals.safeError = true; // our own message: no need to hide it
    return res.status(status).json({ success: false, error, requestId: res.locals.reqId });
  };

  if (API_KEYS.length === 0) return deny(503, "Reporting API not configured"); // fail closed
  if (!keyMatches(req.get("x-api-key"))) return deny(401, "Invalid API key");
  if (req.method !== "GET") return deny(405, "Only GET is allowed");

  const route = ROUTES[req.path];
  if (!route) return deny(404, "Unknown report. Call GET /reports/catalog for the list.");

  for (const [k, v] of Object.entries(req.query)) {
    const spec = route.params[k];
    if (!spec) return deny(400, `Unknown parameter '${k}'. Allowed: ${Object.keys(route.params).join(", ") || "none"}`);
    if (typeof v !== "string" || !spec.check(v)) return deny(400, `Invalid value for '${k}': ${spec.doc}`);
  }
  for (const k of route.required || []) {
    if (!req.query[k]) return deny(400, `Missing required parameter '${k}': ${route.params[k].doc}`);
  }

  const { startDate, endDate } = req.query;
  if (startDate && endDate) {
    const days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000;
    if (days < 0) return deny(400, "endDate must be on or after startDate");
    const cap = Math.min(route.maxDays || MAX_RANGE_DAYS, MAX_RANGE_DAYS);
    if (days + 1 > cap) return deny(400, `Date range too long for this report (max ${cap} days)`);
  }

  req.user = REPORT_USER;
  next();
});

// ---- 3. verifier: the DB user must be read-only --------------------------
app.use(async (req, res, next) => {
  try {
    const verdict = await checkReadOnly();
    if (verdict !== true) {
      res.locals.safeError = true;
      return res.status(503).json({ success: false, error: "Reporting disabled: database user is not read-only.", requestId: res.locals.reqId });
    }
    next();
  } catch (err) {
    next(err);
  }
});

// The modules expect authenticateToken; the gatekeeper above already authenticated.
const authenticateToken = (req, res, next) =>
  req.user ? next() : res.status(401).json({ success: false, error: "Not authenticated" });

// ---- 4. existing analytics modules (GET routes only; no initSchema) -----
registerCutOrderAnalytics(app, { authenticateToken, pool, setSchema });
registerFinishedWarehouseAnalytics(app, { authenticateToken, pool, setSchema });
registerMerchantAnalytics(app, { authenticateToken, pool, setSchema });
if (MECHANICS_ENABLED) {
  // The uploaded file is named mecanics-summary.js; its header says mechanics-summary.js.
  let registerMechanicsSummary;
  try { registerMechanicsSummary = require("./mechanics-summary"); }
  catch { registerMechanicsSummary = require("./mecanics-summary"); }
  registerMechanicsSummary(app, authenticateToken);
}

// ---- 5. reports defined here ---------------------------------------------
const withClient = (handler) => async (req, res, next) => {
  let client;
  try {
    client = await pool.connect();
    await setSchema(client);
    await handler(req, res, client);
  } catch (err) {
    next(err);
  } finally {
    if (client) client.release();
  }
};
const num = (v) => Number(v) || 0;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const todayPlant = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: PLANT_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// GET /reports/catalog
app.get("/reports/catalog", (req, res) => {
  res.json({
    success: true,
    timezone: PLANT_TZ,
    notes: [
      "Todas las fechas son YYYY-MM-DD en hora de planta.",
      "Rangos de fecha: máximo indicado por reporte (maxDays).",
      "Respuestas de más de 5 MB se rechazan: acote el rango o filtre.",
    ],
    reports: Object.entries(ROUTES).map(([path, r]) => ({
      path,
      description: r.desc,
      required: r.required || [],
      maxDays: r.maxDays || null,
      params: Object.fromEntries(Object.entries(r.params).map(([k, s]) => [k, s.doc])),
    })),
  });
});

// GET /reports/line-efficiency?startDate&endDate[&lineNo]
// Same formula as /api/line-tv/week-efficiency (server1.js):
//   efficiency = Σ(packed × SAM) / Σ(operators × hours × 60)
app.get("/reports/line-efficiency", withClient(async (req, res, client) => {
  const { startDate, endDate } = req.query;
  const lineNo = req.query.lineNo || null;
  const { rows } = await client.query(
    `WITH run_totals AS (
       SELECT lr.line_no,
              lr.run_date,
              COALESCE(lr.sam_minutes, 0)::numeric   AS sam,
              COALESCE(lr.working_hours, 0)::numeric AS wh,
              COALESCE(lr.target_pcs, 0)::numeric    AS target,
              COALESCE(NULLIF((SELECT COUNT(*) FROM run_operators ro WHERE ro.run_id = lr.id), 0),
                       lr.operators_count, 0)::numeric AS ops,
              COALESCE((
                SELECT SUM(se.sewed_qty)
                  FROM operator_operations oo
                  JOIN operation_sewed_entries se ON se.operation_id = oo.id
                 WHERE oo.run_id = lr.id
                   AND (   oo.operation_name ILIKE '%pack%'
                        OR oo.operation_name ILIKE '%emp%'
                        OR oo.operation_name ILIKE '%finished%'
                        OR oo.operation_name ILIKE '%terminado%')
              ), 0)::numeric AS packed
         FROM line_runs lr
        WHERE lr.run_date BETWEEN $1::date AND $2::date
          AND ($3::text IS NULL OR lr.line_no = $3)
          AND COALESCE(lr.is_draft, false) = false
     )
     SELECT line_no,
            to_char(run_date, 'YYYY-MM-DD') AS date,
            SUM(packed)        AS produced,
            SUM(target)        AS target,
            SUM(packed * sam)  AS sam_output,
            SUM(ops * wh * 60) AS available_minutes,
            COUNT(*)           AS runs
       FROM run_totals
      GROUP BY line_no, run_date
      ORDER BY run_date, line_no`,
    [startDate, endDate, lineNo]
  );

  const byDay = rows.map((r) => ({
    date: r.date,
    lineNo: r.line_no,
    produced: num(r.produced),
    target: num(r.target),
    samOutput: num(r.sam_output),
    availableMinutes: num(r.available_minutes),
    runs: num(r.runs),
    efficiencyPct: pct(num(r.sam_output), num(r.available_minutes)),
    attainmentPct: pct(num(r.produced), num(r.target)),
  }));

  const roll = (items) => {
    const t = items.reduce((a, d) => ({
      produced: a.produced + d.produced, target: a.target + d.target,
      samOutput: a.samOutput + d.samOutput, availableMinutes: a.availableMinutes + d.availableMinutes,
    }), { produced: 0, target: 0, samOutput: 0, availableMinutes: 0 });
    return { ...t, efficiencyPct: pct(t.samOutput, t.availableMinutes), attainmentPct: pct(t.produced, t.target), days: items.length };
  };
  const lines = [...new Set(byDay.map((d) => d.lineNo))];
  res.json({
    success: true,
    period: { startDate, endDate },
    plant: roll(byDay),
    byLine: lines.map((l) => ({ lineNo: l, ...roll(byDay.filter((d) => d.lineNo === l)) })),
    byDay,
  });
}));

// GET /reports/work-orders?status&customer&dueFrom&dueTo&q
app.get("/reports/work-orders", withClient(async (req, res, client) => {
  const status = req.query.status || "open";
  const params = [];
  const where = [];
  if (status === "open") where.push("COALESCE(wo.status, '') NOT IN ('completed', 'cancelled')");
  else if (status !== "all") { params.push(status); where.push(`wo.status = $${params.length}`); }
  if (req.query.customer) { params.push(req.query.customer); where.push(`UPPER(TRIM(wo.customer_name)) = UPPER(TRIM($${params.length}))`); }
  if (req.query.dueFrom) { params.push(req.query.dueFrom); where.push(`wo.commitment_date >= $${params.length}::date`); }
  if (req.query.dueTo) { params.push(req.query.dueTo); where.push(`wo.commitment_date <= $${params.length}::date`); }
  if (req.query.q) {
    params.push(`%${req.query.q.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`(wo.work_order_no ILIKE $${params.length} OR wo.customer_po ILIKE $${params.length})`);
  }
  params.push(MAX_ROWS + 1);

  const { rows } = await client.query(
    `SELECT wo.id, wo.work_order_no, wo.customer_name, wo.customer_po, wo.style_code,
            wo.style_description, wo.color, wo.status, wo.quantity,
            COALESCE(wo.total_to_produce, wo.quantity) AS target_quantity,
            to_char(wo.commitment_date, 'YYYY-MM-DD') AS commitment_date,
            to_char(wo.created_at AT TIME ZONE '${PLANT_TZ}', 'YYYY-MM-DD') AS created_date
       FROM work_orders wo
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY wo.commitment_date NULLS LAST, wo.work_order_no
      LIMIT $${params.length}`,
    params
  );
  const truncated = rows.length > MAX_ROWS;
  const list = rows.slice(0, MAX_ROWS);

  // Same packing/finishing detection the planner screens use (work-orders.js).
  const byLine = await workOrders.producedByLineForMany(client, list.map((r) => Number(r.id)));
  const today = todayPlant();

  const orders = list.map((r) => {
    const lines = byLine.get(Number(r.id)) || [];
    const produced = lines.reduce((s, l) => s + num(l.finished), 0);
    const target = num(r.target_quantity);
    const open = !["completed", "cancelled"].includes(r.status);
    return {
      workOrderNo: r.work_order_no,
      customer: r.customer_name,
      customerPo: r.customer_po,
      style: r.style_code || r.style_description,
      color: r.color,
      status: r.status,
      quantity: target,
      produced,
      pending: Math.max(target - produced, 0),
      progressPct: pct(produced, target),
      commitmentDate: r.commitment_date,
      createdDate: r.created_date,
      late: open && !!r.commitment_date && r.commitment_date < today && produced < target,
      lines: lines.map((l) => ({ lineNo: l.line_no, produced: num(l.finished) })),
    };
  });

  const byStatus = {};
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  const totQty = orders.reduce((s, o) => s + o.quantity, 0);
  const totProd = orders.reduce((s, o) => s + o.produced, 0);
  res.json({
    success: true,
    asOf: today,
    truncated,
    summary: {
      orders: orders.length,
      lateOrders: orders.filter((o) => o.late).length,
      quantity: totQty,
      produced: totProd,
      progressPct: pct(totProd, totQty),
      byStatus,
    },
    orders,
  });
}));

// GET /reports/customer-production?customer[&startDate&endDate]
app.get("/reports/customer-production", withClient(async (req, res, client) => {
  const customer = req.query.customer.trim();
  const { rows: wos } = await client.query(
    `SELECT id, work_order_no FROM work_orders WHERE UPPER(TRIM(customer_name)) = UPPER($1)`,
    [customer]
  );
  if (wos.length === 0) return res.json({ success: true, customer, totalProduced: 0, byLine: [], byDay: [], rows: [] });

  const noById = new Map(wos.map((w) => [Number(w.id), w.work_order_no]));
  const rows = await workOrders.producedByLineDayForMany(client, {
    workOrderIds: [...noById.keys()],
    from: req.query.startDate || null,
    to: req.query.endDate || null,
  });

  const sumBy = (key) => {
    const m = new Map();
    for (const r of rows) m.set(r[key], (m.get(r[key]) || 0) + r.produced);
    return [...m.entries()].map(([k, produced]) => ({ [key]: k, produced }));
  };
  res.json({
    success: true,
    customer,
    totalProduced: rows.reduce((s, r) => s + r.produced, 0),
    byLine: sumBy("line_no"),
    byDay: sumBy("day"),
    rows: rows.map((r) => ({ workOrderNo: noById.get(r.work_order_id), lineNo: r.line_no, day: r.day, produced: r.produced })),
  });
}));

// GET /reports/plan-load?startDate&endDate[&lineNo]
app.get("/reports/plan-load", withClient(async (req, res, client) => {
  const { startDate, endDate } = req.query;
  const lineNo = req.query.lineNo || null;
  const { rows } = await client.query(
    `SELECT la.line_no,
            to_char(la.assigned_date, 'YYYY-MM-DD') AS day,
            SUM(la.assigned_quantity)               AS planned_pcs,
            COUNT(DISTINCT la.work_order_id)        AS orders
       FROM line_assignments la
      WHERE la.assigned_date BETWEEN $1::date AND $2::date
        AND la.status <> 'cancelled'
        AND ($3::text IS NULL OR la.line_no = $3)
      GROUP BY la.line_no, la.assigned_date
      ORDER BY la.assigned_date, la.line_no`,
    [startDate, endDate, lineNo]
  );

  let blockedDays = [];
  const t = await client.query("SELECT to_regclass('production_holidays') AS t");
  if (t.rows[0].t) {
    const h = await client.query(
      `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS day, name, COALESCE(line_no, 'TODAS') AS line_no
         FROM production_holidays
        WHERE holiday_date BETWEEN $1::date AND $2::date
          AND ($3::text IS NULL OR line_no IS NULL OR line_no = $3)
        ORDER BY holiday_date, line_no NULLS FIRST`,
      [startDate, endDate, lineNo]
    );
    blockedDays = h.rows;
  }

  const cells = rows.map((r) => ({ lineNo: r.line_no, day: r.day, plannedPcs: num(r.planned_pcs), orders: num(r.orders) }));
  const byLine = {};
  for (const c of cells) byLine[c.lineNo] = (byLine[c.lineNo] || 0) + c.plannedPcs;
  res.json({
    success: true,
    period: { startDate, endDate },
    totalPlannedPcs: cells.reduce((s, c) => s + c.plannedPcs, 0),
    byLine: Object.entries(byLine).map(([lineNo2, plannedPcs]) => ({ lineNo: lineNo2, plannedPcs })),
    cells,
    blockedDays,
  });
}));

// GET /reports/pending-approvals
app.get("/reports/pending-approvals", withClient(async (req, res, client) => {
  const out = { success: true, cutRequests: null, closeRequests: null };

  const hasCut = (await client.query("SELECT to_regclass('cut_order_requests') AS t")).rows[0].t;
  if (hasCut) {
    const { rows } = await client.query(
      `SELECT r.urgency, r.color, r.quantity, r.note, r.requested_by_name,
              to_char(r.created_at AT TIME ZONE '${PLANT_TZ}', 'YYYY-MM-DD HH24:MI') AS requested_at,
              wo.work_order_no, wo.customer_name, wo.style_code,
              to_char(wo.commitment_date, 'YYYY-MM-DD') AS commitment_date
         FROM cut_order_requests r
         JOIN work_orders wo ON wo.id = r.work_order_id
        WHERE r.status = 'pending'
        ORDER BY CASE r.urgency WHEN 'urgent' THEN 0 WHEN 'intermediate' THEN 1 ELSE 2 END, r.created_at
        LIMIT 300`
    );
    const byUrgency = { urgent: 0, intermediate: 0, normal: 0 };
    for (const r of rows) byUrgency[r.urgency] = (byUrgency[r.urgency] || 0) + 1;
    out.cutRequests = { pending: rows.length, byUrgency, items: rows };
  }

  const hasClose = (await client.query("SELECT to_regclass('work_order_close_requests') AS t")).rows[0].t;
  if (hasClose) {
    const { rows } = await client.query(
      `SELECT c.kind, c.status, c.pct, c.threshold_pct, c.produced_qty, c.total_qty, c.reason,
              to_char(c.requested_at AT TIME ZONE '${PLANT_TZ}', 'YYYY-MM-DD HH24:MI') AS requested_at,
              wo.work_order_no, wo.customer_name
         FROM work_order_close_requests c
         JOIN work_orders wo ON wo.id = c.work_order_id
        WHERE (c.kind = 'request' AND c.status = 'pending')
           OR (c.kind = 'alert' AND c.acknowledged_at IS NULL)
        ORDER BY c.requested_at DESC
        LIMIT 300`
    );
    out.closeRequests = {
      pendingRequests: rows.filter((r) => r.kind === "request").length,
      unreadAlerts: rows.filter((r) => r.kind === "alert").length,
      items: rows,
    };
  }
  res.json(out);
}));

// ==========================================================================
// PLANNING ANALYTICS — same rules as PlannerAnalytics.jsx
// ==========================================================================
const normKey = (v) => String(v == null ? "" : v).trim().toUpperCase();
const DEAD_STATUSES = ["cancelled", "rejected"];
const daysDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const matchesQ = (q, ...fields) => !q || fields.join(" ").toUpperCase().includes(q.toUpperCase());

// GET /reports/sam-compliance?grain=style|line|order&only&customer&q
// Rule: production SAM (line_runs.sam_minutes) must be LOWER than merchant SAM.
// Merchant SAM: merchant plan first (authoritative), else work-order snapshot
// (largest value when a style carries several). Production SAM: latest run per
// line+style; style/order level takes the worst (highest) of its lines.
app.get("/reports/sam-compliance", withClient(async (req, res, client) => {
  const grain = req.query.grain || "style";
  const only = req.query.only || "all";
  const customer = req.query.customer ? normKey(req.query.customer) : null;
  const q = req.query.q || "";

  const [wo, mp, runs] = await Promise.all([
    client.query(`SELECT id, work_order_no, customer_name, customer_po, style_code, estilo,
                         style_description, color, sam_minutes, status
                    FROM work_orders`),
    client.query(`SELECT work_order_no, color, style_code, estilo, style_description,
                         customer_name, sam_minutes
                    FROM merchant_week_plan
                   ORDER BY week_start, work_order_no, color`),
    client.query(`SELECT DISTINCT ON (line_no, UPPER(TRIM(style)))
                         line_no, style, sam_minutes, efficiency, work_order_id,
                         to_char(run_date, 'YYYY-MM-DD') AS run_date
                    FROM line_runs
                   ORDER BY line_no, UPPER(TRIM(style)), run_date DESC, id DESC`),
  ]);

  // ---- merchant SAM per style --------------------------------------------
  const styles = new Map();
  const ensure = (code) => {
    let e = styles.get(code);
    if (!e) { e = { styleCode: code, description: "", planSam: 0, woSam: 0, seen: new Set(), customers: new Set() }; styles.set(code, e); }
    return e;
  };
  const woSamById = new Map();
  for (const w of wo.rows) {
    const code = normKey(w.style_code) || normKey(w.estilo);
    if (!code) continue;
    const e = ensure(code);
    const sam = num(w.sam_minutes);
    if (sam > 0) { if (!(e.woSam > 0)) e.woSam = sam; e.seen.add(sam); woSamById.set(String(w.id), sam); }
    if (!e.description && w.style_description) e.description = w.style_description;
    if (w.customer_name) e.customers.add(normKey(w.customer_name));
  }
  const mpSamByOrder = new Map();
  for (const r of mp.rows) {
    const code = normKey(r.style_code) || normKey(r.estilo);
    const sam = num(r.sam_minutes);
    if (code) {
      const e = ensure(code);
      if (sam > 0) { if (!(e.planSam > 0)) e.planSam = sam; e.seen.add(sam); }
      if (!e.description && r.style_description) e.description = r.style_description;
      if (r.customer_name) e.customers.add(normKey(r.customer_name));
    }
    if (sam > 0 && r.work_order_no) mpSamByOrder.set(`${normKey(r.work_order_no)}|${normKey(r.color)}`, sam);
  }
  for (const e of styles.values()) {
    const distinct = [...e.seen].filter((x) => x > 0).sort((a, b) => a - b);
    e.conflict = distinct.length > 1;
    e.samValues = distinct;
    e.merchantSam = e.planSam > 0 ? e.planSam : (distinct.length ? distinct[distinct.length - 1] : 0);
  }

  // ---- production SAM (latest run per line+style) -------------------------
  const prodByStyle = new Map();
  const prodSamByWo = new Map();
  for (const r of runs.rows) {
    const code = normKey(r.style);
    const ps = num(r.sam_minutes);
    const arr = prodByStyle.get(code) || [];
    arr.push({ lineNo: String(r.line_no), prodSam: ps, plannedEfficiencyPct: Math.round(num(r.efficiency) * 1000) / 10, runDate: r.run_date, workOrderId: r.work_order_id });
    prodByStyle.set(code, arr);
    if (ps > 0 && r.work_order_id != null) {
      const k = String(r.work_order_id);
      prodSamByWo.set(k, Math.max(prodSamByWo.get(k) || 0, ps));
    }
  }
  const worstOf = (arr) => Math.max(0, ...arr.map((x) => x.prodSam).filter((x) => x > 0));
  const verdict = (m, p) => (!(m > 0) || !(p > 0) ? "nodata" : p < m ? "ok" : "bad");
  const round2 = (v) => Math.round(v * 100) / 100;
  const row = (base, m, p) => ({
    ...base,
    merchantSam: m || null,
    productionSam: p || null,
    marginMinutes: m > 0 && p > 0 ? round2(m - p) : null,
    productionVsMerchantPct: m > 0 && p > 0 ? Math.round((p / m) * 1000) / 10 : null,
    result: verdict(m, p),
  });

  let rows = [];
  if (grain === "style") {
    for (const [code, e] of styles) {
      if (customer && !e.customers.has(customer)) continue;
      const prod = prodByStyle.get(code) || [];
      rows.push(row({ style: code, description: e.description, lines: prod.map((x) => x.lineNo),
                      merchantSamConflict: e.conflict, merchantSamValues: e.samValues },
                    e.merchantSam, worstOf(prod)));
    }
  } else if (grain === "line") {
    for (const [code, prod] of prodByStyle) {
      const e = styles.get(code);
      if (customer && !(e && e.customers.has(customer))) continue;
      for (const r of prod) {
        const exact = r.workOrderId != null ? woSamById.get(String(r.workOrderId)) || 0 : 0;
        const m = exact > 0 ? exact : (e ? e.merchantSam : 0);
        rows.push(row({ lineNo: r.lineNo, style: code, description: e ? e.description : "", lastRunDate: r.runDate,
                        plannedEfficiencyPct: r.plannedEfficiencyPct,
                        merchantSamConflict: exact > 0 ? false : !!(e && e.conflict) },
                      m, r.prodSam));
      }
    }
  } else {
    for (const w of wo.rows) {
      if (DEAD_STATUSES.includes(String(w.status || "").toLowerCase())) continue;
      if (customer && normKey(w.customer_name) !== customer) continue;
      const code = normKey(w.style_code) || normKey(w.estilo);
      if (!code) continue;
      const e = styles.get(code);
      const m = mpSamByOrder.get(`${normKey(w.work_order_no)}|${normKey(w.color)}`) || num(w.sam_minutes);
      const p = prodSamByWo.get(String(w.id)) || worstOf(prodByStyle.get(code) || []);
      rows.push(row({ workOrderNo: w.work_order_no, customer: w.customer_name, customerPo: w.customer_po,
                      style: code, color: w.color, description: w.style_description || (e ? e.description : ""),
                      status: w.status, styleSamConflict: !!(e && e.conflict) },
                    m, p));
    }
  }

  rows = rows.filter((r) => matchesQ(q, r.style, r.workOrderNo || "", r.customerPo || "", r.color || "", r.description || "", r.lineNo || ""));
  const counts = { ok: 0, bad: 0, nodata: 0 };
  for (const r of rows) counts[r.result]++;
  const judged = counts.ok + counts.bad;
  if (only !== "all") rows = rows.filter((r) => r.result === only);
  // worst first: smallest (most negative) margin on top, no-data last
  rows.sort((a, b) => (a.marginMinutes == null) - (b.marginMinutes == null) || (a.marginMinutes ?? 0) - (b.marginMinutes ?? 0));

  res.json({
    success: true,
    grain,
    rule: "La SAM de producción debe ser MENOR que la SAM del merchant.",
    summary: { complies: counts.ok, fails: counts.bad, noData: counts.nodata,
               compliancePct: judged ? Math.round((counts.ok / judged) * 1000) / 10 : null },
    truncated: rows.length > MAX_ROWS,
    rows: rows.slice(0, MAX_ROWS),
  });
}));

// GET /reports/delivery-plan?status&verdict&customer&q
// Plan finish = last assigned day (line_assignments, not cancelled/rejected).
// late = plan finish AFTER merchant delivery (commitment_date).
app.get("/reports/delivery-plan", withClient(async (req, res, client) => {
  const status = req.query.status || "all";
  const only = req.query.verdict || "all";
  const params = [DEAD_STATUSES];
  const where = ["COALESCE(LOWER(wo.status), '') <> ALL($1::text[])"];
  if (status === "open") where.push("COALESCE(LOWER(wo.status), '') <> 'completed'");
  if (req.query.customer) { params.push(req.query.customer); where.push(`UPPER(TRIM(wo.customer_name)) = UPPER(TRIM($${params.length}))`); }
  if (req.query.q) {
    params.push(`%${req.query.q.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`(wo.work_order_no ILIKE $${params.length} OR wo.customer_po ILIKE $${params.length} OR wo.style_code ILIKE $${params.length})`);
  }
  params.push(MAX_ROWS + 1);

  const { rows } = await client.query(
    `WITH plan AS (
       SELECT work_order_id,
              to_char(MIN(assigned_date), 'YYYY-MM-DD') AS plan_start,
              to_char(MAX(assigned_date), 'YYYY-MM-DD') AS plan_finish,
              SUM(assigned_quantity)                     AS assigned,
              array_agg(DISTINCT line_no ORDER BY line_no) AS lines
         FROM line_assignments
        WHERE COALESCE(LOWER(status), '') <> ALL($1::text[])
        GROUP BY work_order_id
     )
     SELECT wo.id, wo.work_order_no, wo.customer_name, wo.customer_po, wo.style_code, wo.color, wo.status,
            COALESCE(wo.total_to_produce, wo.quantity) AS target,
            to_char(wo.commitment_date, 'YYYY-MM-DD') AS merchant_date,
            p.plan_start, p.plan_finish, COALESCE(p.assigned, 0) AS assigned, p.lines
       FROM work_orders wo
       LEFT JOIN plan p ON p.work_order_id = wo.id
      WHERE ${where.join(" AND ")}
      ORDER BY wo.commitment_date NULLS LAST, wo.work_order_no
      LIMIT $${params.length}`,
    params
  );
  const truncated = rows.length > MAX_ROWS;
  const list = rows.slice(0, MAX_ROWS);
  const byLine = await workOrders.producedByLineForMany(client, list.map((r) => Number(r.id)));

  let orders = list.map((r) => {
    const target = num(r.target);
    const produced = (byLine.get(Number(r.id)) || []).reduce((s, l) => s + num(l.finished), 0);
    const st = String(r.status || "").toLowerCase();
    const progress = st === "completed" || (target > 0 && produced >= target) ? "completed" : produced > 0 ? "in_progress" : "pending";
    const v = !r.merchant_date ? "nofecha" : !r.plan_finish ? "sinplan" : daysDiff(r.merchant_date, r.plan_finish) > 0 ? "late" : "ontime";
    return {
      workOrderNo: r.work_order_no, customer: r.customer_name, customerPo: r.customer_po,
      style: r.style_code, color: r.color, status: r.status, progress,
      quantity: target, assigned: num(r.assigned), produced,
      progressPct: pct(produced, target),
      merchantDeliveryDate: r.merchant_date, planStart: r.plan_start, planFinish: r.plan_finish,
      daysAfterDelivery: r.merchant_date && r.plan_finish ? daysDiff(r.merchant_date, r.plan_finish) : null,
      verdict: v, lines: r.lines || [],
    };
  });

  const counts = { ontime: 0, late: 0, sinplan: 0, nofecha: 0 };
  for (const o of orders) counts[o.verdict]++;
  const judged = counts.ontime + counts.late;
  if (only !== "all") orders = orders.filter((o) => o.verdict === only);
  res.json({
    success: true,
    asOf: todayPlant(),
    rule: "El fin de plan debe caer antes o el mismo día que la entrega del merchant.",
    truncated,
    summary: { onTime: counts.ontime, late: counts.late, toPlan: counts.sinplan + counts.nofecha,
               withoutPlan: counts.sinplan, withoutDeliveryDate: counts.nofecha,
               onTimePct: judged ? Math.round((counts.ontime / judged) * 1000) / 10 : null },
    orders,
  });
}));

// ---- 6. errors -------------------------------------------------------------
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  res.status(500).json({ success: false, error: err && err.message });
});

// --------------------------------------------------------------------------
// Start-up: two ways to run, same code.
//
//  A) AWS Lambda Web Adapter (how the LineOps image runs): the container starts
//     `node reporting-lambda.js`, which listens on PORT (default 8080), and the
//     lambda-adapter extension forwards API Gateway events to it.
//     Lambda CMD override:  node,reporting-lambda.js
//
//  B) Classic handler (Lambda Node.js base image): CMD reporting-lambda.handler
//     Needs @codegenie/serverless-express (or @vendia/serverless-express).
// --------------------------------------------------------------------------
if (require.main === module) {
  const port = Number(process.env.PORT || process.env.AWS_LWA_PORT) || 8080;
  app.listen(port, () => console.log(`reporting API listening on ${port}`));
} else {
  let handler = null;
  exports.handler = async (event, context) => {
    if (!handler) {
      let serverlessExpress;
      try { serverlessExpress = require("@codegenie/serverless-express"); }
      catch { serverlessExpress = require("@vendia/serverless-express"); }
      handler = serverlessExpress({ app });
    }
    return handler(event, context);
  };
}
exports.app = app; 