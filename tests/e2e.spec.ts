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
  await expect(alice.page.locator(".friend-card", { hasText: bob.handle }).getByText(/online|offline/)).toBeVisible();
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
  await expect(alice.page.getByText("reconnecting")).toBeVisible();
  await shot(alice.page, "08-opponent-reconnecting");
  bob.page = await bob.context.newPage();
  await addAuthenticator(bob.page);
  await openGame(bob.page, resignGame);
  await expect(alice.page.getByText("connected")).toBeVisible();
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
  const inviteUrl = await clara.page.locator(".break-all").first().textContent();
  await dev.page.goto(inviteUrl || "/");
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
  await page.getByRole("button", { name: "Create passkey" }).click();
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
  await page.getByLabel("Time control").nth(1).selectOption("10|0");
  await page.getByLabel("Start in minutes").fill("0.03");
  await page.getByRole("button", { name: "Propose" }).click();
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${screenDir}/${name}.png`, fullPage: true });
}
