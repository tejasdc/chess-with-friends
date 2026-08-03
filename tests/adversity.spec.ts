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
  // See tests/e2e.spec.ts register() for morph-label rationale.
  await page.getByRole("button", { name: /^(Sign in( as @|.*sign up$)|Sign up as @|Working)/ }).click();
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
  // Presence heartbeat takes a moment to register the peer as online —
  // the Invite button unlocks once bob's presence is fresh.
  await presenceHeartbeat(bob);
  await alice.reload();
  await alice.getByRole("button", { name: `Invite @${bH}` }).click();
  await expect(alice).toHaveURL(/\/waiting\/chl_/);
  await bob.reload();
  await bob.getByRole("button", { name: "Accept" }).first().click();
  await expect(bob).toHaveURL(/\/game\/gam_/);
  const gameId = bob.url().split("/game/")[1];
  // Sender transitions to the game via the waiting-room poll — no need
  // to navigate them manually.
  await expect(alice).toHaveURL(/\/game\/gam_/, { timeout: 6000 });
  await expect(alice.locator(".board")).toBeVisible();
  await expect(bob.locator(".board")).toBeVisible();
  return { aliceCtx, bobCtx, alice, bob, gameId, handles: { a: aH, b: bH } };
}

async function presenceHeartbeat(page: Page) {
  // Force a heartbeat POST from the page so the server marks this user
  // online in the friend list immediately. Home data refresh in the
  // sibling client picks that up on their next reload.
  await page.evaluate(() => {
    return fetch("/api/presence/heartbeat", { method: "POST" });
  });
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

test("sending a challenge takes the sender to the waiting room; accept transitions in-place", async ({ browser }) => {
  // Inviting means sitting down. Alice sends a challenge and lands
  // immediately on /waiting/{id} with the board visible and an
  // "waiting for @bob" line. When Bob accepts, Alice's page transitions
  // to /game/{id} via the poll — she never sees the dashboard again.
  const suffix = Date.now().toString(36).slice(-6);
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  await addAuthenticator(alice);
  await addAuthenticator(bob);
  const aH = `wait_a${suffix}`;
  const bH = `wait_b${suffix}`;
  try {
    await register(alice, aH);
    await register(bob, bH);
    await alice.getByPlaceholder("friend_handle").fill(bH);
    await alice.getByRole("button", { name: "Add" }).click();
    await expect(alice.getByText("Friend request sent.")).toBeVisible();
    await bob.reload();
    await bob.getByRole("button", { name: "Accept" }).first().click();
    await expect(bob.getByText(`@${aH}`)).toBeVisible();
    await alice.reload();
    await presenceHeartbeat(bob);
    await alice.reload();
    await alice.getByRole("button", { name: `Invite @${bH}` }).click();
    // Sender lands on the waiting room, not the dashboard.
    await expect(alice).toHaveURL(/\/waiting\/chl_/);
    await expect(alice.getByText(new RegExp(`waiting for @${bH}`))).toBeVisible();
    await expect(alice.locator(".board")).toBeVisible();
    // Bob accepts.
    await bob.reload();
    await bob.getByRole("button", { name: "Accept" }).first().click();
    await expect(bob).toHaveURL(/\/game\/gam_/);
    // Alice transitions in-place to the game via the waiting-room poll.
    await expect(alice).toHaveURL(/\/game\/gam_/, { timeout: 5000 });
    await expect(alice.locator(".board")).toBeVisible();
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("off-turn tap on own piece is silent — no toast, no selection, no request", async ({ browser }) => {
  // Silent-board principle: during play the BOARD is the only feedback
  // channel. Bob is black, so on the opening position it's white to
  // move. Bob tapping any of his own pieces (own-piece off-turn) MUST
  // be a silent no-op: no toast, no selection state, no move request.
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix);
  try {
    const failures: string[] = [];
    bob.on("response", (r) => {
      if (r.url().includes("/api/games/") && r.url().includes("/move")) {
        failures.push(`unexpected move POST to ${r.url()}`);
      }
    });
    // Bob taps his own e7 pawn — it is currently white's turn.
    await bob.locator('[data-square="e7"]').click();
    await bob.waitForTimeout(300);
    // No toast should appear.
    const toast = await bob.locator(".toast, .toast-body").count();
    expect(toast).toBe(0);
    // No selection frame on e7.
    const selected = await bob.locator('[data-square="e7"].selected').count();
    expect(selected).toBe(0);
    // No move request fired.
    expect(failures).toEqual([]);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("illegal-destination tap deselects silently — no toast, no request", async ({ browser }) => {
  // Alice (white) selects e2 pawn then taps a non-legal square (e5).
  // Client-side legality via chess.js gates the submission — nothing
  // goes to the server, no toast fires, selection just clears.
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix);
  try {
    const failures: string[] = [];
    alice.on("response", (r) => {
      if (r.url().includes("/api/games/") && r.url().includes("/move")) {
        failures.push(`unexpected move POST to ${r.url()}`);
      }
    });
    await alice.locator('[data-square="e2"]').click();
    await alice.waitForTimeout(150);
    await alice.locator('[data-square="e5"]').click();  // illegal — pawn can't jump to e5
    await alice.waitForTimeout(300);
    const toast = await alice.locator(".toast, .toast-body").count();
    expect(toast).toBe(0);
    // Selection cleared.
    const stillSelected = await alice.locator('[data-square="e2"].selected').count();
    expect(stillSelected).toBe(0);
    // No move request fired.
    expect(failures).toEqual([]);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("game screen never scrolls at 390x844, 1280x700, or 1440x900", async ({ browser }) => {
  // Tejas rejected a build where the game screen scrolled — on his phone
  // AND on his laptop (the huge desktop board pushed the bottom bar
  // below the fold). The hard constraint: while a game is open, the
  // page's scroll extent MUST equal the viewport. If it doesn't, the
  // board is over-tall and needs to shrink into the remaining budget.
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix);
  try {
    const sizes = [
      { width: 390, height: 844 },   // iPhone 14 Pro
      { width: 1280, height: 700 },  // laptop with short vertical space
      { width: 1440, height: 900 },  // standard desktop
    ];
    for (const size of sizes) {
      await alice.setViewportSize(size);
      // Force a reflow beat so aspect-ratio + flex chain settles.
      await alice.waitForTimeout(150);
      const scroll = await alice.evaluate(() => ({
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        innerHeight: window.innerHeight,
        screen: document.body.dataset.screen,
      }));
      // Body should be flipped into game mode.
      expect(scroll.screen).toBe("game");
      // Scroll extent must not exceed the viewport height. Allow a
      // 1px slack for subpixel rounding.
      expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.clientHeight + 1);
      expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.innerHeight + 1);
    }
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("recurring schedule creates a game on each firing and can be ended by either party", async ({ browser }) => {
  // Two friends. Alice proposes a daily schedule starting NOW-ish
  // (server accepts anything within 60s of now); Bob accepts; the
  // server's alarm fires and creates a game + queues scheduled_start
  // pushes to both. The schedule stays "accepted" with nextFireAt one
  // day ahead. Bob then cancels the series; the schedule becomes
  // "cancelled".
  const suffix = Date.now().toString(36).slice(-6);
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  await addAuthenticator(alice);
  await addAuthenticator(bob);
  const aH = `rec_a${suffix}`;
  const bH = `rec_b${suffix}`;
  try {
    await register(alice, aH);
    await register(bob, bH);
    await alice.getByPlaceholder("friend_handle").fill(bH);
    await alice.getByRole("button", { name: "Add" }).click();
    await bob.reload();
    await bob.getByRole("button", { name: "Accept" }).first().click();
    await expect(bob.getByText(`@${aH}`)).toBeVisible();

    // Propose a daily schedule starting ~30 seconds from now (server
    // allows startAt within 60s in the past; a small future offset
    // lets the alarm fire during the test window).
    await alice.reload();
    const startAt = Date.now() + 3_000;
    const scheduleId = await alice.evaluate(async ([friendHandle, at]) => {
      // Find friendId by fetching /api/me — the home data enumerates friends.
      const me = await (await fetch("/api/me", { credentials: "include" })).json() as { friends: Array<{ id: string; handle: string }> };
      const friend = me.friends.find((f) => f.handle === friendHandle)!;
      const res = await fetch("/api/schedules", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ friendId: friend.id, timeControl: "10|0", startAt: at, recurrence: { kind: "daily" } }),
      });
      const data = await res.json() as { schedule: { id: string } };
      return data.schedule.id;
    }, [bH, startAt] as const);
    expect(scheduleId).toMatch(/^sch_/);

    // Bob accepts.
    await bob.reload();
    await bob.getByRole("button", { name: "Accept" }).first().click();

    // Wait for the alarm to fire — startAt is ~3s ahead; give the DO
    // a beat past that.
    await bob.waitForTimeout(6_000);

    // Confirm a scheduled_start game exists and the schedule rolled
    // forward instead of firing "fired" (recurring stays accepted).
    type HomeShape = { schedules: Array<{ id: string; status: string; recurrence?: { kind: string }; lastGameId?: string; nextFireAt: number }> };
    const post = await alice.evaluate(async () => (await fetch("/api/me", { credentials: "include" })).json() as Promise<HomeShape>);
    const scheduleAfter = post.schedules.find((s) => s.id === scheduleId)!;
    expect(scheduleAfter.status).toBe("accepted");
    expect(scheduleAfter.recurrence?.kind).toBe("daily");
    expect(scheduleAfter.lastGameId).toMatch(/^gam_/);
    // nextFireAt has advanced by ~1 day.
    const dayLater = startAt + 24 * 60 * 60 * 1000;
    expect(Math.abs(scheduleAfter.nextFireAt - dayLater)).toBeLessThan(60_000);

    // Bob cancels the series.
    await bob.evaluate(async (id) => {
      await fetch(`/api/schedules/${id}/cancel`, { method: "POST", credentials: "include", body: "{}" });
    }, scheduleId);
    const finalState = await alice.evaluate(async () => (await fetch("/api/me", { credentials: "include" })).json() as Promise<HomeShape>);
    const scheduleEnded = finalState.schedules.find((s) => s.id === scheduleId)!;
    expect(scheduleEnded.status).toBe("cancelled");
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("landing puzzle solve walks to a new caption and position without chrome regressions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const shelf = page.locator(".puzzle-shelf");
  await expect(shelf).toBeVisible();
  const firstPuzzle = await shelf.getAttribute("data-puzzle-id");
  const firstCaption = await page.locator(".puzzle-caption").innerText();

  await expect(page.locator(".menu-dot")).toHaveCount(0);
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  const initialScroll = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    innerHeight: window.innerHeight,
  }));
  expect(initialScroll.scrollHeight).toBeLessThanOrEqual(initialScroll.clientHeight + 1);
  expect(initialScroll.scrollHeight).toBeLessThanOrEqual(initialScroll.innerHeight + 1);

  await page.locator('.landing-square[data-square="d8"]').click();
  await expect(page.locator('.landing-square[data-square="h4"] .legal-dot, .landing-square[data-square="h4"] .legal-capture')).toBeVisible();
  await page.locator('.landing-square[data-square="h4"]').click();

  await expect(shelf).toHaveAttribute("data-animating", "true", { timeout: 1200 });
  await expect(page.locator(".puzzle-caption")).not.toHaveText(firstCaption);
  await expect(shelf).toHaveAttribute("data-animating", "false", { timeout: 8000 });

  const nextPuzzle = await shelf.getAttribute("data-puzzle-id");
  const nextCaption = await page.locator(".puzzle-caption").innerText();
  expect(nextPuzzle).not.toBe(firstPuzzle);
  expect(nextCaption).not.toBe(firstCaption);
  await expect(page.locator('.landing-piece[data-square="g2"][data-piece="wq"]')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(page.locator(".menu-dot")).toHaveCount(0);

  const finalScroll = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    innerHeight: window.innerHeight,
  }));
  expect(finalScroll.scrollHeight).toBeLessThanOrEqual(finalScroll.clientHeight + 1);
  expect(finalScroll.scrollHeight).toBeLessThanOrEqual(finalScroll.innerHeight + 1);
});

// Silence unused-import warning if a future refactor drops CDPSession above.
export type _KeepCDP = CDPSession;
