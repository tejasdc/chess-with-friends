# D1 application-state operations

## Ownership

The public Worker is stateless. It reads and conditionally mutates normalized
application records through the `DB` D1 binding. `GameDO` remains the only
writer for live game state, clocks, sockets, and WebRTC signaling. Its D1 game
row is a monotonic directory projection. `SchedulerDO` owns only wake-up timing;
the schedules and occurrence-effect workflow live in D1.

The `APP_DO` binding and class remain deployed solely so pre-cutover data is
recoverable during rollback. No public route, game authorization check,
terminal projection, call notification, or scheduler path normally calls it.

## Local database

Install dependencies and initialize a fresh local database:

```sh
npm install
npm run db:migrate:local
npm run worker:dev
```

Wrangler persists local Worker, D1, and Durable Object state under
`.wrangler/state`. The first migration creates an empty application database;
there is no AppDO importer or dual-write path.

## Production configuration and first cutover

Use the existing unified `remote-box-workers-deploy` Cloudflare token. It must
be granted D1 Edit permission; do not create another credential. Then:

1. Create the production database with `wrangler d1 create
   chess-with-friends`.
2. Replace the all-zero placeholder `database_id` in `wrangler.jsonc` with the
   returned UUID. Keep the `DB` binding name and `migrations_dir` unchanged.
3. Apply the schema with `wrangler d1 migrations apply chess-with-friends
   --remote` and confirm migration `0001_app.sql` succeeds.
4. Run the production deploy through the project's normal deploy channel.
5. Verify the live health response reports `"storage":"d1"`, then exercise
   registration, friendship/challenge, game, call, presence visibility, push,
   and a scheduled alarm on Mobile Safari/WebKit.
6. Inspect D1 rows read/written, Worker requests, Durable Object activity, push
   delivery logs, and TURN traffic for the contained test.

This is an intentional empty-state cutover. Old sessions return the ordinary
logged-out response, and returning players register again. The origin, WebAuthn
rpID behavior, session-cookie contract, VAPID identity, manifest identity, and
service-worker update path do not change, so installed PWAs update without a
reinstall.

## Scheduler recovery

Every schedule mutation that may introduce an earlier deadline asks
`SchedulerDO` to wake no later than that candidate before committing, then asks
it to canonicalize after the D1 write. The pre-commit request carries a unique,
short-lived handoff marker. If its alarm beats the D1 commit or the Worker dies
after committing, the marker preserves watchdog rechecks until the caller
clears it or its bounded recovery window ends. A harmless early alarm is
preferable to a lost deadline. The canonical alarm is the earliest accepted occurrence,
pending-proposal expiry, unfinished occurrence effect retry, or pending push
retry.

The persisted handoff set carries a monotonic generation. Canonicalization
snapshots that generation, queries D1, then re-reads the generation before it
changes the alarm. If a concurrent request added or removed a handoff during
the D1 await, canonicalization retries from a fresh snapshot. Once the second
storage read succeeds, the generation check and following alarm write remain
inside the Durable Object storage input gate.

An alarm atomically claims a stable `(schedule_id, scheduled_for)` occurrence
and records a stable game id before initializing `GameDO` or sending pushes.
Separate completion markers make both effects retryable. Duplicate delivery,
alarm replacement, actor restart, or a crash between effects resumes the same
record instead of creating a second game. A watchdog alarm remains armed while
unfinished effects exist.

`GameDO` initialization parses and validates the complete request before it
enters the actor storage sequence. The remaining get, immutable-value compare,
and create operations contain no non-storage await: the first initialization
wins, an identical concurrent retry is a no-op, and a mismatch is rejected
without replacing actor state.

A call invite uses the same ordering at the game boundary: `GameDO` atomically
stores the requesting call session and a stable actor-local notification effect,
then broadcasts. Its existing alarm includes the effect's retry time until D1
has idempotently accepted the pending push. No singleton application actor or
general Queue participates.

## Rollback

Rollback may route an older Worker build back to the still-bound legacy
`AppDO`. That restores the old AppDO snapshot, not state created in D1 after the
cutover. Preserve both stores for diagnosis; do not delete or overwrite either
one during rollback. Reconciliation or import is deliberately outside this
approved zero-migration change.
