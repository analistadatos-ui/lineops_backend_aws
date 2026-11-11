// ==========================================================================
// verificador-report.js
//
// Pestaña "Reportes semanas bloqueadas" del Verificador.
//
//   GET /api/verificador/locked-weeks
//       Semanas bloqueadas por el CEO (plan-week-locks), con corridas, líneas
//       y piezas terminadas de cada una.
//
//   GET /api/verificador/production-report?week=YYYY-MM-DD[&customer=..][&style=..][&format=json|xlsx]
//       Producción de UNA semana bloqueada, opcionalmente filtrada por cliente
//       y/o estilo interno (line_runs.style).
//         format=json -> vista previa + listas de clientes/estilos para los filtros
//         format=xlsx -> Excel con 6 hojas, mismo formato que el reporte NIKE:
//                        Summary (por estilo) · Daily · Production detail ·
//                        Forward schedule · Plan board · Plan by week
//       Forward schedule / Plan by week = lo PLANEADO desde el lunes de la semana actual hasta el viernes
//       de la semana actual + 4 (line_assignments del Plan Board), con los
//       mismos filtros de cliente/estilo. Una fila por celda del Plan Board:
//       su día (assigned_date) y su cantidad (assigned_quantity).
//       Si la semana NO está bloqueada responde 409.
//
// "Output" = piezas de las operaciones de empaque/terminado, con las MISMAS
// palabras clave que PACKING_KEYWORDS en work-orders.js.
//
// Corridas SIN orden ligada (line_runs.work_order_id NULL): el cliente, estilo
// cliente y temporada se toman de la orden más reciente con el mismo
// style_code, para que el filtro por cliente no las pierda. En el Excel salen
// marcadas en rojo (igual que en el reporte NIKE) para que se liguen.
//
// "Internal order no." = work_orders.tech_pack_no (el número NKB-… de Nike).
//
// --------------------------------------------------------------------------
// SETUP
// --------------------------------------------------------------------------
//   npm install exceljs
//
// En server.js, DESPUÉS de POST /api/verificador/update-sewed:
//     const registerVerificadorReport = require("./verificador-report");
//     registerVerificadorReport(app, { authenticateToken, pool, setSchema, requireVerificador });
// ==========================================================================

const ExcelJS = require("exceljs");
const planWeekLocks = require("./plan-week-locks");
// Avisa al panel del CEO cada vez que se descarga el Excel.
const verificadorActivity = require("./verificador-activity");

const PACKING_KEYWORDS = ["pack", "emp", "termin", "finish"];
const PACKING_SQL = PACKING_KEYWORDS
  .map((k) => `lower(oo.operation_name) LIKE '%${k}%'`)
  .join(" OR ");

