# UX Review

## Verdict

Block

The interface is calm, friends-only, and does not introduce ratings, feeds, streaks, matchmaking, or other infinite-engagement affordances. The desktop experience is visually coherent and the chess board is readable. Blockers remain for v1 UX fitness because the screenshot evidence is desktop-only, the notification/install copy does not fully earn the permission request before asking, and the in-game resign action is an immediate terminal action with no confirmation.

## Findings

1. `tmp/reviews/screens/*.png` - All available screenshots are desktop-width captures, mostly `1280px` wide. The requirements call out two real people on two phones/browsers and an installable PWA with iPhone install guidance. Current evidence does not prove mobile home layout, mobile board playability, safe-area behavior, or the iPhone-oriented install/notification flow.

2. `src/main.tsx:257`, `src/main.tsx:262`, `tmp/reviews/screens/01-alice-account.png` - The install panel asks for notification permission with only "On iPhone, open Share and choose Add to Home Screen before enabling notifications." The exact three notification types are only shown after successful subscription at `src/main.tsx:250`, so the user has not seen the full notification policy before the permission action. For this product thesis, the pre-permission copy should explicitly say notifications are only for friend requests, challenges, and scheduled games.

3. `src/main.tsx:537`, `tmp/reviews/screens/06-challenge-game-started.png` - `Resign` is a one-click destructive terminal action. On mobile this is easy to hit accidentally, and the app has no confirmation, undo window, or second step. This is a serious game UX risk even though the button is visually distinct.

4. `src/main.tsx:319`, `src/main.tsx:320`, `tmp/reviews/screens/01-alice-account.png` - The add-friend handle field relies on placeholder text only and has no visible label. That weakens form ergonomics and accessibility, especially once the field contains text or a validation error.

5. `src/main.tsx:375`, `src/main.tsx:376`, `src/main.tsx:420`, `src/main.tsx:421`, `tmp/reviews/screens/04-friend-request-accepted.png` - Friend and time-control selects in Challenge/Schedule have `aria-label`s but no visible labels. The first select value can say `Friend`, while the second says `10|0` without context. This is usable for a tester, but underspecified for a new player.

6. `src/main.tsx:424`, `tmp/reviews/screens/12-schedule-accepted.png` - Scheduling uses a relative `Minutes` field instead of a concrete proposed game time. That is acceptable for automation, but weak for the "time and place" product mechanism: two friends should see the actual scheduled time before sending/accepting, not infer it from minutes-from-now.

7. `src/main.tsx:434`, `tmp/reviews/screens/12-schedule-accepted.png`, `tmp/reviews/screens/13-scheduled-push-fired.png` - Scheduled game rows show seconds and terse states like `accepted` / `fired`. The proof is technically visible, but the user-facing language feels implementation-shaped. `fired` in particular should not appear in the product UI.

8. `src/styles.css:281`, `src/main.tsx:517`, `src/main.tsx:522`, `tmp/reviews/screens/11-timeout-terminal.png` - Clock digits are readable, but the CSS does not set `font-variant-numeric: tabular-nums`; clock width can shift as seconds change. For rapid chess, stable clocks matter.

9. `src/styles.css:286`, `src/styles.css:369`, `tmp/reviews/screens/06-challenge-game-started.png` - Board clarity is good on desktop, but no screenshot proves the mobile board plus clocks plus side controls fit without excessive vertical scrolling. The CSS likely stacks correctly at `max-width: 760px`, but this remains unverified evidence-wise.

10. `src/main.tsx:150`, `src/styles.css:91` - No skip link or explicit focus styling is defined. Browser defaults may appear, but this should be made intentional for a keyboard-usable PWA.

## Screenshot Evidence Reviewed

