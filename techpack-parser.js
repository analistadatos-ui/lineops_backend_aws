// ==========================================================================
// techpack-parser.js
// parseTechPack(pages) -> structured style order matching the wizard's 7 steps:
//   { header, fabrics, trimMaterials, spec, workmanship, sam,
//     colorways, garmentTrims, packingTrims, skus, warnings }
//
// Tuned to the 莎美娜 / SKM Nike processing sheet (加工指導書) layout, e.g.
// FN2798 / NKB-26-07-0461. It is deliberately defensive: anything it cannot
// read confidently is left blank and noted in `warnings` for the user to fix.
// The wizard treats every field as editable — this only removes typing.
// ==========================================================================

const SIZES = ["2XS", "XS", "S", "M", "L", "XL", "XXL", "S-T", "M-T", "L-T", "XL-T", "2XL-T"];
const uid = () => Math.random().toString(36).slice(2);
const isNum = (v) => v !== "" && v != null && !isNaN(Number(String(v).replace(/,/g, "")));
const cleanNum = (v) => String(v ?? "").replace(/,/g, "").trim();

// ---- helpers over the row model ------------------------------------------
const allRows = (pages) => pages.flatMap((p) => p.rows.map((r) => ({ ...r, page: p.num })));
const pageWith = (pages, tag) => pages.find((p) => p.rows.some((r) => r.text.includes(tag)));
const rowIndex = (rows, pred) => rows.findIndex(pred);

// ==========================================================================
function parseTechPack(pages) {
  const warnings = [];
  const rows = allRows(pages);

  const order = {
    header: parseHeader(rows, warnings),
    fabrics: parseFabrics(pages, warnings),
    trimMaterials: [],
    spec: parseSpec(pages, warnings),
    workmanship: parseWorkmanship(pages, warnings),
    colorways: parseColorways(pages, warnings),
    skus: parseSkus(pages, warnings),
  };

  const trims = parseTrims(pages, warnings);
  order.trimMaterials = trims.materials;
  order.garmentTrims = trims.garment;
  order.packingTrims = trims.packing;

  // SAM isn't in the tech pack — seed the operation list from workmanship so the
  // user only enters minutes.
  order.sam = order.workmanship.map((w) => ({
    key: uid(),
    op: w.area || "Operación",
    machine: w.machine || "Plana 1 aguja",
    minutes: "",
  }));
  if (order.workmanship.length) warnings.push("El SAM no viene en el tech pack: se listaron las operaciones sin minutos.");

  order.warnings = warnings;
  return order;
}

