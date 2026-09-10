import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

await mkdir("tmp", { recursive: true });
const output = resolve("tmp/app-state-test-worker.mjs");
await build({
  entryPoints: [process.env.APP_STATE_TEST_SOURCE || "src/worker.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  plugins: [{
    name: "durable-object-host",
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "host", namespace: "test-host" }));
      builder.onLoad({ filter: /.*/, namespace: "test-host" }, () => ({
        contents: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
      }));
    },
  }],
});
const { AppDO } = await import(pathToFileURL(output).href);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(env = {}) {
  const now = Date.now();
  let db = {
    users: Object.fromEntries(["alice", "bob"].map((id) => [id, { id, handle: id, createdAt: now, credentials: [], inviteToken: id }])),
    handleToUserId: { alice: "alice", bob: "bob" },
    sessions: { alice: { userId: "alice", createdAt: now }, bob: { userId: "bob", createdAt: now } },
    friendships: { "alice:bob": { id: "alice:bob", userIds: ["alice", "bob"], createdAt: now } },
    games: { gam_existing: { id: "gam_existing", whiteId: "alice", blackId: "bob", status: "active", createdAt: now } },
  };
  const background = [];
  const storage = {
    async get(key) { assert.equal(key, "db"); return structuredClone(db); },
    async put(key, value) { assert.equal(key, "db"); db = structuredClone(value); },
    async setAlarm() {},
  };
  const app = new AppDO({ storage, waitUntil: (promise) => background.push(promise) }, {
    VAPID_PUBLIC_KEY: "",
    GAME_DO: { idFromName: (id) => id, get: () => ({ fetch: async () => Response.json({ ok: true }) }) },
    ...env,
  });
  return {
    app,
    state: () => structuredClone(db),
    async settled() {
      while (background.length) await Promise.all(background.splice(0));
    },
  };
}

