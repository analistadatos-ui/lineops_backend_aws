// ==========================================================================
// verificador-activity.js
//
// Bitácora de lo que hace el Verificador, para avisar al CEO:
//   • "correction"       -> cambió cantidades en "Corrección de producción"
//   • "report_download"  -> descargó el Excel de "Reportes semanas bloqueadas"
//
// Rutas (panel CEO):
//   GET  /api/ceo/verificador-activity?limit=30
//        -> { items, unread, lastSeenAt }   (items[].unread por usuario)
//   POST /api/ceo/verificador-activity/:id/seen
//        -> marca UN aviso como visto (botón "Entendido")
//   POST /api/ceo/verificador-activity/seen
//        -> marca TODO como visto PARA ESE USUARIO
// Lo visto se guarda en la base por usuario, así el aviso no reaparece si el
// CEO entra desde otro equipo.
//
// Helpers para otros módulos:
//   logCorrection(client, { runId, user, changes })
//   logReportDownload(client, { user, week, filters, rows, totals })
// Ambos crean las tablas solas la primera vez (no hace falta initSchema, y
// funciona igual en Lambda con RUN_MIGRATIONS=false). Si fallan, solo lo
// registran en consola: la corrección o la descarga del usuario NUNCA se cae
// por culpa de la bitácora.
//
// --------------------------------------------------------------------------
// SETUP (server.js) — no depende de requireVerificador, va junto a los otros
// módulos (por ejemplo debajo de registerEfficiencyPermission):
//
//     const verificadorActivity = require("./verificador-activity");
//     verificadorActivity(app, { authenticateToken, pool, setSchema });
//
// y en POST /api/verificador/update-sewed/:runId, ver CAMBIOS-server.md.
// ==========================================================================

// Quién recibe los avisos. El Factory Director entra como "master".
const CEO_ROLES = ["master", "skyrina", "admin", "ceo"];

// Mismas palabras clave que PACKING_KEYWORDS en work-orders.js: un cambio en
// estas operaciones cambia lo PRODUCIDO de la orden.
const PACKING_KEYWORDS = ["pack", "emp", "termin", "finish"];
const isPacking = (name) => {
  const n = String(name || "").toLowerCase();
  return PACKING_KEYWORDS.some((k) => n.includes(k));
};

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const shortDate = (s) => {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : String(s || "");
};
const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const userName = (u) => u?.full_name || u?.username || null;

// ------------------------------------------------------------------ schema --
let schemaReady = null;
async function ensureSchema(client) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS verificador_activity(
          id BIGSERIAL PRIMARY KEY,
          action VARCHAR(30) NOT NULL,
          user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
          user_name TEXT,
          run_id BIGINT,
          line_no TEXT,
          run_date DATE,
          style TEXT,
          work_order_no VARCHAR(80),
          summary TEXT NOT NULL,
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_verificador_activity_created ON verificador_activity(created_at DESC);"
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS verificador_activity_reads(
          user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      // Vistos uno por uno ("Entendido" en un aviso).
      await client.query(`
        CREATE TABLE IF NOT EXISTS verificador_activity_acks(
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          activity_id BIGINT NOT NULL REFERENCES verificador_activity(id) ON DELETE CASCADE,
          seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, activity_id)
        );
      `);
    })().catch((e) => {
      schemaReady = null; // reintentar en la siguiente llamada
      throw e;
    });
  }
  await schemaReady;
}

async function insertActivity(client, a) {
  await ensureSchema(client);
  await client.query(
    `INSERT INTO verificador_activity
       (action, user_id, user_name, run_id, line_no, run_date, style, work_order_no, summary, details)
     VALUES ($1, $2,
             COALESCE($3, (SELECT COALESCE(NULLIF(TRIM(full_name), ''), username) FROM users WHERE id = $2)),
             $4, $5, $6::date, $7, $8, $9, $10::jsonb)`,
    [
      a.action, a.userId ?? null, a.userName ?? null,
      a.runId ?? null, a.lineNo ?? null, a.runDate ?? null, a.style ?? null, a.workOrderNo ?? null,
      a.summary, JSON.stringify(a.details || {}),
    ]
  );
}

// ---------------------------------------------------------------- helpers --
// changes: [{ operatorNo, operationName, slotLabel, from, to }] — solo celdas
// cuyo valor CAMBIÓ. Sin cambios no se registra nada.
async function logCorrection(client, { runId, user, changes }) {
  try {
    const list = (changes || []).filter((c) => num(c.from) !== num(c.to));
    if (!list.length) return null;

    const r = await client.query(
      `SELECT lr.id, lr.line_no, to_char(lr.run_date, 'YYYY-MM-DD') AS run_date, lr.style,
              wo.work_order_no, wo.customer_name
         FROM line_runs lr
         LEFT JOIN work_orders wo ON wo.id = lr.work_order_id
        WHERE lr.id = $1`,
      [runId]
    );
    const run = r.rows[0] || {};

    const packingDelta = list
      .filter((c) => isPacking(c.operationName))
      .reduce((s, c) => s + (num(c.to) - num(c.from)), 0);
    const totalDelta = list.reduce((s, c) => s + (num(c.to) - num(c.from)), 0);

    const where = [
      run.line_no != null ? `Línea ${run.line_no}` : null,
      run.run_date ? shortDate(run.run_date) : null,
      run.style ? `${run.style}${run.work_order_no ? ` (${run.work_order_no})` : ""}` : null,
    ].filter(Boolean).join(" · ");
    const summary =
      `Corrigió producción · ${where}: ${list.length} celda(s)` +
      (packingDelta !== 0 ? `, producido ${signed(packingDelta)} pzas` : "");

    await insertActivity(client, {
      action: "correction",
      userId: user?.id,
      userName: userName(user),
      runId,
      lineNo: run.line_no,
      runDate: run.run_date,
      style: run.style,
      workOrderNo: run.work_order_no,
      summary,
      details: {
        customer: run.customer_name || null,
        cells: list.length,
        packing_delta: packingDelta,
        total_delta: totalDelta,
        // Se guardan hasta 200 celdas; de sobra para una corrida.
        changes: list.slice(0, 200).map((c) => ({
          operator: c.operatorNo,
          operation: c.operationName,
          slot: c.slotLabel,
          from: num(c.from),
          to: num(c.to),
          packing: isPacking(c.operationName),
        })),
      },
    });
    return true;
  } catch (e) {
    console.warn("⚠️  verificador-activity logCorrection falló (la corrección sí se guardó):", e.message);
    return null;
  }
}

