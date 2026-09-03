# AppDO to D1 Architecture Plan

Status: **Implemented locally on 2026-09-03; production configuration and deployment remain intentionally pending.**

The implementation uses the approved zero-migration cutover. No remote D1
database was created and nothing was deployed because the current unified
Cloudflare deployment token lacks D1 API permission. See
`docs/d1-operations.md` for the exact remaining steps.

Independent review outcome: the first pass returned `NO-SHIP` on four bounded gaps. The reviewed version incorporated scheduler recovery, reset safety, presence compatibility, and complete AppDO seam removal, then received **`SHIP` with no remaining plan blockers**. The owner subsequently confirmed that nobody is using the app and explicitly accepted abandoning all current sessions and activity, so the reviewed quiet-window preflight is unnecessary: its safety condition is already known to be true. Runtime correctness still has to be demonstrated by the implementation checks in this document.

## Recommendation

Keep the current one-`GameDO`-per-game design and the existing WebRTC call path. Replace the singleton `AppDO` as the normal application database with stateless Worker endpoints backed by D1. Preserve global presence as short-lived D1 leases, and retain one small Durable Object only as the exact-time alarm coordinator for scheduled games.

For the current operating profile—no active users and no irreplaceable production history—the approved cutover is **zero migration**: start D1 empty, let prior accounts register again when they return, and leave the legacy Durable Object data untouched for rollback. Existing sessions and any unnoticed activity may be abandoned by design. This avoids building a privileged snapshot/export/import path whose complexity would exceed the value of the data being preserved.

## Operating profile

- Today: two known users, light traffic, and recoverable data.
- Near-term possibility: a public social-media launch with a burst of new accounts and concurrent games.
- Trust boundary: public internet ingress, passkey authentication, push subscriptions, and TURN credentials are real security boundaries even at hobby scale.
- Availability and recovery: brief maintenance or asking the two users to register again is acceptable. Formal high availability, compliance, and zero-downtime migration are not required.
- Cost target: remain within Cloudflare's free allowances at current usage and avoid adding a Queue or another service until observed traffic justifies it.

## Acceptance criteria

The approved implementation must satisfy all of these as one coherent change:

1. Normal account, session, social, schedule, notification, and presence requests no longer pass through the singleton `AppDO`.
2. Each game remains owned by its existing `GameDO`, including legal moves, clocks, WebSocket fan-out, resign/draw state, and WebRTC signaling.
3. Durable application records live in D1 with explicit constraints, indexes, and transactional mutations.
4. Global presence still answers “is this friend recently active?” and preserves `foregroundGameId` for suppressing redundant call pushes. Presence never grants authorization or changes game correctness.
5. Scheduled games can still fire close to their due time even when no request is arriving.
6. Existing API paths and response shapes remain compatible for old installed clients. Zero migration intentionally invalidates every old session; a returning client receives the normal logged-out/registration flow. Continuity for an unnoticed active game/call is explicitly not required.
7. The app keeps the same origin, WebAuthn relying-party identity, cookie contract, manifest start URL, and VAPID key. An installed PWA updates normally and does not require deletion or reinstallation.
8. No Queue, cache tier, read replica, per-user actor, or dual-write migration is introduced.
9. Legacy `AppDO` data is not deleted during cutover.

## Architecture after cutover

```text
Installed PWA / browser
        |
        | HTTPS: auth, friends, challenges, schedules, presence, push
        v
Stateless Cloudflare Worker ---------------> D1
        |                                     durable app records
        |
        +-- game HTTP/WebSocket -----------> GameDO(gameId)
        |                                     authoritative game + signaling
        |
        +-- schedule mutation -------------> SchedulerDO(singleton)
                                              next alarm only; queries D1 when awake

During a call:
browser <-------- WebRTC media (peer-to-peer when possible) --------> browser
                         \---- Cloudflare TURN relay if needed ----/
```

The design does not reject Durable Objects. It uses them only where their single-writer or wake-up semantics match the job:

- `GameDO` is the right actor because one game has ordered mutations, connected sockets, clocks, and a natural per-game key.
- `SchedulerDO` is the right alarm owner because a stateless Worker plus D1 cannot wake itself at an exact time.
- A single global `AppDO` is the wrong owner for unrelated users because every ordinary request is serialized through one object and the database is currently rewritten as one JSON value.

## State ownership

