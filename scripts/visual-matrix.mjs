// scripts/visual-matrix.mjs
//
// Visual matrix — ship-gate machinery mandated by Tejas 2026-08-04
// after a schedule-form overlap regression shipped without eyeballs.
//
// Walks every surface × meaningful state × viewport (390, 430, 1440) via
// Playwright + a virtual WebAuthn authenticator, producing:
//   - Individual PNG per (surface, state, viewport) at full resolution
//   - HTML contact sheet per viewport (loads the shots as a labeled
//     mosaic) so the reviewer can scan all cells in one page
//
// Also emits an overlap report per viewport: for each shot, the set of
// visible labeled elements (input/select/button/label) and whether any
// two intersect. The `no element overlap across the visual matrix`
// adversity test runs the same walk in Playwright and asserts zero
// intersections — but this script's overlap report exists so the human
// reviewer can see WHAT overlapped WHERE without needing to re-run the
// test.
//
// Requires a local wrangler dev server on http://localhost:8787. Errors
// out with a hint if the server is not reachable.
//
// Usage: node scripts/visual-matrix.mjs

import { chromium } from "playwright";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BASE = "http://localhost:8787";
const OUT_ROOT = "tmp/visual-matrix";

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
  { name: "1440x900", width: 1440, height: 900 },
];

async function preflight() {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (!r.ok) throw new Error(`unhealthy: ${r.status}`);
  } catch (e) {
    console.error(`\n[visual-matrix] cannot reach ${BASE}/api/health.`);
    console.error(`Run 'npx wrangler dev --local --persist-to=.wrangler/state --port 8787' in another shell, then retry.\n`);
    process.exit(2);
  }
}

async function addAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  return cdp;
}

async function register(page, handle) {
  await page.goto(`${BASE}/`);
  await page.getByPlaceholder("your_handle").fill(handle);
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /^(Sign in( as @|.*sign up$)|Sign up as @|Working)/ }).click();
  await page.getByText(`@${handle}`).waitFor({ timeout: 15000 });
}

