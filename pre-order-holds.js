// ==========================================================================
// pre-order-holds.js
//
// PLAN BOARD "holds" for PRE#### pre-orders.
//
// A pre-order is not yet a real PO, so it can't live in line_assignments
// (that table's work_order_id is NOT NULL -> work_orders, and it feeds
// settle-day / completion / production, none of which apply to something with
// nothing to produce yet). Instead the planner can drop a PRE#### onto a
// LINE + DAY cell as a *hold*: a soft reservation that
//   • renders on the Plan Board as a violet PRE cell, and
//   • RESERVES that line/day's capacity, so a real PO can't silently take the
//     slot (server.js adds these into /available-lines and the POST
//     /line-assignments capacity guard).
// A hold never enters settle-day, completion or production. When the merchant
// converts the pre-order, pre-orders.js drops its holds and the planner then
// assigns the real PO(s) to days normally.
//
// Register-module in the same shape as merchant-plan.js / work-orders.js.
//
// --------------------------------------------------------------------------
// SETUP  (server.js)
// --------------------------------------------------------------------------
// 1. Near the other requires (by registerMerchantPlan):
//        const registerPreOrderHolds = require("./pre-order-holds");
// 2. In the async startup block, by the other initSchema calls:
//        await registerPreOrderHolds.initSchema({ pool, setSchema });
// 3. Where the other modules register:
//        registerPreOrderHolds(app, { authenticateToken, pool, setSchema, holidays: registerHolidays });
//
// Gated by authenticateToken only. created_by records who placed the hold; the
// board is ORG-WIDE like the merchant plan.
//
// Endpoints
//   GET    /api/pre-order-holds[?from=&to=]     -> { success, holds:[...] }
//   POST   /api/pre-order-holds                 -> upsert ONE line/day/color
//   DELETE /api/pre-order-holds?id=             -> remove ONE hold row
//   DELETE /api/pre-order-holds?preOrderId=     -> remove ALL holds of a PRE
//
// POST item (camelCase from the board):
//   { preOrderId, lineNo, assignedDate,  // assignedDate = "YYYY-MM-DD"
//     quantity, color,
//     preOrderNo, customerName, styleCode, estilo }
// Re-dropping the same pre-order+line+day+color ADDS to the existing quantity
// (the board walks a PO across days, sending only what fits each day).
//
// CAPACITY: POST is checked against the PLANNER's standard for the hold's style
// (planner-style-params.js), not the line engineers' runs. Requires
// planner-style-params.js next to this file.
// ==========================================================================

