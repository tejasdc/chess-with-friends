import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

const screenDir = "tmp/reviews/screens";
const REQUIRED_PUSH_COPY_TYPES = ["friend_request", "challenge", "challenge_accepted", "scheduled_start", "call_invite"] as const;

type PendingPushPayload = {
  id: string;
  type?: string;
  body?: string;
  url?: string;
  createdAt?: number;
};

test.describe.configure({ mode: "serial" });

test("notification prompt disappears after permission is granted and sign-out preserves the browser subscription", async ({ browser, browserName }) => {
  test.skip(browserName === "webkit", "Playwright exposes virtual WebAuthn only through Chromium CDP.");
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
          window.localStorage.setItem("notificationSubscribeCount", String(Number(window.localStorage.getItem("notificationSubscribeCount") || "0") + 1));
          return subscription;
        },
      },
    };
    (subscription as typeof subscription & { unsubscribe: () => Promise<boolean> }).unsubscribe = async () => {
      window.localStorage.setItem("notificationUnsubscribed", "true");
      window.localStorage.removeItem("notificationSubscription");
      return true;
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
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByPlaceholder("your_handle")).toBeVisible();
  await expect(page.evaluate(() => Notification.permission)).resolves.toBe("granted");
  await expect(page.evaluate(async () => Boolean(await navigator.serviceWorker.ready.then((registration) => registration.pushManager.getSubscription())))).resolves.toBe(true);
  await expect(page.evaluate(() => window.localStorage.getItem("notificationUnsubscribed"))).resolves.toBeNull();

  await page.evaluate(() => window.localStorage.removeItem("notificationSubscription"));
  await register(page, handle);
  await expect(page.getByRole("button", { name: "Enable notifications" })).toBeHidden();
  await expect(page.evaluate(async () => Boolean(await navigator.serviceWorker.ready.then((registration) => registration.pushManager.getSubscription())))).resolves.toBe(true);
  await expect(page.evaluate(() => window.localStorage.getItem("notificationSubscribeCount"))).resolves.toBe("2");
  await shot(page, "00-notifications-enabled-after-reload");
  await context.close();
});

test("pending push is POST-only, consume-on-read, and ack is idempotent", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const alice = await client(browser, `push_a_${suffix}`);
  const bob = await client(browser, `push_b_${suffix}`);
  try {
    await register(alice.page, alice.handle);
    await register(bob.page, bob.handle);
    await fakePushSubscribe(bob.page);

    await alice.page.getByRole("button", { name: "Add a friend" }).click();
    await alice.page.getByPlaceholder("friend_handle").fill(bob.handle);
    await alice.page.getByRole("button", { name: "Add", exact: true }).click();

    const first = await peekPendingPush(bob.page);
    const second = await peekPendingPush(bob.page);
    expect(first?.type).toBe("friend_request");
    expect(second).toBeNull();

    const getStatus = await bob.page.evaluate(async () => {
      return (await fetch("/api/push/pending", { method: "GET", credentials: "include" })).status;
    });
    expect(getStatus).not.toBe(200);

    await ackPendingPush(bob.page, first!.id);
    const afterAck = await peekPendingPush(bob.page);
    expect(afterAck).toBeNull();
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});

