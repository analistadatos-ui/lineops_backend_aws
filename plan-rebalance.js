// plan-rebalance.js
// ---------------------------------------------------------------------------
// Plan Board · Snapshot + Redistribución exacta
//
// 1) SNAPSHOT: before touching anything we freeze every line_assignments row of
//    the affected lines (from `fromDate` onward) into plan_board_snapshots.
//    Any snapshot can be restored later, exactly as it was (original ids).
//
// 2) REDISTRIBUCIÓN: per line, the orders that are 'planned' inside
//    [fromDate, toDate] are re-packed SEQUENTIALLY, filling every working day
//    to the line's full daily capacity before moving on:
//
//        capacity 401/day, order 1,951 pcs  →  401 · 401 · 401 · 401 · 347
//        the next order starts on the same day with the 54 pcs left, etc.
//
//    Rules
//      • The LINE of every order is kept. Only the days (and cell quantities) change.
//      • Order sequence per line = current sequence (first day it appears), or
//        by delivery date if `sequence = "commitment"`.
//      • Weekends and holidays (plant-wide or per line) are skipped.
//      • Rows that are NOT 'planned' (released / completed), pre-order holds and
//        planned rows after `toDate` are FIXED: they keep their place and
//        consume the capacity of their day.
//      • If a line doesn't fit in the range, the rest spills into the next
//        working days, only into free capacity (never overloads a day).
//      • Daily capacity = the SAME number the Plan Board shows / exports as
//        "Capacidad línea/día" (sum of the line's runs on the most-recent
//        configured day, CEO style efficiency overrides, planner-line fallback),
//        rounded to whole pieces.
//
//    Accuracy guarantees (checked inside the transaction; any failure = ROLLBACK):
//      • pieces per (line, order, color) before == after, to the cent
//      • no day on which pieces were placed ends above its capacity
//      • what gets applied is exactly what was previewed (input fingerprint)
//
// Wiring (server1.js):
//   const registerPlanRebalance = require("./plan-rebalance");
//   registerPlanRebalance(app, { authenticateToken, pool, setSchema, planWeekLocks,
//     registerHolidays, getLineCapacityForDate, mergeOrInsertAssignment,
//     cleanupOrphanDraftRuns });
//   …and in the migrations block:
//   await registerPlanRebalance.initSchema({ pool, setSchema });
// ---------------------------------------------------------------------------
const crypto = require("crypto");

// ---------- date helpers (pure strings, timezone-safe) ----------------------
const addDaysStr = (ymd, k) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + k);
  return dt.toISOString().slice(0, 10);
};
const isWeekend = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const g = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return g === 0 || g === 6;
};
const isYmd = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Quantities are handled in integer hundredths (NUMERIC(12,2)) so sums are exact.
const toC = (v) => Math.round((parseFloat(v) || 0) * 100);
const fromC = (c) => Math.round(c) / 100;

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const groupKey = (lineNo, woId, color) => `${lineNo}|${woId}|${color ?? ""}`;

const MAX_SPILL_WORKDAYS = 400; // safety horizon for spill-over

