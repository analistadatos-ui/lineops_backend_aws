// cut-order-analytics.js
//
// CEO analytical view of the cut_orders table — the read-only twin of
// merchant-analytics.js, feeding CutOrderAnalytics.jsx from /api/cut-orders/analytics.
//
// It answers, on one screen, the questions the cutting floor cares about:
//   • status of every corte (pendiente / en proceso / terminada / cancelada)
//   • how many órdenes de corte were created and how many piezas they carry
//   • which tallas are actually being cut, and how many piezas per talla
//   • how many marcadas (trazos) each corte carries, and how many are cerradas
//
// The heavy lifting (marcadas, size_progress, tallas) lives in JSONB columns,
// so the date-range fetch is done in SQL and the per-order roll-ups in JS.
//
// WIRING in server.js — mirror the cut-orders lines already there:
//
//   1. Near the other requires (right after registerCutOrders):
//        const registerCutOrderAnalytics = require("./cut-order-analytics");
//
//   2. Next to registerCutOrders(app, {...}):
//        registerCutOrderAnalytics(app, { authenticateToken, pool, setSchema });
//
//   There is no schema to create — it only reads cut_orders — so there is no
//   initSchema call to add.
// ---------------------------------------------------------------------------

// Roles allowed to see the executive cut board. Matches the broad exec set used
// elsewhere in the app; trim it if the cutting board should be narrower.
const ALLOWED_ROLES = ['skyrina', 'master', 'engineer', 'supervisor', 'soporte_it', 'admin', 'planner'];

const STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];

// Garment tallas don't sort alphabetically (XL > L, 2 < 10). Give the common
// alpha sizes a fixed rank; anything numeric sorts by its number after them;
// anything unknown falls to the very end but keeps a stable order.
const TALLA_RANK = { XXS: 0, XS: 1, S: 2, M: 3, L: 4, XL: 5, XXL: 6, XXXL: 7, '2XL': 6, '3XL': 7, '4XL': 8 };
function tallaSortKey(t) {
  const k = String(t || '').trim().toUpperCase();
  if (k in TALLA_RANK) return [0, TALLA_RANK[k], k];
  const n = parseFloat(k);
  if (!isNaN(n)) return [1, n, k];
  return [2, 0, k];
}
function cmpTalla(a, b) {
  const ka = tallaSortKey(a), kb = tallaSortKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || (ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0);
}

const num = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};

// Normalise the JSONB columns that may arrive as an object, a JSON string, or null.
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

// Pieces already cut for the order: prefer the scalar amount_cut the cutter saved,
// otherwise add up the per-talla size_progress rows.
function cutOf(row, sp) {
  if (row.amount_cut != null && row.amount_cut !== '') return num(row.amount_cut);
  return sp.reduce((s, r) => s + num(r.amountCut), 0);
}
// Pieces still owed: prefer the scalar, then the size_progress rows, then plan − cut.
function remainingOf(row, sp, cut, planned) {
  if (row.remaining_to_cut != null && row.remaining_to_cut !== '') return Math.max(num(row.remaining_to_cut), 0);
  if (sp.length) {
    return sp.reduce((s, r) => {
      if (r.remaining != null && r.remaining !== '') return s + Math.max(num(r.remaining), 0);
      return s + Math.max(num(r.quantity) - num(r.amountCut), 0);
    }, 0);
  }
  return Math.max(planned - cut, 0);
}

// A marcada is "cerrada" when the corte is completed, or (when the cutter tracks
// per-talla progress) when every talla the marcada touches has nothing left to cut.
function markerDone(marker, spByTalla, status) {
  if (status === 'completed') return true;
  if (status === 'cancelled') return false;
  const lines = asArray(marker.lines);
  if (!lines.length || !spByTalla) return false;
  return lines.every((l) => {
    const rec = spByTalla[String(l.talla || '').trim().toUpperCase()];
    return rec && num(rec.remaining) <= 0 && num(rec.amountCut) > 0;
  });
}

