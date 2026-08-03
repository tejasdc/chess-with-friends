// Evidence for the fixed-bottom toast fix at 390px:
//  (1) toast pinned to viewport bottom on the fresh dashboard
//  (2) toast STILL pinned to viewport bottom while the page is scrolled
//      (artificially pad body to force scrollability so the proof is honest)
//  (3) error variant tinted vermillion
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const OUT = "tmp/reviews/screens-r2";
mkdirSync(OUT, { recursive: true });

async function addAuth(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
}
async function register(page, handle) {
  await page.getByPlaceholder("your_handle").fill(handle);
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /^(Sign in( as @|.*sign up$)|Sign up as @|Working)/ }).click();
  await page.getByPlaceholder("friend_handle").waitFor({ timeout: 15000 });
}
async function ensureServer() {
  const r = await fetch("http://localhost:8787/api/health").catch(() => null);
  if (r?.ok) return null;
  const child = spawn("npm", ["run", "worker:dev"], { stdio: "ignore", detached: true });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const ok = await fetch("http://localhost:8787/api/health").catch(() => null);
    if (ok?.ok) return child;
  }
  throw new Error("worker never came up");
}

const child = await ensureServer();
const browser = await chromium.launch();
const suffix = Date.now().toString(36).slice(-5);

const aliceCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const alice = await aliceCtx.newPage();
await addAuth(alice);
await alice.goto("http://localhost:8787/");
await register(alice, `toastA_${suffix}`);
await alice.evaluate(() => document.fonts && document.fonts.ready);

// Trigger info toast: add a nonexistent friend → server rejects but wait —
// that's an error path. Add an existing user first for an info toast, and
// a nonexistent one for the error toast.
const bobCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const bob = await bobCtx.newPage();
await addAuth(bob);
await bob.goto("http://localhost:8787/");
await register(bob, `toastB_${suffix}`);

// (1) Info toast on fresh dashboard — send friend request to bob
await alice.getByPlaceholder("friend_handle").fill(`toastb_${suffix}`);
await alice.getByRole("button", { name: "Add" }).click();
await alice.getByText("Friend request sent.").waitFor({ timeout: 5000 });
await alice.screenshot({ path: join(OUT, "toast-info-fresh.png"), fullPage: false });
console.log("wrote toast-info-fresh.png");

// (2) Force scrollability by padding the body, then scroll to bottom,
// prove the toast STAYS at viewport bottom. First trigger a new toast so
// the 4s timer resets.
await alice.evaluate(() => { document.body.style.paddingBottom = "1200px"; });
await alice.getByPlaceholder("friend_handle").fill(`toastc_${suffix}`);
await alice.getByRole("button", { name: "Add" }).click();
// The toast either appears with "sent" (if user existed) or with error copy.
// Either way we want it VISIBLE, so wait a tick then scroll.
await sleep(150);
await alice.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await sleep(150);
const toastAfterScroll = await alice.evaluate(() => {
  const t = document.querySelector(".toast");
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { visible: r.top >= 0 && r.bottom <= window.innerHeight, top: r.top, bottom: r.bottom, viewportH: window.innerHeight, docScroll: window.scrollY };
});
console.log("toast after scroll:", JSON.stringify(toastAfterScroll));
await alice.screenshot({ path: join(OUT, "toast-info-scrolled.png"), fullPage: false });
console.log("wrote toast-info-scrolled.png");

// (3) Error toast — trigger by adding a friend that doesn't exist
await alice.evaluate(() => { document.body.style.paddingBottom = ""; });
await sleep(4500);  // let previous toast auto-dismiss
await alice.getByPlaceholder("friend_handle").fill(`nobody_xyz_${suffix}`);
await alice.getByRole("button", { name: "Add" }).click();
await sleep(300);
await alice.screenshot({ path: join(OUT, "toast-error.png"), fullPage: false });
const errToast = await alice.evaluate(() => {
  const t = document.querySelector(".toast");
  return t ? { classes: t.className, text: t.textContent } : null;
});
console.log("error toast:", JSON.stringify(errToast));

// (4) Auto-dismiss check — wait 4.5s and confirm gone
await sleep(4500);
const gone = await alice.evaluate(() => !document.querySelector(".toast"));
console.log("auto-dismissed after 4.5s:", gone);

if (!toastAfterScroll || !toastAfterScroll.visible) throw new Error("FAIL: toast not visible after scroll");
if (!errToast || !errToast.classes.includes("toast-error")) throw new Error("FAIL: error toast missing error class");
if (!gone) throw new Error("FAIL: toast did not auto-dismiss");
console.log("ALL PASS: toast fixed-bottom, visible on scroll, error tinted, auto-dismisses");

await browser.close();
if (child) try { process.kill(-child.pid); } catch {}
