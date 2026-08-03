import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const screenDir = "tmp/reviews/screens";

test.describe.configure({ mode: "serial" });

test("notification prompt disappears after permission is granted and stays gone on reload", async ({ browser }) => {
  mkdirSync(screenDir, { recursive: true });
  const suffix = Date.now().toString(36).slice(-6);
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const subscription = {
      endpoint: "https://push.invalid/ui-notification-test",
      keys: { p256dh: "test", auth: "test" },
      toJSON() {
        return { endpoint: this.endpoint, keys: this.keys };
      },
    };
    class FakeNotification {
      static get permission() {
        return window.localStorage.getItem("notificationPermission") || "default";
      }

      static async requestPermission() {
        window.localStorage.setItem("notificationPermission", "granted");
        return "granted";
      }
    }
    const registration = {
      pushManager: {
        async getSubscription() {
          return window.localStorage.getItem("notificationSubscription") ? subscription : null;
        },
        async subscribe() {
          window.localStorage.setItem("notificationSubscription", "true");
          return subscription;
        },
      },
    };
    Object.defineProperty(window, "Notification", { configurable: true, value: FakeNotification });
    Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {} });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        register: async () => registration,
      },
    });
  });
  const page = await context.newPage();
  await addAuthenticator(page);
  await page.goto("/");
  const handle = `notify_${suffix}`;
  await register(page, handle);

  await expect(page.getByRole("button", { name: "Enable notifications" })).toBeVisible();
  await page.getByRole("button", { name: "Enable notifications" }).click();
  await expect(page.getByRole("button", { name: "Enable notifications" })).toBeHidden();
  await expect(page.getByText("Notifications enabled for friend requests, challenges, and scheduled games.")).toBeVisible();
  await shot(page, "00-notifications-enabled-prompt-gone");

  await page.reload();
  await expect(page.getByRole("button", { name: "Enable notifications" })).toBeHidden();
  await shot(page, "00-notifications-enabled-after-reload");
  await context.close();
});

// Regression guard for the "board grows unboundedly on scroll" bug that
// hit iOS Safari (chess.tejas.nyc, 2026-08-03). Root cause was implicit
// auto-track grids in the .shell > .stage > .game > .board-column chain
// feeding back through .board-holder's aspect-ratio: each layout pass
// recomputed a slightly larger width. This test measures the board at a
// mobile viewport, scrolls, and asserts the width is stable and ≤ viewport.
// Chromium doesn't reproduce the iOS-specific loop, but this catches any
// future breakage of the "definite width" invariant.
test("auth board holds a stable size at mobile viewport under scroll", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto("/");
  // The auth screen mounts a 3D wallet inside .auth-scene — a definite-width,
  // aspect-ratio child of the same grid ancestor chain that the game screen
  // uses. If the invariant breaks, this element grows unboundedly on scroll
  // (the original iOS Safari bug).
  await page.waitForSelector(".auth-scene");

  async function measure() {
    return page.evaluate(() => {
      const el = document.querySelector(".auth-scene");
      const doc = document.documentElement;
      return {
        elementWidth: el ? el.getBoundingClientRect().width : 0,
        docScrollWidth: doc.scrollWidth,
        docClientWidth: doc.clientWidth,
      };
    });
  }

  const initial = await measure();
  expect(initial.elementWidth).toBeGreaterThan(0);
  expect(initial.elementWidth).toBeLessThanOrEqual(390);
  expect(initial.docScrollWidth).toBeLessThanOrEqual(initial.docClientWidth + 1);

  for (let i = 0; i < 8; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), i * 60);
    await page.waitForTimeout(60);
  }
  const after = await measure();

  expect(Math.abs(after.elementWidth - initial.elementWidth)).toBeLessThan(1);
  expect(after.docScrollWidth).toBeLessThanOrEqual(after.docClientWidth + 1);

  await context.close();
});