test("push payload copy is asserted for every push type", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const alice = await client(browser, `copy_a_${suffix}`);
  const bob = await client(browser, `copy_b_${suffix}`);
  const asserted = new Set<string>();
  try {
    await register(alice.page, alice.handle);
    await register(bob.page, bob.handle);
    await fakePushSubscribe(alice.page);
    await fakePushSubscribe(bob.page);

    await alice.page.getByRole("button", { name: "Add a friend" }).click();
    await alice.page.getByPlaceholder("friend_handle").fill(bob.handle);
    await alice.page.getByRole("button", { name: "Add", exact: true }).click();
    const friendRequest = await waitForPushPayload(bob.page, "friend_request");
    // copy-contract: friend_request
    expect(friendRequest).toMatchObject({ type: "friend_request", body: `@${alice.handle} sent a friend request`, url: "/" });
    asserted.add("friend_request");

    await bob.page.reload();
    await bob.page.getByRole("button", { name: "Accept" }).first().click();
    await alice.page.reload();

    await alice.page.goto("/");
    await bob.page.goto("/");
    await alice.page.getByRole("button", { name: `Invite @${bob.handle}` }).click();
    const challenge = await waitForPushPayload(bob.page, "challenge");
    // copy-contract: challenge
    expect(challenge).toMatchObject({ type: "challenge", body: `@${alice.handle} invited you to a game`, url: "/" });
    asserted.add("challenge");

    await bob.page.reload();
    await bob.page.getByRole("button", { name: "Accept" }).first().click();
    const accepted = await waitForPushPayload(alice.page, "challenge_accepted");
    // copy-contract: challenge_accepted
    expect(accepted).toMatchObject({ type: "challenge_accepted", body: `@${bob.handle} accepted — your game is ready` });
    expect(accepted.url).toMatch(/^\/game\/gam_/);
    asserted.add("challenge_accepted");

    const gameId = accepted.url!.split("/game/")[1];
    await installSocketTracker(alice.page);
    await alice.page.goto(`/game/${gameId}`);
    await bob.page.goto("/");
    await bob.page.evaluate(() => fetch("/api/presence/heartbeat", { method: "POST", credentials: "include", body: "{}" }));
    await sendVoice(alice.page, { type: "call-initiate" });
    const callInvite = await waitForPushPayload(bob.page, "call_invite");
    // copy-contract: call_invite
    expect(callInvite).toMatchObject({ type: "call_invite", body: `@${alice.handle} wants to talk`, url: `/game/${gameId}` });
    asserted.add("call_invite");

    await alice.page.goto("/");
    await bob.page.goto("/");
    await scheduleSoon(alice.page, bob.handle);
    await bob.page.reload();
    await bob.page.getByRole("button", { name: "Accept" }).first().click();
    const scheduledForAlice = await waitForPushPayload(alice.page, "scheduled_start", 15_000);
    const scheduledForBob = await waitForPushPayload(bob.page, "scheduled_start", 15_000);
    // copy-contract: scheduled_start
    expect(scheduledForAlice).toMatchObject({ type: "scheduled_start", body: `Your game with @${bob.handle} is starting` });
    expect(scheduledForBob).toMatchObject({ type: "scheduled_start", body: `Your game with @${alice.handle} is starting` });
    asserted.add("scheduled_start");

    expect([...asserted].sort()).toEqual([...REQUIRED_PUSH_COPY_TYPES].sort());
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});

test("service worker shows payload body as title and ACKs pending push", async () => {
  const endpoint = "https://push.invalid/sw-harness";
  const pending = {
    id: "psh_body_title",
    type: "challenge",
    body: "@alice invited you to a game",
    url: "/",
    createdAt: Date.now(),
  };
  const result = await runServiceWorkerPush({ endpoint, pendingPayload: pending });

  expect(result.notifications).toHaveLength(1);
  expect(result.notifications[0].title).toBe(pending.body);
  expect("body" in result.notifications[0].options).toBe(false);
  expect(result.fetches).toHaveLength(2);
  expect(result.fetches[0]).toMatchObject({ url: "/api/push/pending", body: { endpoint } });
  expect(result.fetches[1]).toMatchObject({ url: "/api/push/pending", body: { endpoint, ackId: pending.id } });
});

test("service worker fallback titles cover every supported push type", async () => {
  const expected: Record<(typeof REQUIRED_PUSH_COPY_TYPES)[number], string> = {
    friend_request: "Friend request",
    challenge: "Game challenge",
    challenge_accepted: "Your game is ready",
    scheduled_start: "Your game is starting",
    call_invite: "Your friend wants to talk",
  };

  for (const type of REQUIRED_PUSH_COPY_TYPES) {
    const result = await runServiceWorkerPush({
      endpoint: "https://push.invalid/sw-fallback",
      eventPayload: { id: `psh_${type}`, type, url: "/", createdAt: Date.now() },
    });
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].title).toBe(expected[type]);
  }
});

test("service worker precaches injected manifest and waits for gated skipWaiting message", async () => {
  const manifest = [
    { url: "assets/index-test.js", revision: "asset-js" },
    { url: "manifest.webmanifest", revision: "manifest" },
  ];
  const result = await runServiceWorkerLifecycle(manifest);

  expect(result.cacheAddAlls).toEqual([["/", "assets/index-test.js", "manifest.webmanifest"]]);
  expect(result.skipWaitingCalls).toBe(0);

  await result.dispatchMessage({ type: "NOT_THE_GATE" });
  expect(result.skipWaitingCalls).toBe(0);

  await result.dispatchMessage({ type: "SKIP_WAITING" });
  expect(result.skipWaitingCalls).toBe(1);

  await result.dispatchActivate();
  expect(result.deletedCacheNames).toEqual(["old-precache"]);
  expect(result.deletedRequests).toEqual(["https://twochairs.club/old.js"]);
});

