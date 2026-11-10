// ==========================================================================
// mechanics-summary.js
//
// Proxy endpoint that fans out to skyrina-backend (the Mechanics FastAPI
// Lambda in mx-central-1), merges the relevant responses, and returns one
// clean payload for the frontend.
//
// It calls, in parallel:
//   1. GET /rh/bonos/semana/{semana}      -> per-mechanic bonus + closed/assigned + location
//   2. GET /supervisor/dashboard/stats    -> global created/closed totals
//
// --------------------------------------------------------------------------
// HOW IT REACHES SKYRINA (changed)
// --------------------------------------------------------------------------
// Previously this called the PUBLIC API Gateway URL over HTTPS, which from
// inside the VPC had to go out through the NAT gateway.
//
// Now it invokes the skyrina-backend Lambda DIRECTLY with the AWS SDK. The
// call goes through the Lambda VPC endpoint (vpce-01b56ab670f2e013f), so it
// never leaves the VPC and the NAT gateway is no longer needed for it.
// The request is wrapped in an API Gateway (REST / v1) event, which Mangum
// in the FastAPI app already understands, so skyrina-backend needs NO changes.
//
// Access is controlled by IAM: the LineOps Lambda role has the
// InvokeMechanicsLambda inline policy (lambda:InvokeFunction on skyrina-backend).
//
// --------------------------------------------------------------------------
// SETUP
// --------------------------------------------------------------------------
// 1. Add the dependency:   npm install @aws-sdk/client-lambda
//
// 2. Environment variables on the LineOps Lambda:
//      MECHANICS_FUNCTION_NAME=skyrina-backend          (required)
//      MECHANICS_PATH_PREFIX=/api                       (optional; only if the
//                                                        FastAPI app mounts its
//                                                        routes under /api, i.e.
//                                                        if the old AWS_API_BASE
//                                                        ended in /api)
//      AWS_API_KEY=<key>                                (optional; only forwarded
//                                                        in case FastAPI itself
//                                                        checks the x-api-key header)
//    AWS_API_BASE is no longer used and can be removed.
//
// 3. Wire it into server.js after `authenticateToken` is defined (unchanged):
//      const registerMechanicsSummary = require("./mechanics-summary");
//      registerMechanicsSummary(app, authenticateToken);
//
// NOTE: this event format is for a REST API (v1) trigger. If skyrina-backend
// is fronted by an HTTP API, the event must use the version 2.0 format.
// ==========================================================================

const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

// --- Config -------------------------------------------------------------
const MECHANICS_FUNCTION_NAME = process.env.MECHANICS_FUNCTION_NAME; // e.g. skyrina-backend
const MECHANICS_PATH_PREFIX = (process.env.MECHANICS_PATH_PREFIX || "").replace(/\/$/, "");
const AWS_API_KEY = process.env.AWS_API_KEY; // optional

// Fail fast instead of hanging the frontend if skyrina is slow.
const AWS_TIMEOUT_MS = 15000;

const lambdaClient = new LambdaClient({
  region: process.env.AWS_REGION || "mx-central-1",
});

// --- Helpers ------------------------------------------------------------

// Monday of the current week as YYYY-MM-DD, matching the Python
// get_week_monday() the AWS /rh routes expect.
function currentWeekMonday(ref = new Date()) {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  const day = d.getUTCDay();                 // 0 = Sunday, 1 = Monday, ...
  const diff = (day === 0 ? -6 : 1 - day);   // shift back to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// Basic YYYY-MM-DD sanity check for the optional ?semana= override.
function isValidWeek(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

// YYYY-MM (month) and YYYY (year) validators for the period selector.
function isValidMonth(s) {
  return typeof s === "string" && /^\d{4}-\d{2}$/.test(s);
}
function isValidYear(s) {
  return typeof s === "string" && /^\d{4}$/.test(s);
}

// Build an API Gateway REST (v1) proxy event for a GET request.
function buildApiGatewayEvent(path) {
  const url = new URL(`${MECHANICS_PATH_PREFIX}${path}`, "http://internal");
  const query = url.searchParams.toString()
    ? Object.fromEntries(url.searchParams.entries())
    : null;

  const headers = { accept: "application/json" };
  if (AWS_API_KEY) headers["x-api-key"] = AWS_API_KEY;

  return {
    resource: "/{proxy+}",
    path: url.pathname,
    httpMethod: "GET",
    headers,
    multiValueHeaders: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]])),
    queryStringParameters: query,
    multiValueQueryStringParameters: query
      ? Object.fromEntries(Object.entries(query).map(([k, v]) => [k, [v]]))
      : null,
    pathParameters: { proxy: url.pathname.replace(/^\//, "") },
    stageVariables: null,
    requestContext: {
      resourcePath: "/{proxy+}",
      httpMethod: "GET",
      path: url.pathname,
      stage: "internal",
      requestId: `lineops-${Date.now()}`,
      identity: { sourceIp: "127.0.0.1", userAgent: "lineops-lambda" },
    },
    body: null,
    isBase64Encoded: false,
  };
}