async function screenshot(page, dir, key) {
  const path = join(dir, `${key}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}

async function collectOverlaps(page) {
  return await page.evaluate(() => {
    // Elements that CARRY user intent — the ones that must never
    // visually collide with another such element.
    const sel = "input, select, button, textarea, label";
    const nodes = Array.from(document.querySelectorAll(sel));
    // Modal overlays cover content by design; only same-layer pairs count.
    const MODAL_SELECTOR = ".menu-sheet, .menu-backdrop, [role='dialog'], [role='alertdialog']";
    const boxes = [];
    for (const el of nodes) {
      if (el.getAttribute("aria-hidden") === "true") continue;
      const r = el.getBoundingClientRect();
      // Skip zero-size / hidden / off-screen
      if (r.width < 4 || r.height < 4) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      if (r.right < 0 || r.left > window.innerWidth) continue;
      // Skip elements that are ANCESTORS of another labeled element
      // (a <label> that wraps an <input> naturally shares bounding
      // area with the input — that's not "overlap" the way Tejas
      // means it; only sibling-level collisions count).
      const isAncestorOfOther = nodes.some((o) => o !== el && el.contains(o));
      const modal = Boolean(el.closest(MODAL_SELECTOR));
      const short = (el.tagName + (el.getAttribute("class") ? "." + el.getAttribute("class").split(" ")[0] : "")).slice(0, 60);
      boxes.push({ tag: short, ancestor: isAncestorOfOther, modal, x: r.x, y: r.y, w: r.width, h: r.height });
    }
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].ancestor) continue;
      for (let j = i + 1; j < boxes.length; j++) {
        if (boxes[j].ancestor) continue;
        const a = boxes[i], b = boxes[j];
        // Skip modal-over-page pairs (menu-sheet floating above dashboard
        // chrome is by design, not a layout regression).
        if (a.modal !== b.modal) continue;
        // AABB intersection
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        if (ix >= 3 && iy >= 3) overlaps.push({ a: a.tag, b: b.tag, iw: ix, ih: iy });
      }
    }
    return { boxes: boxes.length, overlaps };
  });
}

// ----- surface × state walk ------------------------------------------

// Each state entry: { key, label, mount(page, ctx) }
// ctx carries persistent state (users, tokens, etc.).

async function unauth(page, path) {
  const ctx = await page.context();
  await ctx.clearCookies();
  await page.goto(`${BASE}${path}`);
}

async function stateLanding(page, ctx) {
  await unauth(page, "/");
  await page.waitForSelector(".puzzle-shelf[data-puzzle-id]", { timeout: 15000 });
  await page.waitForTimeout(700);
}

async function stateLandingSelected(page, ctx) {
  await stateLanding(page, ctx);
  const shelf = page.locator(".puzzle-shelf");
  const id = await shelf.getAttribute("data-puzzle-id");
  const first = ctx.positions.find((p) => p.id === id);
  if (!first) return;
  await page.locator(`.landing-square[data-square="${first.solution.from}"]`).click();
  await page.waitForTimeout(200);
}

async function stateLandingTransitioning(page, ctx) {
  await stateLanding(page, ctx);
  const shelf = page.locator(".puzzle-shelf");
  const id = await shelf.getAttribute("data-puzzle-id");
  const first = ctx.positions.find((p) => p.id === id);
  if (!first) return;
  await page.locator(`.landing-square[data-square="${first.solution.from}"]`).click();
  await page.waitForTimeout(220);
  await page.locator(`.landing-square[data-square="${first.solution.to}"]`).click();
  // Screenshot while data-animating=true.
  await page.waitForFunction(
    () => document.querySelector(".puzzle-shelf")?.getAttribute("data-animating") === "true",
    null,
    { timeout: 6000 },
  );
  await page.waitForTimeout(700);
}

async function stateInspirations(page, ctx) {
  await unauth(page, "/inspirations");
  await page.waitForSelector(".insp-title");
  await page.waitForTimeout(400);
}

async function stateDashboardRest(page, ctx) {
  await page.goto(`${BASE}/`);
  await page.getByText(`@${ctx.alice.handle}`).waitFor({ timeout: 8000 });
  // Close menu if lingering
  await page.evaluate(() => (document.querySelector(".menu-backdrop"))?.click());
  await page.waitForTimeout(300);
}

async function stateDashboardAddFriendOpen(page, ctx) {
  await stateDashboardRest(page, ctx);
  const t = page.getByRole("button", { name: "Add a friend" });
  if ((await t.getAttribute("aria-expanded")) !== "true") await t.click();
  await page.waitForTimeout(200);
}

async function stateDashboardScheduleOpen(page, ctx) {
  await stateDashboardRest(page, ctx);
  const t = page.getByRole("button", { name: "Schedule a game" });
  if ((await t.getAttribute("aria-expanded")) !== "true") await t.click();
  await page.waitForTimeout(200);
}

async function stateDashboardMenuOpen(page, ctx) {
  await stateDashboardRest(page, ctx);
  await page.locator(".menu-dot").click();
  await page.waitForTimeout(200);
}

async function stateDashboardMenuNotifOpen(page, ctx) {
  await stateDashboardMenuOpen(page, ctx);
  await page.getByRole("button", { name: /Notifications/ }).click();
  await page.waitForTimeout(200);
}

async function stateWaitingRoom(page, ctx) {
  // Alice invites bob (already friends per ctx setup).
  await stateDashboardRest(page, ctx);
  await page.getByRole("button", { name: `Invite @${ctx.bob.handle}` }).click();
  await page.waitForURL(/\/waiting\/chl_/);
  await page.waitForTimeout(500);
}

async function stateGameLive(page, ctx) {
  // Assumes stateWaitingRoom was called on alice earlier, then bob accepts.
  // Simpler: alice sends fresh invite, bob accepts through his page.
  await stateDashboardRest(page, ctx);
  await page.getByRole("button", { name: `Invite @${ctx.bob.handle}` }).click();
  await page.waitForURL(/\/waiting\/chl_/);
  const chlUrl = new URL(page.url()).pathname;
  const chl = chlUrl.split("/waiting/")[1];
  // Have bob accept via a helper page in his context
  await ctx.acceptChallengeAsBob(chl);
  await page.waitForURL(/\/game\/gam_/, { timeout: 12000 });
  await page.waitForTimeout(500);
}

async function stateGameSelected(page, ctx) {
  await stateGameLive(page, ctx);
  // Click any own piece (Alice plays white — try e2 pawn if present).
  const own = page.locator(`.board:not(.board-static) .square[data-square="e2"]`);
  if (await own.count()) await own.first().click().catch(() => {});
  await page.waitForTimeout(200);
}

// ----- runner --------------------------------------------------------

async function makeContext(browser) {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  await addAuthenticator(alice);
  await addAuthenticator(bob);
  const suffix = Date.now().toString(36).slice(-6);
  const aH = `mata_${suffix}`;
  const bH = `matb_${suffix}`;
  await register(alice, aH);
  await register(bob, bH);
  // Alice → Bob friend request, bob accepts.
  const addToggle = alice.getByRole("button", { name: "Add a friend" });
  if ((await addToggle.getAttribute("aria-expanded")) !== "true") await addToggle.click();
  await alice.getByPlaceholder("friend_handle").fill(bH);
  await alice.getByRole("button", { name: "Add", exact: true }).click();
  await alice.getByText("Friend request sent.").waitFor();
  await bob.reload();
  await bob.getByRole("button", { name: "Accept" }).first().click();
  await bob.getByText(`@${aH}`).waitFor();
  // Presence heartbeat.
  await bob.evaluate(() => fetch("/api/presence/heartbeat", { method: "POST" }));
  await alice.reload();
  await alice.getByText(`@${bH}`).waitFor();
  // Positions
  const raw = (await import("node:fs")).readFileSync("src/data/positions.json", "utf8");
  const positions = JSON.parse(raw);
  return {
    alice: { page: alice, handle: aH, ctx: aliceCtx },
    bob:   { page: bob,   handle: bH, ctx: bobCtx },
    positions,
    async acceptChallengeAsBob(chl) {
      await bob.reload();
      await bob.getByRole("button", { name: "Accept" }).first().click().catch(() => {});
      await bob.waitForURL(/\/game\/gam_/, { timeout: 12000 });
    },
  };
}

const CELLS = [
  // Unauth cells (any page context works — we'll use a fresh unauth ctx).
  { group: "unauth", key: "landing-rest",          label: "landing / rest",         run: stateLanding },
  { group: "unauth", key: "landing-selected",      label: "landing / piece selected", run: stateLandingSelected },
  { group: "unauth", key: "landing-transitioning", label: "landing / mid-transition", run: stateLandingTransitioning },
  { group: "unauth", key: "inspirations-rest",     label: "inspirations",           run: stateInspirations },
  // Alice cells (uses alice page + shared ctx).
  { group: "alice",  key: "dashboard-rest",             label: "dashboard / rest",             run: stateDashboardRest },
  { group: "alice",  key: "dashboard-addfriend-open",   label: "dashboard / add-friend open",  run: stateDashboardAddFriendOpen },
  { group: "alice",  key: "dashboard-schedule-open",    label: "dashboard / schedule open",    run: stateDashboardScheduleOpen },
  { group: "alice",  key: "dashboard-menu-open",        label: "dashboard / menu open",        run: stateDashboardMenuOpen },
  { group: "alice",  key: "dashboard-menu-notif-open",  label: "dashboard / notif info open",  run: stateDashboardMenuNotifOpen },
  { group: "alice",  key: "waiting-room",               label: "waiting room",                  run: stateWaitingRoom },
  // Game-live/game-selected are follow-up cells. Live-game reuse of
  // the challenge inbox needs a per-run reset that isn't in yet; the
  // existing game tests (game-screen-scroll, socket-death, etc.) cover
  // game-state regressions at 390 and desktop for now. Add these back
  // once the reset is wired.
];

async function runViewport(browser, viewport) {
  const dir = join(OUT_ROOT, viewport.name);
  if (existsSync(dir)) await rm(dir, { recursive: true });
  await mkdir(dir, { recursive: true });

  // Fresh browser context PER viewport so the pages get the right size.
  const ctx = await makeContext(browser);
  await ctx.alice.page.setViewportSize({ width: viewport.width, height: viewport.height });
  await ctx.bob.page.setViewportSize({ width: viewport.width, height: viewport.height });

  const unauthCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const unauthPage = await unauthCtx.newPage();

  const results = [];
  for (const cell of CELLS) {
    try {
      const page = cell.group === "unauth" ? unauthPage : ctx.alice.page;
      await cell.run(page, ctx);
      const path = await screenshot(page, dir, cell.key);
      const overlaps = await collectOverlaps(page);
      results.push({ ...cell, path, overlaps, ok: true });
      console.log(`  [ok] ${viewport.name} · ${cell.label}  (${overlaps.boxes} boxes, ${overlaps.overlaps.length} overlaps)`);
    } catch (e) {
      results.push({ ...cell, error: String(e).slice(0, 300), ok: false });
      console.log(`  [FAIL] ${viewport.name} · ${cell.label}: ${String(e).slice(0, 200)}`);
    }
  }
  // Contact sheet HTML
  const html = renderContactSheet(viewport, results);
  await writeFile(join(dir, "contact-sheet.html"), html);
  // Overlap JSON
  const overlapRows = results
    .filter((r) => r.ok && r.overlaps.overlaps.length)
    .map((r) => ({ cell: r.key, count: r.overlaps.overlaps.length, samples: r.overlaps.overlaps.slice(0, 8) }));
  await writeFile(join(dir, "overlaps.json"), JSON.stringify(overlapRows, null, 2));

  await unauthCtx.close();
  await ctx.alice.ctx.close();
  await ctx.bob.ctx.close();
  return { viewport, results };
}

function renderContactSheet(viewport, results) {
  const cells = results.map((r) => {
    const status = r.ok ? (r.overlaps.overlaps.length ? "warn" : "ok") : "fail";
    return `
      <figure class="cell cell-${status}">
        <div class="thumb"><img src="${r.key}.png" alt="${r.label}"></div>
        <figcaption>
          <span class="label">${r.label}</span>
          <span class="meta">${r.ok ? `${r.overlaps.boxes} elements · ${r.overlaps.overlaps.length} overlap${r.overlaps.overlaps.length === 1 ? "" : "s"}` : `FAILED: ${r.error}`}</span>
        </figcaption>
      </figure>
    `;
  }).join("\n");
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Visual matrix · ${viewport.name}</title>
<style>
  body { margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f4efe4; color: #2b2233; }
  h1 { font-family: ui-monospace, monospace; font-weight: 500; font-size: 18px; margin: 0 0 8px; }
  .sub { color: #6b6472; margin-bottom: 24px; font-family: ui-monospace, monospace; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
  .cell { margin: 0; background: #fff; border: 1px solid #d0c8b8; padding: 0; }
  .cell-warn { border-color: #c9a24a; }
  .cell-fail { border-color: #b23a3a; }
  .thumb { background: #ede6d5; }
  .thumb img { display: block; width: 100%; height: auto; }
  figcaption { padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; font-family: ui-monospace, monospace; font-size: 12px; }
  .label { color: #2b2233; }
  .meta { color: #6b6472; font-size: 11px; }
  .cell-warn .meta { color: #7a5a1a; }
  .cell-fail .meta { color: #b23a3a; }
</style>
</head><body>
<h1>Visual matrix · ${viewport.name}</h1>
<p class="sub">${results.length} cells · ${results.filter((r) => r.ok && r.overlaps.overlaps.length).length} with element overlap · ${results.filter((r) => !r.ok).length} failed to render</p>
<div class="grid">
${cells}
</div>
</body></html>`;
}

async function main() {
  await preflight();
  await mkdir(OUT_ROOT, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const viewport of VIEWPORTS) {
      console.log(`\n[matrix] viewport ${viewport.name}`);
      await runViewport(browser, viewport);
    }
  } finally {
    await browser.close();
  }
  console.log(`\n[matrix] done. Contact sheets:`);
  for (const v of VIEWPORTS) console.log(`  file://${process.cwd()}/${OUT_ROOT}/${v.name}/contact-sheet.html`);
}

main().catch((e) => { console.error(e); process.exit(1); });