function registerCutOrderAnalytics(app, { authenticateToken, pool, setSchema }) {
  app.get('/api/cut-orders/analytics', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);

      if (!ALLOWED_ROLES.includes(req.user?.role)) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      const today = new Date().toISOString().split('T')[0];
      const startDate = req.query.startDate || today;
      const endDate = req.query.endDate || startDate;
      const statusFilter = req.query.status && req.query.status !== 'all' ? req.query.status : null;

      const params = [startDate, endDate];
      let where = 'co.cut_date BETWEEN $1 AND $2';
      if (statusFilter) { params.push(statusFilter); where += ` AND co.status = $${params.length}`; }

      const { rows } = await client.query(`
        SELECT co.id,
               co.work_order_id,
               to_char(co.cut_date, 'YYYY-MM-DD') AS cut_date,
               co.quantity,
               co.amount_cut,
               co.remaining_to_cut,
               co.panels,
               co.total_length,
               co.status,
               co.fabric,
               co.fabric_code,
               COALESCE(co.color, wo.color)      AS color,
               co.sizes,
               co.size_progress,
               co.markers,
               COALESCE(co.style_no, wo.style_code) AS style_no,
               wo.work_order_no,
               wo.customer_name,
               wo.customer_po,
               wo.style_description
          FROM cut_orders co
          JOIN work_orders wo ON wo.id = co.work_order_id
         WHERE ${where}
         ORDER BY co.cut_date DESC, co.created_at DESC
      `, params);

      // ---- Roll-ups --------------------------------------------------------
      const summary = {
        total_orders: rows.length,
        total_quantity: 0,
        total_cut: 0,
        total_remaining: 0,
        total_length: 0,
        pending_orders: 0,
        in_progress_orders: 0,
        completed_orders: 0,
        cancelled_orders: 0,
        total_marcadas: 0,
        completed_marcadas: 0,
        tallas: 0,
        fabrics_count: 0,
      };

      const byStatus = Object.fromEntries(STATUSES.map((s) => [s, { status: s, orders: 0, quantity: 0, cut: 0 }]));
      const byTalla = new Map();   // talla -> { talla, planned, cut, remaining, orders }
      const byFabric = new Map();  // name|code -> { fabric, fabric_code, orders, quantity, length }
      const byDay = new Map();     // day -> { day, orders, quantity, cut }
      const tallaSet = new Set();
      const fabricSet = new Set();
      const detail = [];

      for (const row of rows) {
        const sp = asArray(row.size_progress);
        const markers = asArray(row.markers);
        const planned = num(row.quantity);
        const cut = cutOf(row, sp);
        const remaining = remainingOf(row, sp, cut, planned);
        const status = row.status || 'pending';

        summary.total_quantity += planned;
        summary.total_cut += cut;
        summary.total_remaining += remaining;
        summary.total_length += num(row.total_length);
        summary[`${status}_orders`] != null && (summary[`${status}_orders`] += 1);

        // Status roll-up
        if (byStatus[status]) {
          byStatus[status].orders += 1;
          byStatus[status].quantity += planned;
          byStatus[status].cut += cut;
        }

        // Per-talla plan/cut. size_progress is the source of truth when present;
        // otherwise derive the plan from the marcada lines so tallas still show.
        const spByTalla = {};
        for (const r of sp) {
          const t = String(r.talla || '').trim().toUpperCase();
          if (!t) continue;
          spByTalla[t] = r;
        }
        const tallaPlan = new Map(); // talla -> { planned, cut, remaining }
        if (sp.length) {
          for (const r of sp) {
            const t = String(r.talla || '').trim().toUpperCase();
            if (!t) continue;
            const q = num(r.quantity), c = num(r.amountCut);
            const rem = r.remaining != null && r.remaining !== '' ? Math.max(num(r.remaining), 0) : Math.max(q - c, 0);
            const cur = tallaPlan.get(t) || { planned: 0, cut: 0, remaining: 0 };
            cur.planned += q; cur.cut += c; cur.remaining += rem;
            tallaPlan.set(t, cur);
          }
        } else {
          for (const m of markers) {
            for (const l of asArray(m.lines)) {
              const t = String(l.talla || '').trim().toUpperCase();
              if (!t) continue;
              const cur = tallaPlan.get(t) || { planned: 0, cut: 0, remaining: 0 };
              cur.planned += num(l.pieces);
              tallaPlan.set(t, cur);
            }
          }
        }
        const orderTallas = [...tallaPlan.keys()].sort(cmpTalla);
        for (const [t, v] of tallaPlan) {
          tallaSet.add(t);
          const cur = byTalla.get(t) || { talla: t, planned: 0, cut: 0, remaining: 0, orders: 0 };
          cur.planned += v.planned; cur.cut += v.cut; cur.remaining += v.remaining; cur.orders += 1;
          byTalla.set(t, cur);
        }

        // Marcadas
        const marcadasDone = markers.reduce((s, m) => s + (markerDone(m, spByTalla, status) ? 1 : 0), 0);
        summary.total_marcadas += markers.length;
        summary.completed_marcadas += marcadasDone;

        // Per-fabric (representative tela name + código). Group by name+código so
        // two códigos of the same tela stay as separate rows.
        const fabricName = (row.fabric || 'Sin tela').toString();
        const fabricCode = (row.fabric_code || '').toString();
        const fabricKey = `${fabricName.toUpperCase()}||${fabricCode.toUpperCase()}`;
        fabricSet.add(fabricKey);
        const f = byFabric.get(fabricKey) || { fabric: fabricName, fabric_code: fabricCode || null, orders: 0, quantity: 0, length: 0 };
        f.orders += 1; f.quantity += planned; f.length += num(row.total_length);
        byFabric.set(fabricKey, f);

        // Per-day
        const d = byDay.get(row.cut_date) || { day: row.cut_date, orders: 0, quantity: 0, cut: 0 };
        d.orders += 1; d.quantity += planned; d.cut += cut;
        byDay.set(row.cut_date, d);

        detail.push({
          id: row.id,
          work_order_no: row.work_order_no,
          customer_name: row.customer_name,
          customer_po: row.customer_po,
          style: row.style_no || row.style_description || null,
          cut_date: row.cut_date,
          fabric: fabricName,
          fabric_code: fabricCode || null,
          color: row.color || null,
          quantity: planned,
          amount_cut: cut,
          remaining,
          status,
          panels: row.panels != null ? num(row.panels) : null,
          marcadas: markers.length,
          marcadas_done: marcadasDone,
          tallas: orderTallas,
          progress: planned > 0 ? Math.min(Math.round((cut / planned) * 100), 100) : (cut > 0 ? 100 : 0),
        });
      }

      summary.tallas = tallaSet.size;
      summary.fabrics_count = fabricSet.size;
      summary.progress = summary.total_quantity > 0
        ? Math.min(Math.round((summary.total_cut / summary.total_quantity) * 100), 100)
        : 0;

      res.json({
        success: true,
        range: { startDate, endDate },
        summary,
        byStatus: STATUSES.map((s) => byStatus[s]).filter((r) => r.orders > 0),
        byTalla: [...byTalla.values()].sort((a, b) => cmpTalla(a.talla, b.talla)),
        byFabric: [...byFabric.values()].sort((a, b) => b.quantity - a.quantity),
        byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
        detail,
      });
    } catch (err) {
      console.error('❌ Error fetching cut-order analytics:', err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });
}

module.exports = registerCutOrderAnalytics;