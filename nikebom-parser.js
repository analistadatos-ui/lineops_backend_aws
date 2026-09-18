// ==========================================================================
// nikebom-parser.js
// Parse Nike's native "BILL OF MATERIALS" export (English, per-colorway
// columns) into the style-order shape the wizard uses:
//   { header, fabrics, trimMaterials, garmentTrims, packingTrims, colorways,
//     spec:[], workmanship:[], sam:[], skus:[], warnings }
//
// Size spec and workmanship are NOT in this document (it defers to the base
// style), so they come back empty for the merchant to upload/enter.
//
// The BOM repeats the material list once per group of ~4 colorways across the
// pages. We read each group's colorway columns by X position, then MERGE each
// material line across groups by its line number so every material ends up with
// its colour in every colorway — "materials combined with colorway".
// ==========================================================================

const uid = () => Math.random().toString(36).slice(2);
const isBlank = (s) => !s || /^NOCOLR$/i.test(s.trim());

// which material rows are packing vs sewn-into-garment
const PACK_RE = /POLYBAG|HANGTAG|HANG TAG|UPC|CARTON|FOLD|PACKING|PACKAGING|STICKER|PRICE|RFID|INSERT|TISSUE|HANGER|SIZER|SIZE STRIP/i;
const FABRIC_RE = /LINEAR YARD|FABRIC|KNIT|WOVEN/i;

// ---- column model ---------------------------------------------------------
// Given the header row items, find the colorway columns (x -> {code}) and the
// x of the metadata columns so we can bucket every cell.
function columnsFromHeader(items) {
  // colorway header tokens look like "@013" or a bare 3-digit "126"
  const cws = [];
  for (const it of items) {
    const m = it.s.match(/^[@*]?(\d{3})$/);
    if (m && it.x > 360) cws.push({ code: m[1], x: it.x });
  }
  return cws.sort((a, b) => a.x - b.x);
}

