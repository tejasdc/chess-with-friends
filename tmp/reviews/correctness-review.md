# Verdict

Block

# Findings

## High: Production debug endpoint leaks global push state to any signed-in user

`src/worker.ts:333`, `src/worker.ts:769`, `src/worker.ts:1054`

`/api/debug/push-log` is routed through the public Worker with every other `/api/*` path, and `debugPushLog()` trusts the caller-supplied `x-debug-local: true` header. Because the route is after `requireUser()`, this is not anonymous, but any authenticated user can add that header in production and receive the global `pushLog` plus all users' `pendingPushes`. That leaks handles embedded in notification bodies, game URLs, notification timing, and cross-user notification state.

The game debug route has a public Worker hostname guard before setting its local-only header; this route does not. This should be blocked before v1 deployment.

## High: Real Web Push delivery is not correctly modeled and can drop notifications across devices

`src/worker.ts:276`, `src/worker.ts:281`, `src/worker.ts:288`, `src/worker.ts:736`, `src/worker.ts:739`, `src/worker.ts:741`, `public/sw.js:37`, `public/sw.js:39`, `src/worker.ts:580`

The Worker sends an empty Web Push request and relies on the service worker to fetch `/api/push/pending` after wake-up. The pending queue is per user and destructive via `shift()`, while `enqueuePush()` sends to every stored subscription for that user. If a user has more than one installed client, the first service worker that fetches `/api/push/pending` consumes the only payload, and the other subscriptions receive a push event with no payload left to display.

This is also a testability gap for real delivery: the subscription keys are stored but never used for encrypted payloads, and the Web Push request body is empty. For a v1 requirement of working push notifications, the server should either send encrypted payloads to each subscription or enqueue payloads per subscription/device so each delivered push can render independently.

## Medium: Push tests only prove the AppDO pending queue, not service-worker notification behavior

`tests/e2e.spec.ts:132`, `tests/e2e.spec.ts:154`, `tests/e2e.spec.ts:157`, `public/sw.js:25`

The e2e test fakes subscriptions with `https://push.invalid/...` and verifies notifications by polling `/api/push/pending` from a page context. That proves allowed notification types are enqueued, but it does not exercise a browser `push` event, the service worker fallback fetch, `showNotification()`, notification click routing, or actual VAPID delivery semantics.

The requirements allow API/service-worker-level automation for push delivery, but the committed test currently stops at API queue verification. Add a service-worker-level test or a targeted mock around `showPolicyNotification()` so the actual notification rendering path is covered.

## Medium: Passkey registration allows non-user-verified, non-discoverable credentials

`src/worker.ts:392`, `src/worker.ts:400`, `src/worker.ts:454`, `src/worker.ts:460`

The product contract says the account credential is a passkey, synced by platform password managers. The current WebAuthn options use `residentKey: "preferred"` and `userVerification: "preferred"` for registration/login. That can allow authenticators that are not user-verified and not discoverable/synced passkeys, depending on browser/authenticator behavior.

If passkey anchoring is an invariant, registration should require the properties the product depends on, or explicitly reject credentials that do not satisfy them.

## Medium: Visible clocks are server-authoritative but not live-updating for players

`src/main.tsx:476`, `src/main.tsx:480`, `src/main.tsx:517`, `src/main.tsx:519`, `src/main.tsx:523`, `src/main.tsx:524`, `src/worker.ts:1001`

The server clock math is authoritative, and `GameDO` alarms should terminate timeout games. However, the client only updates displayed clocks when it receives a WebSocket state message or reloads; there is no local display ticker or periodic sync during a normal turn. A player can stare at a frozen clock until a move, reconnect event, reload, or terminal timeout broadcast.

This does not appear to let players cheat the clock, but it fails the practical "clock correctness" expectation for rapid games because the UI does not continuously reflect the server clock.

## Low: Reconnect/gone state is volatile in memory

`src/worker.ts:778`, `src/worker.ts:779`, `src/worker.ts:831`, `src/worker.ts:848`, `src/worker.ts:934`, `src/worker.ts:935`, `src/worker.ts:966`