function request(path, body = {}, extraHeaders = {}) {
  return new Request(`https://app.local${path}`, {
    method: "POST",
    headers: { cookie: "cwf_session=alice", "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function pausedBody(path, body, headers) {
  const entered = deferred();
  const resume = deferred();
  const req = request(path, body, headers);
  req.json = async () => {
    entered.resolve();
    await resume.promise;
    return body;
  };
  return { request: req, entered: entered.promise, resume: resume.resolve };
}

for (const [path, body, headers] of [
  ["/api/presence/heartbeat", {}],
  ["/api/_client_error", { message: "diagnostic" }],
  ["/_internal/call-invite", { gameId: "gam_existing", initiatorId: "alice", recipientId: "bob" }, { "x-internal": "game" }],
]) {
  test(`a paused ${path} cannot erase a concurrent challenge or push`, async () => {
    const f = fixture();
    const paused = pausedBody(path, body, headers);
    const first = f.app.fetch(paused.request);
    await paused.entered;
    const challenge = f.app.fetch(request("/api/challenges", { friendId: "bob" }));
    // Drain runnable work while the first request is deliberately suspended.
    await setImmediate();
    paused.resume();
    const [firstResponse, challengeResponse] = await Promise.all([first, challenge]);
    assert.equal(firstResponse.status, 200, await firstResponse.text());
    const result = await challengeResponse.json();
    assert.equal(challengeResponse.status, 200, JSON.stringify(result));
    await f.settled();
    assert.equal(f.state().challenges[result.challenge.id]?.status, "pending");
    assert.ok(f.state().pendingPushes.bob.some((push) => push.type === "challenge"));
  });
}

test("alarm writes survive a suspended heartbeat and preserve scheduled notifications", async () => {
  const f = fixture();
  const scheduled = await f.app.fetch(request("/api/schedules", { friendId: "bob", startAt: Date.now() - 1_000 }));
  const { schedule } = await scheduled.json();
  assert.equal(scheduled.status, 200);
  const accepted = await f.app.fetch(request(`/api/schedules/${schedule.id}/accept`, {}, { cookie: "cwf_session=bob" }));
  assert.equal(accepted.status, 200);
  const paused = pausedBody("/api/presence/heartbeat", {});
  const heartbeat = f.app.fetch(paused.request);
  await paused.entered;
  const alarm = f.app.alarm();
  await setImmediate();
  paused.resume();
  await Promise.all([heartbeat, alarm]);
  await f.settled();
  assert.equal(f.state().schedules[schedule.id].status, "fired");
  for (const user of ["alice", "bob"]) {
    assert.ok(f.state().pendingPushes[user].some((push) => push.type === "scheduled_start"));
  }
});

test("concurrent pending reads consume a push once and repeated ACKs stay idempotent", async () => {
  const f = fixture();
  await f.app.fetch(request("/api/challenges", { friendId: "bob" }));
  await f.settled();
  const reads = await Promise.all(Array.from({ length: 2 }, () => f.app.fetch(request("/api/push/pending", {}, { cookie: "cwf_session=bob" }))));
  const payloads = await Promise.all(reads.map((response) => response.json()));
  assert.equal(payloads.filter(Boolean).length, 1);
  const push = payloads.find(Boolean);
  assert.equal(push.type, "challenge");
  const acks = await Promise.all(Array.from({ length: 2 }, () => f.app.fetch(request("/api/push/pending", { ackId: push.id }, { cookie: "cwf_session=bob" }))));
  assert.ok(acks.every((response) => response.ok));
  assert.equal(f.state().pendingPushes.bob, undefined);
});

test("a rejected request does not poison later mutations", async () => {
  const f = fixture();
  const rejected = await f.app.fetch(request("/api/challenges", { friendId: "unknown" }));
  assert.equal(rejected.status, 400);
  const accepted = await f.app.fetch(request("/api/challenges", { friendId: "bob" }));
  assert.equal(accepted.status, 200);
  await f.settled();
  assert.equal(Object.keys(f.state().challenges).length, 1);
});

test("a late push delivery preserves a new subscription and commits after an overlapping heartbeat", async (t) => {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const f = fixture({ VAPID_PUBLIC_KEY: "test", VAPID_PRIVATE_KEY: JSON.stringify(await crypto.subtle.exportKey("jwk", key.privateKey)) });
  const deliveryStarted = deferred();
  const finishDelivery = deferred();
  t.mock.method(globalThis, "fetch", async () => {
    deliveryStarted.resolve();
    await finishDelivery.promise;
    return new Response(null, { status: 410 });
  });
  const subscribe = (endpoint) => f.app.fetch(request("/api/push/subscribe", { subscription: { endpoint, keys: { p256dh: "test", auth: "test" } } }, { cookie: "cwf_session=bob" }));
  assert.equal((await subscribe("https://push.invalid/old")).status, 200);
  assert.equal((await f.app.fetch(request("/api/challenges", { friendId: "bob" }))).status, 200);
  await deliveryStarted.promise;
  assert.equal((await subscribe("https://push.invalid/new")).status, 200);
  const paused = pausedBody("/api/presence/heartbeat", {});
  const heartbeat = f.app.fetch(paused.request);
  await paused.entered;
  finishDelivery.resolve();
  await setImmediate();
  paused.resume();
  await heartbeat;
  await f.settled();
  assert.deepEqual(f.state().pushSubscriptions.bob.map((s) => s.endpoint), ["https://push.invalid/new"]);
  assert.equal(f.state().pushLog.at(-1).status, 410);
  assert.equal(Object.keys(f.state().challenges).length, 1);
  assert.ok(f.state().presence.alice.lastSeenAt);
});

test("the local schedule tick completes within the request's existing state ownership", async () => {
  const f = fixture();
  const startAt = Date.now() + 60_000;
  const scheduled = await f.app.fetch(request("/api/schedules", { friendId: "bob", startAt }));
  const { schedule } = await scheduled.json();
  assert.equal(scheduled.status, 200);
  assert.equal((await f.app.fetch(request(`/api/schedules/${schedule.id}/accept`, {}, { cookie: "cwf_session=bob" }))).status, 200);
  const tick = await f.app.fetch(request("/_debug/tick", { now: startAt + 1 }, { "x-debug-local": "true" }));
  assert.equal(tick.status, 200);
  await f.settled();
  assert.equal(f.state().schedules[schedule.id].status, "fired");
});