// nearest colorway column for a token x
function nearestCw(x, cws) {
  let best = null, bestD = 1e9;
  for (const c of cws) {
    const d = Math.abs(x - c.x);
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= 40 ? best : null; // 40pt tolerance around the column
}

// ---- header ---------------------------------------------------------------
function parseHeader(pages, warnings) {
  const flat = pages.flatMap((p) => p.rows.map((r) => r.text));
  const grab = (re) => { for (const t of flat) { const m = t.match(re); if (m) return m[1].trim(); } return ""; };
  const h = {
    customer: "NIKE",
    styleName: grab(/Style Name\s*:\s*(.+?)(?:Season|$)/i),
    season: grab(/Season\s*:\s*([A-Z0-9]+)/i),
    styleNo: grab(/Style #\s*:\s*([A-Z0-9]+)/i),
    orderNo: "",
    version: grab(/Exp\. #\s*:\s*([0-9]+)/i),
    quantity: "",
    orderDate: "",
    deliveryDate: "",
    patternMaker: grab(/Developer\s*:\s*([A-Z0-9]+)/i),
    factory: grab(/Factory\/L\.O\.\s*:\s*(.+?)(?:Status|$)/i),
  };
  if (!h.styleNo) warnings.push("No pude leer el número de estilo del encabezado del BOM.");
  if (!h.season) {
    const tok = pages.flatMap((p) => p.rows).flatMap((r) => r.cells).find((c) => /^(SP|SU|FA|HO)\d{2}$/.test(c));
    if (tok) h.season = tok;
  }
  return h;
}

// ---- colorway metadata (primary / logo colour, prod id) per group ---------
// returns { code -> {primary, logo, prodId} } merged across all groups
function parseColorwayMeta(pages) {
  const meta = {};
  for (const p of pages) {
    const header = p.rows.find((r) => r.items.some((i) => /^[@*]?\d{3}$/.test(i.s) && i.x > 360) && r.text.includes("VENDOR"));
    if (!header) continue;
    const cws = columnsFromHeader(header.items);
    if (!cws.length) continue;
    const rowVals = (re) => {
      const r = p.rows.find((x) => re.test(x.text));
      if (!r) return {};
      const out = {};
      for (const it of r.items) {
        if (/Prmry|Logo|Prod ID|:/.test(it.s)) continue;
        const c = nearestCw(it.x, cws);
        if (c) out[c.code] = (out[c.code] ? out[c.code] + " " : "") + it.s;
      }
      return out;
    };
    const prim = rowVals(/Prmry:/);
    const logo = rowVals(/Logo:/);
    const pid = rowVals(/Prod ID:/);
    for (const c of cws) {
      meta[c.code] = meta[c.code] || {};
      if (prim[c.code]) meta[c.code].primary = prim[c.code];
      if (logo[c.code]) meta[c.code].logo = logo[c.code];
      if (pid[c.code]) meta[c.code].prodId = pid[c.code];
    }
  }
  return meta;
}

// ---- materials ------------------------------------------------------------
// Walk each page; a material starts at a row whose first item is a line number
// at the far left (x < 20). Accumulate its wrapped rows until the next line
// number. Read metadata + per-colorway colour by X.
// merge rows whose y are within a few points (in this BOM the colour values
// print a couple points above the line-number/UOM row of the same item).
function clusterRows(rows) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    if (cur && Math.abs(cur.y - r.y) <= 4) {
      cur.items = cur.items.concat(r.items);
      cur.y = (cur.y + r.y) / 2;
    } else {
      cur = { y: r.y, items: [...r.items] };
      out.push(cur);
    }
  }
  return out.map((c) => ({ y: c.y, items: c.items.sort((a, b) => a.x - b.x), text: c.items.map((i) => i.s).join(" ") }));
}

function parseMaterials(pages, warnings) {
  const byLine = {};
  const order = [];

  for (const p of pages) {
    const clustered = clusterRows(p.rows);
    const header = clustered.find((r) => r.items.some((i) => /^[@*]?\d{3}$/.test(i.s) && i.x > 360) && r.text.includes("VENDOR"));
    if (!header) continue;
    const cws = columnsFromHeader(header.items);
    const headerY = header.y;

    let cur = null;
    const flush = () => { if (cur) { mergeMaterial(byLine, order, cur); cur = null; } };

    for (const r of clustered.filter((x) => x.y < headerY)) {
      const first = r.items[0];
      const isNew = first && first.x < 20 && /^\d{1,3}$/.test(first.s);
      if (isNew) {
        flush();
        cur = { line: first.s, isn: "", vendor: [], use: [], uom: "", qty: "", desc: [], colorsByCw: {} };
      }
      if (!cur) continue;

      for (const it of r.items) {
        if (it.x >= 360) { // colorway colour columns
          if (/^(Colorway|CW|Prod|Ofrg|Plug|ID|Cd)$/i.test(it.s) || /^\d+\/\d+$/.test(it.s)) continue; // pagination/label noise
          const c = nearestCw(it.x, cws);
          if (c) cur.colorsByCw[c.code] = (cur.colorsByCw[c.code] ? cur.colorsByCw[c.code] + " " : "") + it.s;
          continue;
        }
        if (isNew) {
          if (it.x < 20) continue;                         // line number
          else if (it.x < 45) cur.isn = cur.isn || it.s;   // IS/N flag
          else if (it.x < 205) cur.vendor.push(it.s);      // vendor
          else if (it.x < 285) cur.use.push(it.s);         // USE
          else if (it.x < 312) cur.qty = cur.qty || it.s;  // QTY
          else cur.uom = (cur.uom ? cur.uom + " " : "") + it.s; // UOM
        } else {
          if (it.x < 205) cur.desc.push(it.s);             // wrapped description (far-left column)
          else if (it.x < 285) cur.use.push(it.s);         // USE continuation
          else if (it.x >= 312 && it.x < 360) cur.uom = cur.uom || it.s;
        }
      }
    }
    flush();
  }
  return order.map((line) => byLine[line]);
}

function mergeMaterial(byLine, order, cur) {
  const key = cur.line;
  if (!byLine[key]) {
    const desc = cur.desc.join(" ").replace(/\s+/g, " ").trim();
    const im = (desc.match(/IM#\s*(\d+)/) || desc.match(/\*\*\*\s*[A-Z]?(\d{6,})/) || [])[1] || "";
    byLine[key] = {
      key: uid(),
      line: cur.line,
      isn: cur.isn,
      code: im,
      vendor: cur.vendor.join(" ").replace(/\s+/g, " ").trim(),
      desc,
      use: cur.use.join(" ").replace(/\s+/g, " ").trim(),
      uom: cur.uom,
      qty: cur.qty,
      composition: (desc.match(/(\d+%[^;]*?(?:POLYESTER|ELASTANE|COTTON|NYLON|SPANDEX)[^;]*)/i) || [])[1] || "",
      weight: (desc.match(/G\/M2\)?:?\s*([\d.]+)/i) || [])[1] || "",
      width: (desc.match(/W\s*\(CM\):\s*([\d.]+)/i) || [])[1] || "",
      colorsByCw: {},
    };
    order.push(key);
  } else if (!byLine[key].use && cur.use.length) {
    byLine[key].use = cur.use.join(" ").trim();
  }
  Object.assign(byLine[key].colorsByCw, cur.colorsByCw);
}

// ---- assemble the wizard shape --------------------------------------------
function parseNikeBom(pages) {
  const warnings = [];
  const header = parseHeader(pages, warnings);
  const meta = parseColorwayMeta(pages);
  const materials = parseMaterials(pages, warnings);

  // colorways: union of all codes seen, ordered
  const cwCodes = Object.keys(meta).sort();
  // fabric lines that define body / back-neck colour
  const bodyFab = materials.find((m) => /BODY/i.test(m.use) && FABRIC_RE.test(m.uom + " " + m.desc) && !/HEATHER/i.test(m.desc));
  const bodyFabAny = materials.find((m) => /BODY/i.test(m.use) && FABRIC_RE.test(m.uom + " " + m.desc));
  const neckFab = materials.find((m) => /BACK NECK|NECK/i.test(m.use) && FABRIC_RE.test(m.uom + " " + m.desc));
  const colorOf = (mat, cw) => {
    if (!mat) return "";
    const v = mat.colorsByCw[cw];
    return v && !isBlank(v) ? v : "";
  };
  const colorways = cwCodes.map((code) => ({
    key: uid(),
    code,
    name: (meta[code].primary || "").trim() + (meta[code].prodId ? ` · ${meta[code].prodId}` : ""),
    body: colorOf(bodyFab, code) || colorOf(bodyFabAny, code) || (meta[code].primary || ""),
    neckTape: colorOf(neckFab, code) || colorOf(bodyFab, code) || "",
    swoosh: (meta[code].logo || "").trim(),
    thread: "",
  }));

  // fabrics vs trims vs packing
  const fabrics = [];
  const trimMaterials = [];
  const garmentTrims = [];
  const packingTrims = [];
  const colorSummary = (m) =>
    cwCodes
      .map((cw) => { const v = m.colorsByCw[cw]; return v && !isBlank(v) ? `${cw}:${v}` : null; })
      .filter(Boolean)
      .join("  ");

  for (const m of materials) {
    const isFabric = FABRIC_RE.test(m.uom) || /FABRIC/i.test(m.vendor);
    const isPack = PACK_RE.test(m.desc + " " + m.use + " " + m.vendor);
    if (isFabric) {
      fabrics.push({
        key: uid(),
        code: m.code || m.line,
        position: /BODY/i.test(m.use) ? "Cuerpo" : /BACK NECK|NECK/i.test(m.use) ? "Vista de cuello" : /SLEEVE/i.test(m.use) ? "Manga" : "Cuerpo",
        composition: m.composition,
        width: m.width ? `${m.width} cm` : "",
        weight: m.weight,
        fabricNo: m.code,
        note: colorSummary(m),
      });
    } else {
      const row = {
        key: uid(),
        code: m.code || m.line,
        variant: "",
        desc: (m.desc.split(";")[0] || m.vendor).slice(0, 60),
        spec: colorSummary(m),
        placement: m.use,
        consumption: m.qty || "1",
        unit: (m.uom || "pza").toLowerCase(),
        supplier: m.vendor,
        qty: m.qty || "1",
      };
      trimMaterials.push(row);
      (isPack ? packingTrims : garmentTrims).push({ ...row });
    }
  }

  if (!fabrics.length) warnings.push("No reconocí filas de tela en el BOM.");
  if (!colorways.length) warnings.push("No reconocí las columnas de colorway (@013…).");
  warnings.push("El BOM de Nike no incluye especificación de tallas ni confección: súbelas aparte.");

  return {
    header,
    fabrics,
    trimMaterials,
    garmentTrims,
    packingTrims,
    colorways,
    spec: [],
    workmanship: [],
    sam: [],
    skus: [],
    warnings,
  };
}

module.exports = { parseNikeBom };