test("auth options probes are rate limited per handle", async ({ page }) => {
  await page.goto("/");
  const handle = `probe_${Date.now().toString(36).slice(-6)}`;
  const statuses: number[] = [];
  for (let i = 0; i < 14; i++) {
    statuses.push(await page.evaluate(async (h) => {
      const response = await fetch("/api/auth/register/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: h }),
      });
      return response.status;
    }, handle));
  }
  expect(statuses.some((status) => status === 400)).toBe(true);
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

  // Sign out lives inside the universal ⋯ menu now (one menu pattern,
  // one position — team-lead's spec). Open the menu, then click Sign out.
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByText(`@${handle}`)).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByPlaceholder("your_handle")).toBeVisible();
  await expect(page.getByText(`@${handle}`)).toBeHidden();

  await context.close();
});

test("scheduler canonicalization re-queries when an earlier handoff arrives during D1 I/O", async ({ request }) => {
  type SchedulerState = {
    wakeState: {
      generation: number;
      handoffs: Record<string, { candidate: number; expiresAt: number }>;
    };
    alarm: number | null;
    paused: boolean;
  };
  const scheduler = async (action: string, payload: unknown = {}) => {
    const response = await request.post("/_debug/scheduler", { data: { action, payload } });
    expect(response.status()).toBe(200);
    return await response.json();
  };
  await request.post("/_debug/reset-app", { data: {} });
  await scheduler("prepare");
  const canonicalization = scheduler("canonicalize");
  try {
    await expect.poll(async () => (await scheduler("state") as SchedulerState).paused).toBe(true);
    const candidate = Date.now() + 60_000;
    const handoffId = `wake_race_${Date.now().toString(36)}`;
    await scheduler("wake", { candidate, handoffId });
    const prearmed = await scheduler("state") as SchedulerState;
    expect(prearmed.wakeState.handoffs[handoffId]?.candidate).toBe(candidate);
    expect(prearmed.alarm).toBe(candidate);
    await scheduler("release");
    const completed = await canonicalization as { attempts: number };
    expect(completed.attempts).toBeGreaterThanOrEqual(2);
    const final = await scheduler("state") as SchedulerState;
    expect(final.wakeState.handoffs[handoffId]?.candidate).toBe(candidate);
    expect(final.alarm).toBe(candidate);
  } finally {
    await scheduler("release").catch(() => undefined);
    await request.post("/_debug/reset-app", { data: {} });
  }
});

