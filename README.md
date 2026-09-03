# two chairs

Live chess for people who know each other. No matchmaking pool, no
strangers, no ratings, no bots. A game happens when a friend of yours
sits down across from you.

Live at **[twochairs.club](https://twochairs.club)** (installs to the
home screen). Private, invite-only.

## What it is

Most chess apps optimize for infinite opponents and one more game. This
one treats the scarcity of opponents as the feature. The design encodes
a small set of intentions instead of engagement metrics:

- Only friends. Add them by handle or by shareable invite link. Friend
  requests need acceptance.
- Live-only, two-player, standard rules. Rapid 10|0 default; blitz 5|0
  second option. Server is authoritative over clocks and legality.
- No ELO, no ladder, no streaks, no puzzles feed, no daily anything.
  Rematch is fine — a friend consenting is the natural rate limiter.
- Presence is visible only when you open the app. There is no push for
  "your friend came online" — that is a re-engagement hook, and it is
  permanently out.
- Notifications exist only when they serve *your* intention: a request
  to you, a handshake you started completing, a time you agreed to
  arriving. `friend_request`, `challenge`, `challenge_accepted`,
  `scheduled_start`, `call_invite` — that's the whole set today. A
  script (`scripts/verify-push-policy.mjs`) fails the build if code
  reaches for anything else.
- Correspondence chess isn't in v1 but nothing in the data model
  assumes both players are always connected. "Live" is a policy, not
  an architecture.

## Engineering notes

Worth reading the source for, if any of these catch you:

- **Passkeys instead of accounts.** No email, no phone number, no
  password. The credential is a WebAuthn passkey generated at signup;
  iCloud Keychain and Google Password Manager handle multi-device
  sync and recovery for free. A cookie keeps day-to-day use
  frictionless; the passkey is the anchor when the session is gone.
  The Worker stores only a SHA-256 digest of each bearer session in D1;
  the raw token exists only in the secure cookie.
- **D1 for application state, a Durable Object per game.** Stateless
  Worker handlers own accounts, social state, schedules, presence leases,
  and notifications in normalized D1 tables. `GameDO` (SQLite-backed)
  remains the single writer for a game's clock, moves, sockets, and WebRTC
  signaling. A narrow singleton `SchedulerDO` owns only scheduled alarms
  and resumes durable D1 occurrence effects after interruption. The legacy
  `AppDO` binding is retained for rollback data but receives no normal
  public or internal traffic.
- **Hibernatable WebSockets.** Sockets use
  `ctx.acceptWebSocket` so the DO can go cold between moves without
  losing connections. Grace-period countdowns are driven by DO alarms,
  not `setTimeout` — the object may not be alive when the timer would
  have fired.
- **Server-authoritative clocks.** Backgrounding a phone or losing a
  connection mid-game can't corrupt or cheat time. `chess.js` handles
  move legality; the DO decrements the clock.
- **iOS-first PWA.** iOS 16.4+ requires add-to-home-screen before it
  will grant push permission, so the install flow is a guided step
  rather than a suggestion. Web push uses VAPID with an ECDSA
  P-256 JWT signed inside the Worker; `scripts/generate-vapid.mjs`
  produces the keypair. Dead endpoints (410/404) are dropped on the
  next send. Endpoint ownership transfers on subscribe, so a phone
  can only ever ring for one account at a time.
- **State-machine-first.** `docs/state-machines.md` documents every
  lifecycle — friend request, challenge, schedule, game, socket
  session, per-game voice call — with named `GAP-N` invariants. Tests
  cite the gaps by number.
- **Per-game voice.** Optional 1:1 WebRTC call while a game is open,
  signaled through the `GameDO`. Cloudflare TURN via
  `TURN_KEY_ID`/`TURN_KEY_API_TOKEN` when set.

## Stack

TypeScript, React 19, Vite, `chess.js`, Three.js (landing-page board
animation), `@simplewebauthn/{browser,server}`, Cloudflare Workers + D1 +
Durable Objects with the SQLite storage backend, Wrangler, Playwright for
end-to-end tests.

## Run it locally

```
npm install
npm run db:migrate:local # initialize or advance the local D1 database
npm run worker:dev       # builds, migrates, and runs wrangler dev on :8787
```

`npm run dev` runs Vite on its own (useful for the landing / UI without
the Worker). `npm run typecheck` and `npm run test:e2e` do what they
say. `npm run test:push` runs the notification-policy verifiers.

For web push locally, generate a keypair once with `npm run
vapid:generate`, put the public key in `wrangler.jsonc` under
`vars.VAPID_PUBLIC_KEY`, and put the private key in a
`.dev.vars` file as `VAPID_PRIVATE_KEY=…` (gitignored). In production
the private key is a Wrangler secret.

See `docs/d1-operations.md` for ownership, zero-migration cutover, local
state, production configuration, rollback, and scheduler recovery.

## Status

v1, running in private beta with friends. The core loop
(passkey signup, friends, challenge, live game to every terminal
state, mid-game reconnect, scheduled start, push) is in and tested end
to end. The name is provisional — "two chairs" is the current working
title.

## License

No license granted. All rights reserved. The code is public so it can
be read; it is not open for reuse. Open an issue if you want to talk
about that.
