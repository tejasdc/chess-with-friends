// Hostile-conditions harness. The mechanics suite plays a perfect game
// over a perfect socket; this one simulates what a real phone does —
// sockets die, the tab hides, the CPU is throttled, moves come in
// bursts. A round is not shippable unless this suite is green.
//
// All tests use serial mode within the file (one browser at a time
// on a memory-constrained machine). Each test spins up two clients,
// registers them, gets them into a game, then does something horrible
// and asserts the game recovers without user intervention.

import { expect, test, type Browser, type CDPSession, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

// ---------- helpers (kept in-file so this suite is self-contained) ----------

async function addAuthenticator(page: Page) {
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
  return cdp;
}

async function register(page: Page, handle: string) {
  await page.goto("/");
  await page.getByPlaceholder("your_handle").fill(handle);
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Log in or create account" }).click();
  await expect(page.getByText(`@${handle}`)).toBeVisible();
}

async function twoClientsInGame(browser: Browser, suffix: string, opts: { instrumentSockets?: boolean } = {}) {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  if (opts.instrumentSockets) {
    // Wrap WebSocket on both pages BEFORE any navigation so we can
    // reach into the socket bag from within tests.
    await installSocketTracker(alice);
    await installSocketTracker(bob);
  }
  await addAuthenticator(alice);
  await addAuthenticator(bob);
  const aH = `adva_${suffix}`;
  const bH = `advb_${suffix}`;
  await register(alice, aH);
  await register(bob, bH);

  await alice.getByPlaceholder("friend_handle").fill(bH);
  await alice.getByRole("button", { name: "Add" }).click();
  await expect(alice.getByText("Friend request sent.")).toBeVisible();
  await bob.reload();
  await bob.getByRole("button", { name: "Accept" }).first().click();
  await expect(bob.getByText(`@${aH}`)).toBeVisible();

  await alice.reload();
  await alice.getByLabel("Time control").first().selectOption("10|0");
  await alice.getByRole("button", { name: "Send" }).click();
  await bob.reload();
  await bob.getByRole("button", { name: "Accept" }).first().click();
  await expect(bob).toHaveURL(/\/game\/gam_/);
  const gameId = bob.url().split("/game/")[1];
  await alice.goto(`/game/${gameId}`);
  await expect(alice.locator(".board")).toBeVisible();
  await expect(bob.locator(".board")).toBeVisible();
  return { aliceCtx, bobCtx, alice, bob, gameId, handles: { a: aH, b: bH } };
}

async function move(page: Page, from: string, to: string) {
  await page.locator(`[data-square="${from}"]`).click();
  await page.locator(`[data-square="${to}"]`).click();
}

async function killAllSockets(page: Page) {
  // Force-close every WebSocket owned by the page. Used to simulate
  // an iOS-style silent kill.
  await page.evaluate(() => {
    const sockets = (window as unknown as { __sockets?: WebSocket[] }).__sockets;
    if (sockets) sockets.forEach((s) => { try { s.close(); } catch { /* ignored */ } });
  });
}

async function installSocketTracker(page: Page) {
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    const bag: WebSocket[] = [];
    (window as unknown as { __sockets?: WebSocket[] }).__sockets = bag;
    class Tracked extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        bag.push(this);
      }
    }
    (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = Tracked as unknown as typeof WebSocket;
  });
}

// ---------- adversity scenarios ----------

