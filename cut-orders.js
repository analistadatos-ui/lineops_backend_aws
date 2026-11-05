// cut-orders.js
//
// Órdenes de corte (simple): PO + tela + fecha + cantidad total.
// Mirrors the work-orders.js module pattern.
//
// WIRING in server.js — one require, one initSchema, one register call,
// placed right next to the equivalent work-orders lines:
//
//   1. Near the other requires (where work-orders is required):
//        const registerCutOrders = require("./cut-orders");
//
//   2. In the async startup block, next to registerWorkOrders.initSchema:
//        await registerCutOrders.initSchema({ pool, setSchema });
//
//   3. Next to the registerWorkOrders(app, {...}) call:
//        registerCutOrders(app, { authenticateToken, pool, setSchema });
//
// ---------------------------------------------------------------------------

async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cut_orders(
        id BIGSERIAL PRIMARY KEY,
        work_order_id BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
        fabric VARCHAR(150),
        cut_date DATE NOT NULL,
        quantity NUMERIC(12,2) NOT NULL,
        notes TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_cut_qty_positive CHECK (quantity > 0),
        CONSTRAINT chk_cut_status CHECK (status IN ('pending','in_progress','completed','cancelled'))
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_cut_orders_wo ON cut_orders(work_order_id);");
    // yield (fabric per piece) and the resulting total fabric length
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS yield_per_piece NUMERIC(10,4);`);
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS total_length NUMERIC(14,2);`);
    // cutting progress (filled by the cutter)
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS panels INT;`);
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS amount_cut NUMERIC(12,2);`);
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS remaining_to_cut NUMERIC(12,2);`);
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS color VARCHAR(50);`);
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS fabric_code VARCHAR(60);`);
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS sizes JSONB;`);
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS size_progress JSONB;`);
    // marcadas / trazos: [{ id, name, panels, piecesPerPanel, totalPieces, lines:[{talla, perPanel, pieces}] }]
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS markers JSONB;`);
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS style_no VARCHAR(50);`);
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS season VARCHAR(50);`);
    // Todas las telas del corte: [{ name, code, yield, totalLength }]. Una CORTE
    // puede llevar VARIAS telas que se cortan en la MISMA cantidad de piezas.
    // fabric/fabric_code/yield_per_piece/total_length quedan como representativos
    // (primera tela) para las vistas antiguas.
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS fabrics JSONB NOT NULL DEFAULT '[]'::jsonb;`);
    // Prioridad fijada por el planner: 'urgent' (rojo), 'intermediate' (amarillo),
    // 'normal' (verde). El dashboard de corte ordena por prioridad y luego por fecha.
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'normal';`);
    // Verificación del corte (supervisor). Mientras verified_at esté vacío el
    // corte NO está terminado, por más que el cortador haya capturado todas las
    // piezas: sólo /verify pone status = 'completed'.
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;`);
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS verified_by VARCHAR(100);`);
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS verification_notes TEXT;`);
    // 'awaiting_verification' son 21 caracteres y la columna nació VARCHAR(20):
    // sin este ALTER, guardar el estado nuevo truena con "value too long for
    // type character varying(20)" (500 en PATCH /:id/cutting).
    await client.query(`ALTER TABLE cut_orders ALTER COLUMN status TYPE VARCHAR(30);`);
    // El CHECK original no conocía 'awaiting_verification'; se reemplaza para
    // dejar pasar el nuevo estado intermedio.
    await client.query(`
      ALTER TABLE cut_orders DROP CONSTRAINT IF EXISTS chk_cut_status;
    `);
    await client.query(`
      ALTER TABLE cut_orders
        ADD CONSTRAINT chk_cut_status
        CHECK (status IN ('pending','in_progress','awaiting_verification','completed','cancelled'));
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_cut_priority'
        ) THEN
          ALTER TABLE cut_orders
            ADD CONSTRAINT chk_cut_priority
            CHECK (priority IN ('urgent','intermediate','normal'));
        END IF;
      END $$;
    `);
    // ── AGRUPACIÓN DE CORTES ─────────────────────────────────────────────
    // Varias CORTES compatibles (mismo estilo + misma tela, o mismo item code
    // de Nike) se planean juntas: el planner arma UNA serie de marcadas sobre
    // la suma de tallas y al guardar se reparten los paneles entre las órdenes.
    // cut_groups.markers guarda el plan del grupo; cada cut_orders.markers
    // recibe su parte, así verificación, tickets y dashboard siguen igual.
    await client.query(`
      CREATE TABLE IF NOT EXISTS cut_groups(
        id BIGSERIAL PRIMARY KEY,
        group_by VARCHAR(20) NOT NULL DEFAULT 'style_fabric',
        group_key TEXT,
        markers JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_by VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_cut_group_by CHECK (group_by IN ('style_fabric','item_code'))
      );
    `);
    await client.query(`ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS cut_group_id BIGINT REFERENCES cut_groups(id) ON DELETE SET NULL;`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_cut_orders_group ON cut_orders(cut_group_id);");
    console.log("✅ cut_orders table ready in prod_db_schema");
  } finally {
    client.release();
  }
}

// SELECT base de una CORTE con los datos de su orden de trabajo. Lo usan el
// listado y la agrupación (para validar compatibilidad con los mismos datos
// que ve el planner).
const CUT_ORDER_SELECT = `
        SELECT co.id,
               co.work_order_id,
               co.fabric,
               co.fabric_code,
               co.fabrics,
               to_char(co.cut_date, 'YYYY-MM-DD') AS cut_date,
               co.quantity,
               co.yield_per_piece,
               co.total_length,
               co.panels,
               co.amount_cut,
               co.remaining_to_cut,
               co.sizes,
               co.size_progress,
               co.markers,
               co.notes,
               co.status,
               co.verified_at,
               co.verified_by,
               co.verification_notes,
               co.cut_group_id,
               COALESCE(co.priority, 'normal') AS priority,
               co.created_at,
               wo.work_order_no,
               wo.customer_name,
               wo.customer_po,
               wo.style_description,
               wo.style_code,
               wo.estilo,
               mc.code AS master_code,
               -- "tipo modelo correlativo": e.g. DAM+CHA+01 -> DAMCHA01
               NULLIF(CONCAT(mc.type, mc.modelo, mc.correlativo), '') AS modelo_code,
               COALESCE(co.color, wo.color) AS color,
               COALESCE(co.style_no, wo.style_code) AS style_no,
               COALESCE(co.season, wo.season) AS season,
               -- Distinct telas (name+code+yield) across the work order's lines.
               -- The scalar co.fabric_code is just ONE of these; the cutter picks
               -- the código they are actually cutting inside CuttingEntry.
               COALESCE((
                 SELECT jsonb_agg(fab ORDER BY (fab->>'name'), (fab->>'code'))
                   FROM (
                     SELECT DISTINCT ON (upper(f->>'name'), upper(COALESCE(f->>'code','')))
                            f AS fab
                       FROM work_order_lines wl
                       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(wl.fabrics, '[]'::jsonb)) AS f
                      WHERE wl.work_order_id = wo.id
                        AND COALESCE(f->>'name','') <> ''
                      ORDER BY upper(f->>'name'), upper(COALESCE(f->>'code','')), (f->>'yield')
                   ) d
               ), '[]'::jsonb) AS wo_fabrics,
               -- Item codes (Nike) de las líneas de la orden para el color del corte.
               COALESCE((
                 SELECT jsonb_agg(DISTINCT UPPER(TRIM(wl.item_code)))
                   FROM work_order_lines wl
                  WHERE wl.work_order_id = wo.id
                    AND COALESCE(TRIM(wl.item_code), '') <> ''
                    AND (COALESCE(TRIM(co.color), '') = ''
                         OR UPPER(TRIM(wl.color)) = UPPER(TRIM(co.color)))
               ), '[]'::jsonb) AS item_codes
          FROM cut_orders co
          JOIN work_orders wo ON wo.id = co.work_order_id
          LEFT JOIN master_codes mc ON mc.id = wo.master_code_id
