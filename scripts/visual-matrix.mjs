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
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const BASE = "http://localhost:8787";
const OUT_ROOT = "tmp/visual-matrix";

// iOS Simulator UDIDs — booted device is used as the truth pass for
// mobile cells (real WebKit, real browser chrome). Ledger 2026-08-04:
// "any no-scroll surface must be verified with browser chrome present,
// not just nominal viewport." Simulator surfaces expose bugs headless
// Chromium cannot see (URL bar squeezes usable height by ~120-190px on
// mobile Safari; iOS Safari flex behavior differs on intrinsic-min-
// content). Only URL-reachable states are captured on simulator —
// deeper interactive states remain headless.
const SIMULATOR_UDIDS = [
  "3C3CF59F-CC82-47B0-A139-0F14D6AF6165", // iPhone 17 Pro
];

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
  await page.waitForSelector(".dashboard", { timeout: 8000 });
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

async function ensureOutgoingChallenge(ctx) {
  // Idempotent (server dedupes per fromId/toId): safe to call whenever a
  // pending outgoing challenge is required as data setup for a cell.
  const alice = ctx.alice.page;
  await alice.evaluate(async (friendId) => {
    const r = await fetch("/api/challenges", {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ friendId, timeControl: "10|0" }),
    });
    return r.status;
  }, ctx.bob.id);
}

async function ensureNoOutgoingChallenge(ctx) {
  // Withdraw whatever pending outgoing challenge alice has to bob so the
  // next cell doesn't inherit the stale state.
  const alice = ctx.alice.page;
  await alice.evaluate(async () => {
    const me = await (await fetch("/api/me")).json();
    for (const c of me.sentChallenges || []) {
      if (c.status === "pending") {
        await fetch(`/api/challenges/${c.id}/withdraw`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" });
      }
    }
  });
}

async function stateDashboardOutgoingChallenge(page, ctx) {
  // "Waiting for @bob" row in In-play + friend row reads "Invited".
  await ensureOutgoingChallenge(ctx);
  await stateDashboardRest(page, ctx);
}

async function stateDashboardIncomingChallenge(page, ctx) {
  // Screenshot BOB'S page — alice invited him, his home shows the
  // incoming band + friend row for alice reads "Accept".
  await ensureOutgoingChallenge(ctx);
  const bob = ctx.bob.page;
  await bob.goto(`${BASE}/`);
  await bob.waitForSelector(".dashboard", { timeout: 8000 });
  await bob.waitForTimeout(300);
  return bob; // signal the runner to screenshot bob's page instead
}

async function stateWaitingRoom(page, ctx) {
  await ensureOutgoingChallenge(ctx);
  await page.goto(`${BASE}/`);
  await page.waitForSelector(".dashboard", { timeout: 8000 });
  // Open the waiting room via the row that now exists on the dashboard.
  await page.getByRole("link", { name: new RegExp(`waiting room.*@${ctx.bob.handle}`) }).first().click();
  await page.waitForURL(/\/waiting\/chl_/);
  await page.waitForTimeout(500);
}

async function ensureLiveGame(ctx) {
  // Ensure alice+bob are in an active game together. Prereq: an
  // outgoing challenge exists; then bob accepts via API. If a game is
  // already active between them, this is a no-op.
  await ensureOutgoingChallenge(ctx);
  const bob = ctx.bob.page;
  await bob.evaluate(async () => {
    const me = await (await fetch("/api/me")).json();
    for (const c of me.challenges || []) {
      if (c.status === "pending") {
        await fetch(`/api/challenges/${c.id}/accept`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" });
      }
    }
  });
}

async function stateDashboardLiveGame(page, ctx) {
  await ensureLiveGame(ctx);
  await page.goto(`${BASE}/`);
  await page.waitForSelector(".dashboard", { timeout: 8000 });
  await page.waitForTimeout(400);
}

async function stateGameLive(page, ctx) {
  await ensureLiveGame(ctx);
  const alice = ctx.alice.page;
  const me = await alice.evaluate(async () => (await fetch("/api/me")).json());
  const game = (me.games || []).find((g) => g.status === "active");
  if (!game) return;
  await alice.goto(`${BASE}/game/${game.id}`);
  await alice.waitForSelector(".board", { timeout: 8000 });
  await alice.waitForTimeout(400);
}

async function stateGameSelected(page, ctx) {
  await stateGameLive(page, ctx);
  const own = page.locator(`.board:not(.board-static) .square[data-square="e2"]`);
  if (await own.count()) await own.first().click().catch(() => {});
  await page.waitForTimeout(200);
}

async function stateDashboardAcceptedSchedule(page, ctx) {
  // Propose a schedule (idempotent-ish; each call creates a fresh row).
  // We only need ONE accepted schedule for the state to render.
  const alice = ctx.alice.page;
  const me = await alice.evaluate(async () => (await fetch("/api/me")).json());
  const hasAccepted = (me.schedules || []).some((s) => s.status === "accepted");
  if (!hasAccepted) {
    await alice.evaluate(async (friendId) => {
      const startAt = Date.now() + 24 * 60 * 60 * 1000; // 24h out
      await fetch("/api/schedules", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ friendId, timeControl: "10|0", startAt, recurrence: { kind: "once" } }),
      });
    }, ctx.bob.id);
    // Bob accepts.
    const bob = ctx.bob.page;
    await bob.evaluate(async () => {
      const bm = await (await fetch("/api/me")).json();
      const pending = (bm.schedules || []).filter((s) => s.status === "pending");
      for (const s of pending) {
        await fetch(`/api/schedules/${s.id}/accept`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" });
      }
    });
  }
  await page.goto(`${BASE}/`);
  await page.waitForSelector(".dashboard", { timeout: 8000 });
  await page.waitForTimeout(300);
}

