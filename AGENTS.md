# chess-with-friends

## Runtime ownership

- Stateless Worker route handlers in `src/d1-app.ts` own normalized account,
  session, social, schedule, presence-lease, and push state in D1.
- One `GameDO` per game is authoritative for chess state, clocks, hibernatable
  sockets, connection grace, and WebRTC signaling. D1's game row is a
  monotonic directory projection, never the live-game writer.
- The singleton `SchedulerDO` owns only the next Durable Object alarm. D1
  remains the schedule source of truth and stores occurrence claims and every
  unfinished external effect so alarm delivery is safely repeatable.
- `AppDO` and its binding are rollback-only. Do not route a normal public or
  internal request through it, write new application state to it, or delete its
  namespace/data as part of ordinary work.
- Presence is disposable UX state. A stale or failed presence read may change
  a badge or cause an extra call notification; it must never authorize or deny
  an action.

## Local workflow

- Apply D1 migrations with `npm run db:migrate:local`; local state is persisted
  under `.wrangler/state`.
- `npm run worker:dev` builds, migrates, and starts the Worker locally.
- During iteration run the smallest focused Playwright test. At the end of a
  coherent change run typecheck, push policy checks, production build, and
  `npm run test:e2e` according to the global test-cadence rule.
- Any D1 schema change is a new numbered file in `migrations/`; never edit an
  already-applied production migration.
- Keep API, cookie, origin/rpID, VAPID, manifest, service-worker, `GameDO`, and
  WebRTC protocols compatible unless a product requirement explicitly changes
  them.

Production setup, zero-migration behavior, rollback, and scheduler recovery are
documented in `docs/d1-operations.md`.
