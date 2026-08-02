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

## Current constraints
- Work lean due to machine memory pressure.
- Commit after every coherent small change.
- Run at most one headless browser instance during testing and close it promptly.

## Next
- Add lean Playwright two-client automation with screenshots under `tmp/reviews/screens/`.
- Build/typecheck/test, deploy with Wrangler, then run independent reviewer agents.
- Write `tmp/reviews/build-report.md` with deployed URL, test commands, screenshot inventory, known gaps, and human verification items.