| State | Owner | Reason |
| --- | --- | --- |
| Users, credentials, sessions, auth challenges | D1 | Durable indexed records; no global serialization needed |
| Friendships, friend requests, challenges | D1 | Relational constraints and transactions match the data |
| Schedules and game directory/projections | D1 | Searchable durable application state |
| Push subscriptions and pending notification records | D1 | Durable per-user records |
| Presence leases | D1 initially | Ephemeral, queryable, and not correctness-critical |
| Game position, move order, clocks, draw/resign state | `GameDO(gameId)` | One ordered writer per game |
| In-game WebSockets and WebRTC offer/answer/ICE signaling | `GameDO(gameId)` | Fan-out is scoped to the same game |
| Next scheduled wake-up | `SchedulerDO` | Durable Object alarms provide wake-up semantics |
| Media packets | Browser-to-browser WebRTC or TURN | The application server should not proxy audio/video |

## D1 data model

The implementation should use normalized tables rather than copying the current `AppDb` JSON shape literally. Exact SQL belongs in the implementation design, but the required logical tables are:

- `users` and `credentials`: stable user IDs, unique normalized handles, and one or more WebAuthn credentials per user.
- `sessions`: hashed bearer tokens, user ID, creation time, expiry, and revocation state. Raw session tokens must not be stored.
- `auth_challenges`: short-lived registration/login challenges with purpose and expiry.
- `friend_requests` and `friendships`: unique unordered user pairs and checked lifecycle states.
- `challenges`: challenger, recipient, game settings, lifecycle state, and timestamps.
- `schedules`: participants, next occurrence, recurrence data, and lifecycle state.
- `schedule_occurrences`: unique `(schedule_id, scheduled_for)`, stable `game_id`, claimed time, and explicit completion/retry fields for game initialization and both notification effects. This is a domain record, not a general-purpose Queue.
- `games`: the app-level directory/projection needed for home screens and history; `GameDO` remains authoritative for live play.
- `push_subscriptions`, `pending_pushes`, and bounded delivery logs where the current product behavior requires them. Push endpoint ownership is globally unique; reassignment and stale pending-payload cleanup are one atomic mutation.
- `presence_leases`: `lease_id`, `user_id`, `last_seen_at`, and nullable `foreground_game_id`.
- bounded `idempotency_results`, `rate_limits`, and `client_errors` records where existing behavior depends on them.

Every lifecycle status gets a database check constraint. Every natural uniqueness invariant—handle, credential ID, friendship pair, request pair, schedule occurrence, push endpoint, idempotency key—gets a unique constraint rather than a read-then-write convention. Tables that expire require an indexed expiry column and bounded opportunistic cleanup. Mutations use conditional DML and affected-row checks; predetermined multi-statement units use D1 `batch()` so the plan does not assume an arbitrary JavaScript callback transaction exists.

## Mutation and consistency invariants

1. **D1 owns durable application mutations.** Multi-row changes such as accepting a friend request or challenge use one atomic D1 batch with conditional statements, unique constraints, and affected-row checks—not read-then-write guards.
2. **External effects occur after durable intent.** An atomic database mutation first records a claimed transition and its unfinished effects. Creating/initializing a `GameDO` or waking a push subscription follows that commit and is safe to retry until its completion marker is stored.
3. **Every cross-boundary operation is idempotent.** Game creation has a stable game ID derived or recorded before `GameDO` initialization. Schedule occurrences have a unique occurrence key. Push attempts have stable delivery IDs where duplicate delivery matters.
4. **`GameDO` remains authoritative for live game state.** Its completed/aborted result is projected directly to D1 with a monotonic, idempotent conditional update. A game snapshot or result read may repair a missing projection; the D1 projection must not overwrite newer actor state.
5. **Presence is a hint.** Failure to update or read presence can change only an online badge or whether a redundant push is sent. It cannot reject authentication, invitations, calls, or moves.
6. **The scheduler has one wake-up owner, not one app owner.** A schedule mutation that could add an earlier deadline first asks `SchedulerDO` to wake no later than that candidate time; it then commits to D1 and asks the actor to canonicalize the alarm. A failed commit causes only a harmless early wake, while a crash after commit cannot lose the earlier deadline. The alarm atomically creates/claims occurrence records before effects. It queries both newly due work and previously claimed unfinished work; a retry sees the same occurrence key and stable game ID and cannot create a second game.
7. **No dual-write period.** Requests switch from legacy `AppDO` to D1 as a single deployment. Dual-writing would create reconciliation work that is unjustified for two users.
8. **Authentication transitions are single-use.** Verification consumes one unexpired, purpose-bound challenge exactly once while conditionally updating the WebAuthn credential counter and creating the hashed session.

