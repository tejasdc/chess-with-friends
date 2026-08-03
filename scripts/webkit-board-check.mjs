// Reproduce & verify the "iOS Safari board grows unboundedly" bug fix.
// Uses playwright's real WebKit engine at 390×844 (iPhone 12/13/14 layout viewport).
// Sequence: register → challenge → open game → measure board width →
// scroll → re-measure. Board width must be stable, finite, and ≤ viewport.

import { webkit } from "playwright";
import { mkdirSync } from "node:fs";

const base = "http://localhost:8787";
const out = "/Users/tejasdc/workspace/chess-with-friends/tmp/reviews/screens-claude";
mkdirSync(out, { recursive: true });

const suffix = Date.now().toString(36).slice(-6);
const alice = `wka_${suffix}`;
const bob = `wkb_${suffix}`;

async function addAuth(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
}

async function register(page, handle) {
  await page.goto(base);
  await page.getByPlaceholder("your_handle").fill(handle);
  await page.getByRole("button", { name: /^(Sign in( as @|.*sign up$)|Sign up as @|Working)/ }).click();
  await page.getByRole("button", { name: "Create passkey" }).click();
  await page.getByText(`@${handle}`).waitFor();
}

async function shot(page, name) {
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
  console.log("shot", name);
}

async function measure(page) {
  return page.evaluate(() => {
    const holder = document.querySelector(".board-holder");
    const board = document.querySelector(".board");
    const square = document.querySelector(".square");
    const doc = document.documentElement;
    return {
      holderWidth: holder?.getBoundingClientRect().width,
      holderHeight: holder?.getBoundingClientRect().height,
      boardWidth: board?.getBoundingClientRect().width,
      squareWidth: square?.getBoundingClientRect().width,
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
    };
  });
}

// WebKit note: virtual authenticator via CDP is not available in webkit.
// Workaround: run the two-client setup in chromium, then re-open the game URL in webkit
// where the session is the value we care about layout-testing. But we need webkit's
// authenticated session too. Instead: create a game via chromium (with virtual authn),
// then have webkit auth via a shared cookie? Too fragile. Simpler: skip authenticated
// game state in webkit, and layout-test the auth screen static board (which reproduces
// the same size chain: auth-board → board-holder → board → aspect-ratio) at the
// same viewport, plus scroll it. Then also open a game URL directly (unauth → login
// screen, but the auth landing still has the board).

const browser = await webkit.launch({ headless: false });
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  await page.goto(base);
  await page.waitForSelector(".board-holder");

  const initial = await measure(page);
  console.log("initial", initial);
  await shot(page, "webkit-auth-initial");

  // Simulate URL bar hide via scroll — the exact iOS Safari trigger for the bug.
  await page.evaluate(() => window.scrollTo(0, 200));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);

  const afterScroll = await measure(page);
  console.log("afterScroll", afterScroll);
  await shot(page, "webkit-auth-after-scroll");

  // Repeat scroll several times to trigger any compounding.
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollTo(0, Math.random() * 400));
    await page.waitForTimeout(120);
  }
  const compounded = await measure(page);
  console.log("compounded", compounded);
  await shot(page, "webkit-auth-compounded");

  const overflowed = compounded.docScrollWidth > compounded.docClientWidth + 1;
  const grew = Math.abs(compounded.boardWidth - initial.boardWidth) > 1;

  console.log("---");
  console.log("overflowed horizontally:", overflowed);
  console.log("board size drift:", (compounded.boardWidth - initial.boardWidth).toFixed(2), "px");
  console.log(overflowed || grew ? "FAIL — bug still reproduces" : "PASS — board width is stable, no overflow");

  await ctx.close();
} finally {
  await browser.close();
}
