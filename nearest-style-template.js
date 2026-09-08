// ---------------------------------------------------------------------------
// Nearest-style template resolution for new line_runs.
//
// Problem: when a style has never run on a line, seeding a new run from "the
// line's most recent run of ANY style" gives a bad capacity estimate (e.g. a
// blouse seeded from a t-shirt). This picks the closest same-family style that
// HAS run on the line instead, so operators_count / efficiency are realistic.
//
// SAM is intentionally NOT trusted from the neighbour: callers should keep
// resolving SAM from the merchant order first (resolveOrderSam) and only use
// the template SAM as a last resort. target = ops * h * 60 * eff / sam, and SAM
// is the most style-specific term — a wrong SAM = a wrong quantity.
// ---------------------------------------------------------------------------

// "DAMBLS05" -> { raw:"DAMBLS05", prefix:"DAMBLS", num:5 }
// "DAMBLS"   -> { raw:"DAMBLS",   prefix:"DAMBLS", num:null }  (prefix-only)
function parseStyle(code) {
  const raw = String(code || "").toUpperCase().trim();
  const m = raw.match(/^(.*?)(\d+)$/);          // lazy prefix + trailing digits
  if (!m) return { raw, prefix: raw, num: null };
  return { raw, prefix: m[1], num: parseInt(m[2], 10) };
}

/**
 * Choose the best template row to seed a new run for (line, style).
 * Priority:
 *   1. "exact"       exact same style on this line (its most recent run)
 *   2. "nearest"     same family prefix, smallest |number| distance, on this line
 *   3. "line-recent" line's most recent run of any style (old behaviour)
 *   4. "planner"     planner_lines config
 *   5. "default"     hardcoded fallback
 *
 * Returns { src, templateRunId, source, basedOnStyle }.
 *   src            row with { operators_count, working_hours, sam_minutes, efficiency }
 *   templateRunId  id of the line_run used as template, or null for planner/default
 *   source         one of the strings above (for logging / UI badge)
 *   basedOnStyle   the style the numbers came from, or null
 */
async function resolveTemplateRun(client, { line, style }) {
  const want = parseStyle(style);

  // Newest run per style on this line, in one pass.
  const { rows } = await client.query(
    `SELECT DISTINCT ON (style)
            id, style, operators_count, working_hours, sam_minutes, efficiency
       FROM line_runs
      WHERE line_no = $1
      ORDER BY style, run_date DESC, created_at DESC`,
    [String(line)]
  );

  if (rows.length) {
    // 1. exact style match
    const exact = rows.find((r) => parseStyle(r.style).raw === want.raw);
    if (exact) {
      return { src: exact, templateRunId: exact.id, source: "exact", basedOnStyle: exact.style };
    }

    // 2. nearest same-family style (same prefix, closest number)
    if (want.num != null) {
      const family = rows
        .map((r) => ({ row: r, s: parseStyle(r.style) }))
        .filter((x) => x.s.prefix === want.prefix && x.s.num != null)
        .sort((a, b) => {
          const d = Math.abs(a.s.num - want.num) - Math.abs(b.s.num - want.num);
          if (d !== 0) return d;
          // tie: prefer the lower/earlier version, then it's deterministic
          return a.s.num - b.s.num;
        });
      if (family.length) {
        const best = family[0].row;
        return { src: best, templateRunId: best.id, source: "nearest", basedOnStyle: best.style };
      }
    }
  }

  // 3. line's most recent run of any style
  const recent = await client.query(
    `SELECT id, style, operators_count, working_hours, sam_minutes, efficiency
       FROM line_runs
      WHERE line_no = $1
      ORDER BY run_date DESC, created_at DESC
      LIMIT 1`,
    [String(line)]
  );
  if (recent.rows[0]) {
    const r = recent.rows[0];
    return { src: r, templateRunId: r.id, source: "line-recent", basedOnStyle: r.style };
  }

  // 4. planner_lines config
  const pl = await client.query(
    `SELECT operators_count, working_hours, sam_minutes, efficiency
       FROM planner_lines WHERE line_no = $1`,
    [String(line)]
  );
  if (pl.rows[0]) {
    return { src: pl.rows[0], templateRunId: null, source: "planner", basedOnStyle: null };
  }

  // 5. hardcoded default
  return {
    src: { operators_count: 20, working_hours: 8, sam_minutes: 3.5, efficiency: 0.85 },
    templateRunId: null,
    source: "default",
    basedOnStyle: null,
  };
}

module.exports = { parseStyle, resolveTemplateRun };


/* ===========================================================================
   CALL-SITE 1 — assignment / draft-run creation (currently ~line 6307).
   Replace the `tpl` query + planner_lines fallback block with:

   const { src, templateRunId, source, basedOnStyle } =
     await resolveTemplateRun(client, { line, style: runStyle });

   if (source === "nearest") {
     console.log(`   ↳ no history for "${runStyle}" on L${line}; ` +
                 `seeding from nearest style "${basedOnStyle}"`);
   }

   // ...then the existing operators/hours/eff/sam/target computation stays
   //    EXACTLY as-is. resolveOrderSam still runs first, so the real merchant
   //    SAM wins and only the neighbour's operators/efficiency are borrowed:
   const operators = parseInt(src?.operators_count) || 20;
   const hours     = parseFloat(src?.working_hours) || 8;
   let   eff       = parseFloat(src?.efficiency) || 0.85;
   if (eff > 1) eff = eff / 100;
   if (eff > 1) eff = 1;
   const orderSam  = await resolveOrderSam(client, { workOrderId, lineNo: line, runDate, style: runStyle });
   const sam       = orderSam || parseFloat(src?.sam_minutes) || 3.5;
   // target unchanged...

   =========================================================================== */

/* ===========================================================================
   CALL-SITE 2 — operators-modal save (currently ~line 2015), the `tmpl` query.
   Swap it for the same helper so both entry points behave identically:

   const { src } = await resolveTemplateRun(client, { line: String(lineNo), style: styleStr });
   const wh  = parseFloat(src?.working_hours) || 0;
   const eff = parseFloat(src?.efficiency) || 0;
   const orderSam = await resolveOrderSam(client, { lineNo: String(lineNo), runDate: anchor, style: styleStr });
   const sam = orderSam || parseFloat(src?.sam_minutes) || 0;
   // { targetPcs, targetPerHour } = calc(wh, eff, sam)  — unchanged
   =========================================================================== */