// Six-fixes evidence at 390px against the local dev worker:
//  (1) install prompt has a × dismiss; dismissal persists across reload
//  (2) push copy: friend-request body = "@handle sent a friend request"
//      challenge body = "@handle invited you to a game"
//  (3) app icon: already inspected as a static file (apple-touch-icon.png)
//  (4) inputs computed font-size >= 16px (iOS anti-zoom)
//  (5) capture-strip reserved space (min-height > 0 even with 0 captures)
//  (6) select chevron rendered as background-image
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
  await page.getByRole("button", { name: /^(Sign in( as @|.*sign up$)|Sign up as @|Working)/ }).click();
  await page.getByPlaceholder("friend_handle").waitFor({ timeout: 15000 });
}
async function fakePushSubscribe(page) {
  await page.evaluate(async () => {
    const endpoint = `https://push.invalid/${Math.random()}`;
    window.localStorage.setItem("testPushEndpoint", endpoint);
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: "test", auth: "test" } } }),
    });
  });
}
async function readLatestPush(page) {
  return page.evaluate(async () => {
    const endpoint = window.localStorage.getItem("testPushEndpoint") || "";
    const r = await fetch("/api/push/pending", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    return r.json();
  });
}
async function ensureServer() {
  const res = await fetch("http://localhost:8787/api/health").catch(() => null);
  if (res?.ok) return null;
  const child = spawn("npm", ["run", "worker:dev"], { stdio: "ignore", detached: true });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const ok = await fetch("http://localhost:8787/api/health").catch(() => null);
    if (ok?.ok) return child;
  }
  throw new Error("worker never came up");
}

const child = await ensureServer();
const browser = await chromium.launch();

// ---------- Fix 1: install dismiss + persistence ----------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await addAuth(page);
  await page.goto("http://localhost:8787/");
  await register(page, `dsm_${Date.now().toString(36).slice(-5)}`);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(300);
  // Before: install strip with dismiss visible
  await page.screenshot({ path: join(OUT, "fix2-install-with-dismiss.png"), fullPage: true });
  const strip = await page.locator(".install-strip").count();
  const dismiss = await page.getByRole("button", { name: "Dismiss install prompt" }).count();
  if (strip !== 1 || dismiss !== 1) throw new Error(`FAIL install visibility: strip=${strip} dismiss=${dismiss}`);
  // Click × and verify strip disappears
  await page.getByRole("button", { name: "Dismiss install prompt" }).click();
  await page.waitForTimeout(200);
  const afterStrip = await page.locator(".install-strip").count();
  const afterInstallBlock = await page.locator(".install-block").count();
  if (afterInstallBlock !== 0) throw new Error(`FAIL install did not dismiss visually: block=${afterInstallBlock}`);
  await page.screenshot({ path: join(OUT, "fix2-install-after-dismiss.png"), fullPage: true });
  // Reload and verify still dismissed
  await page.reload();
  await page.waitForSelector(".dashboard");
  const persistedBlock = await page.locator(".install-block").count();
  if (persistedBlock !== 0) throw new Error(`FAIL install dismissal did not persist across reload: block=${persistedBlock}`);
  console.log("PASS fix1 install-dismiss: visible→click→gone→reload still gone");

  // ---------- Fix 4: input font-size >= 16px ----------
  await page.reload();
  await page.waitForSelector(".dashboard");
  const friendInputSize = await page.evaluate(() => {
    const el = document.querySelector('.add-friend input');
    return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
  });
  if (friendInputSize < 16) throw new Error(`FAIL friend_handle input font-size ${friendInputSize} < 16`);
  console.log(`PASS fix4 add-friend input font-size = ${friendInputSize}px`);

  // ---------- Fix 6: select chevron ----------
  // Need to be in the Play section which shows a select — but need a friend
  // to actually have a Friend select. Skip; verify Time-control select which
  // is always there when a friend exists... actually the play form only shows
  // if home.friends.length > 0. Use a second-client dance to add a friend
  // then check the selects have background-image chevron.
  await ctx.close();
}

// ---------- Fix 4 (auth screen) + Fix 6 (chevron) + Fix 2 (push copy) ----------
const suffix = Date.now().toString(36).slice(-5);
const aliceCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const bobCtx   = await browser.newContext({ viewport: { width: 390, height: 844 } });
const alice = await aliceCtx.newPage();
const bob   = await bobCtx.newPage();
await addAuth(alice); await addAuth(bob);