## AppDO seam-removal checklist

The implementation is incomplete until every live singleton dependency is addressed explicitly:

- Game-route session authorization reads D1, not `AppDO`.
- `GameDO.reportStatus` writes the monotonic game projection to D1, not `/_internal/game-status` on `AppDO`.
- `GameDO` call-invite handling uses the shared D1 presence and pending-push implementation, not `/_internal/call-invite` on `AppDO`.
- `GameDO.init` is idempotent **by value**: an identical immutable game ID, players, handles, and time control succeeds; any mismatch fails loudly.
- The public Worker allowlists valid game actions. It never proxies `/init` and never forwards or trusts a client-supplied internal-auth header; server-created internal calls construct their own headers.
- The legacy `AppDO` class/binding remains only so its old data is recoverable. No public or normal internal request routes to it.
- A repository-wide completion search confirms that all six pre-cutover `appStub(` references are gone. The retained `APP_DO` binding, legacy class routes, and documentation are accounted for as rollback-only.

## Global presence design

Presence remains useful, but it should not be stored as one record per user in a global actor.

- Each new open visible client has a random `leaseId`; multiple devices or tabs therefore do not overwrite each other.
- `leaseId` is optional during the old-client compatibility window. For a heartbeat without it, the server derives a stable legacy lease key from the authenticated session hash; it never stores the raw session token.
- A visible client heartbeats every **30 seconds**. Background or hidden clients stop heartbeating.
- A user is considered online when any lease has `last_seen_at` within **75 seconds**.
- The heartbeat includes nullable `foregroundGameId`, preserving the current call-notification optimization. Foreground suppression has its own **30-second freshness window**; it does not inherit the 75-second online TTL.
- On a route or visibility change, a new client heartbeats immediately. When hidden or leaving a game it best-effort clears foreground state before stopping periodic heartbeats.
- Missing, ambiguous, stale, or failed foreground-presence reads always fail open to **sending** the call push. An extra notification is preferable to a missed call.
- The heartbeat endpoint keeps both its current request compatibility and response shape, including home/dashboard data, so an old inactive client can cross a deployment safely. The implementation may split the internal queries without changing the public contract.
- Reads return a conservative result if D1 is unavailable: presence is unknown/offline and the system may send an extra push.
- Expired leases are deleted opportunistically in bounded batches. Correctness never waits for cleanup.

At 30-second intervals, one continuously visible client generates about 2,880 logical heartbeat updates/day. D1 indexes can add billable rows written beyond that logical count, so actual metadata must be measured. This is still comfortable for two users but must be watched before a large launch. If presence becomes the dominant D1 write load, the endpoint can move behind the same HTTP contract to a sharded, hibernatable `PresenceDO`; because presence is ephemeral, that later change requires no data migration. That actor is deliberately not part of this change.

## Scheduled-game design

A stateless Worker and D1 are enough for request-driven work, but not for exact scheduled wake-ups. The replacement therefore retains one narrowly scoped actor:

- `SchedulerDO` stores only the alarm/wake-up responsibility, not users, sessions, social data, presence, or the schedule catalog.
- Before committing a mutation that could introduce an earlier deadline, the Worker calls `wakeNoLaterThan(candidateTime)`. After the D1 mutation, it calls an idempotent `canonicalize` method. A cancellation may leave a harmless early wake if canonicalization fails.
- `canonicalize` queries D1 and sets the next wake to the minimum of: the next accepted occurrence, a pending schedule's `startAt + 60 seconds` expiry deadline, and the retry time of claimed unfinished effects.
- At alarm entry, the actor first installs a short retry-watchdog alarm. It then atomically creates/claims all due occurrence records in a bounded batch with stable game IDs and explicit effect state.
- The alarm processes both new due occurrences and unfinished claimed occurrences. It initializes each `GameDO` idempotently by value, stores completion, durably enqueues each notification payload, wakes the subscription, and stores the effect result so retries resume only unfinished work.
- Before returning successfully, it replaces the watchdog with the next canonical deadline or deletes the alarm when none exists. If processing throws, Cloudflare's alarm retry and the installed watchdog provide bounded immediate and longer-lived recovery.