async function stateDashboardIncomingFriendRequest(page, ctx) {
  // A THIRD user (charlie) sends alice a friend request; alice's home
  // then shows the incoming band. Charlie's ctx is created lazily and
  // reused across viewport runs.
  if (!ctx.charlie) return; // charlie provisioned by makeContext
  await ctx.charlie.page.evaluate(async (aliceHandle) => {
    await fetch("/api/friends/request", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: aliceHandle }) });
  }, ctx.alice.handle);
  await page.goto(`${BASE}/`);
  await page.waitForSelector(".dashboard", { timeout: 8000 });
  await page.waitForTimeout(300);
}

async function stateDashboardOutgoingFriendRequest(page, ctx) {
  // Alice requests DEBBIE (a fresh unregistered handle). No one accepts,
  // so it stays as a pending outgoing request bullet.
  const debbie = `mtd_${Date.now().toString(36).slice(-5)}`;
  // Register debbie in a throwaway context so the handle exists.
  const dCtx = await ctx.browser.newContext();
  const dPage = await dCtx.newPage();
  try {
    await addAuthenticator(dPage);
    await register(dPage, debbie);
  } finally {
    await dCtx.close();
  }
  await ctx.alice.page.evaluate(async (h) => {
    await fetch("/api/friends/request", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: h }) });
  }, debbie);
  await page.goto(`${BASE}/`);
  await page.waitForSelector(".dashboard", { timeout: 8000 });
  await page.waitForTimeout(300);
}

async function stateDashboardZeroFriends(page, ctx) {
  // Fresh user with no relationships — proves the empty-state copy.
  // Uses the ephemeral zero-friends context spun up per viewport run.
  const zPage = ctx.zeroFriends.page;
  await zPage.goto(`${BASE}/`);
  await zPage.waitForSelector(".dashboard", { timeout: 8000 });
  await zPage.waitForTimeout(300);
  return zPage;
}

// ----- runner --------------------------------------------------------

async function makeContext(browser) {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const charlieCtx = await browser.newContext();
  const zeroCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  const charlie = await charlieCtx.newPage();
  const zero = await zeroCtx.newPage();
  await addAuthenticator(alice);
  await addAuthenticator(bob);
  await addAuthenticator(charlie);
  await addAuthenticator(zero);
  const suffix = Date.now().toString(36).slice(-6);
  const aH = `mata_${suffix}`;
  const bH = `matb_${suffix}`;
  const cH = `matc_${suffix}`;
  const zH = `matz_${suffix}`;
  await register(alice, aH);
  await register(bob, bH);
  await register(charlie, cH);
  await register(zero, zH);
  // Alice ↔ Bob become friends.
  const addToggle = alice.getByRole("button", { name: "Add a friend" });
  if ((await addToggle.getAttribute("aria-expanded")) !== "true") await addToggle.click();
  await alice.getByPlaceholder("friend_handle").fill(bH);
  await alice.getByRole("button", { name: "Add", exact: true }).click();
  await alice.getByText("Friend request sent.").waitFor();
  await bob.reload();
  await bob.getByRole("button", { name: "Accept" }).first().click();
  await bob.getByText(`@${aH}`).waitFor();
  await bob.evaluate(() => fetch("/api/presence/heartbeat", { method: "POST" }));
  await alice.reload();
  await alice.getByText(`@${bH}`).waitFor();
  // Pull IDs so the seed helpers can hit the API without UI selectors.
  const [aliceInfo, bobInfo, charlieInfo] = await Promise.all([
    alice.evaluate(async () => (await (await fetch("/api/me")).json()).user),
    bob.evaluate(async () => (await (await fetch("/api/me")).json()).user),
    charlie.evaluate(async () => (await (await fetch("/api/me")).json()).user),
  ]);
  const raw = (await import("node:fs")).readFileSync("src/data/positions.json", "utf8");
  const positions = JSON.parse(raw);
  return {
    browser,
    alice:   { page: alice,   handle: aH, id: aliceInfo.id,   ctx: aliceCtx },
    bob:     { page: bob,     handle: bH, id: bobInfo.id,     ctx: bobCtx },
    charlie: { page: charlie, handle: cH, id: charlieInfo.id, ctx: charlieCtx },
    zeroFriends: { page: zero, handle: zH, ctx: zeroCtx },
    positions,
  };
}

