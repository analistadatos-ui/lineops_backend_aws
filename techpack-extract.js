// ==========================================================================
// techpack-extract.js
// Turn a tech-pack PDF buffer into per-page rows using pdfjs-dist, grouping
// text items into visual rows (cluster by Y) and ordering by X. Each row keeps
// both the pipe-cell array (good for column tables) and a space-joined string
// (good for regexing wrapped lines).
//
// pdfjs v4 ships ESM only; we load it with dynamic import() so this file stays
// a normal CommonJS module that the Express app can `require`.
// ==========================================================================

// ---------------------------------------------------------------------------
// pdfjs-dist v4 calls Promise.withResolvers(), which only exists on Node 22+.
// The Lambda runs Node 20, so we polyfill it. It is defined here AND invoked
// again right before the dynamic import() below, so it is guaranteed to run
// before pdfjs loads even if a bundler reorders/hoists the module.
// ---------------------------------------------------------------------------
function ensurePromiseWithResolvers() {
  if (typeof Promise.withResolvers !== "function") {
    Promise.withResolvers = function withResolvers() {
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
  }
}
ensurePromiseWithResolvers(); // at module load

async function extractRows(buffer) {
  ensurePromiseWithResolvers(); // again, immediately before pdfjs is loaded
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const data = new Uint8Array(
    buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer
  );
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const byY = {};
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]); // vertical position
      (byY[y] = byY[y] || []).push({ x: it.transform[4], s: it.str.trim() });
    }
    const rows = Object.keys(byY)
      .map(Number)
      .sort((a, b) => b - a) // top -> bottom
      .map((y) => {
        const sorted = byY[y].sort((a, b) => a.x - b.x);
        const cells = sorted.map((i) => i.s);
        return {
          y,
          cells,
          items: sorted.map((i) => ({ x: Math.round(i.x), s: i.s })), // x kept for column-aligned tables (Nike BOM)
          text: cells.join(" ").replace(/\s+/g, " ").trim(),
        };
      });
    pages.push({ num: p, rows });
  }
  return pages;
}

module.exports = { extractRows };