- `tmp/reviews/screens/01-alice-account.png` - Alice signed in, install/friends/challenge/schedule/games dashboard.
- `tmp/reviews/screens/02-bob-account.png` - Bob signed in, same dashboard.
- `tmp/reviews/screens/03-handle-friend-request-sent.png` - Sent friend request state.
- `tmp/reviews/screens/04-friend-request-accepted.png` - Accepted friend visible, challenge flow enabled.
- `tmp/reviews/screens/05-presence-visible-in-app.png` - Presence visible in app only.
- `tmp/reviews/screens/06-challenge-game-started.png` - Active game with board, clocks, opponent connected.
- `tmp/reviews/screens/07-checkmate-terminal.png` - Checkmate terminal state.
- `tmp/reviews/screens/08-opponent-reconnecting.png` - Opponent reconnecting indicator.
- `tmp/reviews/screens/09-opponent-reconnected.png` - Opponent connected indicator restored.
- `tmp/reviews/screens/10-resign-terminal.png` - Resign terminal state.
- `tmp/reviews/screens/11-timeout-terminal.png` - Timeout terminal state.
- `tmp/reviews/screens/12-schedule-accepted.png` - Accepted scheduled game row and prior games.
- `tmp/reviews/screens/13-scheduled-push-fired.png` - Scheduled game fired state and open action.
- `tmp/reviews/screens/14-invite-link-friend-accepted.png` - Invite-link friendship acceptance.

## Residual Risks

- Real iPhone add-to-home-screen and push permission UX is not evidenced by screenshots.
- Real notification delivery on iOS/Android still needs human device verification.
- The review did not rerun the app or create new mobile screenshots, per the no-code-change review request.
- Accessibility was reviewed from source and screenshots, not with a screen reader.

## Re-review Addendum

### Verdict

Approve

The previous UX blockers are resolved for this focused pass. The product remains calm and friends-only, the notification copy now discloses the exact three allowed push categories before permission, the mobile screenshots are visually usable, resign is implemented as a two-step action, labels and focus states are improved, schedule status no longer exposes `fired`, and clocks now use tabular numerals. No regressions were found in the touched areas.

### Evidence

- `src/main.tsx:257-266`, `tmp/reviews/screens/01-alice-account.png`, `tmp/reviews/screens/15-mobile-home-ready-schedule.png` - Pre-permission install copy says notifications are only for friend requests, game challenges, and scheduled games starting. This matches the requirements invariant and appears before the `Enable notifications` button on desktop and mobile.
- `src/main.tsx:561-574` - Resign is now two-step: first tap sets `confirmResign`, then the terminal request is only sent from `Confirm resign`; `Cancel` backs out.
- `src/main.tsx:320-324`, `src/main.tsx:379-386`, `src/main.tsx:430-440`, `tmp/reviews/screens/01-alice-account.png`, `tmp/reviews/screens/15-mobile-home-ready-schedule.png` - Friend handle, challenge friend/time control, and schedule friend/time/start fields now have visible labels.
- `src/main.tsx:643-646`, `tmp/reviews/screens/13-scheduled-push-fired.png`, `tmp/reviews/screens/15-mobile-home-ready-schedule.png` - Scheduled game `fired` status is rendered as `ready`; the implementation-shaped word is no longer visible.
- `src/styles.css:57-62` - Buttons, inputs, and selects now have intentional `:focus-visible` outlines.
- `src/styles.css:288-292` - Clock numerals use `font-variant-numeric: tabular-nums`.
- `tmp/reviews/screens/15-mobile-home-ready-schedule.png` - Mobile dashboard is readable at `390px` wide. Sections stack cleanly; install text, friend controls, challenge, schedule, ready scheduled game, and game history are visible without overlap.
- `tmp/reviews/screens/16-mobile-game-board.png` - Mobile game board is readable at `390px` wide. Board, pieces, clocks, opponent state, and resign action fit the viewport width without horizontal overflow.
- `npm run typecheck` - Passes, covering the touched TypeScript areas including the live clock data shape.

### Remaining Findings

- `tmp/reviews/screens/16-mobile-game-board.png`, `src/main.tsx:561-574` - Non-blocking evidence gap: the screenshot set shows the initial `Resign` button and terminal resigned state, but does not include the intermediate `Confirm resign` / `Cancel` UI. Source verifies the two-step behavior.

### Residual Risks

- Real iPhone add-to-home-screen and push delivery still require hand verification on device.
- This re-review did not rerun the end-to-end browser suite; it inspected source, current screenshots, and typecheck output only.
