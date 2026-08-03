// Screenshot the chess app at mobile + desktop widths using a virtual WebAuthn
// authenticator, then walk auth → dashboard → play → game.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.env.BASE_URL || "http://localhost:8787";
const out = "/Users/tejasdc/workspace/chess-with-friends/tmp/reviews/screens-claude";
mkdirSync(out, { recursive: true });

const suffix = Date.now().toString(36).slice(-6);
const alice = `alice_${suffix}`;
const bob = `bob_${suffix}`;

async function addAuth(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
}

async function register(page, handle) {
  await page.goto(base);
  await page.getByPlaceholder("your_handle").fill(handle);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Create passkey" }).click();
  await page.getByText(`@${handle}`).waitFor();
}

async function shot(page, name) {
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  console.log("shot", name);
}

const browser = await chromium.launch();
try {
  // --- MOBILE 390 auth screen (unauthed) ---
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(base);
    await shot(page, "mobile-auth-empty");
    await page.getByPlaceholder("your_handle").fill("someone_new");
    await shot(page, "mobile-auth-typed");
    await ctx.close();
  }

  // --- DESKTOP 1200 auth screen (unauthed) ---
  {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(base);
    await shot(page, "desktop-auth-empty");
    await ctx.close();
  }

  // --- register alice on desktop, capture empty dashboard ---
  const aliceCtx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const alicePage = await aliceCtx.newPage();
  await addAuth(alicePage);
  await register(alicePage, alice);
  await shot(alicePage, "desktop-dashboard-empty");

  // register bob in a second context
  const bobCtx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const bobPage = await bobCtx.newPage();
  await addAuth(bobPage);
  await register(bobPage, bob);

  // alice adds bob
  await alicePage.getByPlaceholder("friend_handle").fill(bob);
  await alicePage.getByRole("button", { name: "Add" }).click();
  await alicePage.getByText("Friend request sent.").waitFor();
  await shot(alicePage, "desktop-friend-request-sent");

  await bobPage.reload();
  await shot(bobPage, "desktop-incoming-friend");
  await bobPage.getByRole("button", { name: "Accept" }).first().click();
  await bobPage.getByText(`@${alice}`).waitFor();

  await alicePage.reload();
  await shot(alicePage, "desktop-dashboard-with-friend");

  // alice challenges
  await alicePage.getByLabel("Time control").first().selectOption("10|0");
  await alicePage.getByRole("button", { name: "Send" }).click();
  await alicePage.getByText("Challenge sent.").waitFor();
  await shot(alicePage, "desktop-challenge-sent");

  await bobPage.reload();
  await shot(bobPage, "desktop-incoming-challenge");
  await bobPage.getByRole("button", { name: "Accept" }).first().click();
  await bobPage.waitForURL(/\/game\/gam_/);
  const gameId = bobPage.url().split("/game/")[1];

  await alicePage.goto(`${base}/game/${gameId}`);
  await alicePage.locator(".board").waitFor();
  await shot(alicePage, "desktop-game-fresh");

  // play a couple moves
  await alicePage.locator('[data-square="e2"]').click();
  await alicePage.locator('[data-square="e4"]').click();
  await bobPage.locator('[data-square="e7"]').click();
  await bobPage.locator('[data-square="e5"]').click();
  await alicePage.locator('[data-square="g1"]').click();
  await alicePage.locator('[data-square="f3"]').click();
  await alicePage.waitForTimeout(300);
  await shot(alicePage, "desktop-game-mid");

  // schedule tab
  await alicePage.goto(base);
  await alicePage.getByRole("tab", { name: "Schedule" }).click();
  await shot(alicePage, "desktop-play-schedule-tab");

  // --- MOBILE dashboard + game ---
  await alicePage.setViewportSize({ width: 390, height: 844 });
  await shot(alicePage, "mobile-dashboard-with-friend");
  await alicePage.getByRole("tab", { name: "Now" }).click();
  await shot(alicePage, "mobile-dashboard-now-tab");
  await alicePage.goto(`${base}/game/${gameId}`);
  await alicePage.locator(".board").waitFor();
  await shot(alicePage, "mobile-game");

  await aliceCtx.close();
  await bobCtx.close();
} finally {
  await browser.close();
}
