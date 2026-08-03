# Correctness Redesign Review

Verdict: PASS

No blocking regressions found against `docs/requirements.md`.

The notification prompt bug is fixed at the root cause: `InstallPanel` now computes push UI state from browser permission plus the actual push subscription, and hides only when both permission is granted and a subscription exists. The focused e2e proves the `Enable notifications` control disappears after enabling and stays hidden after reload; screenshots `00-notifications-enabled-prompt-gone.png` and `00-notifications-enabled-after-reload.png` confirm the visual state.

The push policy invariant remains exact: `friend_request`, `challenge`, `scheduled_start`. Source enforcement remains in Worker and service worker allow-lists, and `npm run test:push` passed with exactly those three types.

The redesign did not alter game-rule code. Legal moves and terminal state detection still run through `chess.js` in `GameDO`; the redesign changed React/CSS/test evidence only. The latest e2e and screenshots cover auth, friend request by handle, invite-link friend request, challenge accept, schedule accept/start, clocks, reconnect indicator, checkmate, resign, timeout, desktop layout, and mobile layout.

Residual gaps: real installed-device Web Push still needs manual device verification, and timeout automation uses a local debug expire route rather than waiting for a natural full clock alarm.

Required fixes: none.