No Cloudflare Queue is required for this operating profile. If the exact-time scheduled-game feature is intentionally removed, `SchedulerDO` can also be removed; otherwise a D1-only design would silently change product behavior.

## Data cutover choices

### A. Zero migration — approved

Deploy the D1-backed architecture with an empty database. Prior users register again when they return. Old accounts, sessions, friendships, games, schedules, and pushes remain in the unreachable legacy `AppDO` for rollback but are not imported.

Benefits:

- No privileged export endpoint, migration token, snapshot format, or one-time importer.
- No need to translate stale caches, presence, rate limits, or partially completed records.
- No dual-write, reconciliation, maintenance mode, or identity mapping.
- The implementation and rollback paths remain small enough to inspect confidently.

User-visible cost:

- Both users are logged out and must register again, recreate friendships/challenges/schedules, and accept that old games are not in the new history.
- The owner has confirmed that nobody is using the app and accepts abandoning any unnoticed active game, call, or accepted schedule. There is no quiet-window check or temporary maintenance system.
- Existing passkeys for the old account may remain in the device credential picker as orphaned entries. Registration creates a new credential; the UI should give the two users a short heads-up rather than adding passkey-recovery machinery.
- Push subscriptions are associated again after login through the existing client subscription sync.

This option does **not** require uninstalling the PWA. It is a backend account reset inside the same installed app. A returning user registers again. If preserving current sessions or live-game continuity becomes a requirement before deployment, stop and revisit accounts-only import instead.

### B. Accounts-only import — not recommended by default

Import users, WebAuthn credentials, valid sessions, and possibly push subscriptions, while discarding social, games, and schedules.

This looks modest but requires most of the risky machinery of a full migration: a secure way to extract the legacy private blob, preserve stable IDs, hash or translate session records, validate credential uniqueness, mark an import exactly once, and verify/roll back it. Preserving identity also creates understandable pressure to preserve associated relationships and history. Choose it only if avoiding re-registration is worth that implementation and security surface.

### C. Full durable-state import

Build a one-time, authenticated legacy snapshot path and importer. Import durable user, session, social, schedule, game-directory, and push-subscription records with stable IDs. Deliberately discard presence, auth challenges, transient operation caches, rate-limit windows, and diagnostic logs. Verify counts and referential integrity, mark the import atomically, and ask `SchedulerDO` to re-arm from imported schedules.

This best preserves continuity but is disproportionate for two recoverable users. It should be approved only if the existing history is declared valuable enough to justify a security-sensitive migration path and its tests.

## One-change cutover sequence for the recommended option

This is an implementation order inside one approved delivery, not a phased product rollout:

1. Add the D1 schema, repositories, stateless route handlers, presence lease behavior, and narrowly scoped `SchedulerDO`.
2. Preserve all existing public route paths and response shapes needed by the current client.
3. Make D1 the only durable app-state write path and remove the singleton `AppDO` from authentication and game-request authorization.
4. Deploy with empty D1 application tables. Keep the legacy Durable Object binding and stored data intact but remove it from public and normal internal routing.
5. Returning users reopen the installed app and register again. The service worker fetches the normal update; no reinstall is requested.
6. Run the real-environment acceptance checks below. Do not delete the legacy namespace in this change.

## PWA and old-client compatibility

- Keep the same hostname/origin, WebAuthn RP identity, authentication cookie name and semantics, manifest identity/start URL, and push VAPID key.
- Keep the current service-worker activation policy: download updates, but do not force activation while the user is in an active game. Retain the current no-cache behavior for HTML and non-hashed runtime assets.
- Preserve the external API contract across the cutover. An old tab may hold previous JavaScript and receives an ordinary unauthenticated response/registration flow after its session is invalidated. Preserving an unnoticed active game is explicitly outside the approved reset contract.
- A reset session should receive the ordinary unauthenticated response and registration flow, not an opaque server error.
- After re-registration, the client re-sends its existing browser push subscription to associate it with the new user. The VAPID identity does not change.
- Do not bundle Worker asset-routing/cost optimization into this migration. `run_worker_first` can be measured separately after the state cutover; changing fetch routing at the same time adds PWA cache risk without solving the singleton.

## Rollback