test("socket death mid-game recovers silently, no lost opponent moves", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix, { instrumentSockets: true });
  try {
    // Alice (white) moves — bob receives normally.
    await move(alice, "e2", "e4");
    await expect(bob.locator('[data-square="e4"] .piece')).toBeVisible({ timeout: 5000 });

    // Bob makes his response so it's alice's turn next.
    await move(bob, "e7", "e5");
    await expect(alice.locator('[data-square="e5"] .piece')).toBeVisible({ timeout: 5000 });

    // Kill bob's socket mid-game. The board must not freeze.
    await killAllSockets(bob);

    // Alice makes another move while bob's socket is dead. Bob's
    // reconnect (backoff or visibility path) must pick it up.
    await move(alice, "g1", "f3");
    await expect(bob.locator('[data-square="f3"] .piece')).toBeVisible({ timeout: 15000 });
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("visibilitychange after socket death triggers immediate resync", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix, { instrumentSockets: true });
  try {
    // Warm up — alice is white in this app, so she moves first.
    await move(alice, "e2", "e4");
    await expect(bob.locator('[data-square="e4"] .piece')).toBeVisible({ timeout: 5000 });
    await move(bob, "e7", "e5");
    await expect(alice.locator('[data-square="e5"] .piece')).toBeVisible({ timeout: 5000 });

    // Kill bob's live socket AND flip visibility hidden — this is the
    // iOS "app backgrounded, socket died silently" state.
    await bob.evaluate(() => {
      const bag = (window as unknown as { __sockets?: WebSocket[] }).__sockets;
      if (bag) bag.forEach((s) => { try { s.close(); } catch { /* ignore */ } });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Alice makes a move while bob's socket is dead + tab "hidden".
    await move(alice, "g1", "f3");

    // Bring bob back: visibility handler must reconnect + resync
    // immediately and pick up the missed move.
    await bob.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect(bob.locator('[data-square="f3"] .piece')).toBeVisible({ timeout: 10000 });
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("network dropout: bob catches up after his network returns", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix);
  try {
    // Warm up so it's alice's turn again after the offline period.
    await move(alice, "e2", "e4");
    await expect(bob.locator('[data-square="e4"] .piece')).toBeVisible({ timeout: 5000 });
    await move(bob, "e7", "e5");
    await expect(alice.locator('[data-square="e5"] .piece')).toBeVisible({ timeout: 5000 });

    // Cut bob's network entirely via CDP.
    const cdp = await bob.context().newCDPSession(bob);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });

    // Alice makes a move while bob is offline. His board should not
    // update until network + reconnect return.
    await move(alice, "d2", "d4");

    // Restore bob's network. Reconnect + REST resync must fire on the
    // next visibilitychange OR on the next backoff-driven reconnect
    // attempt, and the missed move must materialize.
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: 10_000_000,
      uploadThroughput: 10_000_000,
    });
    await bob.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(bob.locator('[data-square="d4"] .piece')).toBeVisible({ timeout: 20000 });
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("rapid double-click on the same square does not desync", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix);
  try {
    // Alice double-clicks e2 → e4 (rapid taps a user makes on mobile).
    const from = alice.locator('[data-square="e2"]');
    const to = alice.locator('[data-square="e4"]');
    await from.click();
    await from.click(); // deselect
    await from.click();
    await to.click({ clickCount: 2 }); // rapid duplicate
    // The move must land once (piece on e4), and it must not have
    // caused a phantom second move on the server.
    await expect(alice.locator('[data-square="e4"] .piece')).toBeVisible({ timeout: 5000 });
    // Bob mirrors that state — only one move made.
    await expect(bob.locator('[data-square="e4"] .piece')).toBeVisible({ timeout: 5000 });

    // Sanity: it's bob's turn now. If a phantom second move had gone
    // through it would be alice's turn again.
    await expect(bob.getByText("Your move")).toBeVisible({ timeout: 5000 });
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("move roundtrip stays under the perf budget on a throttled CPU", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix);
  try {
    // Throttle alice's CPU 4x to simulate a modest phone.
    const cdp = await alice.context().newCDPSession(alice);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

    const start = Date.now();
    await move(alice, "e2", "e4");
    await expect(bob.locator('[data-square="e4"] .piece')).toBeVisible({ timeout: 5000 });
    const roundtrip = Date.now() - start;

    // Local, no real network — round-trip under 2000ms on a 4x-throttled
    // CPU is the budget. If we ever ship code that regresses this by
    // 10x (the "incredibly bad lag" symptom), the test catches it.
    expect(roundtrip).toBeLessThan(2000);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

// Silence unused-import warning if a future refactor drops CDPSession above.
export type _KeepCDP = CDPSession;
