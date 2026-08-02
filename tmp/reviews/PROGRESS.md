# Progress

## Done
- Read `docs/requirements.md` and extracted the required v1 contract.
- Committed scaffold: Vite/React entry, Cloudflare Worker config, PWA manifest, service worker, dependencies.
- Committed backend: singleton `AppDO` for accounts, friends, invites, schedules, push queue/policy, and `GameDO` for live chess state, WebSocket presence, legal moves, clocks, resign/checkmate/timeout.
- `npm run typecheck` passed after the backend implementation.
- Added React client logic for passkey signup/login, invite links, friend requests, challenge accept/start, schedule proposal/accept, notification opt-in, game list, live board, WebSocket reconnect state, clocks, moves, and resign.
- `npm run typecheck` passed after the client logic file.
- Added responsive CSS for the PWA shell, forms, friend/challenge/schedule panels, board, clocks, move list, and connection states.
- `npm run typecheck && npm run build` passed after CSS.
- Added `scripts/generate-vapid.mjs` for Web Push VAPID key generation without committing private keys.
- Added `scripts/verify-push-policy.mjs`; `npm run test:push && npm run typecheck && npm run build` passed.
- Added lean Playwright config and e2e scenario using one Chromium browser instance with two contexts, virtual WebAuthn authenticators, API-level push checks, and screenshots under `tmp/reviews/screens/`.
- Hardened Web Push sending so bad/stale subscriptions cannot break friend/challenge/schedule flows.
- `npm run test:push && npm run typecheck` passed after adding the e2e harness.
- First `npm run test:e2e` failed immediately because Playwright had no `baseURL`; added `baseURL: http://127.0.0.1:8787`.
- Second `npm run test:e2e` reached passkey registration but failed because WebAuthn rejects `127.0.0.1` as an RP ID; switched Playwright to `http://localhost:8787`.
- Third `npm run test:e2e` showed friend request succeeded but the client cleared the success message during refresh; fixed `refresh()` to preserve status text. `npm run typecheck` passed.
- Fourth `npm run test:e2e` advanced through acceptance and failed on a strict locator ambiguity for a friend handle; narrowed the assertion to `.friend-card`. `npm run typecheck` passed.
- Fifth `npm run test:e2e` advanced through checkmate, reconnect, and resign, then failed because the timeout debug route saw the DO-internal `game.local` host; added a local-only debug header from the public Worker and buffered DO proxy request bodies. `npm run test:push && npm run typecheck` passed.
- Sixth `npm run test:e2e` showed Miniflare still presented `game.local` inside `GameDO`; moved the local-only debug guard fully to the public Worker boundary. `npm run test:push && npm run typecheck` passed.
- Seventh `npm run test:e2e` advanced to scheduling and failed on another strict handle locator; narrowed `scheduleSoon()` to `.friend-card`. `npm run typecheck` passed.
- Eighth `npm run test:e2e` proved scheduled pushes fired but Bob had older challenge pushes queued first; changed push assertions to drain until the expected allowed type. `npm run typecheck` passed.
- Ninth `npm run test:e2e` passed end-to-end with one Chromium browser process and screenshots written to `tmp/reviews/screens/`.
- Visual inspection found screenshot `14-invite-link-friend-accepted` still showed the pre-accept request row and `13-scheduled-push-fired` needed a refreshed page state; tightened both waits. `npm run typecheck` passed.
- Regenerated screenshots with `npm run test:e2e` passing; visually inspected the evidence, including corrected `13-scheduled-push-fired` and `14-invite-link-friend-accepted`.
- Generated Web Push VAPID keys, wrote the public key to `wrangler.jsonc`, and set `VAPID_PRIVATE_KEY` as a Wrangler secret for Worker `chess-with-friends`.
- Full local verification passed: `npm run test:push && npm run typecheck && npm run build && npm run test:e2e`.
- First deploy succeeded at `https://chess-with-friends.thnkring.workers.dev`, but remote smoke checks returned Cloudflare 1042 for API/assets. Updated Worker static-asset routing to SPA fallback with `run_worker_first` limited to `/api/*` and `/_auth/*`. `npm run test:push && npm run typecheck && npm run build` passed.
- Redeployed version `5d38ee36-3a14-449e-9c95-4fa326005faa` to `https://chess-with-friends.thnkring.workers.dev`; remote smoke checks passed for `/`, `/manifest.webmanifest`, and `/api/health` with exactly `friend_request`, `challenge`, `scheduled_start`.
- Correctness review blocked on production debug leakage and multi-device empty-push payload consumption. Fixed `/api/debug/push-log` to be allowed only at the public Worker boundary on localhost, and changed pending push payloads to queue per subscription endpoint with service-worker endpoint lookup. `npm run test:push && npm run typecheck` passed.
- Addressed UX/correctness polish: required resident/user-verified passkeys, exact notification-policy copy before permission, visible labels, two-step resign, friendlier schedule status text, stable ticking clocks, focus styles, and mobile screenshot coverage in e2e. `npm run test:push && npm run typecheck` passed.
- Full verification after review fixes failed in e2e because fake push endpoints were stored on `window` and lost across reload; moved the test endpoint to `localStorage`. `npm run typecheck` passed.
- Full verification passed after review fixes. Visual inspection of new screenshots confirmed mobile home/board coverage and notification copy; found stale confirm controls after resign terminal and cleared confirm state after resign. `npm run typecheck` passed.

## Current constraints
- Work lean due to machine memory pressure.
- Commit after every coherent small change.
- Run at most one headless browser instance during testing and close it promptly.

## Next
- Build/typecheck/test, deploy with Wrangler, then run independent reviewer agents.
- Write `tmp/reviews/build-report.md` with deployed URL, test commands, screenshot inventory, known gaps, and human verification items.
