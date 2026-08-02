# Progress

## Done
- Read `docs/requirements.md` and extracted the required v1 contract.
- Committed scaffold: Vite/React entry, Cloudflare Worker config, PWA manifest, service worker, dependencies.
- Committed backend: singleton `AppDO` for accounts, friends, invites, schedules, push queue/policy, and `GameDO` for live chess state, WebSocket presence, legal moves, clocks, resign/checkmate/timeout.
- `npm run typecheck` passed after the backend implementation.
- Added React client logic for passkey signup/login, invite links, friend requests, challenge accept/start, schedule proposal/accept, notification opt-in, game list, live board, WebSocket reconnect state, clocks, moves, and resign.
- `npm run typecheck` passed after the client logic file.

## Current constraints
- Work lean due to machine memory pressure.
- Commit after every coherent small change.
- Run at most one headless browser instance during testing and close it promptly.

## Next
- Add focused CSS and commit it.
- Add push VAPID setup helper/policy verifier and commit it.
- Add lean Playwright two-client automation with screenshots under `tmp/reviews/screens/`.
- Build/typecheck/test, deploy with Wrangler, then run independent reviewer agents.
- Write `tmp/reviews/build-report.md` with deployed URL, test commands, screenshot inventory, known gaps, and human verification items.
