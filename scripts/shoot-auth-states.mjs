// Auth-row visual evidence: empty state (disabled ghost button), typed-free-handle
// state (enabled ink + "Sign up as @handle"), and typed-taken-handle state
// (enabled ink + "Sign in as @handle" + subline warning). Requires a live
// worker so the handle-probe actually returns login/register.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const OUT = "tmp/reviews/screens-r2";
mkdirSync(OUT, { recursive: true });

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

async function addAuth(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
}

const child = await ensureServer();
const browser = await chromium.launch();
const suffix = Date.now().toString(36).slice(-5);
const takenHandle = `tea_${suffix}`;

// Setup: register a taken handle in a throwaway session
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await c.newPage();
  await addAuth(p);
  await p.goto("http://localhost:8787/");
  await p.getByPlaceholder("your_handle").fill(takenHandle);
  await sleep(500);
  await p.getByRole("button", { name: /^(Sign up as @|Sign in( as @|.*sign up$))/ }).click();
  await p.getByPlaceholder("friend_handle").waitFor({ timeout: 10000 });
  await c.close();
}

// (1) Empty state — disabled ghost button
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await c.newPage();
  await p.goto("http://localhost:8787/");
  await p.waitForSelector(".auth-input");
  await p.evaluate(() => document.fonts && document.fonts.ready);
  await sleep(400);
  await p.screenshot({ path: join(OUT, "auth-state-1-empty.png"), fullPage: true });
  console.log("wrote auth-state-1-empty.png");
  await c.close();
}

// (2) Free handle — enabled ink, "Sign up as @..." label, empty subline (reserved)
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await c.newPage();
  await p.goto("http://localhost:8787/");
  await p.getByPlaceholder("your_handle").fill(`fresh_${suffix}`);
  // Wait for probe (350ms debounce) to update state
  await sleep(700);
  await p.evaluate(() => document.fonts && document.fonts.ready);
  await p.screenshot({ path: join(OUT, "auth-state-2-free-handle.png"), fullPage: true });
  console.log("wrote auth-state-2-free-handle.png");
  const btn = await p.evaluate(() => {
    const el = document.querySelector(".auth-primary");
    return { text: el.textContent, disabled: el.disabled };
  });
  console.log("  free state button:", JSON.stringify(btn));
  await c.close();
}

// (3) Taken handle — enabled ink, "Sign in as @..." label, subline populated
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await c.newPage();
  await p.goto("http://localhost:8787/");
  await p.getByPlaceholder("your_handle").fill(takenHandle);
  await sleep(700);
  await p.evaluate(() => document.fonts && document.fonts.ready);
  await p.screenshot({ path: join(OUT, "auth-state-3-taken-handle.png"), fullPage: true });
  console.log("wrote auth-state-3-taken-handle.png");
  const info = await p.evaluate(() => {
    const btn = document.querySelector(".auth-primary");
    const sub = document.querySelector(".auth-subline");
    return { btnText: btn.textContent, btnDisabled: btn.disabled, subText: sub.textContent.trim() };
  });
  console.log("  taken state:", JSON.stringify(info));
  if (!info.btnText.includes(`Sign in as @${takenHandle}`)) throw new Error(`FAIL: expected morphed 'Sign in as @', got '${info.btnText}'`);
  if (!/New here\?/.test(info.subText)) throw new Error(`FAIL: expected subline warning, got '${info.subText}'`);
  console.log("  PASS morphed label + subline present");
  await c.close();
}

await browser.close();
if (child) { try { process.kill(-child.pid); } catch {} }