// The matrix covers UI states AND DATA STATES (Tejas 2026-08-04): a
// state that only exists when data exists is a state nobody looks at
// unless the matrix creates the data. Cells that need data seed it via
// the API and then screenshot the resulting UI. Sequence matters —
// cells that share data (e.g. waiting-room and dashboard-with-waiting)
// reuse the seed; cells with conflicting data (e.g. rest vs
// outgoing-challenge) are ordered so cleanup runs between them.
//
// Return value from run(page, ctx): normally undefined (screenshot the
// passed `page`); if a state returns a Page object, that alternate page
// is screenshotted instead (used when a state naturally lives on bob's
// or a fresh user's page — the state IS the point of view).
const CELLS = [
  // Unauth cells.
  { group: "unauth", key: "landing-rest",          label: "landing / rest",              run: stateLanding },
  { group: "unauth", key: "landing-selected",      label: "landing / piece selected",    run: stateLandingSelected },
  { group: "unauth", key: "landing-transitioning", label: "landing / mid-transition",    run: stateLandingTransitioning },
  { group: "unauth", key: "inspirations-rest",     label: "inspirations",                run: stateInspirations },
  // Data-agnostic dashboard states (alice as the primary POV).
  { group: "alice",  key: "dashboard-rest",             label: "dashboard / rest",             run: stateDashboardRest },
  { group: "alice",  key: "dashboard-addfriend-open",   label: "dashboard / add-friend open",  run: stateDashboardAddFriendOpen },
  { group: "alice",  key: "dashboard-schedule-open",    label: "dashboard / schedule open",    run: stateDashboardScheduleOpen },
  { group: "alice",  key: "dashboard-menu-open",        label: "dashboard / menu open",        run: stateDashboardMenuOpen },
  { group: "alice",  key: "dashboard-menu-notif-open",  label: "dashboard / notif info open",  run: stateDashboardMenuNotifOpen },
  // Data-dependent states (Tejas 2026-08-04): each seeds the data
  // it needs, some clean up between so no cross-cell pollution.
  { group: "alice",  key: "dashboard-outgoing-challenge", label: "dashboard / outgoing challenge (waiting row + Invited)", run: stateDashboardOutgoingChallenge },
  { group: "alice",  key: "waiting-room",                 label: "waiting room",                                            run: stateWaitingRoom },
  { group: "alice",  key: "dashboard-incoming-challenge", label: "bob's dashboard / incoming challenge (Accept row)",       run: stateDashboardIncomingChallenge },
  { group: "alice",  key: "dashboard-live-game",          label: "dashboard / live game (Resume + in-play row)",            run: stateDashboardLiveGame },
  { group: "alice",  key: "game-live",                    label: "game / live",                                             run: stateGameLive },
  { group: "alice",  key: "game-selected",                label: "game / selected",                                         run: stateGameSelected },
  { group: "alice",  key: "dashboard-accepted-schedule",  label: "dashboard / accepted schedule (Scheduled)",               run: stateDashboardAcceptedSchedule },
  { group: "alice",  key: "dashboard-friend-req-incoming",label: "dashboard / incoming friend request",                     run: stateDashboardIncomingFriendRequest },
  { group: "alice",  key: "dashboard-friend-req-outgoing",label: "dashboard / outgoing friend request",                     run: stateDashboardOutgoingFriendRequest },
  { group: "alice",  key: "dashboard-zero-friends",       label: "dashboard / zero friends (empty state)",                   run: stateDashboardZeroFriends },
];