test("concurrent first GameDO initialization preserves the first immutable value", async ({ request }) => {
  type RaceResult = {
    first: { status: number; body: { ok?: boolean } };
    second: { status: number; body: { existing?: boolean; error?: string } };
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  };
  const runRace = async (mode: "identical" | "mismatch") => {
    const gameId = `gam_debug_${mode}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const response = await request.post("/_debug/game-init-race", { data: { gameId, mode } });
    expect(response.status()).toBe(200);
    return await response.json() as RaceResult;
  };

  const identical = await runRace("identical");
  expect(identical.first).toMatchObject({ status: 200, body: { ok: true } });
  expect(identical.second).toMatchObject({ status: 200, body: { existing: true } });
  expect(identical.after).toEqual(identical.before);

  const mismatch = await runRace("mismatch");
  expect(mismatch.first).toMatchObject({ status: 200, body: { ok: true } });
  expect(mismatch.second.status).toBe(400);
  expect(mismatch.second.body.error).toContain("does not match");
  expect(mismatch.after).toEqual(mismatch.before);
  expect(mismatch.after.blackHandle).toBe("race_black");
});

test("D1 cutover keeps sessions revocable, presence lease-scoped, schedules idempotent, and game init private", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const alice = await client(browser, `d1a_${suffix}`);
  const bob = await client(browser, `d1b_${suffix}`);
  const charlie = await client(browser, `d1c_${suffix}`);
  try {
    const health = await alice.page.request.get("/api/health");
    expect(health.status()).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ ok: true, storage: "d1" });
    expect((await alice.page.request.get("/api/me")).status()).toBe(401);

    await register(alice.page, alice.handle);
    await register(bob.page, bob.handle);

    const inviteToken = await alice.page.evaluate(async () => {
      const home = await (await fetch("/api/me", { credentials: "include" })).json() as { user: { inviteToken: string } };
      return home.user.inviteToken;
    });
    await bob.page.evaluate(async (token) => {
      const response = await fetch("/api/friends/invite", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-client-op-id": `friend:${token}` },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error(await response.text());
    }, inviteToken);

    const beforePresence = await alice.page.evaluate(async () => {
      const response = await fetch("/api/debug/db-stats", { credentials: "include" });
      return await response.json() as { counts: Record<string, number> };
    });
    for (const leaseId of ["tab-a", "tab-b", undefined, undefined]) {
      await bob.page.evaluate(async (lease) => {
        const response = await fetch("/api/presence/heartbeat", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(lease ? { leaseId: lease, foregroundGameId: null } : {}),
        });
        if (!response.ok) throw new Error(await response.text());
      }, leaseId);
    }
    const afterPresence = await alice.page.evaluate(async () => {
      const response = await fetch("/api/debug/db-stats", { credentials: "include" });
      return await response.json() as { counts: Record<string, number> };
    });
    expect(afterPresence.counts.presence_leases - beforePresence.counts.presence_leases).toBe(3);
    const aliceHome = await alice.page.evaluate(async () => (
      await (await fetch("/api/me", { credentials: "include" })).json()
    ) as { friends: Array<{ handle: string; online: boolean }> });
    expect(aliceHome.friends.find((friend) => friend.handle === bob.handle)?.online).toBe(true);

    const bobId = await bob.page.evaluate(async () => {
      const home = await (await fetch("/api/me", { credentials: "include" })).json() as { user: { id: string } };
      return home.user.id;
    });
    const scheduleOpId = `schedule:${suffix}`;
    const scheduleRequest = { friendId: bobId, timeControl: "10|0", startAt: Date.now() + 30_000, recurrence: { kind: "once" } };
    const createSchedule = () => alice.page.evaluate(async ({ body, opId }) => {
      const response = await fetch("/api/schedules", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-client-op-id": opId },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await response.text());
      return await response.json() as { schedule: { id: string } };
    }, { body: scheduleRequest, opId: scheduleOpId });
    const firstSchedule = await createSchedule();
    const replayedSchedule = await createSchedule();
    expect(replayedSchedule.schedule.id).toBe(firstSchedule.schedule.id);

    await bob.page.evaluate(async (scheduleId) => {
      const response = await fetch(`/api/schedules/${scheduleId}/accept`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-client-op-id": `accept:${scheduleId}` },
        body: "{}",
      });
      if (!response.ok) throw new Error(await response.text());
    }, firstSchedule.schedule.id);
    const tick = () => alice.page.evaluate(async (now) => {
      const response = await fetch("/_debug/tick", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ now }),
      });
      if (!response.ok) throw new Error(await response.text());
    }, scheduleRequest.startAt + 1);
    await tick();
    await tick();

    const fired = await alice.page.evaluate(async (scheduleId) => {
      const home = await (await fetch("/api/me", { credentials: "include" })).json() as {
        schedules: Array<{ id: string; status: string; gameId?: string }>;
      };
      return home.schedules.find((schedule) => schedule.id === scheduleId);
    }, firstSchedule.schedule.id);
    expect(fired).toMatchObject({ status: "fired" });
    expect(fired?.gameId).toMatch(/^gam_/);

    const beforeRecurring = await alice.page.evaluate(async () => (
      await (await fetch("/api/debug/db-stats", { credentials: "include" })).json()
    ) as { counts: Record<string, number> });
    const recurringStart = Date.now() + 30_000;
    const recurring = await alice.page.evaluate(async ({ friendId, startAt }) => {
      const response = await fetch("/api/schedules", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-client-op-id": `recurring:${startAt}` },
        body: JSON.stringify({ friendId, timeControl: "10|0", startAt, recurrence: { kind: "daily" } }),
      });
      if (!response.ok) throw new Error(await response.text());
      return await response.json() as { schedule: { id: string } };
    }, { friendId: bobId, startAt: recurringStart });
    await bob.page.evaluate(async (scheduleId) => {
      const response = await fetch(`/api/schedules/${scheduleId}/accept`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-client-op-id": `accept:${scheduleId}` },
        body: "{}",
      });
      if (!response.ok) throw new Error(await response.text());
    }, recurring.schedule.id);
    const recurrenceTickStartedAt = Date.now();
    await alice.page.evaluate(async ({ now, scheduleId }) => {
      const response = await fetch("/_debug/tick", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ now, scheduleId }),
      });
      if (!response.ok) throw new Error(await response.text());
    }, { now: recurringStart + 8 * 24 * 60 * 60 * 1000, scheduleId: recurring.schedule.id });
    const afterRecurring = await alice.page.evaluate(async (scheduleId) => {
      const [home, stats] = await Promise.all([
        fetch("/api/me", { credentials: "include" }).then((response) => response.json()) as Promise<{
          schedules: Array<{ id: string; status: string; nextFireAt: number; lastGameId?: string }>;
        }>,
        fetch("/api/debug/db-stats", { credentials: "include" }).then((response) => response.json()) as Promise<{
          counts: Record<string, number>;
        }>,
      ]);
      return { schedule: home.schedules.find((item) => item.id === scheduleId), counts: stats.counts };
    }, recurring.schedule.id);
    expect(afterRecurring.schedule).toMatchObject({ status: "accepted" });
    expect(afterRecurring.schedule?.lastGameId).toMatch(/^gam_/);
    expect(afterRecurring.schedule!.nextFireAt).toBeGreaterThan(recurrenceTickStartedAt + 23 * 60 * 60 * 1000);
    expect(afterRecurring.schedule!.nextFireAt).toBeLessThan(recurrenceTickStartedAt + 25 * 60 * 60 * 1000);
    expect(afterRecurring.counts.games - beforeRecurring.counts.games).toBe(1);
    expect(afterRecurring.counts.schedule_occurrences - beforeRecurring.counts.schedule_occurrences).toBe(1);

    const privateInit = await alice.page.evaluate(async (gameId) => {
      const response = await fetch(`/api/games/${gameId}/init`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-internal": "d1" },
        body: "{}",
      });
      return response.status;
    }, fired!.gameId!);
    expect(privateInit).toBe(404);

    await register(charlie.page, charlie.handle);
    expect(await charlie.page.evaluate(async (gameId) => (
      await fetch(`/api/games/${gameId}/state`, { credentials: "include" })
    ).status, fired!.gameId!)).toBe(404);

    const staleCookie = (await bob.context.cookies()).find((cookie) => cookie.name === "cwf_session");
    expect(staleCookie?.value).toMatch(/^ses_/);
    await bob.page.evaluate(async () => {
      const response = await fetch("/api/auth/logout", { method: "POST", credentials: "include", body: "{}" });
      if (!response.ok) throw new Error(await response.text());
    });
    await bob.context.addCookies([{ name: "cwf_session", value: staleCookie!.value, url: bob.page.url() }]);
    expect(await bob.page.evaluate(async () => (await fetch("/api/me", { credentials: "include" })).status)).toBe(401);
  } finally {
    await alice.context.close();
    await bob.context.close();
    await charlie.context.close();
  }
});

// WebAuthn cancel taxonomy — team-lead's explicit matrix. NEVER surface raw
// platform text; NEVER go silent; the truthful interpretation lives on the
// toast immediately. Sign-up cancel → "Passkey wasn't created — try again."
// Sign-in cancel  → "That handle may be taken — try a different one."
//
// Simulated by stubbing navigator.credentials.{create,get} at page-init time
// to reject with a real DOMException("...", "NotAllowedError"). The stub runs
// before any script — including simplewebauthn — so both flows hit the
// browser-native cancel path exactly as a real user tap-dismiss would.
async function stubCredentialsCancel(context: import("@playwright/test").BrowserContext) {
  await context.addInitScript(() => {
    const reject = () => Promise.reject(new DOMException("The request is not allowed.", "NotAllowedError"));
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { create: reject, get: reject },
    });
  });
}

test("sign-up cancel surfaces \"Passkey wasn't created — try again.\"", async ({ browser }) => {
  const context = await browser.newContext();
  await stubCredentialsCancel(context);
  const page = await context.newPage();
  await page.goto("/");
  const handle = `cancsu_${Date.now().toString(36).slice(-5)}`;
  await page.getByPlaceholder("your_handle").fill(handle);
  // Wait for the probe → button label morphs to "Sign up as @…"
  await expect(page.getByRole("button", { name: new RegExp(`Sign up as @${handle}`) })).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: new RegExp(`Sign up as @${handle}`) }).click();
  await expect(page.getByText("Passkey wasn't created — try again.")).toBeVisible({ timeout: 5000 });
  await context.close();
});

test("sign-in cancel surfaces \"That handle may be taken — try a different one.\"", async ({ browser }) => {
  // Setup: register a handle in a throwaway context so it's confirmed taken.
  const takenHandle = `cancsi_${Date.now().toString(36).slice(-5)}`;
  const setupCtx = await browser.newContext();
  const setupPage = await setupCtx.newPage();
  await addAuthenticator(setupPage);
  await setupPage.goto("/");
  await register(setupPage, takenHandle);
  await setupCtx.close();

  // Fresh context with the credentials stub → probe finds the handle
  // (server call, not credentials), button morphs to "Sign in as @…",
  // click triggers startAuthentication which hits the stubbed reject.
  const context = await browser.newContext();
  await stubCredentialsCancel(context);
  const page = await context.newPage();
  await page.goto("/");
  await page.getByPlaceholder("your_handle").fill(takenHandle);
  await expect(page.getByRole("button", { name: new RegExp(`Sign in as @${takenHandle}`) })).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: new RegExp(`Sign in as @${takenHandle}`) }).click();
  await expect(page.getByText("That handle may be taken — try a different one.")).toBeVisible({ timeout: 5000 });
  await context.close();
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

  // Add-a-friend collapsed disclosure at the friends section footer.
  await alice.page.getByRole("button", { name: "Add a friend" }).click();
  await alice.page.getByPlaceholder("friend_handle").fill(bob.handle);
  await alice.page.getByRole("button", { name: "Add", exact: true }).click();
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
  await expect(bob.page.locator('[data-square="f3"] .piece')).toBeVisible({ timeout: 5000 });
  await move(bob.page, "e7", "e5");
  await expect(alice.page.locator('[data-square="e5"] .piece')).toBeVisible({ timeout: 5000 });
  await move(alice.page, "g2", "g4");
  await expect(bob.page.locator('[data-square="g4"] .piece')).toBeVisible({ timeout: 5000 });
  await move(bob.page, "d8", "h4");
  await expect(alice.page.getByText("checkmate")).toBeVisible();
  await shot(alice.page, "07-checkmate-terminal");

  const resignGame = await challengeAndAccept(alice.page, bob.page, "5|0");
  await openGame(alice.page, resignGame);
  await openGame(bob.page, resignGame);
  await bob.page.close();
  // Presence is a plain colored dot (green / amber-pulse / hollow gray).
  // Dedicated adversity tests assert exact reconnecting/gone semantics;
  // this broad mechanics screenshot just captures the transient visual.
  await alice.page.waitForTimeout(500);
  await shot(alice.page, "08-opponent-reconnecting");
  bob.page = await bob.context.newPage();
  await addAuthenticator(bob.page);
  await openGame(bob.page, resignGame);
  await expect(alice.page.getByRole("status", { name: "opponent connected" })).toBeVisible();
  await shot(alice.page, "09-opponent-reconnected");
  // Resign / Confirm resign live inside the game screen's ⋯ menu.
  // The menu STAYS OPEN after tapping Resign so Confirm resign appears
  // right there — no need to re-open the sheet between the two taps.
  await alice.page.getByRole("button", { name: "Open menu" }).click();
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

  // Home lives inside the game screen's ⋯ menu.
  await alice.page.getByRole("button", { name: "Open menu" }).click();
  await alice.page.getByLabel("App menu").getByRole("button", { name: "Home" }).click();
  await bob.page.getByRole("button", { name: "Open menu" }).click();
  await bob.page.getByLabel("App menu").getByRole("button", { name: "Home" }).click();
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
  await expect(dev.page.locator(".friend-card", { hasText: clara.handle })).toBeVisible({ timeout: 10000 });
  await clara.page.reload();
  await expect(clara.page.locator(".friend-card", { hasText: dev.handle })).toBeVisible();
  await shot(clara.page, "14-invite-link-friend-accepted");
  await clara.context.close();
  await dev.context.close();
});

async function client(browser: Browser, handle: string) {
  const context = await browser.newContext({ serviceWorkers: "block" });
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
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/me");
      if (!response.ok()) return null;
      const data = (await response.json()) as { user?: { handle?: string } };
      return data.user?.handle || null;
    })
    .toBe(handle.toLowerCase());
}

async function fakePushSubscribe(page: Page, endpointOverride?: string) {
  return await page.evaluate(async (providedEndpoint) => {
    const endpoint = providedEndpoint || `https://push.invalid/${Math.random()}`;
    window.localStorage.setItem("testPushEndpoint", endpoint);
    await fetch("/api/push/subscribe", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subscription: {
          endpoint,
          keys: { p256dh: "test", auth: "test" },
        },
      }),
    });
    return endpoint;
  }, endpointOverride || "");
}