// Regression guard for the sign-out bug: signOut() used to pushState-only,
// leaving stale home state so the dashboard kept rendering after logout.
// The fix does a hard navigation. Test that after clicking Sign out, we land
// back on the auth screen (Handle input visible).
test("sign out returns to the auth screen", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await addAuthenticator(page);
  await page.goto("/");
  const handle = `signout_${Date.now().toString(36).slice(-6)}`;
  await register(page, handle);
  await expect(page.getByText(`@${handle}`)).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByPlaceholder("your_handle")).toBeVisible();
  await expect(page.getByText(`@${handle}`)).toBeHidden();

  await context.close();
});

// Guard for the "Sarah types a taken handle" case (the exact ambiguity that
// killed the morph-only design): the button quietly reads "Sign in as
// @sarah" but the subline UNDER the row spells it out — "New here? This
// handle's taken — try another." — so a new user has words, not just a verb.
// Register a handle in one context; type the same handle in a fresh context;
// assert the subline appears once the probe lands.
test("subline warns a new user when a typed handle is already taken", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const taken = `taken_${suffix}`;
  const ctxA = await browser.newContext();
  const pA = await ctxA.newPage();
  await addAuthenticator(pA);
  await pA.goto("/");
  await register(pA, taken);
  await ctxA.close();

  const ctxB = await browser.newContext();
  const pB = await ctxB.newPage();
  await addAuthenticator(pB);
  await pB.goto("/");
  await pB.getByPlaceholder("your_handle").fill(taken);
  // Debounced probe (350ms) + tiny buffer. The subline is text-visible when
  // flow === "login" (i.e., server confirmed the handle exists).
  await expect(pB.getByText(/New here\? This handle's taken/)).toBeVisible({ timeout: 5000 });
  // And the button label morphs to "Sign in as @taken_..." — the mask that
  // the subline is guarding against.
  await expect(pB.getByRole("button", { name: new RegExp(`Sign in as @${taken}`) })).toBeVisible();
  await ctxB.close();
});

// Regression guard for the install-panel-disappears-in-private-browsing bug:
// install guidance must show independently of push support.
test("install guidance shows even when push is unsupported", async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    // Simulate a private-browsing / push-unsupported environment: strip PushManager.
    Object.defineProperty(window, "PushManager", { configurable: true, value: undefined });
  });
  const page = await context.newPage();
  await addAuthenticator(page);
  await page.goto("/");
  const handle = `noPush_${Date.now().toString(36).slice(-6)}`;
  await register(page, handle);
  await expect(page.getByText("Install to your Home Screen")).toBeVisible();

  await context.close();
});

