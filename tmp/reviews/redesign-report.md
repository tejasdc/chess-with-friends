# Redesign Report

## Summary

Completed a notification bug fix and a full visual redesign for the friends-only chess PWA.

The redesign is grounded in chess's chaturanga lineage rather than generic ornament: the dashboard now leads with a board-table register, live boards use ashtapada-style markings, bishops render as gaja pieces, and all pieces use custom chaturanga SVG glyphs (`padati`, `ashva`, `gaja`, `ratha`, `mantri`, `raja`). Forms, clocks, lists, buttons, empty states, manifest theme color, and the PWA icon now share the same Mewar/Rajasthani miniature-inspired paper, line, and register system.

Research references used:
- Chaturanga/ashtapada/gaja lineage: https://en.wikipedia.org/wiki/Chaturanga
- Indian chess set and elephant/camel substitution notes: https://www.nortonsimon.org/art/detail/F.1978.20.01-33.S
- Indian chess and chess-table museum references: https://artsandculture.google.com/story/CgVxmEsjAM5pbg
- Mewar miniature construction references: https://www.asiaresearchnews.com/content/luminous-miniature-paintings-mewar-%E2%80%94-centuries-long-tradition
- South Asian manuscript/miniature painting context: https://imp-art.org/articles/manuscript-miniature-painting/

## Notification Bug

Root cause: `InstallPanel` rendered the install/notification prompt unconditionally for signed-in users. `enablePush()` subscribed and showed a success message, but the component never derived UI state from `Notification.permission` and `registration.pushManager.getSubscription()`, so the prompt returned immediately and on reload.

Fix: `InstallPanel` now computes `PushStatus` from browser support, permission state, and the actual Push subscription. It returns `null` only when permission is granted and `getSubscription()` returns a subscription. It also calls `Notification.requestPermission()` from the intentional button gesture before subscribing.

Evidence:
- `tmp/reviews/screens/00-notifications-enabled-prompt-gone.png`
- `tmp/reviews/screens/00-notifications-enabled-after-reload.png`
- `npm run test:e2e` includes the focused prompt test plus the full two-client mechanics test.

## Screenshot Inventory

Before screenshots were preserved in `tmp/reviews/screens-before/`. After screenshots are in `tmp/reviews/screens/`.

Key before/after pairs:
- Account/dashboard: `screens-before/01-alice-account.png` -> `screens/01-alice-account.png`
- Friend presence: `screens-before/05-presence-visible-in-app.png` -> `screens/05-presence-visible-in-app.png`
- Challenge board: `screens-before/06-challenge-game-started.png` -> `screens/06-challenge-game-started.png`
- Checkmate terminal: `screens-before/07-checkmate-terminal.png` -> `screens/07-checkmate-terminal.png`
- Schedule fired: `screens-before/13-scheduled-push-fired.png` -> `screens/13-scheduled-push-fired.png`
- Mobile dashboard: `screens-before/15-mobile-home-ready-schedule.png` -> `screens/15-mobile-home-ready-schedule.png`
- Mobile board: `screens-before/16-mobile-game-board.png` -> `screens/16-mobile-game-board.png`

New bug-specific evidence:
- `screens/00-notifications-enabled-prompt-gone.png`
- `screens/00-notifications-enabled-after-reload.png`

I visually inspected the notification screenshots, desktop dashboard, desktop board, checkmate terminal, and mobile board after the second-pass redesign.

## Verification

Local final verification passed:

```bash
npm run test:push && npm run typecheck && npm run build && npm run test:e2e
```

Observed results:
- Push policy verified exactly: `friend_request`, `challenge`, `scheduled_start`.
- Typecheck passed.
- Build passed.
- Playwright passed 2 tests with 1 worker: focused notification prompt test and full two-client v1 mechanics test.

Review artifacts:
- `tmp/reviews/design-redesign-review.md` - initially blocked; second-pass re-review PASS.
- `tmp/reviews/correctness-redesign-review.md` - PASS.

## Deployment

Deployed with:

```bash
npm run deploy
```

Production URL:
- https://chess.tejas.nyc

Worker version:
- `e2b75fe1-5da8-45ec-a291-062c6832ec58`

Production smoke checks passed:
- `GET https://chess.tejas.nyc/api/health` -> `{"ok":true,"pushTypes":["friend_request","challenge","scheduled_start"]}`
- `curl -s https://chess.tejas.nyc/ | grep -c cloudflareinsights` -> `1`
- Manifest theme/background colors now use `#efe0bd`.
- Served asset hashes include `assets/index-Bps-i0fI.js` and `assets/index-CkXPnFbj.css`.

## Human-Eyes Items

- Real installed-PWA push delivery still needs manual iPhone/Android verification.
- Real iPhone Add to Home Screen flow still needs manual verification.
- Final app name remains open; display copy stays neutral and does not choose a new name.