async function pendingPush(page: Page): Promise<PendingPushPayload | null> {
  const pending = await peekPendingPush(page);
  if (pending?.id) await ackPendingPush(page, pending.id);
  return pending;
}

async function peekPendingPush(page: Page): Promise<PendingPushPayload | null> {
  return page.evaluate(async (): Promise<PendingPushPayload | null> => {
    const endpoint = window.localStorage.getItem("testPushEndpoint") || "";
    const response = await fetch("/api/push/pending", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    return response.json() as Promise<PendingPushPayload | null>;
  });
}

async function ackPendingPush(page: Page, id: string) {
  await page.evaluate(async (ackId) => {
    const endpoint = window.localStorage.getItem("testPushEndpoint") || "";
    const response = await fetch("/api/push/pending", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint, ackId }),
    });
    if (!response.ok) throw new Error(`ack failed: ${response.status}`);
  }, id);
}

async function waitForPush(page: Page, type: string, timeout = 10_000) {
  await expect
    .poll(async () => {
      const pending = await pendingPush(page);
      return pending?.type === type ? type : pending?.type || null;
    }, { timeout })
    .toBe(type);
}

async function waitForPushPayload(page: Page, type: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let lastType: string | null = null;
  while (Date.now() <= deadline) {
    const pending = await pendingPush(page);
    if (pending?.type === type) return pending;
    if (pending?.type) lastType = pending.type;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${type}; last pending type was ${lastType || "none"}`);
}

async function challengeAndAccept(alice: Page, bob: Page, timeControl: "10|0" | "5|0") {
  await alice.goto("/");
  await bob.goto("/");
  const friendHandle = await bob.evaluate(async () => {
    const me = await (await fetch("/api/me", { credentials: "include" })).json() as { user: { handle: string } };
    return me.user.handle;
  });
  await alice.getByRole("button", { name: `Invite @${friendHandle}` }).click();
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
  await page.evaluate(async ({ friendHandle, startAt }) => {
    const me = await (await fetch("/api/me", { credentials: "include" })).json() as { friends: Array<{ id: string; handle: string }> };
    const friend = me.friends.find((f) => f.handle === friendHandle);
    if (!friend) throw new Error(`Friend ${friendHandle} not found.`);
    const response = await fetch("/api/schedules", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ friendId: friend.id, timeControl: "10|0", startAt, recurrence: { kind: "once" } }),
    });
    if (!response.ok) throw new Error(await response.text());
  }, { friendHandle, startAt: Date.now() + 3_000 });
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${screenDir}/${name}.png`, fullPage: true });
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

