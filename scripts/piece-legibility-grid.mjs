// Render a piece-legibility grid — every glyph (k,q,r,b,n,p) in both
// colors on both square colors (paper + walnut) at the actual 390px
// mobile square size (~44px per square). No cheating — this is the
// exhaustive at-scale check team-lead asked for.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = "tmp/reviews/screens-r2";
mkdirSync(OUT, { recursive: true });

const html = `<!doctype html>
<html><head>
<link rel="stylesheet" href="http://127.0.0.1:4173/assets/index-uRzzsVxR.css" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" />
<style>
  body { padding: 12px 16px; background: #7CA898; font-family: "IBM Plex Mono", monospace; font-size: 11px; color: #2E2A3D; }
  h1 { font-size: 12px; margin: 0 0 8px 0; letter-spacing: 0.14em; text-transform: uppercase; color: #6B6455; font-weight: 500; }
  table { border-collapse: collapse; }
  td { padding: 0; margin: 0; }
  .lab { padding: 0 6px; font-size: 10px; color: #6B6455; letter-spacing: 0.1em; text-transform: uppercase; vertical-align: middle; }
  .cell {
    width: 44px; height: 44px;
    display: inline-block;
    position: relative;
    text-align: center;
    vertical-align: middle;
    display: table-cell;
  }
  .light { background: #E8DBBE; }
  .dark  { background: #5F8A7A; }
  /* Reuse the shipped piece rules by hoisting them here (mirror of styles.css) */
  .piece {
    font-family: "Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols2", "IBM Plex Sans", sans-serif;
    font-size: 32px; /* matches 8.4vw at 390px viewport → ~32.8px */
    line-height: 1;
    user-select: none;
    display: inline-block;
    transform: translateY(-1px);
  }
  .piece-w {
    color: #E8DBBE;
    text-shadow:
      -1px -1px 0 #2E2A3D,
       1px -1px 0 #2E2A3D,
      -1px  1px 0 #2E2A3D,
       1px  1px 0 #2E2A3D;
  }
  .piece-b {
    color: #2E2A3D;
    text-shadow:
      -1px -1px 0 #EEE3C4,
       1px -1px 0 #EEE3C4,
      -1px  1px 0 #EEE3C4,
       1px  1px 0 #EEE3C4;
  }
  .divider { padding: 12px 0 4px; }
</style>
</head><body>
<h1>white pieces on paper (light) — should be readable via walnut contrast stroke</h1>
<table><tr>
  <td class="lab">W · LIGHT</td>
  ${["k","q","r","b","n","p"].map(t => `<td class="cell light"><span class="piece piece-w">${["♚","♛","♜","♝","♞","♟"][["k","q","r","b","n","p"].indexOf(t)]}</span></td>`).join("")}
</tr></table>

<h1 class="divider">white pieces on walnut (dark) — the failing case in round-2</h1>
<table><tr>
  <td class="lab">W · DARK</td>
  ${["k","q","r","b","n","p"].map(t => `<td class="cell dark"><span class="piece piece-w">${["♚","♛","♜","♝","♞","♟"][["k","q","r","b","n","p"].indexOf(t)]}</span></td>`).join("")}
</tr></table>

<h1 class="divider">black pieces on paper (light) — should be high contrast (dark on bone)</h1>
<table><tr>
  <td class="lab">B · LIGHT</td>
  ${["k","q","r","b","n","p"].map(t => `<td class="cell light"><span class="piece piece-b">${["♚","♛","♜","♝","♞","♟"][["k","q","r","b","n","p"].indexOf(t)]}</span></td>`).join("")}
</tr></table>

<h1 class="divider">black pieces on walnut (dark) — near-tone; should still be legible via shape (≈7:1)</h1>
<table><tr>
  <td class="lab">B · DARK</td>
  ${["k","q","r","b","n","p"].map(t => `<td class="cell dark"><span class="piece piece-b">${["♚","♛","♜","♝","♞","♟"][["k","q","r","b","n","p"].indexOf(t)]}</span></td>`).join("")}
</tr></table>

<h1 class="divider">alternating strips — the real-world mixed condition</h1>
<table><tr>
  <td class="lab">MIXED</td>
  ${["k","q","r","b","n","p","k","q"].map((t,i) => `<td class="cell ${i%2===0?"light":"dark"}"><span class="piece piece-w">${filledFor(t)}</span></td>`).join("")}
</tr></table>
<table><tr>
  <td class="lab">MIXED</td>
  ${["k","q","r","b","n","p","k","q"].map((t,i) => `<td class="cell ${i%2===1?"light":"dark"}"><span class="piece piece-b">${filledFor(t)}</span></td>`).join("")}
</tr></table>

<script>
  function filledFor(t){ return { k:"♚", q:"♛", r:"♜", b:"♝", n:"♞", p:"♟" }[t] }
</script>
</body></html>`;