The opponent connection indicator works for the tested in-memory close/reopen path, but `connectionState` and reconnect timers are not persisted. Durable Object restart/eviction or WebSocket lifecycle edge cases can reset both players to `gone` even while clients are reconnecting. This is acceptable for a v1 indicator if documented, but it is weaker than the game-state persistence used for moves/clocks.

## Low: Schedule creation accepts slightly past timestamps

`src/worker.ts:676`, `src/worker.ts:677`

`createSchedule()` accepts `startAt` values up to 60 seconds in the past even though the error text says "Choose a future time." This likely exists to tolerate client skew, but it means direct API clients can create and accept already-due schedules. If intentional, name it as a skew allowance; otherwise require `startAt > Date.now()`.

# Test Evidence Reviewed

- Read `docs/requirements.md` in full.
- Inspected committed backend/game code in `src/worker.ts`.
- Inspected committed client WebSocket/game/push code in `src/main.tsx` and `public/sw.js`.
- Inspected committed e2e coverage in `tests/e2e.spec.ts`.
- Inspected Cloudflare deployment config in `wrangler.jsonc`.
- Inspected push policy tooling in `scripts/verify-push-policy.mjs`.
- Ran `npm run typecheck`: passed.
- Ran `npm run test:push`: passed, but it only verifies allowed push type literals.
- Ran `npm run build`: passed.
- Reviewed `tmp/reviews/PROGRESS.md`, which records prior successful local e2e, screenshot visual inspection, deployment, and smoke checks. I did not rerun the browser e2e in this review because the current request was code review and the machine has known memory pressure constraints.

# Residual Risks

- I did not verify the deployed Worker state or Wrangler secrets during this review. Real Web Push depends on `VAPID_PRIVATE_KEY` being present in the deployed environment.
- I did not perform a real iPhone installed-PWA push test; that remains a manual platform check.
- I did not inspect every screenshot visually during this review; I treated the existing progress note and screenshot inventory as historical evidence, not as fresh approval.
- The all-state-in-one AppDO database is pragmatic for v1, but it will become a scaling and migration concern if usage grows.

# Re-review Addendum

## Verdict

Approve

## Evidence

- Production `/api/debug/push-log` is now blocked at the public Worker boundary before AppDO forwarding. `src/worker.ts:1066` handles that path specially, `src/worker.ts:1067` returns 404 unless the request hostname is `127.0.0.1` or `localhost`, and only the local branch injects `x-debug-local: true` at `src/worker.ts:1068-1070`.
- The old spoofed-header leak is addressed because production requests to `/api/debug/push-log` no longer reach `AppDO.debugPushLog()` through the generic `/api/*` forwarding path at `src/worker.ts:1072`.
- Pending push storage now has a per-endpoint map in `AppDb` at `src/worker.ts:120`, initialized in `emptyDb()` at `src/worker.ts:167`.
- `enqueuePush()` now writes a pending payload for each subscribed endpoint at `src/worker.ts:749-753`; the legacy per-user queue is only used when the user has no subscriptions at `src/worker.ts:756-758`.
- `/api/push/pending` now accepts POST as well as GET at `src/worker.ts:321`, reads the requested endpoint at `src/worker.ts:583-590`, verifies the endpoint belongs to the signed-in user at `src/worker.ts:591`, and destructively reads that endpoint's queue at `src/worker.ts:592`.
- The service worker now fetches the current push subscription endpoint with `pushManager.getSubscription()` at `public/sw.js:39` and POSTs it to `/api/push/pending` at `public/sw.js:40-45`.
- The Playwright fake push helper now stores a test endpoint and polls `/api/push/pending` by endpoint at `tests/e2e.spec.ts:143-168`, so the automated path follows the new endpoint-scoped queue contract.

Checks run in this re-review:

- `npm run typecheck`: passed.
- `npm run test:push`: passed, reporting exactly `friend_request`, `challenge`, `scheduled_start`.
- `npm run build`: passed.
- `npm run test:e2e`: passed, 1 test using 1 worker, 6.7s test body / 10.9s total.

## Remaining Findings

None blocking in the re-reviewed areas.

Residual caveat: Web Push still sends an empty push body and relies on the service worker making an authenticated same-origin fetch for the endpoint-scoped payload. That is now coherent for multi-device delivery, but real installed-device delivery still needs the already-planned manual iPhone/PWA verification.