async function logReportDownload(client, { user, week, filters, rows, totals }) {
  try {
    const who = filters?.customer || "todos los clientes";
    const st = filters?.style ? ` · estilo ${filters.style}` : "";
    const summary =
      `Descargó reporte Excel · Semana ${week.iso_week} (${shortDate(week.week_start)} – ${shortDate(week.week_end)})` +
      ` · ${who}${st} · ${rows} corrida(s)`;
    await insertActivity(client, {
      action: "report_download",
      userId: user?.id,
      userName: userName(user),
      runDate: week.week_start,
      style: filters?.style || null,
      summary,
      details: {
        week_start: week.week_start,
        week_end: week.week_end,
        iso_week: week.iso_week,
        customer: filters?.customer || null,
        style: filters?.style || null,
        rows,
        produced: totals?.produced ?? null,
        target: totals?.target ?? null,
      },
    });
    return true;
  } catch (e) {
    console.warn("⚠️  verificador-activity logReportDownload falló (la descarga sí se hizo):", e.message);
    return null;
  }
}

// ----------------------------------------------------------------- routes --
function registerVerificadorActivity(app, { authenticateToken, pool, setSchema }) {
  const requireCeo = (req, res, next) => {
    const roles = [req.user?.role, req.user?.actual_role].filter(Boolean);
    if (!roles.some((r) => CEO_ROLES.includes(r))) {
      return res.status(403).json({ success: false, error: "Access denied." });
    }
    next();
  };

  app.get("/api/ceo/verificador-activity", authenticateToken, requireCeo, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      await ensureSchema(client);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 200);

      const seen = await client.query(
        "SELECT last_seen_at FROM verificador_activity_reads WHERE user_id = $1",
        [req.user.id]
      );
      const lastSeenAt = seen.rows[0]?.last_seen_at || null;

      // Sin ver = posterior al último "marcar todo" Y sin "Entendido" propio.
      const UNREAD_SQL = `(a.created_at > COALESCE($2::timestamptz, '-infinity'::timestamptz)
                           AND NOT EXISTS (SELECT 1 FROM verificador_activity_acks k
                                            WHERE k.activity_id = a.id AND k.user_id = $3::bigint))`;
      const { rows } = await client.query(
        `SELECT a.id, a.action, a.user_name, a.run_id, a.line_no,
                to_char(a.run_date, 'YYYY-MM-DD') AS run_date, a.style, a.work_order_no,
                a.summary, a.details, a.created_at,
                ${UNREAD_SQL} AS unread
           FROM verificador_activity a
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT $1`,
        [limit, lastSeenAt, req.user.id]
      );
      const unread = await client.query(
        // $1 no se usa aquí; se pasa para que UNREAD_SQL conserve $2/$3.
        `SELECT COUNT(*)::int AS n FROM verificador_activity a WHERE $1::int = 0 AND ${UNREAD_SQL}`,
        [0, lastSeenAt, req.user.id]
      );

      res.json({ success: true, items: rows, unread: unread.rows[0].n, lastSeenAt });
    } catch (err) {
      console.error("❌ /api/ceo/verificador-activity error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  app.post("/api/ceo/verificador-activity/:id/seen", authenticateToken, requireCeo, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: "id inválido" });
    const client = await pool.connect();
    try {
      await setSchema(client);
      await ensureSchema(client);
      await client.query(
        `INSERT INTO verificador_activity_acks (user_id, activity_id)
         SELECT $1::bigint, id FROM verificador_activity WHERE id = $2::bigint
         ON CONFLICT DO NOTHING`,
        [req.user.id, id]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("❌ /api/ceo/verificador-activity/:id/seen error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  app.post("/api/ceo/verificador-activity/seen", authenticateToken, requireCeo, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      await ensureSchema(client);
      await client.query(
        `INSERT INTO verificador_activity_reads (user_id, last_seen_at) VALUES ($1, now())
         ON CONFLICT (user_id) DO UPDATE SET last_seen_at = now()`,
        [req.user.id]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("❌ /api/ceo/verificador-activity/seen error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });
}

registerVerificadorActivity.logCorrection = logCorrection;
registerVerificadorActivity.logReportDownload = logReportDownload;
module.exports = registerVerificadorActivity;