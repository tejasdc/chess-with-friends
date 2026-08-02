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

## Current constraints
- Work lean due to machine memory pressure.
- Commit after every coherent small change.
- Run at most one headless browser instance during testing and close it promptly.

## Next
- Build/typecheck/test, deploy with Wrangler, then run independent reviewer agents.
- Write `tmp/reviews/build-report.md` with deployed URL, test commands, screenshot inventory, known gaps, and human verification items.