async function runViewport(browser, viewport) {
  const dir = join(OUT_ROOT, viewport.name);
  if (existsSync(dir)) await rm(dir, { recursive: true });
  await mkdir(dir, { recursive: true });

  // Fresh browser context PER viewport so the pages get the right size.
  const ctx = await makeContext(browser);
  for (const pg of [ctx.alice.page, ctx.bob.page, ctx.charlie.page, ctx.zeroFriends.page]) {
    await pg.setViewportSize({ width: viewport.width, height: viewport.height });
  }

  const unauthCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const unauthPage = await unauthCtx.newPage();

  const results = [];
  for (const cell of CELLS) {
    try {
      const defaultPage = cell.group === "unauth" ? unauthPage : ctx.alice.page;
      // A cell may return an alternate Page — some states live on
      // bob's or a fresh user's page (incoming challenge on bob,
      // zero-friends on the empty user). Fall back to the default
      // when the cell returns void.
      const returned = await cell.run(defaultPage, ctx);
      const targetPage = returned && typeof returned.screenshot === "function" ? returned : defaultPage;
      const path = await screenshot(targetPage, dir, cell.key);
      const overlaps = await collectOverlaps(targetPage);
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
  await ctx.charlie.ctx.close();
  await ctx.zeroFriends.ctx.close();
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

// iOS Simulator capture — mandate 2026-08-04. Boots the target device
// (if not already booted), points mobile Safari at each URL-reachable
// surface, and grabs the device screenshot (browser chrome included).
// Only URL states are captured; deeper interactive states stay headless.
async function runSimulator() {
  const dir = join(OUT_ROOT, "simulator");
  if (existsSync(dir)) await rm(dir, { recursive: true });
  await mkdir(dir, { recursive: true });
  const results = [];
  const URL_STATES = [
    { key: "landing-rest",    label: "landing / rest",   path: "/" },
    { key: "inspirations",    label: "inspirations",     path: "/inspirations" },
  ];
  for (const udid of SIMULATOR_UDIDS) {
    // Boot if not booted (idempotent — simctl returns error if already booted).
    try { await execFileP("xcrun", ["simctl", "boot", udid]); } catch { /* already booted */ }
    // Give the device a beat to settle if we just booted.
    await new Promise((r) => setTimeout(r, 800));
    for (const st of URL_STATES) {
      const url = `${BASE}${st.path}`;
      try {
        await execFileP("xcrun", ["simctl", "openurl", udid, url]);
        // Safari needs a moment to load. Landing needs the shelf mount
        // + measure; give it real time.
        await new Promise((r) => setTimeout(r, 3500));
        const path = join(dir, `${st.key}-${udid.slice(0, 8)}.png`);
        await execFileP("xcrun", ["simctl", "io", udid, "screenshot", path]);
        results.push({ udid, ...st, path, ok: true });
        console.log(`  [ok] simulator ${udid.slice(0, 8)} · ${st.label}`);
      } catch (e) {
        results.push({ udid, ...st, error: String(e).slice(0, 300), ok: false });
        console.log(`  [FAIL] simulator ${udid.slice(0, 8)} · ${st.label}: ${String(e).slice(0, 200)}`);
      }
    }
  }
  // HTML contact sheet for simulator shots.
  const html = renderSimulatorSheet(results);
  await writeFile(join(dir, "contact-sheet.html"), html);
  return results;
}

function renderSimulatorSheet(results) {
  const cells = results.map((r) => {
    const status = r.ok ? "ok" : "fail";
    return `
      <figure class="cell cell-${status}">
        <div class="thumb"><img src="${r.path.split("/").pop()}" alt="${r.label}"></div>
        <figcaption>
          <span class="label">${r.label}</span>
          <span class="meta">simulator ${r.udid.slice(0, 8)} · real WebKit + browser chrome</span>
        </figcaption>
      </figure>
    `;
  }).join("\n");
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Visual matrix · iOS Simulator (real WebKit)</title>
<style>
  body { margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f4efe4; color: #2b2233; }
  h1 { font-family: ui-monospace, monospace; font-weight: 500; font-size: 18px; margin: 0 0 8px; }
  .sub { color: #6b6472; margin-bottom: 24px; font-family: ui-monospace, monospace; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }
  .cell { margin: 0; background: #fff; border: 1px solid #d0c8b8; }
  .cell-fail { border-color: #b23a3a; }
  .thumb { background: #ede6d5; }
  .thumb img { display: block; width: 100%; height: auto; }
  figcaption { padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; font-family: ui-monospace, monospace; font-size: 12px; }
  .label { color: #2b2233; }
  .meta { color: #6b6472; font-size: 11px; }
</style>
</head><body>
<h1>Visual matrix · iOS Simulator (real WebKit)</h1>
<p class="sub">Mobile Safari truth pass. Captures URL-reachable states with browser chrome present — the class of bug headless Chromium cannot see.</p>
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
  // Simulator pass — mandatory for mobile truth. Runs after headless
  // so it doesn't block the fast programmatic guards.
  console.log(`\n[matrix] simulator (real WebKit)`);
  try {
    await runSimulator();
  } catch (e) {
    console.log(`  [warn] simulator pass failed: ${String(e).slice(0, 200)}`);
  }
  console.log(`\n[matrix] done. Contact sheets:`);
  for (const v of VIEWPORTS) console.log(`  file://${process.cwd()}/${OUT_ROOT}/${v.name}/contact-sheet.html`);
  console.log(`  file://${process.cwd()}/${OUT_ROOT}/simulator/contact-sheet.html`);
}

main().catch((e) => { console.error(e); process.exit(1); });
