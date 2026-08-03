// Round-2 followup fix evidence at 390px mobile:
//  (a) alice's dashboard with bob-friend row → shows the GREEN dot (online)
//  (b) alice's dashboard with bob offline    → shows the HOLLOW dot
//  (c) mid-game shot showing:
//        - green dot presence next to opponent handle (no word)
//        - vermillion turn strip (alice's turn)
//  (d) opponent-piece-tap probe: click bob's e7 pawn — assert NO .legal-dot
//        or .legal-capture appears, and no square gets .selected.
//
// Drives the local dev worker (npm run worker:dev) — same one the test suite
// uses. Two-client dance mirrors tests/e2e.spec.ts patterns.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const OUT = "tmp/reviews/screens-r2";
mkdirSync(OUT, { recursive: true });

async function addAuth(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
}
async function register(page, handle) {
  await page.getByPlaceholder("your_handle").fill(handle);
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Log in or create account" }).click();
  // At 390px the topbar @handle is hidden by design — wait on a stable
  // dashboard-landed signal (the add-friend input) instead.
  await page.getByPlaceholder("friend_handle").waitFor({ timeout: 15000 });
}

// Assume the dev worker is already up on 8787 — we spawn it if not.
async function ensureServer() {
  const res = await fetch("http://localhost:8787/api/health").catch(() => null);
  if (res?.ok) return null;
  console.log("spawning wrangler dev...");
  const child = spawn("npm", ["run", "worker:dev"], { stdio: "ignore", detached: true });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const ok = await fetch("http://localhost:8787/api/health").catch(() => null);
    if (ok?.ok) { console.log("worker up"); return child; }
  }
  throw new Error("worker never became ready");
}

const child = await ensureServer();
const browser = await chromium.launch();

const suffix = Date.now().toString(36).slice(-5);
const aliceCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const bobCtx   = await browser.newContext({ viewport: { width: 390, height: 844 } });
const alice = await aliceCtx.newPage();
const bob   = await bobCtx.newPage();
await addAuth(alice);
await addAuth(bob);

const aliceH = `evA_${suffix}`;
const bobH   = `evB_${suffix}`;

// Register both
await alice.goto("http://localhost:8787/");
await register(alice, aliceH);
await bob.goto("http://localhost:8787/");
await register(bob, bobH);

// Friend
await alice.getByPlaceholder("friend_handle").fill(bobH);
await alice.getByRole("button", { name: "Add" }).click();
await bob.reload();
await bob.getByRole("button", { name: "Accept" }).first().click();
await alice.reload();

// Dashboard shot showing green dot for online friend
await alice.evaluate(() => document.fonts && document.fonts.ready);
await alice.waitForTimeout(500);
await alice.screenshot({ path: join(OUT, "fix-mobile-friend-online-green-dot.png"), fullPage: true });
console.log("wrote fix-mobile-friend-online-green-dot.png");

// Start a game
await alice.getByRole("button", { name: "Send" }).click();
await bob.reload();
await bob.getByRole("button", { name: "Accept" }).first().click();
await bob.waitForURL(/\/game\//);
const gameId = bob.url().split("/game/")[1];
await alice.goto(`http://localhost:8787/game/${gameId}`);
await alice.waitForSelector(".board");
await alice.evaluate(() => document.fonts && document.fonts.ready);
await alice.waitForTimeout(500);

// Baseline: mid-game shot with dot presence + vermillion active strip
await alice.screenshot({ path: join(OUT, "fix-mobile-game-dot-presence.png"), fullPage: true });
console.log("wrote fix-mobile-game-dot-presence.png");

// Probe (a): tap Bob's e7 pawn (opponent piece) → assert NO dots appear
await alice.locator('[data-square="e7"]').click();
await alice.waitForTimeout(150);
const opponentDots = await alice.locator(".legal-dot, .legal-capture").count();
const opponentSelected = await alice.locator(".square.selected").count();
console.log(`After tapping opponent e7: legal dots=${opponentDots}, selected squares=${opponentSelected} (both must be 0)`);
await alice.screenshot({ path: join(OUT, "fix-mobile-opponent-piece-tap-no-dots.png"), fullPage: true });

// Probe (b): tap own e2 pawn (my piece) → assert dots DO appear
await alice.locator('[data-square="e2"]').click();
await alice.waitForTimeout(150);
const ownDots = await alice.locator(".legal-dot").count();
const ownSelected = await alice.locator(".square.selected").count();
console.log(`After tapping own e2: legal dots=${ownDots}, selected squares=${ownSelected} (dots > 0, selected == 1)`);
await alice.screenshot({ path: join(OUT, "fix-mobile-own-piece-tap-shows-dots.png"), fullPage: true });

if (opponentDots !== 0 || opponentSelected !== 0) throw new Error(`FAIL: opponent tap produced dots=${opponentDots}, selected=${opponentSelected}`);
if (ownDots === 0 || ownSelected !== 1) throw new Error(`FAIL: own tap did not produce expected dots=${ownDots}, selected=${ownSelected}`);

console.log("PASS: opponent tap = silent, own tap = dots appear");

await browser.close();
if (child) {
  try { process.kill(-child.pid); } catch {}
}