test("two simulated clients exercise v1 mechanics", async ({ browser }) => {
  mkdirSync(screenDir, { recursive: true });
  const suffix = Date.now().toString(36).slice(-6);
  const alice = await client(browser, `alice_${suffix}`);
  const bob = await client(browser, `bob_${suffix}`);

  await register(alice.page, alice.handle);
  await shot(alice.page, "01-alice-account");
  await register(bob.page, bob.handle);
  await shot(bob.page, "02-bob-account");

  await fakePushSubscribe(alice.page);
  await fakePushSubscribe(bob.page);

  await alice.page.getByPlaceholder("friend_handle").fill(bob.handle);
  await alice.page.getByRole("button", { name: "Add" }).click();
  await expect(alice.page.getByText("Friend request sent.")).toBeVisible();
  await waitForPush(bob.page, "friend_request");
  await shot(alice.page, "03-handle-friend-request-sent");

  await bob.page.reload();
  await bob.page.getByRole("button", { name: "Accept" }).first().click();
  await expect(bob.page.getByText(`@${alice.handle}`)).toBeVisible();
  await shot(bob.page, "04-friend-request-accepted");

  await alice.page.reload();
  await expect(alice.page.locator(".friend-card", { hasText: bob.handle })).toBeVisible();
  // Presence is a plain colored dot now (green/amber/hollow) — the words
  // "online"/"offline" are gone from the DOM, state lives in aria-label
  // and the .presence.online / .presence.offline class contract.
  await expect(
    alice.page.locator(".friend-card", { hasText: bob.handle }).locator(".presence.online, .presence.offline"),
  ).toBeVisible();
  await shot(alice.page, "05-presence-visible-in-app");

  const mateGame = await challengeAndAccept(alice.page, bob.page, "10|0");
  await waitForPush(bob.page, "challenge");
  await openGame(alice.page, mateGame);
  await openGame(bob.page, mateGame);
  await shot(alice.page, "06-challenge-game-started");
  await move(alice.page, "f2", "f3");
  await move(bob.page, "e7", "e5");
  await move(alice.page, "g2", "g4");
  await move(bob.page, "d8", "h4");
  await expect(alice.page.getByText("checkmate")).toBeVisible();
  await shot(alice.page, "07-checkmate-terminal");

  const resignGame = await challengeAndAccept(alice.page, bob.page, "5|0");
  await openGame(alice.page, resignGame);
  await openGame(bob.page, resignGame);
  await bob.page.close();
  // Presence is now a plain colored dot (green / amber-pulse / hollow gray).
  // The old "here" / "away" / "offline" words are gone from the DOM per
  // Tejas's direct order — state exposed via .presence.<state> class and
  // aria-label only. The state class names on the element are unchanged,
  // so we assert on those.
  await expect(alice.page.locator(".presence.reconnecting")).toBeVisible();
  await shot(alice.page, "08-opponent-reconnecting");
  bob.page = await bob.context.newPage();
  await addAuthenticator(bob.page);
  await openGame(bob.page, resignGame);
  await expect(alice.page.locator(".presence.connected")).toBeVisible();
  await shot(alice.page, "09-opponent-reconnected");
  await alice.page.getByRole("button", { name: "Resign" }).click();
  await alice.page.getByRole("button", { name: "Confirm resign" }).click();
  await expect(alice.page.getByText("resigned")).toBeVisible();
  await shot(alice.page, "10-resign-terminal");

  const timeoutGame = await challengeAndAccept(alice.page, bob.page, "5|0");
  await openGame(alice.page, timeoutGame);
  await openGame(bob.page, timeoutGame);
  await expireClock(alice.page, timeoutGame);
  await expect(alice.page.getByText("timeout")).toBeVisible();
  await shot(alice.page, "11-timeout-terminal");

  await alice.page.getByRole("button", { name: "Home" }).click();
  await bob.page.getByRole("button", { name: "Home" }).click();
  await scheduleSoon(alice.page, bob.handle);
  await bob.page.reload();
  await bob.page.getByRole("button", { name: "Accept" }).first().click();
  await expect(bob.page.getByText("accepted")).toBeVisible();
  await shot(bob.page, "12-schedule-accepted");
  await waitForPush(alice.page, "scheduled_start", 15_000);
  await waitForPush(bob.page, "scheduled_start", 15_000);
  await alice.page.reload();
  await expect(alice.page.getByText("ready")).toBeVisible();
  await shot(alice.page, "13-scheduled-push-fired");
  await alice.page.setViewportSize({ width: 390, height: 844 });
  await shot(alice.page, "15-mobile-home-ready-schedule");
  const scheduledGameId = await alice.page.evaluate(async () => {
    const response = await fetch("/api/me");
    const data = (await response.json()) as { schedules: Array<{ status: string; gameId?: string }> };
    return data.schedules.find((schedule: { status: string; gameId?: string }) => schedule.status === "fired")?.gameId;
  });
  if (!scheduledGameId) throw new Error("Scheduled game did not become available.");
  await openGame(alice.page, scheduledGameId);
  await shot(alice.page, "16-mobile-game-board");

  await alice.context.close();
  await bob.context.close();

  const clara = await client(browser, `clara_${suffix}`);
  const dev = await client(browser, `dev_${suffix}`);
  await register(clara.page, clara.handle);
  await register(dev.page, dev.handle);
  const inviteUrl = await clara.page.evaluate(async () => {
    const response = await fetch("/api/me");
    const data = (await response.json()) as { inviteUrl: string };
    return `${window.location.origin}${data.inviteUrl}`;
  });
  await dev.page.goto(inviteUrl);
  await dev.page.getByRole("button", { name: "Send friend request" }).click();
  await waitForPush(clara.page, "friend_request");
  await clara.page.reload();
  await clara.page.getByRole("button", { name: "Accept" }).first().click();
  await expect(clara.page.locator(".friend-card", { hasText: dev.handle })).toBeVisible();
  await shot(clara.page, "14-invite-link-friend-accepted");
  await clara.context.close();
  await dev.context.close();
});