async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS pre_order_day_holds(
        id             BIGSERIAL PRIMARY KEY,
        pre_order_id   BIGINT NOT NULL REFERENCES pre_orders(id) ON DELETE CASCADE,
        line_no        TEXT   NOT NULL,
        assigned_date  DATE   NOT NULL,
        quantity       NUMERIC(12,2) NOT NULL DEFAULT 0,
        color          VARCHAR(50)  NOT NULL DEFAULT '',
        pre_order_no   VARCHAR(80),
        customer_name  VARCHAR(150),
        style_code     VARCHAR(20),
        estilo         VARCHAR(120),
        created_by     BIGINT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_pre_order_day_holds_qty CHECK (quantity > 0)
      );
    `);
    // One row per (pre-order, line, day, color): a re-drop merges into it.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pre_order_day_holds
        ON pre_order_day_holds (pre_order_id, line_no, assigned_date, color);
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_pre_order_day_holds_cell ON pre_order_day_holds(line_no, assigned_date);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_pre_order_day_holds_pre ON pre_order_day_holds(pre_order_id);");

    // 🛡️ Guardia en la base: una PRE convertida o cancelada NO puede recibir
    // reservas nuevas, venga de donde venga (ruta, deshacer, script, SQL a mano).
    // BEFORE INSERT que regresa NULL = la fila simplemente no se escribe, sin
    // romper la transacción de quien la intentó.
    try {
      await client.query(`
        CREATE OR REPLACE FUNCTION trg_pre_order_holds_closed_guard() RETURNS trigger AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pre_orders p
                      WHERE p.id = NEW.pre_order_id
                        AND p.status IN ('converted', 'cancelled')) THEN
            RETURN NULL;
          END IF;
          RETURN NEW;
        END
        $$ LANGUAGE plpgsql;
      `);
      await client.query("DROP TRIGGER IF EXISTS pre_order_holds_closed_guard ON pre_order_day_holds;");
      await client.query(`
        CREATE TRIGGER pre_order_holds_closed_guard
          BEFORE INSERT ON pre_order_day_holds
          FOR EACH ROW EXECUTE PROCEDURE trg_pre_order_holds_closed_guard();
      `);
    } catch (e) {
      console.warn("\u26a0\ufe0f  no se pudo crear la guardia de reservas PRE cerradas:", e.message);
    }

    // Limpieza al arrancar: reservas huérfanas que hayan quedado de antes.
    try {
      await purgeClosedPreOrderHolds(client);
    } catch (e) {
      console.warn("\u26a0\ufe0f  limpieza de reservas PRE al arrancar falló:", e.message);
    }

    console.log("\u2705 pre_order_day_holds table ready in prod_db_schema");
  } finally {
    client.release();
  }
}

// Planner-owned standards per style (SAM / operators / hours / efficiency).
// A hold now reserves capacity measured with ITS style's standard, exactly
// like a real PO, and the server refuses a hold that doesn't fit the day.
const plannerStyleParams = require("./planner-style-params");
// 🔒 Candado de semanas del CEO: una reserva PRE no se crea, cambia ni borra
// en una semana bloqueada (trigger en pre_order_day_holds, opt-in con enforce).
const planWeekLocks = require("./plan-week-locks");

// ---------------------------------------------------------------------------
// Reservas huérfanas: una PRE convertida o cancelada ya no reserva nada. Sus
// reservas sólo pueden quedarse en una semana bloqueada por el CEO; en cuanto
// esa semana ya no está bloqueada, sobran. El tablero NO las pinta, pero
// cellCapacity() sí las contaba, y la línea se veía vacía aunque estaba "llena"
// (así quedó la línea 11 del 3 dic al 2 mar con la PRE 243).
//
// Se llama al arrancar, en cada carga del tablero (GET) y desde pre-orders.js,
// así ninguna fuga —conversión fallida, cancelación a medias o semana
// desbloqueada— sobrevive más de una carga del tablero.
// ---------------------------------------------------------------------------
async function purgeClosedPreOrderHolds(client) {
  const r = await client.query(
    `DELETE FROM pre_order_day_holds h
      USING pre_orders p
      WHERE p.id = h.pre_order_id
        AND p.status IN ('converted', 'cancelled')
        AND ${planWeekLocks.notInLockedWeekSql("h.assigned_date")}`
  );
  if (r.rowCount) {
    console.warn(`\u{1F9F9} ${r.rowCount} reserva(s) PRE huérfana(s) eliminada(s) (pre-orden convertida o cancelada)`);
  }
  return r.rowCount;
}

// --- coercion helpers ------------------------------------------------------
const txt = (v, n) => (v == null ? null : String(v).trim().slice(0, n || 200) || null);
const col = (v) => String(v == null ? "" : v).trim().toUpperCase().slice(0, 50);
const numOr = (v, d = 0) => { const n = Number(v); return isNaN(n) ? d : n; };
const isYmd = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
// Date helpers in UTC (no timezone drift), same as server.js.
const addDaysStr = (ymdStr, n) => {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};
const isWeekend = (ymdStr) => {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sun, 6 = Sat
  return dow === 0 || dow === 6;
};
// How far forward a hold may spill looking for free capacity.
const MAX_SPILL_DAYS = 180;

function registerPreOrderHolds(app, deps) {
  const { authenticateToken, pool, setSchema } = deps;
  // Optional: holidays module (registerHolidays) so the spill skips días festivos.
  const holidays = deps.holidays || null;

  // ---- GET: all holds (optionally within a date window) ------------------
  app.get("/api/pre-order-holds", authenticateToken, async (req, res) => {
    const from = isYmd(req.query.from) ? req.query.from : null;
    const to = isYmd(req.query.to) ? req.query.to : null;
    const client = await pool.connect();
    try {
      await setSchema(client);
      // Cada carga del tablero barre las reservas de PRE cerradas fuera de
      // semanas bloqueadas (incluye las que quedaron al desbloquear una semana).
      try { await purgeClosedPreOrderHolds(client); }
      catch (e) { console.warn("\u26a0\ufe0f  limpieza de reservas PRE falló:", e.message); }
      const params = [];
      const where = [];
      if (from) { params.push(from); where.push(`assigned_date >= $${params.length}`); }
      if (to) { params.push(to); where.push(`assigned_date <= $${params.length}`); }
      const { rows } = await client.query(
        `SELECT h.id, h.pre_order_id, h.line_no,
                to_char(h.assigned_date, 'YYYY-MM-DD') AS assigned_date,
                h.quantity, h.color, h.pre_order_no, h.customer_name, h.style_code, h.estilo,
                h.updated_at,
                -- Fecha de entrega de la pre-orden: viaja con cada reserva para
                -- que el tablero marque a tiempo / atrasada sin otra consulta.
                to_char(p.target_date, 'YYYY-MM-DD') AS target_date,
                -- Estado de la pre-orden y POs en que se convirtió: el tablero
                -- etiqueta una reserva que quedó en semana bloqueada como
                -- "PRE → SKM####" en vez de una PRE viva.
                p.status AS pre_status, p.work_order_nos
           FROM pre_order_day_holds h
           LEFT JOIN pre_orders p ON p.id = h.pre_order_id
          WHERE ${[
            // Una PRE convertida o cancelada ya no reserva nada. Su reserva solo
            // sobrevive en una semana bloqueada por el CEO (se suelta al
            // desbloquear); fuera de eso es un huérfano y no se pinta.
            `(COALESCE(p.status, 'pending') NOT IN ('converted','cancelled')
              OR NOT ${planWeekLocks.notInLockedWeekSql("h.assigned_date")})`,
            ...where.map((w) => "h." + w),
          ].join(" AND ")}
          ORDER BY h.assigned_date, h.line_no, h.pre_order_no`,
        params
      );

      // SAM per hold, so the board can count holds in the EQUIVALENT load
      // (eq = quantity x SAM / equivalence) exactly like real POs.
      // SAM comes ONLY from the planner's style standard (planner_style_params):
      // the same SAM the POST capacity check used, so a cell that shows 100% of
      // pieces also shows its full eq. A hold can't be placed without a
      // standard (POST returns STYLE_PARAMS_REQUIRED), so every hold has one.
      const samByStyle = new Map();
      for (const r of rows) {
        const style = plannerStyleParams.normStyle(r.style_code || "") ||
                      plannerStyleParams.normStyle(r.estilo || "");
        if (style && !samByStyle.has(style)) {
          let sp = null;
          try { sp = await plannerStyleParams.getParams(client, style); } catch (_) { sp = null; }
          samByStyle.set(style, Number(sp?.sam_minutes) || 0);
        }
        r.sam_minutes = style ? samByStyle.get(style) : 0;
      }
      res.json({ success: true, holds: rows });
    } catch (err) {
      console.error("\u274c GET /api/pre-order-holds:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---- POST: upsert a hold (merges quantity on conflict) -----------------
  // Capacity check (planner style standards): the hold's style must have a
  // standard (else 409 STYLE_PARAMS_REQUIRED so the board asks the planner).
  //
  // FIX (capacity mismatch board vs server): the board estimates per day how
  // many pieces fit, but the server's cellCapacity() (planner standard +
  // learning curve + other loads) is the only truth. Instead of rejecting a
  // chunk that is bigger than what the server says fits, the server now
  // places what fits on the requested day and SPILLS the rest forward onto the
  // next working days of the same line (skips weekends, holidays and CEO-locked
  // weeks), exactly like the PO move endpoint does. All-or-nothing: if the
  // whole quantity can't be placed within MAX_SPILL_DAYS, nothing is saved.
  //
  // Body flags:
  //   { spread: false }          -> old strict behaviour (400 if it doesn't fit)
  //   { skipCapacityCheck: true } -> restore a hold exactly as it was (undo)
  //
  // Response keeps `hold` (first row) for compatibility and adds `holds`
  // (every row written), `spilled` (true when it went past the requested day).
  app.post("/api/pre-order-holds", authenticateToken, async (req, res) => {
    const b = req.body || {};
    const preOrderId = b.preOrderId ?? b.pre_order_id ?? null;
    const lineNo = b.lineNo ?? b.line_no ?? null;
    const assignedDate = b.assignedDate ?? b.assigned_date ?? null;
    const quantity = numOr(b.quantity);
    if (preOrderId == null || lineNo == null || String(lineNo).trim() === "" || !isYmd(assignedDate) || quantity <= 0) {
      return res.status(400).json({ success: false, error: "preOrderId, lineNo, assignedDate (YYYY-MM-DD) y quantity (>0) son obligatorios" });
    }
    const line = String(lineNo).trim();
    const preId = parseInt(preOrderId, 10);
    const client = await pool.connect();
    try {
      await setSchema(client);
      await client.query("BEGIN");
      await planWeekLocks.enforce(client); // 🔒 semanas bloqueadas por el CEO

      // Una PRE convertida o cancelada ya no puede reservar (ni por mover una
      // celda vieja ni por deshacer): el planner debe asignar la PO real.
      const st = await client.query(
        "SELECT status, work_order_nos FROM pre_orders WHERE id = $1",
        [preId]
      );
      if (!st.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, error: "Pre-orden no encontrada" });
      }
      if (["converted", "cancelled"].includes(st.rows[0].status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          code: "PRE_ORDER_CLOSED",
          error: st.rows[0].status === "converted"
            ? `Esta pre-orden ya se convirtió en ${st.rows[0].work_order_nos || "PO"}. Asigne la PO real.`
            : "Esta pre-orden fue cancelada.",
        });
      }

      // Style of the hold: what the board sent, else the pre-order's own.
      let style = plannerStyleParams.normStyle(b.styleCode ?? b.style_code ?? "") ||
                  plannerStyleParams.normStyle(b.estilo ?? "");
      if (!style) {
        const po = await client.query(
          `SELECT UPPER(TRIM(COALESCE(NULLIF(TRIM(style_code), ''), NULLIF(TRIM(estilo), ''), ''))) AS style
             FROM pre_orders WHERE id = $1`,
          [preId]
        );
        style = po.rows[0]?.style || "";
      }

      const meta = {
        color: col(b.color),
        preOrderNo: txt(b.preOrderNo ?? b.pre_order_no, 80),
        customerName: txt(b.customerName ?? b.customer_name, 150),
        styleCode: txt(b.styleCode ?? b.style_code, 20) || txt(style, 20),
        estilo: txt(b.estilo, 120),
        userId: req.user?.id ?? null,
      };
      const insertHold = async (day, qty) => {
        const { rows } = await client.query(
          `INSERT INTO pre_order_day_holds
             (pre_order_id, line_no, assigned_date, quantity, color,
              pre_order_no, customer_name, style_code, estilo, created_by, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
           ON CONFLICT (pre_order_id, line_no, assigned_date, color) DO UPDATE SET
             quantity      = pre_order_day_holds.quantity + EXCLUDED.quantity,
             pre_order_no  = EXCLUDED.pre_order_no,
             customer_name = EXCLUDED.customer_name,
             style_code    = EXCLUDED.style_code,
             estilo        = EXCLUDED.estilo,
             updated_at    = NOW()
           RETURNING id, line_no, to_char(assigned_date,'YYYY-MM-DD') AS assigned_date, quantity`,
          [preId, line, day, qty, meta.color, meta.preOrderNo, meta.customerName,
           meta.styleCode, meta.estilo, meta.userId]
        );
        return rows[0];
      };
      // Serialize writers on a line-day so two drops can't both take the
      // last free pieces.
      const lockCell = (day) =>
        client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`hold|${line}|${day}`]);

      // ---- Undo / exact restore: no capacity check --------------------------
      if (b.skipCapacityCheck === true) {
        await lockCell(assignedDate);
        const row = await insertHold(assignedDate, quantity);
        await client.query("COMMIT");
        return res.json({ success: true, hold: row, holds: [row], spilled: false });
      }

      // ---- Requested day ------------------------------------------------------
      await lockCell(assignedDate);
      const firstCap = await plannerStyleParams.cellCapacity(client, { lineNo: line, date: assignedDate, style });
      if (!firstCap.params) {
        await client.query("ROLLBACK");
        return plannerStyleParams.styleParamsRequired(res, style);
      }

      // Strict mode (old behaviour), only if the caller explicitly asks for it.
      if (b.spread === false) {
        if (quantity > firstCap.available) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            success: false,
            error: `La Línea ${line} solo tiene capacidad para ${Math.floor(firstCap.available)} pzas de ${style} el ${assignedDate}.`,
            available: firstCap.available,
          });
        }
        const row = await insertHold(assignedDate, quantity);
        await client.query("COMMIT");
        return res.json({ success: true, hold: row, holds: [row], spilled: false });
      }

      // ---- Spread: fill the requested day, spill the rest forward ------------
      const written = [];
      let remaining = quantity;

      const fit = (available) => Math.min(remaining, Math.max(0, Math.floor(Number(available) || 0)));
      let chunk = fit(firstCap.available);
      // Less than one piece left to place: put it where the planner dropped it.
      if (remaining < 1) chunk = remaining;
      if (chunk > 0) {
        written.push(await insertHold(assignedDate, chunk));
        remaining -= chunk;
      }

      if (remaining > 0) {
        // Days the walk must hop over: weekends, holidays of this line or the
        // whole plant, and weeks the CEO locked.
        const holidaySet = new Set();
        if (holidays && typeof holidays.holidaysBetween === "function") {
          try {
            const hrows = await holidays.holidaysBetween(client, {
              from: assignedDate, to: addDaysStr(assignedDate, MAX_SPILL_DAYS + 30),
            });
            for (const h of hrows) {
              if (h.line_no == null || String(h.line_no) === line) holidaySet.add(String(h.holiday_date).slice(0, 10));
            }
          } catch (e) {
            console.warn("⚠️  holidays not available for pre-order hold spill:", e.message);
          }
        }
        let lockedWeeks = null;
        try { lockedWeeks = await planWeekLocks.lockedWeekSet(client); } catch (_) { lockedWeeks = null; }

        let day = assignedDate;
        let scanned = 0;
        while (remaining > 0 && scanned < MAX_SPILL_DAYS) {
          scanned++;
          day = addDaysStr(day, 1);
          if (isWeekend(day) || holidaySet.has(day)) continue;
          if (lockedWeeks && planWeekLocks.isLockedDay(lockedWeeks, day)) continue;
          await lockCell(day);
          const cap = await plannerStyleParams.cellCapacity(client, { lineNo: line, date: day, style });
          chunk = remaining < 1 ? remaining : fit(cap.available);
          if (chunk <= 0) continue;
          written.push(await insertHold(day, chunk));
          remaining -= chunk;
        }
      }

      if (remaining > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          error: `La Línea ${line} no tiene capacidad para ${Math.ceil(remaining)} de las ${quantity} pzas de ${style} ` +
                 `entre el ${assignedDate} y los siguientes ${MAX_SPILL_DAYS} días. No se reservó nada.`,
          available: firstCap.available,
          unplaced: remaining,
        });
      }

      await client.query("COMMIT");
      res.json({
        success: true,
        hold: written[0],
        holds: written,
        spilled: written.some((h) => h.assigned_date !== assignedDate),
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (planWeekLocks.isLockError(err)) return planWeekLocks.sendLocked(res, err);
      console.error("\u274c POST /api/pre-order-holds:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // ---- DELETE: one hold (?id=) or every hold of a pre-order (?preOrderId=)
  app.delete("/api/pre-order-holds", authenticateToken, async (req, res) => {
    const id = req.query.id ?? req.body?.id ?? null;
    const preOrderId = req.query.preOrderId ?? req.body?.preOrderId ?? null;
    if (id == null && preOrderId == null) {
      return res.status(400).json({ success: false, error: "id o preOrderId es obligatorio" });
    }
    const client = await pool.connect();
    try {
      await setSchema(client);
      // All-or-nothing, como al borrar POs: si alguna reserva cae en una semana
      // bloqueada, no se borra ninguna y el tablero muestra el aviso del candado.
      await client.query("BEGIN");
      await planWeekLocks.enforce(client); // 🔒 semanas bloqueadas por el CEO
      const { rowCount } = id != null
        ? await client.query("DELETE FROM pre_order_day_holds WHERE id = $1", [parseInt(id, 10)])
        : await client.query("DELETE FROM pre_order_day_holds WHERE pre_order_id = $1", [parseInt(preOrderId, 10)]);
      await client.query("COMMIT");
      res.json({ success: true, deleted: rowCount });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (planWeekLocks.isLockError(err)) return planWeekLocks.sendLocked(res, err);
      console.error("\u274c DELETE /api/pre-order-holds:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });
}

registerPreOrderHolds.initSchema = initSchema;
registerPreOrderHolds.purgeClosedPreOrderHolds = purgeClosedPreOrderHolds;
module.exports = registerPreOrderHolds;