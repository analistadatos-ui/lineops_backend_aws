// cut-order-analytics.js
//
// CEO analytical view of the cut_orders table — the read-only twin of
// merchant-analytics.js, feeding CutOrderAnalytics.jsx from /api/cut-orders/analytics.
//
// It answers, on one screen, the questions the cutting floor cares about:
//   • the ETAPA of every corte (planeación / corte / verificación / terminada)
//   • how many órdenes de corte were created and how many piezas they carry
//   • which tallas are actually being cut, and how many piezas per talla
//   • how many marcadas (trazos) each corte carries, and how many are cerradas
//
// ETAPAS (derived here, never stored) ---------------------------------------
//   planning      sin marcadas todavía — el planner aún no arma los trazos
//   ready         marcadas listas, nada cortado — el corte no ha empezado
//   cutting       hay piezas cortadas y todavía falta
//   verification  ya se cortó todo pero NADIE lo ha verificado
//   verified      verificación exitosa → esta es la única etapa "terminada"
//   cancelled     corte cancelado
//
// A corte NO cuenta como terminado sólo porque el cortador capturó todas las
// piezas: cuenta cuando `verified_at` tiene fecha. Mientras esa columna no
// exista (o esté vacía), los cortes con status 'completed' caen en
// `verification` — que es exactamente la verdad: cortados, sin verificar.
//
// La columna se detecta en caliente, así que este módulo NO truena si todavía
// no corres la migración; simplemente todo lo cortado se queda en "Por
// verificar" hasta que exista `verified_at` y alguien firme.
//
// MIGRACIÓN (en cut-orders.js → initSchema):
//   ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
//   ALTER TABLE cut_orders ADD COLUMN IF NOT EXISTS verified_by VARCHAR(100);
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
// 'corte' is here so the cutting floor's own Dashboard tab can read it.
const ALLOWED_ROLES = ['skyrina', 'master', 'engineer', 'supervisor', 'soporte_it', 'admin', 'planner', 'corte'];

const STATUSES = ['pending', 'in_progress', 'awaiting_verification', 'completed', 'cancelled'];

// Order matters: this is the order the board draws them in, left to right.
const STAGES = ['planning', 'ready', 'cutting', 'verification', 'verified', 'cancelled'];

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

// A marcada is "cerrada" when the supervisor ticked it in CutVerification
// (marker.done), when the corte is verified, or — para marcadas viejas sin el
// flag — when every talla que toca ya no tiene nada por cortar.
function markerDone(marker, spByTalla, stage) {
  if (stage === 'cancelled') return false;
  // Si la marcada trae el flag, ESE es el dato: lo escribe el supervisor en
  // CutVerification y nada más. Inferir "cerrada" desde size_progress cuando el
  // flag dice false es lo que hacía ver 2/2 marcadas en cortes que nadie firmó
  // (el size_progress venía inflado por el bug viejo de CutPlanning).
  if (marker && typeof marker.done === 'boolean') return marker.done;
  if (stage === 'verified') return true;
  // Sólo para marcadas legacy sin el campo `done`.
  const lines = asArray(marker.lines);
  if (!lines.length || !spByTalla) return false;
  return lines.every((l) => {
    const rec = spByTalla[String(l.talla || '').trim().toUpperCase()];
    return rec && num(rec.remaining) <= 0 && num(rec.amountCut) > 0;
  });
}

// Eficiencia de marcada (%) que el planner captura en CutPlanning. Cada marcada
// puede traer `efficiency` (número) o no traerla (marcadas viejas). Resumimos la
// eficiencia de una orden con el promedio simple de sus marcadas con dato, más
// el rango (min–max) para un tooltip. `sum`/`count` se usan para el promedio
// global exacto sin arrastrar el redondeo del promedio por orden.
function markerEfficiencyStats(markers) {
  const vals = [];
  for (const m of markers) {
    const e = m == null ? null : m.efficiency;
    if (e === null || e === undefined || e === '') continue;
    const n = num(e);
    if (n > 0) vals.push(n);
  }
  if (!vals.length) return { avg: null, min: null, max: null, count: 0, sum: 0 };
  const sum = vals.reduce((s, v) => s + v, 0);
  const r1 = (x) => Math.round(x * 10) / 10;
  return { avg: r1(sum / vals.length), min: r1(Math.min(...vals)), max: r1(Math.max(...vals)), count: vals.length, sum };
}