function filledFor(t){ return ({ k:"♚", q:"♛", r:"♜", b:"♝", n:"♞", p:"♟" })[t]; }

const rendered = html.replaceAll("${filledFor(t)}", "REPLACED-INLINE");
// Actually — just inline all glyphs directly by re-doing the string:
const glyphs = { k:"♚", q:"♛", r:"♜", b:"♝", n:"♞", p:"♟" };
const cellsW  = ["k","q","r","b","n","p"].map(t => `<td class="cell light"><span class="piece piece-w">${glyphs[t]}</span></td>`).join("");
const cellsWD = ["k","q","r","b","n","p"].map(t => `<td class="cell dark"><span class="piece piece-w">${glyphs[t]}</span></td>`).join("");
const cellsB  = ["k","q","r","b","n","p"].map(t => `<td class="cell light"><span class="piece piece-b">${glyphs[t]}</span></td>`).join("");
const cellsBD = ["k","q","r","b","n","p"].map(t => `<td class="cell dark"><span class="piece piece-b">${glyphs[t]}</span></td>`).join("");
const mixedW  = ["k","q","r","b","n","p","k","q"].map((t,i) => `<td class="cell ${i%2===0?"light":"dark"}"><span class="piece piece-w">${glyphs[t]}</span></td>`).join("");
const mixedB  = ["k","q","r","b","n","p","k","q"].map((t,i) => `<td class="cell ${i%2===1?"light":"dark"}"><span class="piece piece-b">${glyphs[t]}</span></td>`).join("");
const HTML = `<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" />
<style>
  body { padding: 12px 16px; background: #7CA898; font-family: "IBM Plex Mono", monospace; font-size: 11px; color: #2E2A3D; }
  h1 { font-size: 12px; margin: 0 0 8px 0; letter-spacing: 0.14em; text-transform: uppercase; color: #6B6455; font-weight: 500; }
  table { border-collapse: collapse; margin: 0; }
  td { padding: 0; margin: 0; }
  .lab { padding: 0 8px; font-size: 10px; color: #6B6455; letter-spacing: 0.1em; text-transform: uppercase; vertical-align: middle; }
  .cell { width: 44px; height: 44px; text-align: center; vertical-align: middle; }
  .light { background: #E8DBBE; }
  .dark  { background: #5F8A7A; }
  .piece {
    font-family: "Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols2", "IBM Plex Sans", sans-serif;
    font-size: 32px; line-height: 1; user-select: none; display: inline-block; transform: translateY(-1px);
  }
  .piece-w { color: #F0E6D2; text-shadow: -1px -1px 0 #3A2B1E, 1px -1px 0 #3A2B1E, -1px 1px 0 #3A2B1E, 1px 1px 0 #3A2B1E; }
  .piece-b { color: #12100C; }
  .divider { padding: 14px 0 4px; }
</style></head><body>
<h1>white pieces on paper (light) — must be readable via walnut contrast stroke</h1>
<table><tr><td class="lab">W&nbsp;·&nbsp;LIGHT</td>${cellsW}</tr></table>

<h1 class="divider">white pieces on walnut (dark) — the failing case in round-2</h1>
<table><tr><td class="lab">W&nbsp;·&nbsp;DARK</td>${cellsWD}</tr></table>

<h1 class="divider">black pieces on paper (light) — high contrast (dark on bone)</h1>
<table><tr><td class="lab">B&nbsp;·&nbsp;LIGHT</td>${cellsB}</tr></table>

<h1 class="divider">black pieces on walnut (dark) — near-tone; legible via shape (~7:1)</h1>
<table><tr><td class="lab">B&nbsp;·&nbsp;DARK</td>${cellsBD}</tr></table>

<h1 class="divider">alternating strips — the real-world mixed condition</h1>
<table><tr><td class="lab">MIX·W</td>${mixedW}</tr></table>
<table><tr><td class="lab">MIX·B</td>${mixedB}</tr></table>
</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 460, height: 720 } });
const page = await ctx.newPage();
await page.setContent(HTML, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts && document.fonts.ready);
await page.waitForTimeout(400);
const file = join(OUT, "piece-legibility-grid.png");
await page.screenshot({ path: file, fullPage: true });
console.log("wrote", file);
await browser.close();