// One direct Lambda invoke with a timeout + JSON parsing, with useful errors.
// Same signature and return value as the old fetch-based awsGet, so the
// route code below is unchanged.
async function awsGet(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AWS_TIMEOUT_MS);

  try {
    const result = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: MECHANICS_FUNCTION_NAME,
        Payload: Buffer.from(JSON.stringify(buildApiGatewayEvent(path))),
      }),
      { abortSignal: controller.signal }
    );

    const raw = result.Payload ? Buffer.from(result.Payload).toString("utf8") : "";

    // The skyrina function itself crashed (unhandled error, timeout, etc.).
    if (result.FunctionError) {
      throw new Error(`AWS ${path} -> Lambda error (${result.FunctionError}) ${raw}`.trim());
    }

    const out = raw ? JSON.parse(raw) : {};
    const status = out.statusCode || 500;
    const body = out.isBase64Encoded && out.body
      ? Buffer.from(out.body, "base64").toString("utf8")
      : out.body;

    if (status < 200 || status >= 300) {
      throw new Error(`AWS ${path} -> ${status} ${body || ""}`.trim());
    }
    return body ? JSON.parse(body) : {};
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`AWS ${path} timed out after ${AWS_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Prefer the RH-adjusted final amount when set, else the calculated one.
function effectiveBonus(m) {
  return m.monto_final_mxn != null ? m.monto_final_mxn : (m.monto_bono_mxn || 0);
}

// --- Registration -------------------------------------------------------

/**
 * Registers GET /api/mechanics-summary on the given Express app.
 * @param {import('express').Express} app
 * @param {import('express').RequestHandler} authenticateToken  reuse your existing middleware
 */
module.exports = function registerMechanicsSummary(app, authenticateToken) {
  if (!MECHANICS_FUNCTION_NAME) {
    console.warn(
      "⚠️  mechanics-summary: MECHANICS_FUNCTION_NAME not set — /api/mechanics-summary will return 500 until configured."
    );
  }

  app.get("/api/mechanics-summary", authenticateToken, async (req, res) => {
    try {
      if (!MECHANICS_FUNCTION_NAME) {
        return res.status(500).json({
          success: false,
          error: "AWS integration not configured (missing MECHANICS_FUNCTION_NAME).",
        });
      }

      // Period selector: ?tipo=semana|mes|anio & ?valor=...
      // Back-compat: a bare ?semana=YYYY-MM-DD still works (treated as tipo=semana).
      let tipo = (req.query.tipo || "semana").toLowerCase();
      let valor = req.query.valor;

      if (tipo === "semana") {
        // ---- WEEK VIEW (unchanged behavior) -------------------------------
        const semana =
          isValidWeek(valor) ? valor
          : isValidWeek(req.query.semana) ? req.query.semana
          : currentWeekMonday();

        // Fire all AWS calls in parallel.
        const [bonos, supervisor, perf] = await Promise.all([
          awsGet(`/rh/bonos/semana/${semana}`),
          awsGet(`/supervisor/dashboard/stats`),
          awsGet(`/supervisor/mechanics/performance`),
        ]);

        const mecanicos = Array.isArray(bonos.mecanicos) ? bonos.mecanicos : [];
        const stats = supervisor.stats || {};

        // Per-mechanic performance, keyed by id for merging.
        // NOTE: avg_resolution_minutes here is ALL-TIME (across every ticket the
        // mechanic has closed), not just the selected week — the weekly bono route
        // doesn't expose a per-mechanic time. Labelled accordingly in the UI.
        const perfById = {};
        for (const p of Array.isArray(perf.mechanics) ? perf.mechanics : []) {
          perfById[p.mecanico_id] = p;
        }

        const mechanics = mecanicos.map((m) => ({
          id: m.id,
          name: m.nombre,
          location: m.asignacion,
          ticketsAssigned: m.tickets_asignados,
          ticketsClosed: m.tickets_cerrados,
          bonusMxn: effectiveBonus(m),
          bonusCalculatedMxn: m.monto_bono_mxn,
          bonusFinalMxn: m.monto_final_mxn,
          bonusPct: m.bono_pct,
          avgCloseMinutes: perfById[m.id]?.avg_resolution_minutes ?? null, // all-time avg
          delayedTickets: perfById[m.id]?.delayed_tickets ?? null,         // all-time delayed
        }));

        const totalBonusAllMechanics = mechanics.reduce((sum, m) => sum + (m.bonusMxn || 0), 0);

        return res.json({
          success: true,
          tipo: "semana",
          valor: semana,
          semana,                                   // kept for back-compat
          periodLabel: semana,
          avgCloseScope: "historico",               // all-time avg close time
          weekBonoClosed: bonos.cerrado === true,
          global: {
            ticketsCreated: stats.totalTickets,
            ticketsClosed: stats.closedTickets,
            activeTickets: stats.activeTickets,
            pendingValidation: stats.pendingValidation,
            avgClosingMinutes: stats.avgClosing,
            totalBonusAllMechanics,
          },
          mechanics,
        });
      }

      // ---- MONTH / YEAR VIEW (new period rollup) --------------------------
      if (tipo !== "mes" && tipo !== "anio") {
        return res.status(400).json({ success: false, error: "tipo inválido (usa semana | mes | anio)." });
      }
      if (tipo === "mes" && !isValidMonth(valor)) {
        return res.status(400).json({ success: false, error: "valor inválido para mes (usa YYYY-MM)." });
      }
      if (tipo === "anio" && !isValidYear(valor)) {
        return res.status(400).json({ success: false, error: "valor inválido para año (usa YYYY)." });
      }

      // The periodo route gives period-scoped tickets + summed weekly bonus.
      // Supervisor stats supplies only the live "activos / por validar" snapshot,
      // which is inherently a right-now number (not period-scoped).
      const [periodo, supervisor] = await Promise.all([
        awsGet(`/rh/bonos/periodo/${tipo}/${valor}`),
        awsGet(`/supervisor/dashboard/stats`),
      ]);

      const mecanicos = Array.isArray(periodo.mecanicos) ? periodo.mecanicos : [];
      const stats = supervisor.stats || {};
      const pg = periodo.global || {};

      const mechanics = mecanicos.map((m) => ({
        id: m.id,
        name: m.nombre,
        location: m.asignacion,
        ticketsAssigned: m.tickets_asignados,        // created in period
        ticketsClosed: m.tickets_cerrados,           // closed in period
        bonusMxn: effectiveBonus(m),                 // summed weekly effective
        bonusCalculatedMxn: m.monto_calculado_mxn,   // summed weekly calculated
        bonusFinalMxn: m.monto_final_mxn,            // summed weekly final (null if none set)
        bonusPct: m.bono_pct,                        // avg weekly %
        avgCloseMinutes: m.avg_resolution_minutes ?? null, // avg within period
        delayedTickets: m.delayed_tickets ?? null,         // delayed within period
      }));

      return res.json({
        success: true,
        tipo,
        valor,
        desde: periodo.desde,
        hasta: periodo.hasta,
        periodLabel: valor,
        avgCloseScope: "periodo",                    // period-scoped avg close time
        weekBonoClosed: false,                        // not applicable for month/year
        bonusWeeksConfirmed: pg.semanas_confirmadas ?? null,
        bonusWeeksOpen: pg.semanas_abiertas ?? null,  // open weeks NOT counted in bonus
        global: {
          ticketsCreated: pg.tickets_creados,
          ticketsClosed: pg.tickets_cerrados,
          activeTickets: stats.activeTickets,          // live snapshot
          pendingValidation: stats.pendingValidation,  // live snapshot
          avgClosingMinutes: pg.avg_closing_minutes,
          totalBonusAllMechanics: pg.total_bono_mxn,
        },
        mechanics,
      });
    } catch (err) {
      console.error("❌ /api/mechanics-summary error:", err.message);
      return res.status(502).json({
        success: false,
        error: "Failed to fetch data from AWS backend.",
        detail: err.message,
      });
    }
  });
};