async function sendVoice(page: Page, message: Record<string, unknown>) {
  await page.waitForFunction(() => {
    return ((window as unknown as { __sockets?: WebSocket[] }).__sockets || []).some((socket) => socket.readyState === WebSocket.OPEN);
  }, null, { timeout: 10_000 });
  await page.evaluate((payload) => {
    const sockets = ((window as unknown as { __sockets?: WebSocket[] }).__sockets || []).filter((socket) => socket.readyState === WebSocket.OPEN);
    if (!sockets.length) throw new Error("No open tracked socket.");
    sockets[sockets.length - 1].send(JSON.stringify(payload));
  }, message);
}

type SwFetchRecord = {
  url: string;
  body: Record<string, unknown>;
};

type SwNotificationRecord = {
  title: string;
  options: NotificationOptions;
};

async function runServiceWorkerPush({
  endpoint,
  pendingPayload,
  eventPayload,
}: {
  endpoint: string;
  pendingPayload?: unknown;
  eventPayload?: unknown;
}) {
  const source = serviceWorkerSource([]);
  const fetches: SwFetchRecord[] = [];
  const notifications: SwNotificationRecord[] = [];
  let pushWait: Promise<void> | undefined;
  type PushEventShape = {
    data: { json: () => unknown } | null;
    waitUntil: (promise: Promise<void>) => void;
  };
  const listeners = new Map<string, (event: PushEventShape) => void>();
  const fakeSelf = {
    registration: {
      pushManager: {
        async getSubscription() {
          return { endpoint };
        },
      },
      async showNotification(title: string, options: NotificationOptions) {
        notifications.push({ title, options });
      },
    },
    location: {
      href: "https://twochairs.club/sw.js",
    },
    addEventListener(type: string, handler: (event: PushEventShape) => void) {
      listeners.set(type, handler);
    },
    skipWaiting() {
      // install path not exercised in this harness
    },
    clients: {
      async claim() {
        // activate path not exercised in this harness
      },
      async openWindow() {
        // notificationclick path not exercised in this harness
      },
    },
  };
  const fakeCaches = {
    async open() {
      return { async addAll() { /* install path not exercised */ } };
    },
    async keys() {
      return [];
    },
    async delete() {
      return true;
    },
    async match() {
      return undefined;
    },
  };
  const fakeFetch = async (url: string, init?: RequestInit) => {
    const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    fetches.push({ url, body: rawBody });
    return Response.json(pendingPayload ?? null);
  };
  const load = new Function("self", "fetch", "caches", source);
  load(fakeSelf, fakeFetch, fakeCaches);
  const push = listeners.get("push");
  if (!push) throw new Error("SW push handler was not registered.");
  push({
    data: eventPayload === undefined ? null : { json: () => eventPayload },
    waitUntil(promise) {
      pushWait = promise;
    },
  });
  await pushWait;
  return { fetches, notifications };
}