async function client(browser: Browser, handle: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await addAuthenticator(page);
  await page.goto("/");
  return { context, page, handle };
}

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
}

async function register(page: Page, handle: string) {
  await page.getByPlaceholder("your_handle").fill(handle);
  // One-press auth: Continue chooses login or passkey creation itself,
  // based on a debounced preflight of the handle. Wait a moment so the
  // preflight has a chance to land before we click.
  await page.waitForTimeout(500);
  // Button label morphs: default "Sign in or sign up" → "Sign up as @handle"
  // once the debounced probe returns (handle is free for fresh registrations).
  // The 500ms wait above lets the probe land. Click by role+regex covers all
  // morph states without coupling the test to a specific label.
  await page.getByRole("button", { name: /^(Sign in( as @|.*sign up$)|Sign up as @|Working)/ }).click();
  await expect(page.getByText(`@${handle}`)).toBeVisible();
}

async function fakePushSubscribe(page: Page) {
  await page.evaluate(async () => {
    const endpoint = `https://push.invalid/${Math.random()}`;
    window.localStorage.setItem("testPushEndpoint", endpoint);
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subscription: {
          endpoint,
          keys: { p256dh: "test", auth: "test" },
        },
      }),
    });
  });
}

async function pendingPush(page: Page): Promise<{ type?: string } | null> {
  return page.evaluate(async () => {
    const endpoint = window.localStorage.getItem("testPushEndpoint") || "";
    const response = await fetch("/api/push/pending", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    return response.json();
  });
}

async function waitForPush(page: Page, type: string, timeout = 10_000) {
  await expect
    .poll(async () => {
      const pending = await pendingPush(page);
      return pending?.type === type ? type : pending?.type || null;
    }, { timeout })
    .toBe(type);
}

async function challengeAndAccept(alice: Page, bob: Page, timeControl: "10|0" | "5|0") {
  await alice.goto("/");
  await bob.goto("/");
  await alice.getByLabel("Time control").first().selectOption(timeControl);
  await alice.getByRole("button", { name: "Send" }).click();
  await bob.reload();
  await bob.getByRole("button", { name: "Accept" }).first().click();
  await expect(bob).toHaveURL(/\/game\/gam_/);
  return bob.url().split("/game/")[1];
}

async function openGame(page: Page, gameId: string) {
  await page.goto(`/game/${gameId}`);
  await expect(page.locator(".board")).toBeVisible();
}

async function move(page: Page, from: string, to: string) {
  await page.locator(`[data-square="${from}"]`).click();
  await page.locator(`[data-square="${to}"]`).click();
}

async function expireClock(page: Page, gameId: string) {
  await page.evaluate(async (id) => {
    await fetch(`/api/games/${id}/debug/expire`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  }, gameId);
  await page.waitForTimeout(700);
  await page.reload();
}

async function scheduleSoon(page: Page, friendHandle: string) {
  await page.locator(".friend-card", { hasText: friendHandle }).waitFor();
  await page.getByRole("tab", { name: "Schedule" }).click();
  await page.getByLabel("Time control").selectOption("10|0");
  await page.getByLabel("Start in minutes").fill("0.03");
  await page.getByRole("button", { name: "Propose" }).click();
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${screenDir}/${name}.png`, fullPage: true });
}