// Fix 4 (b): auth screen handle input font-size
await alice.goto("http://localhost:8787/");
await alice.getByPlaceholder("your_handle").waitFor({ timeout: 10000 });
const authInputSize = await alice.evaluate(() => {
  const el = document.querySelector('input[placeholder="your_handle"]');
  return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
});
if (authInputSize < 16) throw new Error(`FAIL your_handle input font-size ${authInputSize} < 16`);
console.log(`PASS fix4 auth handle input font-size = ${authInputSize}px`);

await register(alice, `evA_${suffix}`);
await bob.goto("http://localhost:8787/");
await register(bob, `evB_${suffix}`);
await fakePushSubscribe(alice);
await fakePushSubscribe(bob);

// Fix 2 (a): friend-request push copy
await alice.getByPlaceholder("friend_handle").fill(`evb_${suffix}`);
await alice.getByRole("button", { name: "Add" }).click();
await alice.waitForTimeout(500);
const friendPush = await readLatestPush(bob);
console.log("friend-request push payload:", JSON.stringify(friendPush));
if (!friendPush || friendPush.type !== "friend_request") throw new Error(`FAIL friend push type: ${friendPush?.type}`);
if (!friendPush.body || !friendPush.body.includes("sent a friend request")) {
  throw new Error(`FAIL friend push body: ${friendPush.body}`);
}
console.log(`PASS fix2 friend push body = "${friendPush.body}"`);

await bob.reload();
await bob.getByRole("button", { name: "Accept" }).first().click();
await alice.reload();
// Wait for /api/me to land and the play-form to render — the play form
// only mounts when home.friends is non-empty.
await alice.locator(".play-form select").first().waitFor({ timeout: 10000 });

// Fix 6: with a friend now, PlaySection renders. Check the two selects for
// background-image (chevron).
const selectChevrons = await alice.evaluate(() => {
  const nodes = document.querySelectorAll('.field select, .play-form select');
  return Array.from(nodes).map((el) => ({
    ariaLabel: el.getAttribute('aria-label'),
    bgImage: getComputedStyle(el).backgroundImage,
    fontSize: parseFloat(getComputedStyle(el).fontSize),
  }));
});
console.log("select chevrons:", JSON.stringify(selectChevrons, null, 2));
const badChevron = selectChevrons.find((s) => !s.bgImage || s.bgImage === "none");
if (badChevron) throw new Error(`FAIL select missing chevron: ${JSON.stringify(badChevron)}`);
const badSelectSize = selectChevrons.find((s) => s.fontSize < 16);
if (badSelectSize) throw new Error(`FAIL select font-size < 16: ${JSON.stringify(badSelectSize)}`);
console.log(`PASS fix6 selects (${selectChevrons.length}) all have chevron + font-size >=16`);

await alice.screenshot({ path: join(OUT, "fix2-dashboard-with-chevrons.png"), fullPage: true });

// Fix 2 (b): challenge push copy
await alice.getByRole("button", { name: "Send" }).click();
await alice.waitForTimeout(500);
const chalPush = await readLatestPush(bob);
console.log("challenge push payload:", JSON.stringify(chalPush));
if (!chalPush || chalPush.type !== "challenge") throw new Error(`FAIL challenge push type: ${chalPush?.type}`);
if (!chalPush.body || !chalPush.body.includes("invited you to a game")) {
  throw new Error(`FAIL challenge push body: ${chalPush.body}`);
}
console.log(`PASS fix2 challenge push body = "${chalPush.body}"`);

// ---------- Fix 5: capture-strip reserved space ----------
await bob.reload();
await bob.getByRole("button", { name: "Accept" }).first().click();
await bob.waitForURL(/\/game\//);
const gameId = bob.url().split("/game/")[1];
await alice.goto(`http://localhost:8787/game/${gameId}`);
await alice.waitForSelector(".board");
await alice.evaluate(() => document.fonts && document.fonts.ready);
await alice.waitForTimeout(300);

const capturedStripHeights = await alice.evaluate(() => {
  const strips = document.querySelectorAll('.captured-strip');
  return Array.from(strips).map((el) => el.getBoundingClientRect().height);
});
console.log("capture-strip heights (empty state):", capturedStripHeights);
if (capturedStripHeights.length !== 2) throw new Error(`FAIL expected 2 capture strips at game start, got ${capturedStripHeights.length}`);
if (capturedStripHeights.some((h) => h < 20)) throw new Error(`FAIL a capture strip is collapsed: ${capturedStripHeights}`);
console.log(`PASS fix5 both capture strips reserved (heights=${capturedStripHeights.map((h) => h.toFixed(1)).join(", ")}px)`);

await alice.screenshot({ path: join(OUT, "fix2-game-strips-reserved.png"), fullPage: true });

console.log("\nALL SIX FIXES VERIFIED at 390px against local dev worker.");
await browser.close();
if (child) { try { process.kill(-child.pid); } catch {} }
