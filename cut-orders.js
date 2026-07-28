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
    console.log("✅ cut_orders table ready in prod_db_schema");
  } finally {
    client.release();
  }
}

/**
 * Registers the cut-order routes on the given Express app.
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {import('express').RequestHandler} deps.authenticateToken
 * @param {import('pg').Pool} deps.pool
 * @param {(client: any) => Promise<void>} deps.setSchema
 */
function registerCutOrders(app, { authenticateToken, pool, setSchema }) {
  // List all cut orders (newest first), with work-order info joined in.
  app.get("/api/cut-orders", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const result = await client.query(`
        SELECT co.id,
               co.work_order_id,
               co.fabric,
               to_char(co.cut_date, 'YYYY-MM-DD') AS cut_date,
               co.quantity,
               co.yield_per_piece,
               co.total_length,
               co.panels,
               co.amount_cut,
               co.remaining_to_cut,
               co.notes,
               co.status,
               co.created_at,
               wo.work_order_no,
               wo.customer_name,
               wo.style_description,
               wo.style_code,
               wo.estilo,
               COALESCE(co.color, wo.color) AS color
          FROM cut_orders co
          JOIN work_orders wo ON wo.id = co.work_order_id
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
      const { workOrderId, fabric, cutDate, quantity, notes, yieldPerPiece, color } = req.body;

      if (!workOrderId || !cutDate || !quantity || parseFloat(quantity) <= 0) {
        return res.status(400).json({
          success: false,
          error: "workOrderId, cutDate y una cantidad positiva son obligatorios",
        });
      }

      const y = yieldPerPiece === undefined || yieldPerPiece === null || yieldPerPiece === ""
        ? null
        : parseFloat(yieldPerPiece);
      if (y !== null && (isNaN(y) || y <= 0)) {
        return res.status(400).json({ success: false, error: "El rendimiento debe ser mayor a 0" });
      }
      const totalLength = y !== null ? y * parseFloat(quantity) : null;

      const wo = await client.query("SELECT id FROM work_orders WHERE id = $1", [parseInt(workOrderId)]);
      if (wo.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Work order not found" });
      }

      const result = await client.query(
        `INSERT INTO cut_orders (work_order_id, fabric, cut_date, quantity, notes, yield_per_piece, total_length, color)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [parseInt(workOrderId), fabric || null, cutDate, parseFloat(quantity), notes || null, y, totalLength, color || null]
      );
      res.json({ success: true, cutOrder: result.rows[0] });
    } catch (err) {
      console.error("❌ Error creating cut order:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // Record cutting progress: panels, amount cut, and remaining to cut.
  // Sets status to 'completed' when nothing remains, else 'in_progress'.
  app.patch("/api/cut-orders/:id/cutting", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { panels, amountCut, remainingToCut } = req.body;

      const p = panels === undefined || panels === null || panels === "" ? null : parseInt(panels);
      const cut = amountCut === undefined || amountCut === null || amountCut === "" ? null : parseFloat(amountCut);
      const rem = remainingToCut === undefined || remainingToCut === null || remainingToCut === "" ? null : parseFloat(remainingToCut);

      if (cut !== null && (isNaN(cut) || cut < 0)) {
        return res.status(400).json({ success: false, error: "Cantidad cortada inválida" });
      }
      if (rem !== null && (isNaN(rem) || rem < 0)) {
        return res.status(400).json({ success: false, error: "Restante por cortar inválido" });
      }
      if (p !== null && (isNaN(p) || p < 0)) {
        return res.status(400).json({ success: false, error: "N° de paneles inválido" });
      }

      // Status: completed if remaining is 0 (and some cutting recorded), else in_progress.
      const newStatus = rem !== null && rem <= 0 ? "completed" : "in_progress";

      const result = await client.query(
        `UPDATE cut_orders
            SET panels = COALESCE($1, panels),
                amount_cut = COALESCE($2, amount_cut),
                remaining_to_cut = COALESCE($3, remaining_to_cut),
                status = $4,
                updated_at = now()
          WHERE id = $5
          RETURNING *`,
        [p, cut, rem, newStatus, parseInt(req.params.id)]
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
      if (!["pending", "in_progress", "completed", "cancelled"].includes(status)) {
        return res.status(400).json({ success: false, error: "Estado inválido" });
      }
      const result = await client.query(
        "UPDATE cut_orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING *",
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
}

registerCutOrders.initSchema = initSchema;
module.exports = registerCutOrders;