- The legacy `AppDO` namespace and data remain untouched throughout this change.
- No dual-write is attempted. If the D1 deployment fails before meaningful new use, route back to the legacy code.
- After users create new D1 state, rollback means accepting a reset to the old snapshot. Preserve the new D1 data as well as the legacy `AppDO` data for diagnosis or a later deliberate recovery; exporting D1 is not a rollback prerequisite.
- Deleting the legacy namespace, its binding, or old user data is a separate destructive decision after the new system has been observed and is explicitly out of scope.

## Verification required after implementation approval

Targeted checks during implementation:

- Auth: WebAuthn registration/login challenge expiry, session hashing/expiry/revocation, and account reset behavior.
- Social graph: concurrent duplicate friend requests, reciprocal requests, accept/decline/cancel, authorization, and unique-pair constraints.
- Challenges: concurrent accept/cancel, stable game ID creation, retry after `GameDO` initialization failure, and duplicate request idempotency.
- Presence: multiple leases for one user, a legacy no-lease-ID client, 75-second online versus 30-second foreground freshness, immediate route/visibility changes, expiry cleanup, and fail-open call push on D1 failure.
- Schedules: pre-commit earlier-deadline wake, post-commit canonicalization failure, pending-schedule expiry wake, concurrent/duplicate alarms, watchdog recovery past provider retries, unfinished occurrence recovery, bounded batch continuation, recurrence advancement, game initialization mismatch, and push retry.
- Projection: completed `GameDO` state reaches D1 idempotently and a missed projection can be repaired without overwriting newer actor state.
- PWA: the actual built production update hook proves that a previously installed app updates without reinstall; an old tab gets a compatible logged-out response after the intentional reset; push subscription re-associates after registration.

End-of-change gates:

- Run the repository's full verification gate once after all implementation work is complete.
- Exercise the installed PWA in WebKit/Mobile Safari, including re-registration, a live game, a call, background/foreground presence, and a scheduled-game alarm.
- Inspect D1 rows-read/rows-written, Worker requests, Durable Object requests/duration, and TURN traffic after the contained real-environment test.

## Approval blockers and proposed resolutions

| Decision/blocker | Why it must be decided | Proposed resolution |
| --- | --- | --- |
| Existing data treatment | It changes implementation scope and the identity/passkey experience | **Resolved: zero migration approved**; returning users register again and legacy data stays intact |
| Exact scheduled wake-ups | D1 cannot wake a stateless Worker, and commit-then-rearm can lose an earlier deadline | Approve alarm-only `SchedulerDO`, pre-commit `wakeNoLaterThan`, occurrence effect state, and watchdog recovery |
| Cross-boundary retries | D1 cannot atomically include `GameDO` initialization or push delivery | Approve durable unfinished-effect records + stable IDs + idempotent retry/repair invariants |
| Presence compatibility and write budget | Old clients have no lease ID; online and call-foreground freshness differ | Approve optional legacy lease fallback, 30-second visible heartbeat, 75-second online TTL, and 30-second call-foreground window |
| Old PWA clients and reset sessions | Zero migration removes their session | **Resolved: continuity intentionally abandoned**; return the normal logged-out/registration flow without requiring reinstall |
| Rollback after new writes | There is intentionally no dual-write reconciliation | Accept reset-style rollback for this two-user cutover; keep legacy data untouched |

## Explicit non-goals

- Redesigning `GameDO`, chess rules, game WebSockets, or WebRTC/TURN media transport.
- Adding Queues, per-user Durable Objects, a permanent `PresenceDO`, read replicas, cache infrastructure, or locally validated signed session cookies.
- Building account merge, passkey recovery, or a credential cleanup UX solely for two reset accounts.
- Changing recurrence/time-zone product semantics as part of the storage migration.
- Optimizing static-asset Worker routing or changing service-worker caching in the same deployment.
- Deleting the old Durable Object namespace or its data.

## Approval requested

Approved implementation choices:

1. **Data:** A (zero migration). Accounts-only and full import are rejected for the current empty-use profile.
2. **Presence:** 30-second visible-only heartbeat, 75-second online lease, separate 30-second call-foreground window, and legacy no-lease-ID compatibility in D1.
3. **Schedules:** retain one alarm-only `SchedulerDO`, plus durable occurrence/effect records and a watchdog, with D1 as the schedule source of truth.
4. **PWA scope:** preserve current API/cache/update contracts and defer asset-routing optimization.
5. **Cutover:** deploy the empty D1 state directly. Do not build a quiet-window check or temporary maintenance subsystem; returning users register again.

These choices are approved for implementation. Any newly discovered security or correctness blocker still stops deployment until resolved.
