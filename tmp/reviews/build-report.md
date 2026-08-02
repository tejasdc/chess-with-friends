# Build Report

## Built

- Friends-only live chess PWA on Cloudflare Workers Static Assets plus Durable Objects.
- Passkey-anchored handle accounts with session cookies; no email or phone fields.
- Friend requests by handle and invite link, both requiring acceptance.
- Challenge flow with friend-request/challenge push queueing.
- One-off scheduling flow; accepted schedules fire scheduled-game-starting pushes and create a game.
- Server-authoritative games in `GameDO` using `chess.js` for legal moves and terminal states.
- Server-authoritative clocks for `10|0` and `5|0`, with timeout alarms and live client display.
- WebSocket game state with opponent `connected` / `reconnecting` / `gone` indicator.
- PWA manifest, service worker, install guidance, and intentional notification permission gesture.
- Push policy constrained to exactly: `friend_request`, `challenge`, `scheduled_start`.

## Deployed

- URL: https://chess-with-friends.thnkring.workers.dev
- Current deployed version: `edd56469-4645-475b-b283-0e28abb264c1`
- Custom domain: not attached.

## How To Run

```bash
npm install
npm run worker:dev
```

Open `http://localhost:8787`.

## How To Test

```bash
npm run test:push
npm run typecheck
npm run build
npm run test:e2e
```

Last full local verification passed with one Playwright worker/browser:

```bash
npm run test:push && npm run typecheck && npm run build && npm run test:e2e
```

Remote smoke checks passed:

- `GET https://chess-with-friends.thnkring.workers.dev/api/health`
- `GET https://chess-with-friends.thnkring.workers.dev/manifest.webmanifest`
- `GET https://chess-with-friends.thnkring.workers.dev/api/debug/push-log` returns `404` in production.

## Screenshot Evidence

Screenshots are stored under `tmp/reviews/screens/`.

- `01-alice-account.png` - passkey-created account and install/notification/friend controls.
- `02-bob-account.png` - second simulated client account.
- `03-handle-friend-request-sent.png` - friend request by handle.
- `04-friend-request-accepted.png` - accepted friend request.
- `05-presence-visible-in-app.png` - friend presence visible inside app.
- `06-challenge-game-started.png` - challenge accepted, live game started.
- `07-checkmate-terminal.png` - complete game to checkmate.
- `08-opponent-reconnecting.png` - mid-game disconnect indicator.
- `09-opponent-reconnected.png` - reconnect restored.
- `10-resign-terminal.png` - complete game to resignation.
- `11-timeout-terminal.png` - complete game to timeout.
- `12-schedule-accepted.png` - scheduled game accepted.
- `13-scheduled-push-fired.png` - scheduled game ready after notification fire.
- `14-invite-link-friend-accepted.png` - friend request via invite link accepted.
- `15-mobile-home-ready-schedule.png` - mobile dashboard and install/notification copy.
- `16-mobile-game-board.png` - mobile game board, clocks, and controls.

I visually inspected the screenshots, including the corrected mobile and terminal-state captures.

## Reviewer Loop

- `tmp/reviews/invariants-review.md` - approved.
- `tmp/reviews/correctness-review.md` - initially blocked on debug leakage and push payload queues; re-review approved after fixes.
- `tmp/reviews/ux-review.md` - initially blocked on mobile evidence, notification copy, resign confirmation, and labels; re-review approved after fixes.

## Known Gaps / Manual Verification

- Real iPhone install flow must be verified by hand: Share sheet -> Add to Home Screen -> launch installed PWA.
- Real iPhone/Android push delivery must be verified on device. Automation verifies API/service-worker-level payload routing and exact push policy.
- Web Push uses empty VAPID push events plus endpoint-scoped same-origin payload fetch by the service worker, not encrypted push bodies.
- `VAPID_PRIVATE_KEY` is set as a Wrangler secret for the deployed Worker; the private key is not committed.
- The working name remains `Chess with Friends`; final product name is still open before launch.