function serviceWorkerSource(manifest: Array<{ url: string; revision: string }>) {
  return readFileSync("src/sw.js", "utf8").replace("self.__WB_MANIFEST", JSON.stringify(manifest));
}

async function runServiceWorkerLifecycle(manifest: Array<{ url: string; revision: string }>) {
  const source = serviceWorkerSource(manifest);
  type GenericEventShape = {
    data?: unknown;
    waitUntil?: (promise: Promise<void>) => void;
  };
  const listeners = new Map<string, (event: GenericEventShape) => void>();
  const cacheAddAlls: string[][] = [];
  const deletedCacheNames: string[] = [];
  const deletedRequests: string[] = [];
  let skipWaitingCalls = 0;
  const cacheRequests = [
    new Request("https://twochairs.club/"),
    new Request("https://twochairs.club/assets/index-test.js"),
    new Request("https://twochairs.club/old.js"),
  ];
  const fakeCache = {
    async addAll(urls: string[]) {
      cacheAddAlls.push(urls);
    },
    async keys() {
      return cacheRequests;
    },
    async delete(request: Request) {
      deletedRequests.push(request.url);
      return true;
    },
  };
  const fakeSelf = {
    location: {
      href: "https://twochairs.club/sw.js",
    },
    registration: {
      pushManager: {
        async getSubscription() {
          return null;
        },
      },
      async showNotification() {
        // push path not exercised here
      },
    },
    addEventListener(type: string, handler: (event: GenericEventShape) => void) {
      listeners.set(type, handler);
    },
    skipWaiting() {
      skipWaitingCalls += 1;
    },
    clients: {
      async claim() {
        // activation path claims silently
      },
      async openWindow() {
        // notificationclick path not exercised here
      },
    },
  };
  const fakeCaches = {
    async open() {
      return fakeCache;
    },
    async keys() {
      return ["chess-with-friends-precache", "old-precache"];
    },
    async delete(name: string) {
      deletedCacheNames.push(name);
      return true;
    },
    async match() {
      return undefined;
    },
  };
  const load = new Function("self", "fetch", "caches", source);
  load(fakeSelf, fetch, fakeCaches);
  const install = listeners.get("install");
  if (!install) throw new Error("SW install handler was not registered.");
  let installWait: Promise<void> | undefined;
  install({ waitUntil: (promise) => { installWait = promise; } });
  await installWait;

  return {
    cacheAddAlls,
    deletedCacheNames,
    deletedRequests,
    get skipWaitingCalls() {
      return skipWaitingCalls;
    },
    async dispatchMessage(data: unknown) {
      const message = listeners.get("message");
      if (!message) throw new Error("SW message handler was not registered.");
      message({ data });
    },
    async dispatchActivate() {
      const activate = listeners.get("activate");
      if (!activate) throw new Error("SW activate handler was not registered.");
      let activateWait: Promise<void> | undefined;
      activate({ waitUntil: (promise) => { activateWait = promise; } });
      await activateWait;
    },
  };
}