// Optional tables/modules (overrides, planner lines, holds, holidays) must never
// abort the surrounding transaction: in Postgres a failed statement poisons the
// whole transaction even if JS catches the error. Wrap them in a SAVEPOINT.
let spSeq = 0;
async function optional(client, fn, fallback) {
  const sp = `pb_opt_${++spSeq}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    const out = await fn();
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return out;
  } catch (e) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
    return fallback;
  }
}


// ---------------------------------------------------------------------------
// PURE packing engine (exported for tests). No DB access.
//
//   days       : ordered array of working-day strings for this line (>= fromDate)
//   capC(d)    : line capacity for day d, in hundredths of a piece
//   fixedC(d)  : hundredths already taken on day d by fixed rows + holds
//   groups     : [{ key, qtyC, ... }] already in the desired sequence
//   nextDay()  : returns the next working day after the last one in `days`
//                (used to extend the horizon when the range overflows)
//
// Returns { placements: [{ key, date, qtyC }], unplaced: [{ key, qtyC }] }
// ---------------------------------------------------------------------------
function packLine({ days, capC, fixedC, groups, nextDay, maxDays = MAX_SPILL_WORKDAYS }) {
  const used = new Map(); // day -> hundredths used (fixed + placed)
  const usedOf = (d) => (used.has(d) ? used.get(d) : fixedC(d));
  const placements = [];
  const unplaced = [];
  let i = 0;
  const dayAt = (idx) => {
    while (days.length <= idx) {
      if (days.length >= maxDays) return null;
      const nd = nextDay(days[days.length - 1]);
      if (!nd) return null;
      days.push(nd);
    }
    return days[idx];
  };

  for (const g of groups) {
    let rem = g.qtyC;
    while (rem > 0) {
      const d = dayAt(i);
      if (d == null) break;
      const cap = capC(d);
      const free = cap - usedOf(d);
      if (free <= 0) { i++; continue; }
      const q = Math.min(rem, free);
      placements.push({ key: g.key, date: d, qtyC: q });
      used.set(d, usedOf(d) + q);
      rem -= q;
      if (usedOf(d) >= cap) i++; // day full → next order/pieces continue tomorrow
    }
    if (rem > 0) unplaced.push({ key: g.key, qtyC: rem });
  }
  return { placements, unplaced };
}

// ---------------------------------------------------------------------------
// Capacity model — mirrors PlanBoard.jsx `targetForLineOnDate` exactly so the
// redistributed plan fills the cells the board (and the Excel) show as 100%.
// ---------------------------------------------------------------------------
async function loadCapacityModel(client, lineNos) {
  const runs = await client.query(
    `SELECT line_no::text AS line_no, to_char(run_date, 'YYYY-MM-DD') AS d, style,
            operators_count, working_hours, sam_minutes, target_pcs
       FROM line_runs
      WHERE line_no::text = ANY($1::text[]) AND target_pcs IS NOT NULL`,
    [lineNos]
  );
  const ovRows = await optional(client, async () =>
    (await client.query("SELECT UPPER(TRIM(style)) AS k, efficiency FROM style_efficiency_overrides")).rows, []);
  const overrides = new Map(ovRows.map((r) => [r.k, parseFloat(r.efficiency)]));
  const effTarget = (r) => {
    const key = String(r.style || "").trim().toUpperCase();
    const ov = key ? overrides.get(key) : null;
    if (ov != null && ov > 0) {
      const ops = Number(r.operators_count) || 0;
      const wh = Number(r.working_hours) || 0;
      const sam = Number(r.sam_minutes) || 0;
      return sam > 0 ? ((ops * wh * 60) / sam) * ov : 0;
    }
    return Number(r.target_pcs) || 0;
  };
  const perLine = new Map(); // line -> sorted [{d,total}]
  for (const r of runs.rows) {
    if (!r.d) continue;
    if (!perLine.has(r.line_no)) perLine.set(r.line_no, new Map());
    const m = perLine.get(r.line_no);
    m.set(r.d, (m.get(r.d) || 0) + effTarget(r));
  }
  const sorted = new Map();
  for (const [ln, m] of perLine) {
    sorted.set(ln, [...m.entries()].map(([d, total]) => ({ d, total })).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0)));
  }
  const plRows = await optional(client, async () =>
    (await client.query("SELECT line_no::text AS line_no, target_pcs FROM planner_lines")).rows, []);
  const planner = new Map(plRows.map((r) => [r.line_no, Number(r.target_pcs) || 0]));

  // Whole pieces per day (what the board shows), returned in hundredths.
  const capPcs = (lineNo, day) => {
    const list = sorted.get(String(lineNo));
    if (list && list.length) {
      let chosen = null;
      for (const e of list) { if (e.d <= day) chosen = e; else break; }
      return Math.round((chosen || list[0]).total);
    }
    return Math.round(planner.get(String(lineNo)) || 0);
  };
  return { capPcs };
}

// ---------------------------------------------------------------------------
// Build the full plan (used by preview AND apply). Read-only.
// ---------------------------------------------------------------------------
const SNAP_COLS = `la.id, la.work_order_id, la.line_run_id, la.line_no::text AS line_no,
       to_char(la.assigned_date, 'YYYY-MM-DD')      AS assigned_date,
       la.assigned_quantity, la.available_minutes, la.required_production_rate,
       to_char(la.planned_start_date, 'YYYY-MM-DD') AS planned_start_date,
       to_char(la.planned_end_date, 'YYYY-MM-DD')   AS planned_end_date,
       la.priority, la.status::text AS status, la.color`;

async function buildPlan(client, deps, { fromDate, toDate, lines, sequence }) {
  // Lines in scope: requested ones, else every line with a planned row in range.
  let lineNos = Array.isArray(lines) && lines.length ? [...new Set(lines.map(String))] : null;
  if (!lineNos) {
    const r = await client.query(
      `SELECT DISTINCT line_no::text AS line_no FROM line_assignments
        WHERE status::text = 'planned' AND assigned_date BETWEEN $1 AND $2`,
      [fromDate, toDate]
    );
    lineNos = r.rows.map((x) => x.line_no);
  }
  lineNos.sort((a, b) => (Number(a) - Number(b)) || String(a).localeCompare(String(b)));

  const empty = { lineNos, lines: [], placementsByLine: new Map(), moveRows: [], fixedRows: [], all: [], holdsC: new Map(), inputFingerprint: sha1("empty"), unplaced: [] };
  if (!lineNos.length) return empty;

  const rowsRes = await client.query(
    `SELECT ${SNAP_COLS},
            wo.work_order_no, wo.customer_name, wo.style_code, wo.estilo,
            to_char(wo.commitment_date, 'YYYY-MM-DD') AS commitment_date,
            wo.sam_minutes AS wo_sam
       FROM line_assignments la
       JOIN work_orders wo ON wo.id = la.work_order_id
      WHERE la.line_no::text = ANY($1::text[])
        AND la.assigned_date >= $2
        AND la.status::text NOT IN ('cancelled', 'rejected')
      ORDER BY la.line_no, la.assigned_date, la.id`,
    [lineNos, fromDate]
  );
  const all = rowsRes.rows;
  const isMove = (r) => r.status === "planned" && r.assigned_date >= fromDate && r.assigned_date <= toDate;
  const moveRows = all.filter(isMove);
  const fixedRows = all.filter((r) => !isMove(r));

  // Holidays (plant-wide or per line) and pre-order holds.
  const horizonTo = addDaysStr(toDate, 800);
  const plantHol = new Set();
  const lineHol = new Map();
  const hrows = await optional(client, () => deps.registerHolidays.holidaysBetween(client, { from: fromDate, to: horizonTo }), null);
  if (hrows == null) console.warn("⚠️  rebalance: holidays unavailable — only weekends are skipped");
  {
    for (const h of hrows || []) {
      const d = String(h.holiday_date).slice(0, 10);
      if (h.line_no == null) plantHol.add(d);
      else {
        const k = String(h.line_no);
        if (!lineHol.has(k)) lineHol.set(k, new Set());
        lineHol.get(k).add(d);
      }
    }
  }

  const holdsC = new Map(); // `${line}|${day}` -> hundredths
  const holdRows = await optional(client, async () => (await client.query(
    `SELECT line_no::text AS line_no, to_char(assigned_date, 'YYYY-MM-DD') AS d, SUM(quantity) AS q
       FROM pre_order_day_holds
      WHERE line_no::text = ANY($1::text[]) AND assigned_date >= $2
      GROUP BY 1, 2`,
    [lineNos, fromDate]
  )).rows, []);
  for (const r of holdRows) holdsC.set(`${r.line_no}|${r.d}`, toC(r.q));

  const { capPcs } = await loadCapacityModel(client, lineNos);

  const outLines = [];
  const placementsByLine = new Map();
  const unplacedAll = [];

  for (const ln of lineNos) {
    const blocked = (d) => isWeekend(d) || plantHol.has(d) || (lineHol.get(ln)?.has(d) ?? false);
    const nextWorkday = (d) => { let x = addDaysStr(d, 1); let n = 0; while (blocked(x) && n < 60) { x = addDaysStr(x, 1); n++; } return x; };

    // Working days of the range, in order.
    const days = [];
    for (let d = fromDate; d <= toDate; d = addDaysStr(d, 1)) if (!blocked(d)) days.push(d);
    if (!days.length) days.push(nextWorkday(toDate));

    const fixedByDay = new Map();
    for (const r of fixedRows) {
      if (r.line_no !== ln) continue;
      fixedByDay.set(r.assigned_date, (fixedByDay.get(r.assigned_date) || 0) + toC(r.assigned_quantity));
    }
    const fixedC = (d) => (fixedByDay.get(d) || 0) + (holdsC.get(`${ln}|${d}`) || 0);
    const capC = (d) => (blocked(d) ? 0 : capPcs(ln, d) * 100);

    // Groups = one per (order, color) on this line, in sequence.
    const gm = new Map();
    for (const r of moveRows) {
      if (r.line_no !== ln) continue;
      const k = groupKey(ln, r.work_order_id, r.color);
      let g = gm.get(k);
      if (!g) {
        g = {
          key: k, lineNo: ln, workOrderId: Number(r.work_order_id), color: r.color ?? null,
          workOrderNo: r.work_order_no, customer: r.customer_name, styleCode: r.style_code || r.estilo || "",
          commitmentDate: r.commitment_date || null, sam: parseFloat(r.wo_sam) || 0,
          firstDate: r.assigned_date, minId: Number(r.id), priority: Number(r.priority) || 0,
          qtyC: 0, before: new Map(), rowIds: [],
        };
        gm.set(k, g);
      }
      g.qtyC += toC(r.assigned_quantity);
      g.before.set(r.assigned_date, (g.before.get(r.assigned_date) || 0) + toC(r.assigned_quantity));
      g.rowIds.push(Number(r.id));
      if (r.assigned_date < g.firstDate) g.firstDate = r.assigned_date;
      if (Number(r.id) < g.minId) g.minId = Number(r.id);
      g.priority = Math.max(g.priority, Number(r.priority) || 0);
    }
    const groups = [...gm.values()].filter((g) => g.qtyC > 0);
    const byCurrent = (a, b) =>
      (a.firstDate < b.firstDate ? -1 : a.firstDate > b.firstDate ? 1 : 0) ||
      (b.priority - a.priority) || (a.minId - b.minId);
    if (sequence === "commitment") {
      groups.sort((a, b) => {
        const ca = a.commitmentDate || "9999-12-31";
        const cb = b.commitmentDate || "9999-12-31";
        return (ca < cb ? -1 : ca > cb ? 1 : 0) || byCurrent(a, b);
      });
    } else {
      groups.sort(byCurrent);
    }
    if (!groups.length) continue;

    const { placements, unplaced } = packLine({ days, capC, fixedC, groups, nextDay: nextWorkday });
    placementsByLine.set(ln, { placements, groups });
    unplaced.forEach((u) => unplacedAll.push({ ...u, lineNo: ln }));

    // ---- report for the UI ----
    const afterByGroup = new Map();
    for (const p of placements) {
      if (!afterByGroup.has(p.key)) afterByGroup.set(p.key, new Map());
      const m = afterByGroup.get(p.key);
      m.set(p.date, (m.get(p.date) || 0) + p.qtyC);
    }
    const dayset = new Set(days);
    placements.forEach((p) => dayset.add(p.date));
    groups.forEach((g) => g.before.forEach((_, d) => dayset.add(d)));
    const allDays = [...dayset].sort();
    const dayInfo = allDays.map((d) => {
      const cap = capC(d);
      const fixed = fixedC(d);
      let before = fixed, after = fixed;
      for (const g of groups) {
        before += g.before.get(d) || 0;
        after += afterByGroup.get(g.key)?.get(d) || 0;
      }
      return {
        date: d, inRange: d >= fromDate && d <= toDate, blocked: blocked(d),
        capacity: fromC(cap), fixed: fromC(fixed), before: fromC(before), after: fromC(after),
        overBefore: before > cap, overAfter: after > cap && after > fixed,
      };
    });
    const orders = groups.map((g, idx) => {
      const aft = afterByGroup.get(g.key) || new Map();
      const cellsAfter = [...aft.entries()].sort().map(([d, c]) => ({ date: d, qty: fromC(c) }));
      return {
        seq: idx + 1, key: g.key, workOrderId: g.workOrderId, workOrderNo: g.workOrderNo, color: g.color,
        customer: g.customer, styleCode: g.styleCode, commitmentDate: g.commitmentDate,
        totalBefore: fromC(g.qtyC),
        totalAfter: fromC([...aft.values()].reduce((s, c) => s + c, 0)),
        cellsBefore: [...g.before.entries()].sort().map(([d, c]) => ({ date: d, qty: fromC(c) })),
        cellsAfter,
        start: cellsAfter[0]?.date || null,
        end: cellsAfter[cellsAfter.length - 1]?.date || null,
        lateVsCommitment: !!(g.commitmentDate && cellsAfter.length && cellsAfter[cellsAfter.length - 1].date > g.commitmentDate),
      };
    });
    outLines.push({
      lineNo: ln,
      days: dayInfo,
      orders,
      cellsBefore: groups.reduce((s, g) => s + g.before.size, 0),
      cellsAfter: placements.length,
      spillPieces: fromC(placements.filter((p) => p.date > toDate).reduce((s, p) => s + p.qtyC, 0)),
      unplacedPieces: fromC(unplaced.reduce((s, u) => s + u.qtyC, 0)),
    });
  }

  // Fingerprint of the INPUT: every row considered + holds. Apply refuses to run
  // if the board changed since the preview.
  const fpRows = all
    .map((r) => `${r.id}|${r.line_no}|${r.assigned_date}|${toC(r.assigned_quantity)}|${r.status}|${r.color ?? ""}`)
    .sort();
  const fpHolds = [...holdsC.entries()].map(([k, v]) => `${k}|${v}`).sort();
  const inputFingerprint = sha1(JSON.stringify({ fromDate, toDate, lineNos, sequence, fpRows, fpHolds }));

  return { lineNos, lines: outLines, placementsByLine, moveRows, fixedRows, all, holdsC, inputFingerprint, unplaced: unplacedAll };
}

function summarize(plan) {
  const s = { lines: plan.lines.length, orders: 0, piecesBefore: 0, piecesAfter: 0, cellsBefore: 0, cellsAfter: 0,
              overDaysBefore: 0, overDaysAfter: 0, spillPieces: 0, unplacedPieces: 0, lateOrders: 0 };
  for (const l of plan.lines) {
    s.orders += l.orders.length;
    s.piecesBefore += l.orders.reduce((a, o) => a + o.totalBefore, 0);
    s.piecesAfter += l.orders.reduce((a, o) => a + o.totalAfter, 0);
    s.cellsBefore += l.cellsBefore;
    s.cellsAfter += l.cellsAfter;
    s.overDaysBefore += l.days.filter((d) => d.overBefore && d.inRange).length;
    s.overDaysAfter += l.days.filter((d) => d.overAfter).length;
    s.spillPieces += l.spillPieces;
    s.unplacedPieces += l.unplacedPieces;
    s.lateOrders += l.orders.filter((o) => o.lateVsCommitment).length;
  }
  s.piecesBefore = Math.round(s.piecesBefore * 100) / 100;
  s.piecesAfter = Math.round(s.piecesAfter * 100) / 100;
  s.spillPieces = Math.round(s.spillPieces * 100) / 100;
  s.unplacedPieces = Math.round(s.unplacedPieces * 100) / 100;
  s.piecesConserved = toC(s.piecesBefore) === toC(s.piecesAfter);
  return s;
}

// Fingerprint of the planned state of some lines from a date on (restore guard).
async function plannedFingerprint(client, lineNos, fromDate, toDate = null) {
  const r = await client.query(
    `SELECT work_order_id, line_no::text AS line_no, to_char(assigned_date, 'YYYY-MM-DD') AS d,
            assigned_quantity, COALESCE(color, '') AS color
       FROM line_assignments
      WHERE line_no::text = ANY($1::text[]) AND assigned_date >= $2
        AND ($3::date IS NULL OR assigned_date <= $3::date)
        AND status::text = 'planned'`,
    [lineNos, fromDate, toDate]
  );
  return sha1(r.rows.map((x) => `${x.work_order_id}|${x.line_no}|${x.d}|${toC(x.assigned_quantity)}|${x.color}`).sort().join("\n"));
}

async function snapshotRows(client, lineNos, fromDate, toDate = null) {
  const r = await client.query(
    `SELECT ${SNAP_COLS}
       FROM line_assignments la
      WHERE la.line_no::text = ANY($1::text[]) AND la.assigned_date >= $2
        AND ($3::date IS NULL OR la.assigned_date <= $3::date)
        AND la.status::text NOT IN ('cancelled', 'rejected')
      ORDER BY la.line_no, la.assigned_date, la.id`,
    [lineNos, fromDate, toDate]
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
module.exports = function registerPlanRebalance(app, deps) {
  const { authenticateToken, pool, setSchema, planWeekLocks, getLineCapacityForDate,
          mergeOrInsertAssignment, cleanupOrphanDraftRuns } = deps;
  const who = (req) => req.user?.username || req.user?.email || (req.user?.id != null ? String(req.user.id) : null);

  const parseBody = (b = {}) => {
    const fromDate = String(b.fromDate || "").slice(0, 10);
    const toDate = String(b.toDate || "").slice(0, 10);
    if (!isYmd(fromDate) || !isYmd(toDate)) throw Object.assign(new Error("fromDate y toDate (YYYY-MM-DD) son obligatorios"), { status: 400 });
    if (toDate < fromDate) throw Object.assign(new Error("toDate no puede ser anterior a fromDate"), { status: 400 });
    if (addDaysStr(fromDate, 62) < toDate) throw Object.assign(new Error("El rango máximo es de 62 días"), { status: 400 });
    const lines = Array.isArray(b.lines) ? b.lines.map(String).filter(Boolean) : null;
    const sequence = b.sequence === "commitment" ? "commitment" : "current";
    return { fromDate, toDate, lines, sequence };
  };
  const fail = (res, err) => {
    if (planWeekLocks?.isLockError?.(err)) return planWeekLocks.sendLocked(res, err);
    const status = err.status || 500;
    if (status >= 500) console.error("❌ plan-rebalance:", err.message);
    res.status(status).json({ success: false, error: err.message, details: err.details });
  };

  // ---------------- PREVIEW (read-only) ----------------
  app.post("/api/plan-board/rebalance/preview", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const params = parseBody(req.body);
      // Read-only transaction: consistent reads + savepoints for optional data.
      await client.query("BEGIN TRANSACTION READ ONLY");
      const plan = await buildPlan(client, deps, params);
      await client.query("ROLLBACK");
      res.json({ success: true, params, inputFingerprint: plan.inputFingerprint, summary: summarize(plan), lines: plan.lines });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      fail(res, err);
    } finally { client.release(); }
  });

  // ---------------- APPLY (snapshot + write) ----------------
  app.post("/api/plan-board/rebalance/apply", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const params = parseBody(req.body);
      const expectedFp = req.body?.inputFingerprint || null;
      const label = String(req.body?.label || "").slice(0, 200) || null;

      await client.query("BEGIN");
      await planWeekLocks?.enforce?.(client); // 🔒 CEO week locks
      await client.query("SELECT pg_advisory_xact_lock(hashtext('plan-board-rebalance'))");

      // Resolve the lines and lock all their rows from fromDate on BEFORE reading
      // the plan, so nothing can change between the check and the write.
      let scopeLines = params.lines;
      if (!scopeLines || !scopeLines.length) {
        const r = await client.query(
          `SELECT DISTINCT line_no::text AS line_no FROM line_assignments
            WHERE status::text = 'planned' AND assigned_date BETWEEN $1 AND $2`,
          [params.fromDate, params.toDate]
        );
        scopeLines = r.rows.map((x) => x.line_no);
      }
      if (scopeLines.length) {
        await client.query(
          `SELECT id FROM line_assignments
            WHERE line_no::text = ANY($1::text[]) AND assigned_date >= $2 FOR UPDATE`,
          [scopeLines, params.fromDate]
        );
      }
      // Fingerprint is computed with the ORIGINAL params (same as the preview).
      const plan = await buildPlan(client, deps, params);
      if (!plan.lines.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, error: "No hay órdenes planeadas para redistribuir en el rango." });
      }
      if (expectedFp && expectedFp !== plan.inputFingerprint) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, error: "El tablero cambió desde la vista previa. Vuelva a generar la vista previa." });
      }
      if (plan.unplaced.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, error: "Hay piezas que no caben en el horizonte (líneas sin capacidad configurada).", details: plan.unplaced });
      }
      const lineNos = plan.lines.map((l) => l.lineNo);

      // 1) SNAPSHOT of the current state.
      const rowsBefore = plan.all.map(({ work_order_no, customer_name, style_code, estilo, commitment_date, wo_sam, ...r }) => r);
      const before = new Map(); // group -> hundredths (planned rows >= fromDate, whole horizon)
      for (const r of rowsBefore) {
        if (r.status !== "planned") continue;
        const k = groupKey(r.line_no, r.work_order_id, r.color);
        before.set(k, (before.get(k) || 0) + toC(r.assigned_quantity));
      }

      // 2) Remove the rows being redistributed.
      const moveIds = plan.moveRows.map((r) => Number(r.id));
      const vacated = new Map(plan.moveRows.map((r) => [`${r.line_no}|${r.assigned_date}`, { lineNo: r.line_no, date: r.assigned_date }]));
      await client.query("DELETE FROM line_assignments WHERE id = ANY($1::bigint[])", [moveIds]);

      // 3) Write the new cells.
      const capCache = new Map();
      const lineDataFor = async (ln, d) => {
        if (!capCache.has(d)) capCache.set(d, (await getLineCapacityForDate(client, d)).lines);
        return capCache.get(d).find((l) => String(l.line_no) === String(ln)) || null;
      };
      const touchedDays = new Map(); // `${line}|${day}` -> { lineNo, date }
      let written = 0;
      for (const [ln, { placements, groups }] of plan.placementsByLine) {
        const gByKey = new Map(groups.map((g) => [g.key, g]));
        const span = new Map();
        for (const p of placements) {
          const s = span.get(p.key) || { start: p.date, end: p.date };
          if (p.date < s.start) s.start = p.date;
          if (p.date > s.end) s.end = p.date;
          span.set(p.key, s);
        }
        for (const p of placements) {
          const g = gByKey.get(p.key);
          const lineData = await lineDataFor(ln, p.date);
          const ops = parseInt(lineData?.operators_count) || 20;
          const wh = parseFloat(lineData?.working_hours) || 8;
          const eff = parseFloat(lineData?.efficiency) || 0.85;
          const sam = g.sam || parseFloat(lineData?.sam_minutes) || 3.5;
          const availableMinutes = ops * wh * 60 * eff;
          const run = await client.query(
            `SELECT id FROM line_runs
              WHERE line_no::text = $1 AND run_date = $2::date
              ORDER BY (UPPER(TRIM(COALESCE(style, ''))) = UPPER(TRIM($3))) DESC, is_draft ASC, id ASC
              LIMIT 1`,
            [ln, p.date, g.styleCode || ""]
          );
          const s = span.get(p.key);
          await mergeOrInsertAssignment(client, {
            workOrderId: g.workOrderId, lineRunId: run.rows[0]?.id || null, lineNo: ln,
            assignedDate: p.date, quantity: fromC(p.qtyC), availableMinutes,
            requiredRate: sam > 0 ? availableMinutes / sam : 0,
            startDate: s.start, endDate: s.end, status: "planned", color: g.color,
          });
          touchedDays.set(`${ln}|${p.date}`, { lineNo: ln, date: p.date });
          written++;
        }
      }

      // 4) VERIFY — 100% or nothing.
      const afterRes = await client.query(
        `SELECT line_no::text AS line_no, work_order_id, color, SUM(assigned_quantity) AS q
           FROM line_assignments
          WHERE line_no::text = ANY($1::text[]) AND assigned_date >= $2 AND status::text = 'planned'
          GROUP BY 1, 2, 3`,
        [lineNos, params.fromDate]
      );
      const after = new Map(afterRes.rows.map((r) => [groupKey(r.line_no, r.work_order_id, r.color), toC(r.q)]));
      const mismatches = [];
      for (const k of new Set([...before.keys(), ...after.keys()])) {
        if ((before.get(k) || 0) !== (after.get(k) || 0)) mismatches.push({ key: k, before: fromC(before.get(k) || 0), after: fromC(after.get(k) || 0) });
      }
      const overloads = [];
      for (const l of plan.lines) {
        const capByDay = new Map(l.days.map((d) => [d.date, toC(d.capacity)]));
        const dayList = [...touchedDays.values()].filter((t) => t.lineNo === l.lineNo).map((t) => t.date);
        if (!dayList.length) continue;
        const tot = await client.query(
          `SELECT to_char(assigned_date, 'YYYY-MM-DD') AS d, SUM(assigned_quantity) AS q
             FROM line_assignments
            WHERE line_no::text = $1 AND assigned_date = ANY($2::date[])
              AND status::text NOT IN ('cancelled', 'rejected')
            GROUP BY 1`,
          [l.lineNo, dayList]
        );
        for (const r of tot.rows) {
          const load = toC(r.q) + (plan.holdsC.get(`${l.lineNo}|${r.d}`) || 0);
          const cap = capByDay.get(r.d) ?? 0;
          if (load > cap) overloads.push({ lineNo: l.lineNo, date: r.d, load: fromC(load), capacity: fromC(cap) });
        }
      }
      if (mismatches.length || overloads.length) {
        await client.query("ROLLBACK");
        return res.status(500).json({
          success: false,
          error: "Verificación fallida: no se aplicó ningún cambio.",
          details: { mismatches: mismatches.slice(0, 50), overloads: overloads.slice(0, 50) },
        });
      }

      // 5) Tidy orphan draft runs on days that lost all their orders.
      for (const c of vacated.values()) {
        if (!touchedDays.has(`${c.lineNo}|${c.date}`)) await cleanupOrphanDraftRuns(client, c.lineNo, c.date);
      }

      const rowsAfter = await snapshotRows(client, lineNos, params.fromDate);
      const afterFp = await plannedFingerprint(client, lineNos, params.fromDate);
      const summary = summarize(plan);
      const snap = await client.query(
        `INSERT INTO plan_board_snapshots
           (kind, label, from_date, to_date, lines, params, rows_before, rows_after, after_fingerprint, summary, created_by)
         VALUES ('rebalance', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, created_at`,
        [label, params.fromDate, params.toDate, lineNos, JSON.stringify(params), JSON.stringify(rowsBefore),
         JSON.stringify(rowsAfter), afterFp, JSON.stringify({ ...summary, rowsDeleted: moveIds.length, cellsWritten: written }), who(req)]
      );
      await client.query("COMMIT");
      res.json({ success: true, snapshotId: snap.rows[0].id, summary, rowsDeleted: moveIds.length, cellsWritten: written });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      fail(res, err);
    } finally { client.release(); }
  });

  // ---------------- MANUAL SNAPSHOT (no changes) ----------------
  app.post("/api/plan-board/snapshots", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { fromDate, toDate, lines } = parseBody(req.body);
      const label = String(req.body?.label || "").slice(0, 200) || null;
      let lineNos = lines;
      if (!lineNos || !lineNos.length) {
        const r = await client.query(
          `SELECT DISTINCT line_no::text AS line_no FROM line_assignments
            WHERE status::text NOT IN ('cancelled', 'rejected') AND assigned_date BETWEEN $1 AND $2`,
          [fromDate, toDate]
        );
        lineNos = r.rows.map((x) => x.line_no);
      }
      if (!lineNos.length) return res.status(400).json({ success: false, error: "No hay asignaciones en el rango." });
      const rows = await snapshotRows(client, lineNos, fromDate, toDate);
      const pieces = fromC(rows.reduce((s, r) => s + toC(r.assigned_quantity), 0));
      const fp = await plannedFingerprint(client, lineNos, fromDate, toDate);
      const snap = await client.query(
        `INSERT INTO plan_board_snapshots
           (kind, label, from_date, to_date, lines, params, rows_before, after_fingerprint, summary, created_by)
         VALUES ('manual', $1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, created_at`,
        [label, fromDate, toDate, lineNos, JSON.stringify({ fromDate, toDate }), JSON.stringify(rows), fp,
         JSON.stringify({ rows: rows.length, pieces, lines: lineNos.length }), who(req)]
      );
      res.json({ success: true, snapshotId: snap.rows[0].id, rows: rows.length, pieces });
    } catch (err) { fail(res, err); } finally { client.release(); }
  });

  // ---------------- LIST / GET ----------------
  app.get("/api/plan-board/snapshots", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { from, to } = req.query;
      const r = await client.query(
        `SELECT id, kind, label, to_char(from_date, 'YYYY-MM-DD') AS from_date, to_char(to_date, 'YYYY-MM-DD') AS to_date,
                lines, summary, status, created_by, created_at, restored_at, restored_by,
                jsonb_array_length(rows_before) AS rows_count
           FROM plan_board_snapshots
          WHERE ($1::date IS NULL OR COALESCE(to_date, from_date) >= $1::date)
            AND ($2::date IS NULL OR from_date <= $2::date)
          ORDER BY created_at DESC
          LIMIT 100`,
        [isYmd(from) ? from : null, isYmd(to) ? to : null]
      );
      res.json({ success: true, snapshots: r.rows });
    } catch (err) { fail(res, err); } finally { client.release(); }
  });

  app.get("/api/plan-board/snapshots/:id", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const r = await client.query("SELECT * FROM plan_board_snapshots WHERE id = $1", [parseInt(req.params.id)]);
      if (!r.rowCount) return res.status(404).json({ success: false, error: "Snapshot no encontrado" });
      res.json({ success: true, snapshot: r.rows[0] });
    } catch (err) { fail(res, err); } finally { client.release(); }
  });

  // ---------------- RESTORE ----------------
  // rebalance snapshot → lines back to their exact pre-rebalance state from from_date on.
  // manual snapshot    → planned rows of [from_date, to_date] back to the snapshot.
  // Guarded: if the board changed since, returns 409 unless { force: true }.
  app.post("/api/plan-board/snapshots/:id/restore", authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const id = parseInt(req.params.id);
      const force = req.body?.force === true;
      await client.query("BEGIN");
      await planWeekLocks?.enforce?.(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('plan-board-rebalance'))");

      const sr = await client.query(
        `SELECT id, kind, status, lines, after_fingerprint, rows_before,
                to_char(from_date, 'YYYY-MM-DD') AS from_date, to_char(to_date, 'YYYY-MM-DD') AS to_date
           FROM plan_board_snapshots WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (!sr.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "Snapshot no encontrado" }); }
      const snap = sr.rows[0];
      const lineNos = snap.lines.map(String);
      const upper = snap.kind === "manual" ? snap.to_date : null;

      const currentFp = await plannedFingerprint(client, lineNos, snap.from_date, upper);
      if (!force && snap.after_fingerprint && currentFp !== snap.after_fingerprint) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false, conflict: true,
          error: snap.kind === "manual"
            ? "El tablero cambió desde este snapshot. Restaurar reemplazará los cambios posteriores en ese rango."
            : "El tablero cambió después de la redistribución. Restaurar reemplazará esos cambios posteriores.",
        });
      }

      const cur = await client.query(
        `SELECT id, line_no::text AS line_no, to_char(assigned_date, 'YYYY-MM-DD') AS d
           FROM line_assignments
          WHERE line_no::text = ANY($1::text[]) AND assigned_date >= $2
            AND ($3::date IS NULL OR assigned_date <= $3::date)
            AND status::text = 'planned'
          FOR UPDATE`,
        [lineNos, snap.from_date, upper]
      );
      const cells = new Map(cur.rows.map((r) => [`${r.line_no}|${r.d}`, { lineNo: r.line_no, date: r.d }]));
      await client.query("DELETE FROM line_assignments WHERE id = ANY($1::bigint[])", [cur.rows.map((r) => Number(r.id))]);

      const planned = (snap.rows_before || []).filter((r) => r.status === "planned");
      let restored = 0, skipped = 0, restoredC = 0, expectedC = 0;
      for (const r of planned) {
        expectedC += toC(r.assigned_quantity);
        await client.query("SAVEPOINT rs");
        try {
          const ins = await client.query(
            `INSERT INTO line_assignments
                (id, work_order_id, line_run_id, line_no, assigned_date, assigned_quantity,
                 available_minutes, required_production_rate, planned_start_date, planned_end_date,
                 priority, status, color)
              VALUES ($1, $2, (SELECT lr.id FROM line_runs lr WHERE lr.id = $3), $4, $5, $6, $7, $8, $9, $10, $11, 'planned', $12)
              ON CONFLICT (id) DO NOTHING
              RETURNING id`,
            [r.id, r.work_order_id, r.line_run_id, r.line_no, r.assigned_date, r.assigned_quantity,
             r.available_minutes, r.required_production_rate, r.planned_start_date, r.planned_end_date,
             r.priority ?? 0, r.color || null]
          );
          await client.query("RELEASE SAVEPOINT rs");
          if (ins.rowCount) { restored++; restoredC += toC(r.assigned_quantity); }
          else skipped++; // id now belongs to a row that changed status (released/completed) — left as is
        } catch (e) {
          await client.query("ROLLBACK TO SAVEPOINT rs");
          if (e.code === "23505") { skipped++; continue; }
          throw e;
        }
        cells.delete(`${r.line_no}|${r.assigned_date}`);
      }
      for (const c of cells.values()) await cleanupOrphanDraftRuns(client, c.lineNo, c.date);

      await client.query(
        "UPDATE plan_board_snapshots SET status = 'restored', restored_at = now(), restored_by = $2 WHERE id = $1",
        [id, who(req)]
      );
      await client.query("COMMIT");
      res.json({ success: true, restored, skipped, piecesRestored: fromC(restoredC), piecesInSnapshot: fromC(expectedC) });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      fail(res, err);
    } finally { client.release(); }
  });
};

module.exports.initSchema = async ({ pool, setSchema }) => {
  const client = await pool.connect();
  try {
    await setSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS plan_board_snapshots(
        id BIGSERIAL PRIMARY KEY,
        kind VARCHAR(20) NOT NULL DEFAULT 'manual',
        label TEXT,
        from_date DATE NOT NULL,
        to_date DATE,
        lines TEXT[] NOT NULL DEFAULT '{}',
        params JSONB,
        rows_before JSONB NOT NULL DEFAULT '[]',
        rows_after JSONB,
        after_fingerprint TEXT,
        summary JSONB,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        restored_at TIMESTAMPTZ,
        restored_by TEXT,
        CONSTRAINT chk_pbs_kind CHECK (kind IN ('manual', 'rebalance')),
        CONSTRAINT chk_pbs_status CHECK (status IN ('active', 'restored'))
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_pbs_range ON plan_board_snapshots(from_date, to_date);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_pbs_created ON plan_board_snapshots(created_at DESC);");
    console.log("✅ plan_board_snapshots ready");
  } finally {
    client.release();
  }
};

module.exports.packLine = packLine; // for tests