// Where in the flow this corte actually sits. Cutting being finished is NOT the
// same as the corte being done — that needs the verification sign-off.
//
// La firma se reconoce de dos formas, y cualquiera basta:
//   • verified_at   — el supervisor cerró el corte con PATCH /verify (trae quién
//                     y cuándo), o
//   • todas las marcadas con done: true — el supervisor las verificó una por una
//                     en CutVerification. Este flag SÓLO lo escribe esa pantalla:
//                     CutPlanning crea las marcadas en done: false y muestra las
//                     verificadas bloqueadas, así que es una firma legítima.
// Sin la segunda regla, todo corte verificado antes de que existiera
// verified_at se quedaba atorado en "Por verificar".
function stageOf({ row, markers, planned, cut, remaining, status }) {
  if (status === 'cancelled') return 'cancelled';
  if (row.verified_at) return 'verified';
  if (markers.length > 0 && markers.every((m) => m && m.done === true)) return 'verified';

  const cutFinished = planned > 0 ? cut >= planned : (cut > 0 && remaining <= 0);
  // Legacy rows: the old /cutting PATCH stamped 'completed' with no verification,
  // so they belong in "por verificar", not in "terminada".
  if (cutFinished || status === 'completed') return 'verification';

  // 'En corte' se gana con piezas, no con el status: una orden marcada
  // in_progress sin nada cortado sigue siendo trabajo del planner.
  if (cut > 0) return 'cutting';
  return markers.length ? 'ready' : 'planning';
}

// Piezas de una marcada: el total guardado, o la suma de sus líneas
// (pieces, o paneles × piezas por panel). Igual que markerTotal del front.
function markerPieces(m) {
  if (m && m.totalPieces != null && m.totalPieces !== '') return num(m.totalPieces);
  return asArray(m && m.lines).reduce(
    (s, l) => s + (l.pieces != null && l.pieces !== '' ? num(l.pieces) : num(l.panels) * num(l.perPanel)),
    0
  );
}

// `completedAt` se guarda en UTC (toISOString). El día que cuenta es el de la
// planta, así que lo pasamos a su zona horaria antes de agrupar: una marcada
// completada a las 7 pm en CDMX no debe caer en el día siguiente.
const PLANT_TZ = process.env.CUT_TZ || 'America/Mexico_City';
const plantDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: PLANT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
function localDay(ts) {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : plantDay.format(d); // "YYYY-MM-DD"
}