// ---- header ---------------------------------------------------------------
function parseHeader(rows, warnings) {
  const find = (pred) => rows.find(pred);
  const after = (label) => {
    const i = rows.findIndex((r) => r.text === label);
    return i >= 0 && rows[i + 1] ? rows[i + 1].text : "";
  };

  const styleName = after("款式名稱");
  const styleRow = find((r) => /^[A-Z]{2}\d{3,5}$/.test(r.cells[0] || ""));
  const orderRow = find((r) => /^[A-Z]{2,4}-\d{2}-\d{2}-\d{3,5}$/.test(r.cells[0] || ""));
  const custRow = find((r) => (r.cells || []).includes("自編單號"));
  const qtyRow = find((r) => r.cells[0] === "數量");
  const dateRow = find((r) => /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(r.cells[0] || "") && /SFC|版本/.test(r.text))
    || find((r) => /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(r.cells[0] || ""));
  const seasonRow = find((r) => /^[A-Z]{2}'?\d{2}$/.test(r.text));
  const factoryRow = find((r) => /Skyrina|SKM|SAA|SAC/.test(r.text) && /生產|Skyrina/.test(r.text));

  const toISO = (s) => {
    const m = String(s || "").match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "";
  };

  const h = {
    customer: custRow ? custRow.cells[0] : "",
    styleNo: styleRow ? styleRow.cells[0] : "",
    version: styleRow ? styleRow.cells[1] || "" : "",
    orderNo: orderRow ? orderRow.cells[0] : "",
    styleName,
    season: seasonRow ? seasonRow.text : "",
    quantity: qtyRow ? cleanNum(qtyRow.cells[1]) : "",
    orderDate: dateRow ? toISO(dateRow.cells[0]) : "",
    deliveryDate: orderRow ? toISO(orderRow.cells[1]) : "",
    patternMaker: styleRow ? (styleRow.cells.slice(2).join("") || "") : "",
    factory: factoryRow ? factoryRow.text.replace(/生產.*/, "").trim() : "",
  };
  if (!h.styleNo) warnings.push("No pude leer el número de estilo del encabezado.");
  return h;
}

// ---- fabric positions from the 搭配表 (body / sleeve / neck-tape / gusset) --
function parseFabricPositions(pages) {
  const page = pageWith(pages, "搭配表");
  const map = {};
  if (!page) return map;
  const posOf = (t) => {
    if (/後領貼|領貼/.test(t)) return "Vista de cuello";
    if (/插片/.test(t)) return "Inserto axila";
    if (/大身|大身\/袖|身\/袖/.test(t)) return "Cuerpo";
    if (/袖/.test(t)) return "Manga";
    return null;
  };
  for (const r of page.rows) {
    const m = r.text.match(/#(\d{5,8})/);
    if (!m) continue;
    const pos = posOf(r.text);
    if (pos && !map[m[1]]) map[m[1]] = pos; // first (primary) position for the code wins
  }
  return map;
}

// ---- logo / label placements from 商標位置 --------------------------------
function parseLogoPlacements(pages) {
  const page = pages.find((p) => p.rows.some((r) => r.text.includes("商標位置")));
  const res = { swoosh: "", mainLabel: "", washLabel: "", idLabel: "" };
  if (!page) return res;
  const start = page.rows.findIndex((r) => r.text.includes("商標位置"));
  for (let i = start + 1; i < page.rows.length; i++) {
    const t = page.rows[i].text.replace(/^\d+\s*[\.．]\s*/, "").trim();
    if (/^-{3,}|面料:|款式/.test(t)) break;
    if (/移印主標|主標/.test(t)) res.mainLabel = res.mainLabel || t;
    else if (/熱轉印|勾勾/.test(t)) res.swoosh = res.swoosh || t;
    else if (/洗標/.test(t)) res.washLabel = res.washLabel || t;
    else if (/ID/.test(t)) res.idLabel = res.idLabel || t;
  }
  return res;
}

// ---- fabrics (布料名稱) ----------------------------------------------------
function parseFabrics(pages, warnings) {
  const page = pageWith(pages, "布料名稱");
  const posByCode = parseFabricPositions(pages);
  const out = [];
  if (!page) { warnings.push("No encontré la sección de telas (布料名稱)."); return out; }
  const seen = new Set();
  for (const r of page.rows) {
    // "1 瑞宜#1056980/00 A/89% POLYESTER (RECYCLED) 11% ELASTANE -W:58\" in. -WT:182g/yd 135g/m2 --DA26070442"
    const m = r.text.match(/#(\d{5,8})\/([^/]+)\/(.+?)-W:\s*([\d.]+)"?.*?([\d.]+)\s*g\/m2.*?--?\s*([A-Z0-9]+)/i);
    if (!m) continue;
    const code = m[1];
    const color = m[2].replace(/\s+/g, "");
    const dedup = `${code}/${color}`;
    if (seen.has(dedup)) continue; // only exact code+colour duplicates are dropped
    seen.add(dedup);
    out.push({
      key: uid(),
      code,
      position: posByCode[code] || "Cuerpo",
      composition: m[3].trim(),
      width: `${m[4]}"`,
      weight: m[5],
      fabricNo: m[6],
      note: `Color ${color}`,
    });
  }
  // Every line from 布料名稱 stays (6 colours of #1056980 + heather #1025727 = 7).
  if (!out.length) warnings.push("Encontré la sección de telas pero no pude leer las líneas.");
  return out;
}

// ---- trims (副料) ----------------------------------------------------------
function parseTrims(pages, warnings) {
  const trimPages = pages.filter((p) => p.rows.some((r) => r.text.includes("副料")));
  const placements = parseLogoPlacements(pages);
  const materials = [];
  const seen = new Set();

  // the variant that follows '//' — a colour (00A), a size (L), or GCW+size
  // (GCW# 3/ L) — cut off before the usage figure.
  const variantOf = (t) => {
    const seg = (t.split("//")[1] || "").split(/\s+[\d.]+\s+(?:PC|M)\b/)[0];
    return seg.replace(/\s+/g, " ").trim();
  };
  // supplier is the name just before the "#DB…" order code at the end of the line
  const supplierOf = (t) => {
    const m =
      t.match(/([A-Za-z][A-Za-z().\- ]*?|[\u4e00-\u9fff]+)\s*#?DB\d+\s*$/) ||
      t.match(/\s([A-Z][A-Za-z().\-]+)\s*$/);
    return m ? m[1].trim() : "";
  };

  for (const p of trimPages) {
    const rws = p.rows;
    for (let i = 0; i < rws.length; i++) {
      const t = rws[i].text;
      if (!t.includes("//") && !/\d\.\d{3}\s+(PC|M)\b/.test(t)) continue;
      const codeM = t.match(/#([0-9]+(?:-[0-9]+)*(?:-[A-Z]{2,4})?)/);
      if (!codeM) continue;
      const base = codeM[1];
      if (base.length < 4 || !/^\d/.test(base)) continue; // skip wrapped fragments
      let variant = variantOf(t);
      // the "// GCW#/size" part often wraps to the neighbouring line (e.g. the
      // main label prints one row per size); pull it from there if missing.
      if (!variant) {
        const near = [rws[i + 1], rws[i - 1]].find((n) => n && !/^\s*#\d/.test(n.text) && n.text.includes("//"));
        if (near) variant = variantOf(near.text);
      }
      const supplier = supplierOf(t);
      const key = base + "|" + variant + "|" + supplier; // only exact duplicates merge
      if (seen.has(key)) continue;
      seen.add(key);
      const useM = t.match(/([\d.]+)\s+(PC|M)\b/i);
      const descM = t.match(/#[^/]+?\s(.+?)(?:\/\/|\s+[\d.]+\s+(?:PC|M))/);
      materials.push({
        key: uid(),
        code: base,
        variant,
        desc: (descM ? descM[1] : t.slice(0, 40)).replace(/#\d+\s*/g, "").trim(),
        spec: variant,
        consumption: useM ? useM[1] : "",
        unit: useM ? useM[2].toLowerCase() : "pza",
        supplier,
      });
    }
  }
  if (!materials.length) warnings.push("No pude leer la lista de avíos (副料).");

  // split garment vs packing; give garment trims their placement from 商標位置
  const PACK = /(吊牌|吊卡|hangtag|HANGTAG|信封袋|PE|衣架|GANCHO|尺碼夾|Sizer|薄紙|UPC|RFID|貼標|銷樣|插卡|INSERT|袋)/i;
  const placementFor = (m) => {
    const s = m.code + " " + m.desc;
    if (/熱轉印|勾勾|swoosh|330279/i.test(s)) return placements.swoosh;
    if (/主標|移印|1028017/i.test(s)) return placements.mainLabel;
    if (/洗標|洗語|477467|093436/i.test(s)) return placements.washLabel;
    if (/\bID\b|368545/i.test(s)) return placements.idLabel;
    return "";
  };
  const garment = [];
  const packing = [];
  materials.forEach((m) => {
    const isPack = PACK.test(m.desc) || PACK.test(m.code);
    const row = {
      key: uid(),
      code: m.code + (m.variant ? ` (${m.variant})` : ""),
      desc: m.desc,
      placement: isPack ? "" : placementFor(m),
      qty: m.consumption || "1",
      unit: m.unit || "pza",
    };
    (isPack ? packing : garment).push(row);
  });
  return { materials, garment, packing };
}

// ---- size spec (尺寸表) ----------------------------------------------------
function parseSpec(pages, warnings) {
  let page = null, hIdx = -1;
  for (const p of pages) {
    const idx = p.rows.findIndex((r) => r.cells.includes("2XS") && r.cells.includes("XS") && r.cells.includes("M"));
    if (idx >= 0) { page = p; hIdx = idx; break; }
  }
  const out = [];
  if (!page) { warnings.push("No encontré la tabla de tallas (尺寸表)."); return out; }
  const rows = page.rows;
  const header = rows[hIdx].cells;
  const sizeStart = header.indexOf("2XS");
  const sizeCols = header.slice(sizeStart).filter((c) => SIZES.includes(c));

  for (let i = hIdx + 1; i < rows.length; i++) {
    const c = rows[i].cells;
    const firstNum = c.findIndex(isNum); // tolerance is the first numeric cell
    if (firstNum < 0) continue;
    const values = c.slice(firstNum + 1);
    if (values.filter(isNum).length < 4) continue; // a real measurement row has several sizes

    const pre = c.slice(0, firstNum); // code and/or name live before the tolerance
    let code = /^[A-Z]{2}[A-Z0-9_]+$/.test(pre[0] || "") ? pre[0] : "";
    let name = (code ? pre.slice(1) : pre).join(" ").trim();
    const tol = c[firstNum];

    // merge a wrapped fragment on the next row (e.g. NK_DB + H -> NK_DBH)
    const nxt = rows[i + 1];
    if (nxt && nxt.cells.filter(isNum).length === 0 && /^[A-Za-z0-9_]{1,3}$/.test(nxt.cells[0] || "")) {
      if (code) code += nxt.cells[0];
      if (nxt.cells[1]) name += " " + nxt.cells[1];
    }

    const vals = {};
    values.forEach((v, k) => { if (sizeCols[k] && isNum(v)) vals[sizeCols[k]] = String(v); });
    if (!code && !name) continue; // stray row with numbers but no label
    out.push({ key: uid(), code, name, how: "", crit: "Crítica", tMinus: tol || "", tPlus: tol || "", vals });
  }
  if (!out.length) warnings.push("Leí la tabla de tallas pero sin filas de medidas.");
  return out;
}

// ---- workmanship (做工說明) ------------------------------------------------
function parseWorkmanship(pages, warnings) {
  const page = pages.find((p) => p.rows.some((r) => r.text.includes("做工說明")));
  const out = [];
  if (!page) { warnings.push("No encontré las instrucciones de confección (做工說明)."); return out; }
  const rows = page.rows;
  const start = rowIndex(rows, (r) => r.text.includes("做工說明"));
  const end = rowIndex(rows, (r) => r.text.includes("商標位置"));
  const stop = end > start ? end : rows.length;

  const machineOf = (t) => {
    if (/#514/.test(t)) return "Overlock 4 hilos (#514)";
    if (/#504/.test(t)) return "Overlock 3 hilos (#504)";
    if (/#602/.test(t)) return "Recubridora 3 agujas (#602)";
    if (/#406/.test(t)) return "Recubridora 2 agujas (#406)";
    if (/#401/.test(t)) return "Cadeneta 1 aguja (#401)";
    if (/熱轉印|移印|勾勾/.test(t)) return "Prensa de calor";
    return "Plana 1 aguja";
  };

  let cur = null;
  for (let i = start + 1; i < stop; i++) {
    const t = rows[i].text;
    const m = t.match(/^(\d)\s*[\.．]\s*(.+)/); // "1 .領- ..."
    if (m) {
      if (cur) out.push(cur);
      const body = m[2];
      const area = (body.split(/[-—:：]/)[0] || `Paso ${m[1]}`).trim();
      cur = { key: uid(), area, instr: body.trim(), machine: machineOf(body), spi: (body.match(/SPI\s*([\d-]+)/i) || [])[1] || "" };
    } else if (cur && t && !/^-+$/.test(t)) {
      cur.instr += " " + t;
      if (!cur.spi) cur.spi = (t.match(/SPI\s*([\d-]+)/i) || [])[1] || cur.spi;
      if (cur.machine === "Plana 1 aguja") cur.machine = machineOf(t);
    }
  }
  if (cur) out.push(cur);
  if (!out.length) warnings.push("No pude separar las operaciones de confección.");
  return out;
}

// ---- colorways (配色表) ----------------------------------------------------
function parseColorways(pages, warnings) {
  const page = pageWith(pages, "配色表");
  if (!page) { warnings.push("No encontré la tabla de colores (配色表)."); return []; }
  const rows = page.rows;
  const hdr = rows.find((r) => r.cells[0] === "配色表");
  if (!hdr) { warnings.push("No reconocí el encabezado de colorways."); return []; }
  const codes = hdr.cells.slice(1).filter((c) => /^\d{3}$/.test(c));

  // the heather (花灰) colorway lives on its own rows in the 搭配表
  const heatherCw = (() => {
    const r = rows.find((x) => /花灰/.test(x.text) && /#\d{3}/.test(x.text));
    const m = r && r.text.match(/#(\d{3})/);
    return m ? m[1] : null;
  })();

  const isColor = (c) => /^(0AJ99J|C\d{4}|[0-9][0-9A-Z]{2})$/.test(c) && !/^\d{3}$/.test(c);
  const tokensOf = (r) => (r ? r.cells.filter(isColor) : []);
  // map a component row's colour tokens onto the colorways, allowing for the
  // heather colorway being on a separate line (so the main row has one fewer).
  const assign = (tokens) => {
    const map = {};
    if (tokens.length === codes.length) {
      codes.forEach((c, i) => (map[c] = tokens[i]));
    } else if (heatherCw && tokens.length === codes.length - 1) {
      codes.filter((c) => c !== heatherCw).forEach((c, i) => (map[c] = tokens[i]));
    } else {
      codes.forEach((c, i) => { if (tokens[i]) map[c] = tokens[i]; });
    }
    return map;
  };
  const rowStarting = (n) => rows.find((r) => new RegExp(`^${n}\\b`).test(r.text));
  const heatherRow = (kw) => rows.find((r) => /花灰/.test(r.text) && kw.test(r.text));

  const body = assign(tokensOf(rowStarting(1)));   // 大身/袖
  const neck = assign(tokensOf(rowStarting(3)));   // 後領貼
  const swoosh = assign(tokensOf(rowStarting(101)));
  const thread = assign(tokensOf(rowStarting(102)));
  if (heatherCw) {
    const grab = (kw) =>
      rows.filter((r) => (/#1025727/.test(r.text) || /花灰/.test(r.text)) && kw.test(r.text)).flatMap(tokensOf)[0];
    const hb = grab(/大身|袖/) || rows.filter((r) => /#1025727/.test(r.text)).flatMap(tokensOf)[0];
    const hn = grab(/後領貼|領貼/) || hb;
    if (hb) body[heatherCw] = body[heatherCw] || hb;
    if (hn) neck[heatherCw] = neck[heatherCw] || hn;
  }

  const NAMES = { "00A": "BLACK", "10A": "WHITE", "3KC": "GREEN GLOW", "44B": "MIDNIGHT NAVY", "6CG": "CHALLENGE RED", "6LG": "PLAYFUL PINK", "0AJ99J": "SMOKE GREY heather", C9694: "SMOKE GREY" };
  const nameFor = (tok) => NAMES[tok] || tok || "";

  const colorways = codes.map((code) => {
    const b = body[code] || "";
    return {
      key: uid(),
      code,
      name: `${nameFor(b)} (${b || "?"})`.replace(" ()", ""),
      body: b,
      neckTape: neck[code] || b,
      swoosh: swoosh[code] || "",
      thread: thread[code] || "",
    };
  });
  if (!colorways.length) warnings.push("No pude leer las combinaciones de color.");
  return colorways;
}

// ---- SKUs / sew package (顏色/尺寸 + PO destinos) --------------------------
function parseSkus(pages, warnings) {
  const poPages = pages.filter((p) => p.rows.some((r) => r.text.includes("顏色/尺寸")));
  const out = [];
  if (!poPages.length) { warnings.push("No encontré las páginas de PO / destinos (顏色/尺寸)."); return out; }

  const destOf = (t) => {
    if (/DICKS|DSG/i.test(t)) return { dest: "USA — DICKS SPORTING", pack: "hanger", hanger: "DICKS DC (HCLR17)" };
    if (/NORDSTROM/i.test(t)) return { dest: "USA — NORDSTROM", pack: "hanger", hanger: "NORDSTROM (HCLR17)" };
    if (/BELK/i.test(t)) return { dest: "USA — BELK DC 0737", pack: "hanger_ratio", hanger: "BELK (HCLR17, por configuración)" };
    if (/AMAZON|亞馬遜/i.test(t)) return { dest: "USA — AMAZON", pack: "flat", hanger: "" };
    if (/CAN|加拿大/i.test(t)) return { dest: "CAN — Canadá", pack: "brick", hanger: "" };
    if (/USA|美國/i.test(t)) return { dest: "USA — general", pack: "brick", hanger: "" };
    return { dest: "", pack: "flat", hanger: "" };
  };

  for (const p of poPages) {
    const rws = p.rows;
    for (let i = 0; i < rws.length; i++) {
      const t = rws[i].text;
      // colour line: "#342/342 (料色:3 KC\ 鮮豔綠) 0 4 70 ... 366"
      const cwM = t.match(/#(\d{3})\/\d{3}\s*\(料色/);
      if (!cwM) continue;
      const nums = (t.match(/\b[\d,]+\b/g) || []).map(cleanNum).filter((x) => x !== "");
      const total = nums.length ? nums[nums.length - 1] : "";
      if (!total || Number(total) === 0) continue; // skip zero-qty placeholder rows
      // find the PO# line just below
      let po = "", meta = { dest: "", pack: "flat", hanger: "" }, delivery = "";
      for (let j = i; j < Math.min(i + 3, rws.length); j++) {
        const pm = rws[j].text.match(/PO#\s*([\w-]+)/);
        if (pm) {
          po = pm[1];
          meta = destOf(rws[j].text);
          const dm = rws[j].text.match(/交期:\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/);
          if (dm) delivery = `${dm[1]}-${dm[2].padStart(2, "0")}-${dm[3].padStart(2, "0")}`;
          break;
        }
      }
      out.push({
        key: uid(),
        po,
        colorway: cwM[1],
        dest: meta.dest,
        pack: meta.pack,
        hangerDest: meta.hanger,
        sizeClip: /DICKS|DSG/i.test(meta.dest),
        delivery,
        qty: total,
      });
    }
  }
  if (!out.length) warnings.push("Leí las páginas de PO pero no extraje SKU con cantidad.");
  return out;
}

module.exports = { parseTechPack, SIZES };