const DOW_ES = ["", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
const DOW_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------------------------------------------------------------- helpers --
const pad = (n) => String(n).padStart(2, "0");

function ymd(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    return isNaN(v) ? null : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  if (typeof v === "object") return ymd(v.week_start ?? v.weekStart ?? v.date ?? null);
  const str = String(v).trim();
  const m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  // dd/mm/yyyy (formato local de México)
  const dmy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${pad(dmy[2])}-${pad(dmy[1])}`;
  // Cualquier otra cosa que Date entienda ("Mon Oct 26 2026 ...", timestamp).
  const d = new Date(/^\d+$/.test(str) ? Number(str) : str);
  return isNaN(d) ? null : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDays(s, n) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const utcDate = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
function isoWeek(s) {
  const dt = utcDate(s);
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return { year: dt.getUTCFullYear(), week: Math.ceil(((dt - yearStart) / 86400000 + 1) / 7) };
}
const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const round = (v, d = 2) => Math.round(num(v) * 10 ** d) / 10 ** d;
const lineSort = (a, b) => {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na; // L15, L9, L5, L3 como el reporte NIKE
  return String(a).localeCompare(String(b));
};

async function listLockedWeeks(client) {
  const set = await planWeekLocks.lockedWeekSet(client);
  let raw = [];
  if (set instanceof Set || Array.isArray(set)) raw = [...set];
  else if (set instanceof Map) raw = [...set.keys()];
  else if (set && typeof set === "object") raw = Object.keys(set);
  const weeks = new Set();
  for (const v of raw) {
    const d = ymd(v);
    if (!d) continue;
    const ws = ymd(planWeekLocks.weekStartOf(d));
    if (ws && planWeekLocks.isLockedDay(set, ws)) weeks.add(ws);
  }
  return { set, weeks: [...weeks].sort().reverse() };
}

function weekInfo(weekStart) {
  const { year, week } = isoWeek(weekStart);
  return { week_start: weekStart, week_end: addDays(weekStart, 6), iso_year: year, iso_week: week };
}

function rangeLabel(info) {
  const [y1, m1, d1] = info.week_start.split("-").map(Number);
  const [y2, m2, d2] = info.week_end.split("-").map(Number);
  const a = `${MONTHS_EN[m1 - 1]} ${d1}`;
  const b = m1 === m2 ? `${d2}` : `${MONTHS_EN[m2 - 1]} ${d2}`;
  return `Week ${info.iso_week}, ${a}–${b}, ${y2 !== y1 ? `${y1}/${y2}` : y2}`;
}

// --------------------------------------------------------------- queries ---
// Una fila por corrida (día + línea + estilo).
async function fetchRuns(client, from, to) {
  const { rows } = await client.query(
    `SELECT lr.id AS run_id,
            to_char(lr.run_date, 'YYYY-MM-DD') AS run_date,
            EXTRACT(ISODOW FROM lr.run_date)::int AS dow,
            lr.line_no, lr.style,
            lr.operators_count, lr.working_hours, lr.sam_minutes, lr.target_pcs,
            (wo.id IS NOT NULL) AS linked,
            wo.work_order_no, wo.customer_po, wo.tech_pack_no,
            COALESCE(wo.customer_name, fb.customer_name) AS customer_name,
            COALESCE(wo.estilo, fb.estilo)               AS client_style,
            COALESCE(wo.season, fb.season)               AS season,
            COALESCE(p.produced, 0) AS produced,
            EXISTS (SELECT 1 FROM operator_operations oo
                     WHERE oo.run_id = lr.id AND (${PACKING_SQL})) AS has_packing_op
       FROM line_runs lr
       LEFT JOIN work_orders wo ON wo.id = lr.work_order_id
       LEFT JOIN LATERAL (
         SELECT w2.customer_name, w2.estilo, w2.season
           FROM work_orders w2
          WHERE lr.work_order_id IS NULL AND w2.style_code = lr.style
          ORDER BY w2.created_at DESC
          LIMIT 1
       ) fb ON true
       LEFT JOIN LATERAL (
         SELECT SUM(se.sewed_qty) FILTER (WHERE (${PACKING_SQL})) AS produced
           FROM operation_sewed_entries se
           JOIN operator_operations oo ON oo.id = se.operation_id
          WHERE se.run_id = lr.id
       ) p ON true
      WHERE lr.run_date BETWEEN $1::date AND $2::date
      ORDER BY lr.run_date, lr.line_no, lr.style`,
    [from, to]
  );

  return rows.map((r) => {
    const operators = num(r.operators_count);
    const hours = round(r.working_hours);
    const sam = round(r.sam_minutes, 3);
    const target = round(r.target_pcs, 0);
    const produced = round(r.produced, 0);
    const samMin = Math.round(produced * sam);
    const minutes = Math.round(operators * hours * 60);
    return {
      run_id: Number(r.run_id),
      run_date: r.run_date,
      day: DOW_ES[r.dow] || "",
      line_no: r.line_no,
      style: r.style,
      customer_name: r.customer_name || null,
      client_style: r.client_style || null,
      linked: !!r.linked,
      work_order_no: r.work_order_no || null,
      customer_po: r.customer_po || null,
      tech_pack_no: r.tech_pack_no || null,
      season: r.season || null,
      operators,
      hours,
      sam,
      target,
      produced,
      difference: produced - target,
      fulfillment_pct: target > 0 ? round((produced * 100) / target, 1) : null,
      sam_min: samMin,
      minutes,
      efficiency_pct: minutes > 0 ? round((samMin * 100) / minutes, 1) : null,
      has_packing_op: !!r.has_packing_op,
    };
  });
}

function totalsOf(rows) {
  const t = rows.reduce(
    (a, r) => {
      a.runs += 1;
      a.target += r.target;
      a.produced += r.produced;
      a.sam_min += r.sam_min;
      a.minutes += r.minutes;
      a.lines.add(String(r.line_no));
      if (!r.has_packing_op) a.noPack += 1;
      if (!r.linked) a.unlinked += 1;
      return a;
    },
    { runs: 0, target: 0, produced: 0, sam_min: 0, minutes: 0, lines: new Set(), noPack: 0, unlinked: 0 }
  );
  return {
    runs: t.runs,
    lines: t.lines.size,
    target: t.target,
    produced: t.produced,
    difference: t.produced - t.target,
    fulfillment_pct: t.target > 0 ? round((t.produced * 100) / t.target, 1) : null,
    efficiency_pct: t.minutes > 0 ? round((t.sam_min * 100) / t.minutes, 1) : null,
    runs_without_packing_op: t.noPack,
    runs_without_order: t.unlinked,
  };
}

// Opciones para los filtros (de la semana completa, sin filtrar).
function filterOptions(rows) {
  const customers = [...new Set(rows.map((r) => r.customer_name).filter(Boolean))].sort();
  const styleMap = new Map();
  for (const r of rows) {
    if (!styleMap.has(r.style)) styleMap.set(r.style, { style: r.style, client_style: r.client_style, customer_name: r.customer_name });
  }
  const styles = [...styleMap.values()].sort((a, b) => a.style.localeCompare(b.style));
  return { customers, styles };
}

function applyFilters(rows, { customer, style }) {
  return rows.filter(
    (r) =>
      (!customer || (r.customer_name || "") === customer) &&
      (!style || r.style === style)
  );
}

// ------------------------------------------------------- forward plan ----
const FORWARD_WEEKS = 4; // semana actual + 4

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const dowUtc = (s) => utcDate(s).getUTCDay(); // 0 = domingo
const mondayOf = (s) => addDays(s, -((dowUtc(s) + 6) % 7));
const isWorkday = (s) => {
  const d = dowUtc(s);
  return d >= 1 && d <= 5;
};
function workdaysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkday(d)) out.push(d);
  return out;
}

// Desde el LUNES de la semana actual (no desde hoy), para que la semana en
// curso salga completa en 'Forward schedule' y 'Plan by week'.
function forwardWindow() {
  const today = todayYmd();
  const from = mondayOf(today); // lunes de la semana actual
  const to = addDays(from, FORWARD_WEEKS * 7 + 4); // viernes de la semana +4
  return { from, to };
}

// Una fila por celda del Plan Board.
//
// En el Plan Board cada asignación es UNA celda: un día (assigned_date) con su
// cantidad (assigned_quantity). planned_start_date / planned_end_date NO son el
// rango de esa celda: al fusionar celdas (mergeOrInsertAssignment) se ensanchan
// con LEAST/GREATEST, así que varias celdas de la misma orden terminan con el
// mismo rango lun–jue. Antes se repartía cada celda en ese rango y la orden
// salía repetida (3 filas por día en la línea 9). Ahora cada celda va en su
// día y con su cantidad completa, igual que se ve en el tablero.
//
// "Planned start" / "Planned end" del Excel = primer y último día que esa
// orden+color tiene en esa línea (todas sus celdas activas, no solo las de la
// ventana).
async function fetchForward(client, { from, to }) {
  const { rows } = await client.query(
    `WITH cells AS (
       SELECT la.*,
              COALESCE(la.assigned_date, la.planned_start_date) AS cell_date
         FROM line_assignments la
         JOIN work_orders wo ON wo.id = la.work_order_id
        WHERE la.status NOT IN ('cancelled', 'completed')
          AND wo.status <> 'completed'
     ),
     ranged AS (
       SELECT c.*,
              MIN(c.cell_date) OVER w AS run_start,
              MAX(c.cell_date) OVER w AS run_end
         FROM cells c
       WINDOW w AS (PARTITION BY c.work_order_id, c.line_no, COALESCE(c.color, ''))
     )
     SELECT r.id, r.line_no,
            to_char(r.cell_date, 'YYYY-MM-DD') AS d,
            to_char(r.run_start, 'YYYY-MM-DD') AS ps,
            to_char(r.run_end,   'YYYY-MM-DD') AS pe,
            r.assigned_quantity,
            COALESCE(NULLIF(TRIM(r.color), ''), wo.color) AS color,
            wo.work_order_no, wo.customer_name, wo.style_code, wo.estilo,
            wo.customer_po, wo.tech_pack_no, wo.season
       FROM ranged r
       JOIN work_orders wo ON wo.id = r.work_order_id
      WHERE r.cell_date BETWEEN $1::date AND $2::date`,
    [from, to]
  );

  const out = [];
  for (const r of rows) {
    const qty = Math.round(num(r.assigned_quantity));
    if (!r.d || qty <= 0) continue;
    const lineNum = Number(r.line_no);
    out.push({
      date: r.d,
      week_of: mondayOf(r.d),
      line_no: Number.isFinite(lineNum) ? lineNum : r.line_no,
      style: r.style_code || "",
      customer_name: r.customer_name || null,
      client_style: r.estilo || null,
      work_order_no: r.work_order_no,
      customer_po: r.customer_po || null,
      tech_pack_no: r.tech_pack_no || null,
      season: r.season || null,
      color: r.color || null,
      qty,
      planned_start: r.ps || r.d,
      planned_end: r.pe || r.d,
    });
  }
  out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      String(a.line_no).localeCompare(String(b.line_no), undefined, { numeric: true }) ||
      String(a.work_order_no).localeCompare(String(b.work_order_no))
  );
  return out;
}

function forwardSummary(rows, win) {
  return {
    from: win.from,
    to: win.to,
    rows: rows.length,
    planned: rows.reduce((s, r) => s + r.qty, 0),
    lines: new Set(rows.map((r) => String(r.line_no))).size,
  };
}

// ------------------------------------------------------------------ XLSX ---
const FONT = "Arial";
const NAVY = "FF1F3864";
const F_HEAD = { name: FONT, size: 10, bold: true, color: { argb: "FFFFFFFF" } };
const F_BODY = { name: FONT, size: 10, color: { argb: "FF000000" } };
const F_BOLD = { name: FONT, size: 10, bold: true, color: { argb: "FF000000" } };
const F_TITLE = { name: FONT, size: 14, bold: true };
const F_NOTE = { name: FONT, size: 9, color: { argb: "FF595959" } };
const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const FILL_HEAD = fill(NAVY);
const FILL_TOTAL = fill("FFD9E1F2");
const FILL_GREY = fill("FFF2F2F2");
const FILL_RED = fill("FFFCE4D6");
const FILL_YELLOW = fill("FFFFF2CC");
const FMT_INT = "#,##0;\\-#,##0;\\-";
const FMT_PCT = "0.0%";
const FMT_DATE = "yyyy\\-mm\\-dd";

function header(ws, rowNo, labels) {
  const row = ws.getRow(rowNo);
  labels.forEach((l, i) => {
    const c = row.getCell(i + 1);
    c.value = l;
    c.font = F_HEAD;
    c.fill = FILL_HEAD;
    c.alignment = { vertical: "middle", wrapText: true };
  });
  row.height = 28;
}
function title(ws, text, note) {
  ws.getCell("A1").value = text;
  ws.getCell("A1").font = F_TITLE;
  ws.getCell("A2").value = note;
  ws.getCell("A2").font = F_NOTE;
}
function styleRow(row, n, { font = F_BODY, fillAll = null } = {}) {
  for (let i = 1; i <= n; i++) {
    const c = row.getCell(i);
    c.font = font;
    if (fillAll) c.fill = fillAll;
  }
}
const F = (formula, result) => ({ formula, result });
const safeDiv = (a, b) => (b ? a / b : "");

async function buildWorkbook(rows, info, { customer, style }, forward = { rows: [], win: forwardWindow() }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "SKM production system";
  wb.created = new Date();

  const who = customer ? customer.toUpperCase() : "All clients";
  const tag = customer || "Client";
  const range = rangeLabel(info);
  const today = new Date().toISOString().slice(0, 10);
  const filterNote = `Filters: client = ${customer || "all"}; style = ${style || "all"}.`;

  // ------------------------------------------------ Production detail ----
  const det = wb.addWorksheet("Production detail", { views: [{ state: "frozen", ySplit: 4, showGridLines: false }] });
  title(
    det,
    `${who} Production Detail – ${range}`,
    `One row per day + line + style. Fill the ${tag} internal order no. (yellow column). Rows in red have no work order linked in the system. ${filterNote}`
  );
  const detCols = [
    "Date", "Line", "Style", "Client", `${tag} style`, "Work order", "Customer PO",
    `${tag} internal order no.`, "Season", "Operators", "Hours", "SAM",
    "Target (pcs)", "Output (pcs)", "Achievement %", "SAM min produced", "Minutes available", "Efficiency %",
  ];
  header(det, 4, detCols);
  [11, 6, 11, 14, 11, 26, 18, 20, 9, 10, 8, 7, 11, 11, 12, 13, 13, 11].forEach((w, i) => (det.getColumn(i + 1).width = w));

  const first = 5;
  const last = first + rows.length - 1;
  rows.forEach((r, i) => {
    const n = first + i;
    const lineNum = Number(r.line_no);
    const row = det.getRow(n);
    row.values = [
      utcDate(r.run_date),
      Number.isFinite(lineNum) ? lineNum : r.line_no,
      r.style,
      r.customer_name || "",
      r.client_style || "",
      r.work_order_no || "",
      r.customer_po || "",
      r.tech_pack_no || "",
      r.season || "",
      r.operators,
      r.hours,
      r.sam,
      r.target,
      r.produced,
      F(`IF(M${n}=0,"",N${n}/M${n})`, safeDiv(r.produced, r.target)),
      F(`ROUND(N${n}*L${n},0)`, r.sam_min),
      F(`J${n}*K${n}*60`, r.minutes),
      F(`IF(Q${n}=0,"",P${n}/Q${n})`, safeDiv(r.sam_min, r.minutes)),
    ];
    styleRow(row, detCols.length);
    row.getCell(1).numFmt = FMT_DATE;
    row.getCell(2).numFmt = "0";
    row.getCell(7).numFmt = "@";
    row.getCell(10).numFmt = "0";
    row.getCell(11).numFmt = "0.00";
    row.getCell(12).numFmt = "0.00";
    [13, 14, 16, 17].forEach((c) => (row.getCell(c).numFmt = FMT_INT));
    [15, 18].forEach((c) => (row.getCell(c).numFmt = FMT_PCT));
    row.getCell(8).fill = FILL_YELLOW;
    if (!r.linked) {
      row.getCell(6).fill = FILL_RED;
      row.getCell(7).fill = FILL_RED;
    }
  });

  const tot = totalsOf(rows);
  const avgOps = rows.length ? Math.round(rows.reduce((s, r) => s + r.operators, 0) / rows.length) : 0;
  const dT = last + 1;
  const dRow = det.getRow(dT);
  dRow.getCell(1).value = "TOTAL";
  dRow.getCell(10).value = F(`ROUND(AVERAGE(J${first}:J${last}),0)`, avgOps);
  dRow.getCell(13).value = F(`SUM(M${first}:M${last})`, tot.target);
  dRow.getCell(14).value = F(`SUM(N${first}:N${last})`, tot.produced);
  dRow.getCell(15).value = F(`IF(M${dT}=0,"",N${dT}/M${dT})`, safeDiv(tot.produced, tot.target));
  const samSum = rows.reduce((s, r) => s + r.sam_min, 0);
  const minSum = rows.reduce((s, r) => s + r.minutes, 0);
  dRow.getCell(16).value = F(`SUM(P${first}:P${last})`, samSum);
  dRow.getCell(17).value = F(`SUM(Q${first}:Q${last})`, minSum);
  dRow.getCell(18).value = F(`IF(Q${dT}=0,"",P${dT}/Q${dT})`, safeDiv(samSum, minSum));
  styleRow(dRow, detCols.length, { font: F_BOLD, fillAll: FILL_TOTAL });
  dRow.getCell(10).numFmt = "0";
  [13, 14, 16, 17].forEach((c) => (dRow.getCell(c).numFmt = FMT_INT));
  [15, 18].forEach((c) => (dRow.getCell(c).numFmt = FMT_PCT));
  det.autoFilter = { from: { row: 4, column: 1 }, to: { row: last, column: detCols.length } };

  const D = (col) => `'Production detail'!$${col}$${first}:$${col}$${last}`;

  // ------------------------------------------------------------ Summary ----
  const sum = wb.addWorksheet("Summary", { views: [{ showGridLines: false }] });
  title(
    sum,
    `${who} Production Summary – ${range}`,
    `Internal and ${tag} style are the same garment and are combined. Figures are calculated from the 'Production detail' sheet. ${filterNote}`
  );
  const sumCols = [
    "Style", "Client", `${tag} style`, "Line-days", "Avg operators", "Target (pcs)", "Output (pcs)",
    "Achievement %", "SAM", "SAM min produced", "Minutes available", "Efficiency %",
  ];
  header(sum, 4, sumCols);
  [12, 14, 11, 10, 12, 13, 13, 13, 8, 15, 15, 12].forEach((w, i) => (sum.getColumn(i + 1).width = w));

  const byStyle = new Map();
  for (const r of rows) {
    const g = byStyle.get(r.style) || { style: r.style, clients: new Set(), cstyles: new Set(), rows: [] };
    if (r.customer_name) g.clients.add(r.customer_name);
    if (r.client_style) g.cstyles.add(r.client_style);
    g.rows.push(r);
    byStyle.set(r.style, g);
  }
  const groups = [...byStyle.values()].sort((a, b) => a.style.localeCompare(b.style));
  groups.forEach((g, i) => {
    const n = 5 + i;
    const s = (k) => g.rows.reduce((a, r) => a + r[k], 0);
    const cnt = g.rows.length, ops = s("operators"), tg = s("target"), out = s("produced"), sm = s("sam_min"), mn = s("minutes");
    const row = sum.getRow(n);
    row.values = [
      g.style,
      [...g.clients].join(", "),
      [...g.cstyles].join(", "),
      F(`COUNTIF(${D("C")},A${n})`, cnt),
      F(`IF(D${n}=0,"",ROUND(SUMIF(${D("C")},A${n},${D("J")})/D${n},0))`, cnt ? Math.round(ops / cnt) : ""),
      F(`SUMIF(${D("C")},A${n},${D("M")})`, tg),
      F(`SUMIF(${D("C")},A${n},${D("N")})`, out),
      F(`IF(F${n}=0,"",G${n}/F${n})`, safeDiv(out, tg)),
      F(`IF(G${n}=0,"",J${n}/G${n})`, safeDiv(sm, out)),
      F(`SUMIF(${D("C")},A${n},${D("P")})`, sm),
      F(`SUMIF(${D("C")},A${n},${D("Q")})`, mn),
      F(`IF(K${n}=0,"",J${n}/K${n})`, safeDiv(sm, mn)),
    ];
    styleRow(row, sumCols.length);
    row.getCell(4).numFmt = "0";
    row.getCell(5).numFmt = "0";
    [6, 7, 10, 11].forEach((c) => (row.getCell(c).numFmt = FMT_INT));
    [8, 12].forEach((c) => (row.getCell(c).numFmt = FMT_PCT));
    row.getCell(9).numFmt = "0.00";
  });
  const sF = 5, sL = 4 + groups.length, sT = sL + 1;
  const sRow = sum.getRow(sT);
  sRow.values = [
    "TOTAL", "", "",
    F(`SUM(D${sF}:D${sL})`, rows.length),
    F(`ROUND(AVERAGE(${D("J")}),0)`, avgOps),
    F(`SUM(F${sF}:F${sL})`, tot.target),
    F(`SUM(G${sF}:G${sL})`, tot.produced),
    F(`IF(F${sT}=0,"",G${sT}/F${sT})`, safeDiv(tot.produced, tot.target)),
    F(`IF(G${sT}=0,"",J${sT}/G${sT})`, safeDiv(samSum, tot.produced)),
    F(`SUM(J${sF}:J${sL})`, samSum),
    F(`SUM(K${sF}:K${sL})`, minSum),
    F(`IF(K${sT}=0,"",J${sT}/K${sT})`, safeDiv(samSum, minSum)),
  ];
  styleRow(sRow, sumCols.length, { font: F_BOLD, fillAll: FILL_TOTAL });
  sRow.getCell(4).numFmt = "0";
  sRow.getCell(5).numFmt = "0";
  [6, 7, 10, 11].forEach((c) => (sRow.getCell(c).numFmt = FMT_INT));
  [8, 12].forEach((c) => (sRow.getCell(c).numFmt = FMT_PCT));
  sRow.getCell(9).numFmt = "0.00";
  [
    "Efficiency = SAM minutes produced ÷ minutes available (operators × hours × 60).",
    "Achievement = output ÷ target. SAM = SAM minutes produced ÷ output. Output = pieces captured on packing/finishing operations.",
    `Source: SKM production system (line runs), locked week, exported ${today}.`,
  ].forEach((t, i) => {
    const c = sum.getCell(`A${sT + 2 + i}`);
    c.value = t;
    c.font = F_NOTE;
  });

  // -------------------------------------------------------------- Daily ----
  const day = wb.addWorksheet("Daily", { views: [{ state: "frozen", ySplit: 4, showGridLines: false }] });
  title(day, `${who} Production by Day – ${range}`, `Calculated from the 'Production detail' sheet. Grey = no production. ${filterNote}`);
  const dayCols = [
    "Date", "Day", "Lines & styles", "Line-days", "Target (pcs)", "Output (pcs)",
    "Achievement %", "SAM min produced", "Minutes available", "Efficiency %",
  ];
  header(day, 4, dayCols);
  [11, 6, 56, 10, 13, 13, 13, 15, 15, 12].forEach((w, i) => (day.getColumn(i + 1).width = w));

  for (let i = 0; i < 7; i++) {
    const ds = addDays(info.week_start, i);
    const n = 5 + i;
    const dr = rows.filter((r) => r.run_date === ds);
    const byLine = new Map();
    for (const r of dr) {
      const k = String(r.line_no);
      if (!byLine.has(k)) byLine.set(k, []);
      if (!byLine.get(k).includes(r.style)) byLine.get(k).push(r.style);
    }
    const lines = [...byLine.keys()].sort(lineSort).map((k) => `L${k}: ${byLine.get(k).join(" → ")}`).join(" | ");
    const s = (k) => dr.reduce((a, r) => a + r[k], 0);
    const tg = s("target"), out = s("produced"), sm = s("sam_min"), mn = s("minutes");
    const row = day.getRow(n);
    row.values = [
      utcDate(ds),
      DOW_EN[utcDate(ds).getUTCDay()],
      lines,
      F(`COUNTIF(${D("A")},A${n})`, dr.length),
      F(`SUMIF(${D("A")},A${n},${D("M")})`, tg),
      F(`SUMIF(${D("A")},A${n},${D("N")})`, out),
      F(`IF(E${n}=0,"",F${n}/E${n})`, safeDiv(out, tg)),
      F(`SUMIF(${D("A")},A${n},${D("P")})`, sm),
      F(`SUMIF(${D("A")},A${n},${D("Q")})`, mn),
      F(`IF(I${n}=0,"",H${n}/I${n})`, safeDiv(sm, mn)),
    ];
    if (dr.length) styleRow(row, dayCols.length);
    else styleRow(row, dayCols.length, { font: { ...F_BODY, color: { argb: "FF808080" } }, fillAll: FILL_GREY });
    row.getCell(1).numFmt = FMT_DATE;
    row.getCell(4).numFmt = "0";
    [5, 6, 8, 9].forEach((c) => (row.getCell(c).numFmt = FMT_INT));
    [7, 10].forEach((c) => (row.getCell(c).numFmt = FMT_PCT));
  }
  const yT = 12;
  const daysWith = new Set(rows.map((r) => r.run_date)).size;
  const yRow = day.getRow(yT);
  yRow.values = [
    "TOTAL", "",
    F(`COUNTIF(D5:D11,">0")&" days with production"`, `${daysWith} days with production`),
    F("SUM(D5:D11)", rows.length),
    F("SUM(E5:E11)", tot.target),
    F("SUM(F5:F11)", tot.produced),
    F(`IF(E${yT}=0,"",F${yT}/E${yT})`, safeDiv(tot.produced, tot.target)),
    F("SUM(H5:H11)", samSum),
    F("SUM(I5:I11)", minSum),
    F(`IF(I${yT}=0,"",H${yT}/I${yT})`, safeDiv(samSum, minSum)),
  ];
  styleRow(yRow, dayCols.length, { font: F_BOLD, fillAll: FILL_TOTAL });
  yRow.getCell(4).numFmt = "0";
  [5, 6, 8, 9].forEach((c) => (yRow.getCell(c).numFmt = FMT_INT));
  [7, 10].forEach((c) => (yRow.getCell(c).numFmt = FMT_PCT));

  // ---------------------------------------------------- Forward schedule ----
  const fw = forward.rows || [];
  const win = forward.win;
  const fws = wb.addWorksheet("Forward schedule", { views: [{ state: "frozen", ySplit: 4, showGridLines: false }] });
  const fmtShort = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return { md: `${MONTHS_EN[m - 1]} ${d}`, y };
  };
  const wf = fmtShort(win.from), wt = fmtShort(win.to);
  title(
    fws,
    `${who} Forward Production Schedule – ${wf.md} to ${wt.md}, ${wt.y} (current week + ${FORWARD_WEEKS} weeks)`,
    `One row per Plan Board cell: planned qty = the quantity assigned to that line on that day. Planned start / end = first and last day of that order on that line. ` +
      `Fill the ${tag} internal order no. (yellow column) where missing. ${filterNote}`
  );
  const fwCols = [
    "Date", "Day", "Week of", "Line", "Style", "Client", `${tag} style`, "Work order", "Customer PO",
    `${tag} internal order no.`, "Season", "Color", "Planned qty (pcs)", "Planned start", "Planned end",
  ];
  header(fws, 4, fwCols);
  [11, 6, 11, 6, 11, 14, 11, 26, 18, 20, 9, 8, 13, 12, 12].forEach((w, i) => (fws.getColumn(i + 1).width = w));
  const fF = 5, fL = fF + fw.length - 1;
  fw.forEach((r, i) => {
    const row = fws.getRow(fF + i);
    row.values = [
      utcDate(r.date), DOW_EN[dowUtc(r.date)], utcDate(r.week_of), r.line_no, r.style,
      r.customer_name || "", r.client_style || "", r.work_order_no || "", r.customer_po || "",
      r.tech_pack_no || "", r.season || "", r.color || "", r.qty,
      utcDate(r.planned_start), utcDate(r.planned_end),
    ];
    styleRow(row, fwCols.length);
    [1, 3, 14, 15].forEach((c) => (row.getCell(c).numFmt = FMT_DATE));
    row.getCell(4).numFmt = "0";
    row.getCell(9).numFmt = "@";
    row.getCell(13).numFmt = FMT_INT;
    row.getCell(10).fill = FILL_YELLOW;
  });
  const plannedTotal = fw.reduce((s, r) => s + r.qty, 0);
  const fT = fw.length ? fL + 1 : fF;
  const fTot = fws.getRow(fT);
  fTot.getCell(1).value = "TOTAL";
  fTot.getCell(13).value = fw.length ? F(`SUM(M${fF}:M${fL})`, plannedTotal) : 0;
  styleRow(fTot, fwCols.length, { font: F_BOLD, fillAll: FILL_TOTAL });
  fTot.getCell(13).numFmt = FMT_INT;
  if (fw.length) fws.autoFilter = { from: { row: 4, column: 1 }, to: { row: fL, column: fwCols.length } };
  else {
    const c = fws.getCell(`A${fT + 2}`);
    c.value = "No planned production in this window for the selected filters.";
    c.font = F_NOTE;
  }

  // -------------------------------------------------------- Plan by week ----
  const pbw = wb.addWorksheet("Plan by week", { views: [{ state: "frozen", xSplit: 3, ySplit: 4, showGridLines: false }] });
  title(
    pbw,
    `${who} Planned Quantity by Line and Week`,
    `Calculated from the 'Forward schedule' sheet. Week = Monday of each week. ${filterNote}`
  );
  const weeks = [];
  for (let w = mondayOf(win.from); w <= win.to; w = addDays(w, 7)) weeks.push(w);
  const weekLabelEn = (w) => {
    const [, m, d] = w.split("-").map(Number);
    return `Week of ${MONTHS_EN[m - 1]} ${pad(d)}`;
  };
  const pbCols = ["Line", "Style", `${tag} style`, ...weeks.map(weekLabelEn), "Total"];
  header(pbw, 4, pbCols);
  // Fila 3: lunes de cada semana (criterio de los SUMIFS), en gris claro.
  weeks.forEach((w, i) => {
    const c = pbw.getRow(3).getCell(4 + i);
    c.value = utcDate(w);
    c.numFmt = FMT_DATE;
    c.font = F_NOTE;
  });
  pbw.getColumn(1).width = 7;
  pbw.getColumn(2).width = 11;
  pbw.getColumn(3).width = 11;
  weeks.forEach((_, i) => (pbw.getColumn(4 + i).width = 14));
  pbw.getColumn(4 + weeks.length).width = 11;

  const pairs = new Map();
  for (const r of fw) {
    const k = `${r.line_no}|${r.style}`;
    if (!pairs.has(k)) pairs.set(k, { line_no: r.line_no, style: r.style, cstyles: new Set(), byWeek: new Map() });
    const p = pairs.get(k);
    if (r.client_style) p.cstyles.add(r.client_style);
    p.byWeek.set(r.week_of, (p.byWeek.get(r.week_of) || 0) + r.qty);
  }
  const plist = [...pairs.values()].sort(
    (a, b) =>
      String(a.line_no).localeCompare(String(b.line_no), undefined, { numeric: true }) ||
      a.style.localeCompare(b.style)
  );
  const colL = (i) => String.fromCharCode(65 + i); // A.. (máx. ~10 columnas)
  const FW = (c) => `'Forward schedule'!$${c}$${fF}:$${c}$${fL}`;
  const lastWeekCol = colL(3 + weeks.length - 1);
  const totCol = colL(3 + weeks.length);
  plist.forEach((p, i) => {
    const n = 5 + i;
    const row = pbw.getRow(n);
    row.getCell(1).value = p.line_no;
    row.getCell(2).value = p.style;
    row.getCell(3).value = [...p.cstyles].join(", ");
    let rowSum = 0;
    weeks.forEach((w, j) => {
      const v = p.byWeek.get(w) || 0;
      rowSum += v;
      const col = colL(3 + j);
      row.getCell(4 + j).value = F(
        `SUMIFS(${FW("M")},${FW("D")},$A${n},${FW("E")},$B${n},${FW("C")},${col}$3)`,
        v
      );
    });
    row.getCell(4 + weeks.length).value = F(`SUM(D${n}:${lastWeekCol}${n})`, rowSum);
    styleRow(row, pbCols.length);
    row.getCell(1).numFmt = "0";
    for (let c = 4; c <= 4 + weeks.length; c++) row.getCell(c).numFmt = FMT_INT;
  });
  const pT = 5 + plist.length;
  const pTot = pbw.getRow(pT);
  pTot.getCell(1).value = "TOTAL";
  for (let j = 0; j <= weeks.length; j++) {
    const col = colL(3 + j);
    const val = j < weeks.length
      ? plist.reduce((s, p) => s + (p.byWeek.get(weeks[j]) || 0), 0)
      : plannedTotal;
    pTot.getCell(4 + j).value = plist.length ? F(`SUM(${col}5:${col}${pT - 1})`, val) : 0;
  }
  styleRow(pTot, pbCols.length, { font: F_BOLD, fillAll: FILL_TOTAL });
  for (let c = 4; c <= 4 + weeks.length; c++) pTot.getCell(c).numFmt = FMT_INT;
  void totCol;

  // ---------------------------------------------------------- Plan board ----
  // Misma vista que el Plan Board: una fila por línea, una columna por día
  // hábil. Cada celda lleva lo asignado a esa línea ese día (estilo · color,
  // orden y piezas); si hay varias órdenes en el mismo día van una debajo de
  // otra. Cada orden tiene su propio color para seguirla a lo largo de la fila.
  const pb = wb.addWorksheet("Plan board", { views: [{ state: "frozen", xSplit: 1, ySplit: 4, showGridLines: false }] });
  title(
    pb,
    `${who} Plan Board – ${wf.md} to ${wt.md}, ${wt.y}`,
    `Same layout as the Plan Board: one row per line, one column per working day. Each cell = what is assigned to that line that day ` +
      `(style · color, work order, pcs). Same work order = same color. ${filterNote}`
  );
  const pbDays = workdaysBetween(mondayOf(win.from), win.to);
  const lines = [...new Set(fw.map((r) => String(r.line_no)))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  // Fila 3: semana ISO sobre el lunes de cada semana. Fila 4: día.
  pb.getRow(4).getCell(1).value = "Line";
  pbDays.forEach((d, i) => {
    const col = 2 + i;
    const [, m, dd] = d.split("-").map(Number);
    if (dowUtc(d) === 1) {
      const c3 = pb.getRow(3).getCell(col);
      c3.value = `S${isoWeek(d).week}`;
      c3.font = F_BOLD;
    }
    pb.getRow(4).getCell(col).value = `${DOW_EN[dowUtc(d)]} ${dd} ${MONTHS_EN[m - 1]}`;
    pb.getColumn(col).width = 20;
  });
  pb.getRow(4).getCell(2 + pbDays.length).value = "Total";
  header(pb, 4, [pb.getRow(4).getCell(1).value, ...pbDays.map((_, i) => pb.getRow(4).getCell(2 + i).value), "Total"]);
  pb.getColumn(1).width = 7;
  pb.getColumn(2 + pbDays.length).width = 10;
  // Lunes con borde izquierdo grueso para separar semanas, como el tablero.
  const weekEdge = (cell, d) => {
    if (dowUtc(d) === 1) cell.border = { ...(cell.border || {}), left: { style: "medium", color: { argb: NAVY } } };
  };

  const PALETTE = ["FFDDEBF7", "FFFCE4D6", "FFE2EFDA", "FFFFF2CC", "FFEDE1F5", "FFDDF3F3", "FFF8DCE6", "FFE7E6E6"];
  const woColor = new Map();
  const colorOf = (wo) => {
    if (!woColor.has(wo)) woColor.set(wo, PALETTE[woColor.size % PALETTE.length]);
    return woColor.get(wo);
  };

  const cellMap = new Map(); // "linea|dia" -> filas
  for (const r of fw) {
    const k = `${r.line_no}|${r.date}`;
    if (!cellMap.has(k)) cellMap.set(k, []);
    cellMap.get(k).push(r);
  }
  const dayTotals = pbDays.map(() => 0);
  lines.forEach((ln, li) => {
    const row = pb.getRow(5 + li);
    const lc = row.getCell(1);
    lc.value = `L${ln}`;
    lc.font = F_BOLD;
    lc.alignment = { vertical: "middle", horizontal: "center" };
    let lineTotal = 0;
    let maxLines = 1;
    pbDays.forEach((d, i) => {
      const c = row.getCell(2 + i);
      const items = (cellMap.get(`${ln}|${d}`) || []).sort((a, b) =>
        String(a.work_order_no).localeCompare(String(b.work_order_no))
      );
      c.alignment = { vertical: "top", wrapText: true };
      c.font = { ...F_BODY, size: 9 };
      c.border = { top: { style: "thin", color: { argb: "FFD9D9D9" } }, bottom: { style: "thin", color: { argb: "FFD9D9D9" } },
                   left: { style: "thin", color: { argb: "FFD9D9D9" } }, right: { style: "thin", color: { argb: "FFD9D9D9" } } };
      if (items.length) {
        c.value = items
          .map((r) => `${r.style}${r.color ? ` · ${r.color}` : ""}\n${r.work_order_no || ""}\n${r.qty.toLocaleString("en-US")} pcs`)
          .join("\n\n");
        c.fill = fill(colorOf(items[0].work_order_no));
        const q = items.reduce((s, r) => s + r.qty, 0);
        lineTotal += q;
        dayTotals[i] += q;
        maxLines = Math.max(maxLines, items.length * 4 - 1);
      } else {
        c.fill = FILL_GREY;
      }
      weekEdge(c, d);
    });
    const t = row.getCell(2 + pbDays.length);
    t.value = lineTotal;
    t.numFmt = FMT_INT;
    t.font = F_BOLD;
    t.alignment = { vertical: "middle" };
    row.height = Math.max(15, maxLines * 12 + 4);
  });
  const pbT = pb.getRow(5 + lines.length);
  pbT.getCell(1).value = "TOTAL";
  dayTotals.forEach((v, i) => {
    const c = pbT.getCell(2 + i);
    c.value = v;
    c.numFmt = FMT_INT;
  });
  pbT.getCell(2 + pbDays.length).value = plannedTotal;
  styleRow(pbT, 2 + pbDays.length, { font: F_BOLD, fillAll: FILL_TOTAL });
  pbT.getCell(2 + pbDays.length).numFmt = FMT_INT;
  pbDays.forEach((d, i) => weekEdge(pbT.getCell(2 + i), d));
  if (!lines.length) {
    const c = pb.getCell(`A${7 + lines.length}`);
    c.value = "No planned production in this window for the selected filters.";
    c.font = F_NOTE;
  }

  // Mismo orden de hojas que el reporte NIKE.
  sum.orderNo = 0;
  day.orderNo = 1;
  det.orderNo = 2;
  fws.orderNo = 3;
  pb.orderNo = 4;
  pbw.orderNo = 5;
  wb.worksheets.sort((a, b) => a.orderNo - b.orderNo);

  return wb;
}

// ---------------------------------------------------------------- routes ---
function registerVerificadorReport(app, { authenticateToken, pool, setSchema, requireVerificador }) {
  if (typeof requireVerificador !== "function") {
    throw new Error("verificador-report: falta requireVerificador (regístralo después de su definición en server.js)");
  }

  app.get("/api/verificador/locked-weeks", authenticateToken, requireVerificador, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { weeks } = await listLockedWeeks(client);
      if (weeks.length === 0) return res.json({ success: true, weeks: [] });

      const from = weeks[weeks.length - 1];
      const to = addDays(weeks[0], 6);
      const { rows } = await client.query(
        `SELECT to_char(lr.run_date, 'YYYY-MM-DD') AS run_date,
                lr.line_no,
                COUNT(DISTINCT lr.id)::int AS runs,
                COALESCE(SUM(se.sewed_qty) FILTER (WHERE (${PACKING_SQL})), 0) AS produced
           FROM line_runs lr
           LEFT JOIN operation_sewed_entries se ON se.run_id = lr.id
           LEFT JOIN operator_operations oo     ON oo.id = se.operation_id
          WHERE lr.run_date BETWEEN $1::date AND $2::date
          GROUP BY lr.run_date, lr.line_no`,
        [from, to]
      );

      const byWeek = new Map(weeks.map((w) => [w, { runs: 0, produced: 0, lines: new Set() }]));
      for (const r of rows) {
        const agg = byWeek.get(ymd(planWeekLocks.weekStartOf(r.run_date)));
        if (!agg) continue;
        agg.runs += r.runs;
        agg.produced += num(r.produced);
        agg.lines.add(String(r.line_no));
      }
      res.json({
        success: true,
        weeks: weeks.map((w) => {
          const a = byWeek.get(w);
          return { ...weekInfo(w), runs: a.runs, lines: a.lines.size, produced: round(a.produced, 0) };
        }),
      });
    } catch (err) {
      console.error("❌ /api/verificador/locked-weeks error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  app.get("/api/verificador/production-report", authenticateToken, requireVerificador, async (req, res) => {
    const client = await pool.connect();
    try {
      await setSchema(client);

      // Acepta ?week= o ?weekStart= / ?week_start= por si el frontend manda otro nombre.
      const rawWeek = req.query.week ?? req.query.weekStart ?? req.query.week_start;
      const asked = ymd(Array.isArray(rawWeek) ? rawWeek[0] : rawWeek);
      if (!asked) {
        console.warn("⚠️  production-report sin semana válida. query =", JSON.stringify(req.query));
        return res.status(400).json({
          success: false,
          error: `Parámetro week requerido (YYYY-MM-DD). Se recibió: ${rawWeek === undefined ? "nada" : JSON.stringify(rawWeek)}.`,
        });
      }
      const format = req.query.format === "xlsx" ? "xlsx" : "json";
      const filters = {
        customer: String(req.query.customer || "").trim() || null,
        style: String(req.query.style || "").trim() || null,
      };

      const weekStart = ymd(planWeekLocks.weekStartOf(asked));
      const set = await planWeekLocks.lockedWeekSet(client);
      if (!weekStart || !planWeekLocks.isLockedDay(set, weekStart)) {
        return res.status(409).json({
          success: false,
          notLocked: true,
          error: "La semana no está bloqueada. El reporte solo se genera para semanas bloqueadas.",
        });
      }

      const info = weekInfo(weekStart);
      const all = await fetchRuns(client, info.week_start, info.week_end);
      const rows = applyFilters(all, filters);

      // Plan hacia adelante (hoy -> semana actual + 4), mismos filtros.
      const win = forwardWindow();
      const forwardRows = applyFilters(await fetchForward(client, win), filters);

      if (format === "json") {
        return res.json({
          success: true,
          week: info,
          filters,
          options: filterOptions(all),
          rows,
          totals: totalsOf(rows),
          forward: forwardSummary(forwardRows, win),
        });
      }

      if (rows.length === 0) {
        return res.status(404).json({ success: false, error: "No hay producción para esa semana con esos filtros." });
      }
      const wb = await buildWorkbook(rows, info, filters, { rows: forwardRows, win });
      const buf = await wb.xlsx.writeBuffer();
      // Nunca lanza: si la bitácora falla, la descarga sigue.
      await verificadorActivity.logReportDownload(client, {
        user: req.user,
        week: info,
        filters,
        rows: rows.length,
        totals: totalsOf(rows),
      });
      const tag = `${info.iso_year}-W${pad(info.iso_week)}`;
      const who = (filters.customer || "All").replace(/[^A-Za-z0-9_-]+/g, "_");
      const st = filters.style ? `_${filters.style.replace(/[^A-Za-z0-9_-]+/g, "_")}` : "";
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${who}_Production_Report_${tag}${st}.xlsx"`);
      return res.send(Buffer.from(buf));
    } catch (err) {
      console.error("❌ /api/verificador/production-report error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });
}

module.exports = registerVerificadorReport;
module.exports._buildWorkbook = buildWorkbook; // para pruebas