// Does cut_orders actually have the verification columns yet? Cached per process
// so we ask the catalog once, not on every request.
let VERIFY_COLS = null;
async function hasVerifyCols(client) {
  if (VERIFY_COLS !== null) return VERIFY_COLS;
  const { rows } = await client.query(`
    SELECT 1
      FROM information_schema.columns
     WHERE table_name = 'cut_orders'
       AND column_name = 'verified_at'
       AND table_schema = ANY (current_schemas(false))
     LIMIT 1
  `);
  VERIFY_COLS = rows.length > 0;
  return VERIFY_COLS;
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
      // Etapa is derived in JS, so it filters the rows after the fetch.
      const stageFilter = STAGES.includes(req.query.stage) ? req.query.stage : null;
      const slim = req.query.slim === '1';
      // Búsqueda por número de orden: work_order_no, customer_po (pedido) o el
      // id del corte. Coincidencia parcial y sin distinguir mayúsculas.
      const search = (req.query.q || '').toString().trim().slice(0, 100);
      // Con búsqueda, allDates=1 ignora el rango de fechas para encontrar la
      // orden aunque no se sepa cuándo se cortó.
      const allDates = !!search && req.query.allDates === '1';
      // dateBy=completed: el rango se aplica al día en que se completó cada
      // marcada (marker.completedAt, hora de la planta) y no a cut_date. Así
      // "Hoy" muestra las órdenes con marcadas completadas hoy, aunque la
      // orden se haya planeado otro día.
      const byCompleted = req.query.dateBy === 'completed';
      const fromDay = allDates ? null : startDate;
      const toDay = allDates ? null : endDate;
      const inRange = (day) => !!day && (!fromDay || day >= fromDay) && (!toDay || day <= toDay);

      const params = [];
      const conds = [];
      if (byCompleted) {
        // Prefiltro barato; el rango exacto se revisa en JS sobre cada marcada.
        conds.push(`co.markers::text LIKE '%completedAt%'`);
        if (!statusFilter) conds.push(`co.status <> 'cancelled'`);
      } else if (!allDates) {
        params.push(startDate, endDate);
        conds.push(`co.cut_date BETWEEN $${params.length - 1} AND $${params.length}`);
      }
      if (statusFilter) { params.push(statusFilter); conds.push(`co.status = $${params.length}`); }
      if (search) {
        // Escapa los comodines de LIKE para que "%" o "_" se busquen literalmente.
        params.push(`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        const p = `$${params.length}`;
        conds.push(`(wo.work_order_no::text ILIKE ${p}
                  OR wo.customer_po::text ILIKE ${p}
                  OR co.id::text ILIKE ${p})`);
      }
      const where = conds.length ? conds.join(' AND ') : 'TRUE';

      const verified = await hasVerifyCols(client);
      const verifiedSelect = verified
        ? `co.verified_at, co.verified_by,`
        : `NULL::timestamptz AS verified_at, NULL::text AS verified_by,`;

      const { rows: allRows } = await client.query(`
        SELECT co.id,
               co.work_order_id,
               to_char(co.cut_date, 'YYYY-MM-DD') AS cut_date,
               co.quantity,
               co.amount_cut,
               co.remaining_to_cut,
               co.panels,
               co.total_length,
               co.status,
               ${verifiedSelect}
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

      // Etapa filter: work out the stage first, then drop what wasn't asked for,
      // so every roll-up below describes exactly the same set of cortes.
      const prepared = allRows.map((row) => {
        const sp = asArray(row.size_progress);
        const markers = asArray(row.markers);
        const planned = num(row.quantity);
        const cut = cutOf(row, sp);
        const remaining = remainingOf(row, sp, cut, planned);
        const status = row.status || 'pending';
        const stage = stageOf({ row, markers, planned, cut, remaining, status });
        // Marcadas completadas dentro del rango (por su completedAt).
        const doneInRange = [];
        markers.forEach((m, i) => {
          if (!m || m.done !== true || !m.completedAt) return;
          const day = localDay(m.completedAt);
          if (inRange(day)) doneInRange.push({ m, i, day });
        });
        return { row, sp, markers, planned, cut, remaining, status, stage, doneInRange };
      });
      let rows = prepared.filter((r) =>
        (!stageFilter || r.stage === stageFilter) && (!byCompleted || r.doneInRange.length > 0)
      );
      if (byCompleted) {
        // Lo más reciente arriba: la orden con la última marcada completada.
        const last = (r) => r.doneInRange.reduce((mx, x) => (String(x.m.completedAt) > mx ? String(x.m.completedAt) : mx), '');
        rows = rows.slice().sort((a, b) => (last(a) < last(b) ? 1 : last(a) > last(b) ? -1 : 0));
      }

      // ---- Roll-ups --------------------------------------------------------
      const summary = {
        total_orders: rows.length,
        total_quantity: 0,
        total_cut: 0,
        total_remaining: 0,
        // Piezas cortadas de MÁS contra el plan (sobrantes de marcada).
        total_over: 0,
        total_length: 0,
        // raw status counters (kept for anything still reading them)
        pending_orders: 0,
        in_progress_orders: 0,
        awaiting_verification_orders: 0,
        completed_orders: 0,
        cancelled_orders: 0,
        // stage counters — these are the ones the board shows
        planning_orders: 0,
        ready_orders: 0,
        cutting_orders: 0,
        verification_orders: 0,
        verified_orders: 0,
        // piezas waiting on a verification sign-off
        verification_quantity: 0,
        total_marcadas: 0,
        completed_marcadas: 0,
        // Promedio de eficiencia de marcada (%) sobre las marcadas con dato.
        avg_efficiency: null,
        tallas: 0,
        fabrics_count: 0,
        verification_enabled: verified,
      };

      const byStatus = Object.fromEntries(STATUSES.map((s) => [s, { status: s, orders: 0, quantity: 0, cut: 0 }]));
      const byStage = Object.fromEntries(STAGES.map((s) => [s, { stage: s, orders: 0, quantity: 0, cut: 0, remaining: 0, over: 0 }]));
      const byTalla = new Map();   // talla -> { talla, planned, cut, remaining, orders }
      const byFabric = new Map();  // name|code -> { fabric, fabric_code, orders, quantity, length }
      const byDay = new Map();     // day -> { day, orders, quantity, cut }
      const tallaSet = new Set();
      const fabricSet = new Set();
      const detail = [];
      // Acumuladores para el promedio global de eficiencia de marcada.
      let effSum = 0;
      let effCount = 0;

      for (const { row, sp, markers, planned, cut, remaining, status, stage, doneInRange } of rows) {
        summary.total_quantity += planned;
        summary.total_cut += cut;
        summary.total_remaining += remaining;
        const over = Math.max(cut - planned, 0);
        summary.total_over += over;
        summary.total_length += num(row.total_length);
        summary[`${status}_orders`] != null && (summary[`${status}_orders`] += 1);
        summary[`${stage}_orders`] != null && (summary[`${stage}_orders`] += 1);
        if (stage === 'verification') summary.verification_quantity += cut;

        // Status roll-up
        if (byStatus[status]) {
          byStatus[status].orders += 1;
          byStatus[status].quantity += planned;
          byStatus[status].cut += cut;
        }

        // Stage roll-up
        if (byStage[stage]) {
          byStage[stage].orders += 1;
          byStage[stage].quantity += planned;
          byStage[stage].cut += cut;
          byStage[stage].remaining += remaining;
          byStage[stage].over += over;
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
            const cur = tallaPlan.get(t) || { planned: 0, cut: 0, remaining: 0, over: 0 };
            cur.planned += q; cur.cut += c; cur.remaining += rem; cur.over += Math.max(c - q, 0);
            tallaPlan.set(t, cur);
          }
        } else {
          for (const m of markers) {
            for (const l of asArray(m.lines)) {
              const t = String(l.talla || '').trim().toUpperCase();
              if (!t) continue;
              const cur = tallaPlan.get(t) || { planned: 0, cut: 0, remaining: 0, over: 0 };
              cur.planned += num(l.pieces);
              tallaPlan.set(t, cur);
            }
          }
        }
        const orderTallas = [...tallaPlan.keys()].sort(cmpTalla);
        for (const [t, v] of tallaPlan) {
          tallaSet.add(t);
          const cur = byTalla.get(t) || { talla: t, planned: 0, cut: 0, remaining: 0, over: 0, orders: 0 };
          cur.planned += v.planned; cur.cut += v.cut; cur.remaining += v.remaining;
          cur.over += v.over || 0; cur.orders += 1;
          byTalla.set(t, cur);
        }

        // Marcadas
        const marcadasDone = markers.reduce((s, m) => s + (markerDone(m, spByTalla, stage) ? 1 : 0), 0);
        summary.total_marcadas += markers.length;
        summary.completed_marcadas += marcadasDone;

        // Eficiencia de marcada de esta orden (promedio + rango).
        const eff = markerEfficiencyStats(markers);
        effSum += eff.sum;
        effCount += eff.count;

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
        const d = byDay.get(row.cut_date) || { day: row.cut_date, orders: 0, quantity: 0, cut: 0, remaining: 0, over: 0 };
        d.orders += 1; d.quantity += planned; d.cut += cut; d.remaining += remaining; d.over += over;
        byDay.set(row.cut_date, d);

        if (!slim) {
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
            over,
            status,
            stage,
            verified_at: row.verified_at || null,
            verified_by: row.verified_by || null,
            panels: row.panels != null ? num(row.panels) : null,
            marcadas: markers.length,
            marcadas_done: marcadasDone,
            efficiency_avg: eff.avg,
            efficiency_min: eff.min,
            efficiency_max: eff.max,
            efficiency_count: eff.count,
            tallas: orderTallas,
            // Marcadas completadas dentro del rango pedido (por completedAt).
            marcadas_done_in_range: doneInRange.length,
            marcadas_pending: Math.max(markers.length - marcadasDone, 0),
            pieces_done_in_range: doneInRange.reduce((s, x) => s + markerPieces(x.m), 0),
            markers_done_in_range: doneInRange.map((x) => x.m.name || `Marcada ${x.i + 1}`),
            efficiency_in_range: markerEfficiencyStats(doneInRange.map((x) => x.m)).avg,
            last_completed_day: doneInRange.reduce((mx, x) => (x.day > mx ? x.day : mx), '') || null,
            progress: planned > 0 ? Math.min(Math.round((cut / planned) * 100), 100) : (cut > 0 ? 100 : 0),
          });
        }
      }

      summary.tallas = tallaSet.size;
      summary.fabrics_count = fabricSet.size;
      // Promedio global de eficiencia de marcada (null si ninguna marcada trae dato).
      summary.avg_efficiency = effCount > 0 ? Math.round((effSum / effCount) * 10) / 10 : null;
      // Piezas cortadas contra lo planeado (avance del corte).
      summary.progress = summary.total_quantity > 0
        ? Math.min(Math.round((summary.total_cut / summary.total_quantity) * 100), 100)
        : 0;
      // Órdenes realmente cerradas: sólo las verificadas.
      summary.verified_progress = summary.total_orders > 0
        ? Math.round((summary.verified_orders / summary.total_orders) * 100)
        : 0;

      // ---- Marcadas completadas por día ------------------------------------
      // Independiente de cut_date: una marcada cuenta el día en que el
      // supervisor la completó (marker.completedAt), aunque la orden de corte
      // se haya creado semanas antes. Con dateBy=completed las órdenes de arriba
      // ya son exactamente ésas; si no, es una consulta aparte sin cut_date.
      let doneRows;
      if (byCompleted) {
        doneRows = rows.map((r) => r.row);
      } else {
      const cParams = [];
      const cConds = [`co.status <> 'cancelled'`, `co.markers::text LIKE '%completedAt%'`];
      if (statusFilter) { cParams.push(statusFilter); cConds.push(`co.status = $${cParams.length}`); }
      if (search) {
        cParams.push(`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        const p = `$${cParams.length}`;
        cConds.push(`(wo.work_order_no::text ILIKE ${p} OR wo.customer_po::text ILIKE ${p} OR co.id::text ILIKE ${p})`);
      }
      ({ rows: doneRows } = await client.query(`
        SELECT co.id, co.markers, wo.work_order_no, wo.customer_po, wo.customer_name
          FROM cut_orders co
          JOIN work_orders wo ON wo.id = co.work_order_id
         WHERE ${cConds.join(' AND ')}
      `, cParams));
      }

      const completedByDay = new Map(); // day -> { day, marcadas, pieces, orders: Map }
      for (const row of doneRows) {
        asArray(row.markers).forEach((m, i) => {
          if (!m || m.done !== true || !m.completedAt) return;
          const day = localDay(m.completedAt);
          if (!inRange(day)) return;
          const pieces = markerPieces(m);
          const d = completedByDay.get(day) || { day, marcadas: 0, pieces: 0, orders: new Map() };
          d.marcadas += 1;
          d.pieces += pieces;
          const o = d.orders.get(row.id) || {
            cut_order_id: row.id,
            work_order_no: row.work_order_no,
            customer_po: row.customer_po,
            customer_name: row.customer_name,
            marcadas: 0,
            pieces: 0,
            markers: [],
          };
          o.marcadas += 1;
          o.pieces += pieces;
          o.markers.push(m.name || `Marcada ${i + 1}`);
          d.orders.set(row.id, o);
          completedByDay.set(day, d);
        });
      }
      const byCompletedDay = [...completedByDay.values()]
        .sort((a, b) => (a.day < b.day ? -1 : 1))
        .map((d) => ({
          day: d.day,
          marcadas: d.marcadas,
          pieces: d.pieces,
          orders: [...d.orders.values()].sort((a, b) => b.marcadas - a.marcadas || a.cut_order_id - b.cut_order_id),
        }));
      const completedOrderIds = new Set(byCompletedDay.flatMap((d) => d.orders.map((o) => o.cut_order_id)));
      summary.completed_marcadas_in_range = byCompletedDay.reduce((s, d) => s + d.marcadas, 0);
      summary.completed_pieces_in_range = byCompletedDay.reduce((s, d) => s + d.pieces, 0);
      summary.completed_marcadas_orders = completedOrderIds.size;

      res.json({
        success: true,
        range: { startDate, endDate, allDates, dateBy: byCompleted ? 'completed' : 'cut_date' },
        search: search || null,
        summary,
        byStatus: STATUSES.map((s) => byStatus[s]).filter((r) => r.orders > 0),
        byStage: STAGES.map((s) => byStage[s]).filter((r) => r.orders > 0),
        byTalla: [...byTalla.values()].sort((a, b) => cmpTalla(a.talla, b.talla)),
        byFabric: [...byFabric.values()].sort((a, b) => b.quantity - a.quantity),
        byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
        byCompletedDay,
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