`;

// ── Agrupación: reglas de compatibilidad ───────────────────────────────────
// (Las mismas reglas viven en CutPlanning.jsx para habilitar las casillas.)
//   style_fabric → mismo estilo y MISMO juego de telas (códigos).
//   item_code    → mismo item code (Nike). La CORTE debe tener un solo item code.
const up = (v) => String(v ?? "").trim().toUpperCase();
const asArr = (v) => (Array.isArray(v) ? v : []);
const cutStyleKey = (r) => up(r.modelo_code || r.style_no || r.style_code || r.estilo);
const cutFabricKey = (r) => {
  const raw = asArr(r.fabrics).length ? asArr(r.fabrics) : asArr(r.wo_fabrics);
  let codes = raw.map((f) => up(f?.code) || up(f?.name)).filter(Boolean);
  if (!codes.length) codes = [up(r.fabric_code) || up(r.fabric)].filter(Boolean);
  return [...new Set(codes)].sort().join("+");
};
const cutItemCode = (r) => {
  const ics = [...new Set(asArr(r.item_codes).map(up).filter(Boolean))];
  return ics.length === 1 ? ics[0] : "";
};
const cutGroupKey = (r, by) => {
  if (by === "item_code") {
    const ic = cutItemCode(r);
    return ic ? `IC:${ic}` : null;
  }
  const st = cutStyleKey(r);
  const fb = cutFabricKey(r);
  return st && fb ? `${st}|${fb}` : null;
};
const hasDoneMarker = (markers, onlyIds = null) =>
  asArr(markers).some((m) => m && m.done && (!onlyIds || onlyIds.has(m.id)));
const sumMarkerPanels = (markers) =>
  asArr(markers).reduce((s, m) => s + (parseInt(m?.panels) || 0), 0);

// Quién puede firmar la verificación del corte. Ajusta a los roles reales de
// tu tabla de usuarios si el nombre difiere.
const VERIFIER_ROLES = ["supervisor", "master", "admin", "skyrina", "soporte_it","corte"];

// Nombre que queda sellado en verified_by; el payload del token varía según el
// login, así que tomamos el primero que exista.
function verifierName(user) {
  return user?.username || user?.name || user?.email || (user?.id != null ? String(user.id) : null);
}

/**
 * Registers the cut-order routes on the given Express app.
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {import('express').RequestHandler} deps.authenticateToken
 * @param {import('pg').Pool} deps.pool
 * @param {(client: any) => Promise<void>} deps.setSchema
 */
// Solicitudes de corte (cut-order-requests.js): al crear un corte se cierra la
// solicitud pendiente de esa orden+color. Opcional: sin el módulo, no pasa nada.
let fulfillPendingRequests = null;
try { ({ fulfillPendingRequests } = require("./cut-order-requests")); } catch (_) { fulfillPendingRequests = null; }

function registerCutOrders(app, { authenticateToken, pool, setSchema }) {
  // List all cut orders (newest first), with work-order info joined in.
  app.get("/api/cut-orders", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const result = await client.query(`${CUT_ORDER_SELECT}
         ORDER BY co.created_at DESC
      `);
      res.json({ success: true, cutOrders: result.rows });
    } catch (err) {
      console.error("❌ Error fetching cut orders:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // Create a cut order.
  app.post("/api/cut-orders", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { workOrderId, fabric, fabricCode, cutDate, quantity, notes, yieldPerPiece, color, sizes, styleNo, season, fabrics, priority, allowExtra } = req.body;

      const VALID_PRIORITIES = ["urgent", "intermediate", "normal"];
      const priorityFinal = VALID_PRIORITIES.includes(priority) ? priority : "normal";

      if (!workOrderId || !cutDate || !quantity || parseFloat(quantity) <= 0) {
        return res.status(400).json({
          success: false,
          error: "workOrderId, cutDate y una cantidad positiva son obligatorios",
        });
      }

      const qty = parseFloat(quantity);

      const y = yieldPerPiece === undefined || yieldPerPiece === null || yieldPerPiece === ""
        ? null
        : parseFloat(yieldPerPiece);
      if (y !== null && (isNaN(y) || y <= 0)) {
        return res.status(400).json({ success: false, error: "El rendimiento debe ser mayor a 0" });
      }

      // Todas las telas del corte. Cada una lleva su propio rendimiento y su
      // largo total (rendimiento × piezas); las piezas son las mismas para todas.
      const toNum = (v) => (v === undefined || v === null || v === "" ? null : (isNaN(parseFloat(v)) ? null : parseFloat(v)));
      const fabricsArr = (Array.isArray(fabrics) ? fabrics : [])
        .map((f) => {
          const name = (f?.name ?? "").toString().trim();
          const code = (f?.code ?? "").toString().trim();
          const fy = toNum(f?.yield);
          return { name, code, yield: fy, totalLength: fy != null ? fy * qty : null };
        })
        .filter((f) => f.name || f.code);

      // Representativos (primera tela) para las columnas escalares / vistas antiguas.
      const repName = (fabric || fabricsArr[0]?.name || null) || null;
      const repCode = (fabricCode || fabricsArr[0]?.code || null) || null;
      const repYield = y != null ? y : (fabricsArr[0]?.yield ?? null);
      // Largo total del encabezado: suma de las telas si traen rendimiento; si no,
      // el cálculo simple con el rendimiento compartido.
      const sumLen = fabricsArr.reduce((s, f) => s + (f.totalLength || 0), 0);
      const totalLength = sumLen > 0 ? sumLen : (repYield != null ? repYield * qty : null);

      // ── ANTI-DUPLICADO ────────────────────────────────────────────────────
      // Transacción + candado por (orden, color): dos clics, dos pestañas o dos
      // planners a la vez quedan en fila; el segundo ya ve el corte del primero.
      // Regla: lo activo (no cancelado) de esa orden+color + lo nuevo no puede
      // pasar las piezas del color. Si se rebasa → 409 con lo que ya existe.
      // allowExtra:true (confirmado por el planner en pantalla) permite un
      // recorte adicional a propósito.
      await client.query("BEGIN");
      const colorKey = String(color || "").trim().toUpperCase();
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cut|${parseInt(workOrderId)}|${colorKey}`]);

      const wo = await client.query(
        "SELECT id, style_code, season, work_order_no, total_to_produce, quantity FROM work_orders WHERE id = $1",
        [parseInt(workOrderId)]
      );
      if (wo.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, error: "Work order not found" });
      }

      // Piezas del color (de las líneas de la orden); sin líneas, el total de la orden.
      const lineQty = await client.query(
        `SELECT COUNT(*)::int AS n,
                COALESCE(SUM(quantity) FILTER (WHERE UPPER(TRIM(color)) = $2), 0) AS color_qty,
                COALESCE(SUM(quantity), 0) AS all_qty
           FROM work_order_lines WHERE work_order_id = $1`,
        [parseInt(workOrderId), colorKey]
      );
      const lq = lineQty.rows[0];
      const woTotal = Number(wo.rows[0].total_to_produce) || Number(wo.rows[0].quantity) || 0;
      const limit = lq.n > 0 ? (colorKey ? Number(lq.color_qty) : Number(lq.all_qty)) : woTotal;

      const existing = await client.query(
        `SELECT id, quantity, status, to_char(cut_date, 'YYYY-MM-DD') AS cut_date
           FROM cut_orders
          WHERE work_order_id = $1
            AND UPPER(TRIM(COALESCE(color, ''))) = $2
            AND status <> 'cancelled'
          ORDER BY id`,
        [parseInt(workOrderId), colorKey]
      );
      const alreadyCut = existing.rows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
      const remaining = Math.max(limit - alreadyCut, 0);
      if (limit > 0 && alreadyCut + qty > limit + 0.001 && allowExtra !== true) {
        await client.query("ROLLBACK");
        const list = existing.rows.map((r) => `CORTE-${String(r.id).padStart(4, "0")}`).join(", ");
        return res.status(409).json({
          success: false,
          code: "CUT_DUPLICATE",
          error: remaining <= 0
            ? `${wo.rows[0].work_order_no}${colorKey ? ` color ${colorKey}` : ""} ya tiene corte completo (${list}).`
            : `${wo.rows[0].work_order_no}${colorKey ? ` color ${colorKey}` : ""} solo tiene ${Math.round(remaining)} pzas por asignar (ya en corte: ${list}).`,
          remaining,
          existing: existing.rows,
        });
      }
      const styleNoFinal = styleNo || wo.rows[0].style_code || null;
      const seasonFinal = season || wo.rows[0].season || null;

      const result = await client.query(
        `INSERT INTO cut_orders (work_order_id, fabric, fabric_code, cut_date, quantity, notes, yield_per_piece, total_length, color, sizes, style_no, season, fabrics, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14)
         RETURNING *`,
        [parseInt(workOrderId), repName, repCode, cutDate, qty, notes || null, repYield, totalLength, color || null,
         Array.isArray(sizes) && sizes.length ? JSON.stringify(sizes) : null, styleNoFinal, seasonFinal,
         JSON.stringify(fabricsArr), priorityFinal]
      );
      // Cierra la solicitud de corte pendiente (si la había) en la MISMA transacción.
      let fulfilledRequests = 0;
      if (fulfillPendingRequests) {
        fulfilledRequests = await fulfillPendingRequests(client, {
          workOrderId, color, cutOrderId: result.rows[0].id, user: req.user,
        });
      }
      await client.query("COMMIT");
      res.json({ success: true, cutOrder: result.rows[0], fulfilledRequests });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("❌ Error creating cut order:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // Record cutting progress: panels, amount cut, and remaining to cut.
  // Terminar de cortar NO cierra la orden: la manda a 'awaiting_verification'.
  // Sólo PATCH /:id/verify la deja en 'completed'.
  app.patch("/api/cut-orders/:id/cutting", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { panels, amountCut, remainingToCut, sizeProgress, markers } = req.body;

      // Marcadas (trazos): each groups sizes and carries its own panel count.
      const mk = Array.isArray(markers) ? markers : null;

      // Per-size progress (talla, quantity, panels, amountCut, remaining).
      let sp = Array.isArray(sizeProgress) ? sizeProgress : null;
      let p, cut, rem;
      if (sp && sp.length > 0) {
        // Panels: from the marcadas when present (a panel serves several sizes,
        // so summing the per-size rows would double count it).
        p = mk && mk.length
          ? mk.reduce((s, m) => s + (parseInt(m.panels) || 0), 0)
          : sp.reduce((s, r) => s + (parseInt(r.panels) || 0), 0);
        cut = sp.reduce((s, r) => s + (parseFloat(r.amountCut) || 0), 0);
        rem = sp.reduce((s, r) => {
          const q = parseFloat(r.quantity) || 0;
          const c = parseFloat(r.amountCut) || 0;
          const rr = r.remaining != null && r.remaining !== "" ? parseFloat(r.remaining) : Math.max(q - c, 0);
          return s + (isNaN(rr) ? 0 : rr);
        }, 0);
      } else {
        p = panels === undefined || panels === null || panels === "" ? null : parseInt(panels);
        cut = amountCut === undefined || amountCut === null || amountCut === "" ? null : parseFloat(amountCut);
        rem = remainingToCut === undefined || remainingToCut === null || remainingToCut === "" ? null : parseFloat(remainingToCut);
      }

      if (cut !== null && (isNaN(cut) || cut < 0)) {
        return res.status(400).json({ success: false, error: "Cantidad cortada inválida" });
      }
      if (rem !== null && (isNaN(rem) || rem < 0)) {
        return res.status(400).json({ success: false, error: "Restante por cortar inválido" });
      }
      if (p !== null && (isNaN(p) || p < 0)) {
        return res.status(400).json({ success: false, error: "N° de paneles inválido" });
      }

      // Status: cortado todo -> a verificación; si falta algo, sigue en proceso.
      // Si la llamada sólo trae marcadas (el planner armando trazos, sin cifras
      // de corte), NO se toca el status: planear no es empezar a cortar.
      const touchedCutting = (sp && sp.length > 0) || cut !== null || rem !== null;
      const newStatus = !touchedCutting
        ? null
        : rem !== null && rem <= 0 ? "awaiting_verification" : "in_progress";

      const result = await client.query(
        `UPDATE cut_orders
            SET panels = COALESCE($1, panels),
                amount_cut = COALESCE($2, amount_cut),
                remaining_to_cut = COALESCE($3, remaining_to_cut),
                size_progress = COALESCE($4::jsonb, size_progress),
                markers = COALESCE($5::jsonb, markers),
                status = COALESCE($6::varchar, status),
                updated_at = now()
          WHERE id = $7
          RETURNING *`,
        [p, cut, rem, sp ? JSON.stringify(sp) : null, mk ? JSON.stringify(mk) : null, newStatus, parseInt(req.params.id)]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Cut order not found" });
      }
      res.json({ success: true, cutOrder: result.rows[0] });
    } catch (err) {
      console.error("❌ Error saving cutting progress:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // Update a cut order's status.
  app.patch("/api/cut-orders/:id/status", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { status } = req.body;
      if (!["pending", "in_progress", "awaiting_verification", "completed", "cancelled"].includes(status)) {
        return res.status(400).json({ success: false, error: "Estado inválido" });
      }
      // 'completed' es la salida de la verificación, no un estado que se pueda
      // fijar a mano — si no, cualquier pantalla podría saltarse al supervisor.
      if (status === "completed") {
        return res.status(400).json({
          success: false,
          error: "Una orden sólo se termina al verificarla: usa PATCH /api/cut-orders/:id/verify",
        });
      }
      // Regresar la orden a corte anula la verificación anterior.
      const result = await client.query(
        `UPDATE cut_orders
            SET status             = $1,
                verified_at        = NULL,
                verified_by        = NULL,
                verification_notes = NULL,
                updated_at         = now()
          WHERE id = $2
          RETURNING *`,
        [status, parseInt(req.params.id)]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Cut order not found" });
      }
      res.json({ success: true, cutOrder: result.rows[0] });
    } catch (err) {
      console.error("❌ Error updating cut order:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // Verificación del corte. Único camino a 'completed'.
  //   { approved: true }                 -> terminada, con sello de quién y cuándo
  //   { approved: false, notes: "..." }  -> regresa a corte con el motivo
  app.patch("/api/cut-orders/:id/verify", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);

      if (!VERIFIER_ROLES.includes(req.user?.role)) {
        return res.status(403).json({ success: false, error: "Sólo el supervisor puede verificar el corte" });
      }

      const approved = req.body.approved !== false;
      const notes = (req.body.notes || "").toString().trim() || null;

      if (!approved && !notes) {
        return res.status(400).json({ success: false, error: "Indica por qué se rechaza el corte" });
      }

      const current = await client.query(
        "SELECT status, amount_cut, remaining_to_cut FROM cut_orders WHERE id = $1",
        [parseInt(req.params.id)]
      );
      if (current.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Cut order not found" });
      }
      if (current.rows[0].status === "cancelled") {
        return res.status(400).json({ success: false, error: "No se puede verificar un corte cancelado" });
      }
      // No se firma un corte donde nadie ha cortado nada. Que falten piezas
      // contra el pedido NO bloquea: el supervisor puede cerrar un corte corto
      // (marcadas que no cubren todo el pedido) a conciencia.
      const already = parseFloat(current.rows[0].amount_cut);
      if (approved && (isNaN(already) || already <= 0)) {
        return res.status(400).json({
          success: false,
          error: "No hay piezas cortadas registradas: verifica las marcadas antes de cerrar el corte",
        });
      }

      const result = await client.query(
        `UPDATE cut_orders
            SET status             = $1,
                verified_at        = $2,
                verified_by        = $3,
                verification_notes = $4,
                updated_at         = now()
          WHERE id = $5
          RETURNING *`,
        [
          approved ? "completed" : "in_progress",
          approved ? new Date() : null,
          approved ? verifierName(req.user) : null,
          notes,
          parseInt(req.params.id),
        ]
      );
      res.json({ success: true, cutOrder: result.rows[0] });
    } catch (err) {
      console.error("❌ Error verifying cut order:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // Update a cut order's priority (urgent / intermediate / normal).
  app.patch("/api/cut-orders/:id/priority", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { priority } = req.body;
      if (!["urgent", "intermediate", "normal"].includes(priority)) {
        return res.status(400).json({ success: false, error: "Prioridad inválida" });
      }
      const result = await client.query(
        "UPDATE cut_orders SET priority = $1, updated_at = now() WHERE id = $2 RETURNING *",
        [priority, parseInt(req.params.id)]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Cut order not found" });
      }
      res.json({ success: true, cutOrder: result.rows[0] });
    } catch (err) {
      console.error("❌ Error updating cut order priority:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // Delete a cut order.
  app.delete("/api/cut-orders/:id", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const result = await client.query(
        "DELETE FROM cut_orders WHERE id = $1 RETURNING id",
        [parseInt(req.params.id)]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Cut order not found" });
      }
      res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
      console.error("❌ Error deleting cut order:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // AGRUPACIÓN DE CORTES
  // ───────────────────────────────────────────────────────────────────────

  // Grupos con al menos una CORTE, con los ids de sus órdenes.
  app.get("/api/cut-groups", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const result = await client.query(`
        SELECT g.id, g.group_by, g.group_key, g.markers, g.created_by, g.created_at, g.updated_at,
               array_agg(co.id ORDER BY co.id) AS member_ids
          FROM cut_groups g
          JOIN cut_orders co ON co.cut_group_id = g.id
         GROUP BY g.id
         ORDER BY g.created_at DESC
      `);
      res.json({ success: true, cutGroups: result.rows });
    } catch (err) {
      console.error("❌ Error fetching cut groups:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // Crear grupo: { cutOrderIds: [..], groupBy: 'style_fabric' | 'item_code' }
  // Las marcadas individuales SIN verificar de las órdenes se descartan: a
  // partir de aquí se planean desde el grupo.
  app.post("/api/cut-groups", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const groupBy = req.body.groupBy === "item_code" ? "item_code" : "style_fabric";
      const ids = [...new Set(asArr(req.body.cutOrderIds).map((v) => parseInt(v)).filter((v) => v > 0))];
      if (ids.length < 2) {
        return res.status(400).json({ success: false, error: "Elija al menos dos órdenes de corte para agrupar" });
      }

      await client.query("BEGIN");
      await client.query("SELECT id FROM cut_orders WHERE id = ANY($1::bigint[]) FOR UPDATE", [ids]);
      const { rows } = await client.query(`${CUT_ORDER_SELECT} WHERE co.id = ANY($1::bigint[])`, [ids]);
      const cutNo = (id) => `CORTE-${String(id).padStart(4, "0")}`;

      const fail = async (status, error) => {
        await client.query("ROLLBACK");
        return res.status(status).json({ success: false, error });
      };
      if (rows.length !== ids.length) return fail(404, "Alguna de las órdenes de corte ya no existe");

      for (const r of rows) {
        if (r.status === "completed" || r.status === "cancelled") {
          return fail(400, `${cutNo(r.id)} está ${r.status === "completed" ? "cortada" : "cancelada"} y no se puede agrupar`);
        }
        if (r.cut_group_id) return fail(409, `${cutNo(r.id)} ya pertenece a otro grupo`);
        if (hasDoneMarker(r.markers)) {
          return fail(409, `${cutNo(r.id)} tiene marcadas verificadas; el supervisor debe reabrirlas antes de agrupar`);
        }
      }

      const key = cutGroupKey(rows[0], groupBy);
      if (!key) {
        return fail(400, groupBy === "item_code"
          ? `${cutNo(rows[0].id)} no tiene un item code único`
          : `${cutNo(rows[0].id)} no tiene estilo o tela para agrupar`);
      }
      const odd = rows.find((r) => cutGroupKey(r, groupBy) !== key);
      if (odd) {
        return fail(400, groupBy === "item_code"
          ? `${cutNo(odd.id)} tiene otro item code; sólo se agrupan órdenes con el mismo item code`
          : `${cutNo(odd.id)} tiene otro estilo o tela; sólo se agrupan órdenes con el mismo estilo y la misma tela`);
      }

      const g = await client.query(
        `INSERT INTO cut_groups (group_by, group_key, created_by) VALUES ($1, $2, $3) RETURNING *`,
        [groupBy, key, verifierName(req.user)]
      );
      const cleared = rows.filter((r) => asArr(r.markers).length > 0).length;
      await client.query(
        `UPDATE cut_orders
            SET cut_group_id = $1,
                markers = CASE WHEN jsonb_typeof(markers) = 'array' AND jsonb_array_length(markers) > 0 THEN '[]'::jsonb ELSE markers END,
                panels = NULL,
                updated_at = now()
          WHERE id = ANY($2::bigint[])`,
        [g.rows[0].id, ids]
      );
      await client.query("COMMIT");
      res.json({ success: true, cutGroup: { ...g.rows[0], member_ids: ids.sort((a, b) => a - b) }, clearedPlans: cleared });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("❌ Error creating cut group:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // Guardar el plan del grupo.
  //   { markers: [marcadas del grupo, tallas sumadas],
  //     allocations: [{ cutOrderId, markers: [la parte de esa orden] }] }
  // Las marcadas ya verificadas en una orden NO se tocan (se conserva la copia
  // que tiene la orden), igual que en la planeación individual.
  app.patch("/api/cut-groups/:id/plan", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const groupId = parseInt(req.params.id);
      const groupMarkers = asArr(req.body.markers).map((m) => ({ ...m, done: false, completedAt: null }));
      const allocations = asArr(req.body.allocations);

      await client.query("BEGIN");
      const g = await client.query("SELECT * FROM cut_groups WHERE id = $1 FOR UPDATE", [groupId]);
      if (!g.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, error: "Grupo no encontrado" });
      }
      const members = await client.query(
        "SELECT id, markers FROM cut_orders WHERE cut_group_id = $1 ORDER BY id FOR UPDATE",
        [groupId]
      );
      const memberIds = new Set(members.rows.map((r) => Number(r.id)));
      const bad = allocations.find((a) => !memberIds.has(Number(a?.cutOrderId)));
      if (bad) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, error: `La orden ${bad?.cutOrderId} no pertenece a este grupo` });
      }
      const allocById = new Map(allocations.map((a) => [Number(a.cutOrderId), asArr(a.markers)]));
      const order = groupMarkers.map((m) => m.id);

      for (const r of members.rows) {
        const existing = asArr(r.markers);
        const doneById = new Map(existing.filter((m) => m && m.done).map((m) => [m.id, m]));
        const incoming = new Map((allocById.get(Number(r.id)) || []).map((m) => [m.id, m]));
        const final = [];
        order.forEach((id) => {
          if (doneById.has(id)) { final.push(doneById.get(id)); doneById.delete(id); }
          else if (incoming.has(id)) final.push({ ...incoming.get(id), done: false, completedAt: null });
        });
        doneById.forEach((m) => final.push(m)); // verificadas que ya no están en el plan: se conservan
        await client.query(
          `UPDATE cut_orders SET markers = $1::jsonb, panels = $2, updated_at = now() WHERE id = $3`,
          [JSON.stringify(final), sumMarkerPanels(final), r.id]
        );
      }
      await client.query(
        "UPDATE cut_groups SET markers = $1::jsonb, updated_at = now() WHERE id = $2",
        [JSON.stringify(groupMarkers), groupId]
      );
      await client.query("COMMIT");

      const updated = await client.query(`${CUT_ORDER_SELECT} WHERE co.cut_group_id = $1 ORDER BY co.id`, [groupId]);
      res.json({
        success: true,
        cutGroup: { ...g.rows[0], markers: groupMarkers, member_ids: updated.rows.map((r) => Number(r.id)) },
        cutOrders: updated.rows,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("❌ Error saving cut group plan:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // Desagrupar: quita de cada orden las marcadas que venían del grupo. No se
  // permite si alguna ya está verificada (el supervisor debe reabrirla).
  app.delete("/api/cut-groups/:id", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const groupId = parseInt(req.params.id);
      await client.query("BEGIN");
      const g = await client.query("SELECT * FROM cut_groups WHERE id = $1 FOR UPDATE", [groupId]);
      if (!g.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, error: "Grupo no encontrado" });
      }
      const groupIds = new Set(asArr(g.rows[0].markers).map((m) => m?.id).filter(Boolean));
      const members = await client.query(
        "SELECT id, markers FROM cut_orders WHERE cut_group_id = $1 FOR UPDATE",
        [groupId]
      );
      const locked = members.rows.find((r) => hasDoneMarker(r.markers, groupIds));
      if (locked) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          error: `CORTE-${String(locked.id).padStart(4, "0")} tiene marcadas del grupo ya verificadas; el supervisor debe reabrirlas antes de desagrupar`,
        });
      }
      for (const r of members.rows) {
        const rest = asArr(r.markers).filter((m) => !groupIds.has(m?.id));
        await client.query(
          `UPDATE cut_orders SET cut_group_id = NULL, markers = $1::jsonb, panels = $2, updated_at = now() WHERE id = $3`,
          [JSON.stringify(rest), rest.length ? sumMarkerPanels(rest) : null, r.id]
        );
      }
      await client.query("DELETE FROM cut_groups WHERE id = $1", [groupId]);
      await client.query("COMMIT");
      res.json({ success: true, id: groupId, released: members.rows.map((r) => Number(r.id)) });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("❌ Error ungrouping cut orders:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });
}

registerCutOrders.initSchema = initSchema;
registerCutOrders.cutGroupKey = cutGroupKey;
module.exports = registerCutOrders;