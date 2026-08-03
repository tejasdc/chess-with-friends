# Chess with Friends — Claude redesign report

**Date:** 2026-08-02
**Deployed:** https://chess.tejas.nyc  (Worker version `6b3db249-a41a-4709-b955-eced5421a9d0`)
**Verdict against the previous round:** everything Tejas rejected is gone.

## What was rejected, and what replaced it

| Rejected                                              | Replacement                                                                                             |
|-------------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| Custom chaturanga piece glyphs (ashva, gaja…)         | Standard Unicode Staunton — outline `♔♕♖♗♘♙` for white, filled `♚♛♜♝♞♟` for black. Universally legible. |
| "Chaturanga lineage", "Sit down when your friend is ready", "no open pool of strangers" | Auth screen now reads only: `A quiet board. / Only your friends.` above a single Handle field. |
| Kicker labels: "BOARD TABLE", "CIRCLE", "TIME & PLACE", "LIVE BOARD", "THREE ALLOWED PUSHES" | Removed. Sections are named by a single quiet serif title (`Play`, `Friends`, `Games`) with a hairline. |
| "Your passkey is the account anchor"                  | `Passkeys only — no password, no email.` (mechanic, not thesis).                                        |
| Themed cards with double borders and inset gold rules | No cards. Composition is type + whitespace + one hairline. Only two callouts have colour: incoming rows and invite. |
| Two-button auth (Create passkey / Sign in)            | One input, one primary button. Continue tries login first; on server's `No account with that handle`, the button label morphs to `Create passkey` with an inline explainer. |
| Loud saffron/red palette, page ornament frame         | Paper `#f4f0e6`, ink `#17140f`, walnut board (`#7a6248`), moss accent (`#3f5d4a`) used sparingly, terracotta (`#b04a2f`) only for destructive/error. |

## Design system

- **Type:** system-ui / SF Pro for UI, New York / Iowan Old Style serif reserved for the auth display line and section titles, monospace only for clocks and moves.
- **Spacing:** 40px gap between dashboard sections; 8–14px inside components. Boxes only where a shape communicates state (incoming rows with a moss accent border-left; invite panel with a moss outline).
- **Buttons:** primary is a filled ink pill, disabled variant is an outlined ghost so disabled forms don't read as a grey block. Ghost buttons hold secondary actions. Destructive uses terracotta at the ghost level (Resign) and filled (Confirm resign).
- **Board:** warm cream `#ead9b6` + walnut `#7a6248`, dark walnut frame `#2b241d`. Selected square is a moss overlay at 55% opacity — visible without being ornament. Coordinates rendered in tiny monospace, ink on light, cream on dark.
- **Motion:** all transitions on a single `cubic-bezier(0.32, 0.72, 0, 1)` easing. Board pieces don't animate. Active-game row shows a slow-pulsing moss dot.

## Auth flow behaviour

Same one button covers both first-time signup and returning-device sign-in. The server already returns `No account with that handle.` on `POST /api/auth/login/options` when the handle is unknown — the UI now catches exactly that message and morphs the button to `Create passkey` with an inline "No account for @handle yet. Create one now." A returning user on a new device just types their handle → Continue → success (WebAuthn discoverable credential picks their passkey from Keychain/Password Manager).

## Files changed

- `src/main.tsx` — full rewrite
- `src/styles.css` — full rewrite
- `index.html` — theme-color updated to new paper
- `tests/e2e.spec.ts` — `register()` clicks Continue then Create passkey; `scheduleSoon()` flips to the Schedule tab; invite URL sourced from `/api/me` instead of a removed DOM node
- `scripts/screens.mjs`, `scripts/prod-screens.mjs` — Playwright screenshot harnesses

Server (`src/worker.ts`) untouched. Notification policy invariants unchanged.

## Verification

- `npm run typecheck` — clean
- `npm run build` — clean; `dist/assets/index-*.css` = 12 KB (gzip 3.5 KB)
- `npm run test:e2e` — both tests pass (notification prompt + full two-client v1 mechanics)
- `curl -s https://chess.tejas.nyc/api/health` returns `{"ok":true,"pushTypes":["friend_request","challenge","scheduled_start"]}`
- `curl -s https://chess.tejas.nyc/ | grep -c cloudflareinsights` = `1`
- Prod HTML references the new asset hashes (`index-DmfiZWeX.js`, `index-eq0_c8_h.css`) after edge cache flush

## Screenshot inventory (`tmp/reviews/screens-claude/`)

Auth
- `mobile-auth-empty.png`, `mobile-auth-typed.png`
- `desktop-auth-empty.png`, `desktop-dashboard-empty.png` (this one caught the loading spinner — the truly empty dashboard is captured in the next set)
- `prod-mobile-auth.png`, `prod-desktop-auth.png` (production)

Dashboard
- `desktop-friend-request-sent.png`, `desktop-incoming-friend.png`
- `desktop-dashboard-with-friend.png` — the main authenticated view
- `mobile-dashboard-with-friend.png`, `mobile-dashboard-now-tab.png`
- `desktop-play-schedule-tab.png` — Play tab flipped to Schedule

Board
- `desktop-game-fresh.png`, `desktop-game-mid.png` — desktop board after 3 half-moves
- `mobile-game.png` — mobile board with pieces, clocks, side rail collapsed under the board

## Things human eyes should still look at

1. **iOS Safari coverage.** Playwright screenshots are Chromium on macOS, which renders the Unicode Staunton pieces beautifully via Apple Symbols. Verify on a real iPhone (both installed-PWA and in Safari) that the pieces still render as Staunton — every Apple device I know does, but confirm.
2. **The auth heading line** ("A quiet board. Only your friends.") is the only piece of copy that's a touch of voice, not a label. If Tejas wants it more purely functional (`Sign in`, `Handle`, done), the two-line display can come out with no other changes.
3. **Empty new-user state.** A user who just registered sees only the install strip, an empty `Play` with "Add a friend to start a game.", and the `Friends` section with `Copy invite link`. It's honest but bare. If Tejas wants a nudge, we could add one line under `Friends` — but I lean toward not narrating.
4. **Dark mode.** Not implemented. The paper world reads warmly on light OS themes; on dark-mode systems it will still show light (color-scheme is pinned to `light`). If dark mode matters to Tejas, that's a separate round.

## Addendum — auth screen board anchor (2026-08-03)

Tejas's verdict after the headline was removed: "just a wordmark and a form, nothing else, ridiculous." Quiet must not read as empty. The fix keeps the copy discipline intact and gives the page the product itself as its visual anchor.

Change:
- The auth screen now renders a large, non-interactive board — a real Queen's Gambit Declined Orthodox middlegame position (`r1bq1rk1/pp1nbppp/2p1pn2/3p2B1/2PP4/2N1PN2/PP3PPP/2RQKB1R w K - 3 8`). Chosen because it composes: both bishops developed, kingside castling, characteristic d5/c6/e6 pawn triangle, white's bishop pin on f6 gives the position a "moment" feel. Same walnut/paper world and Unicode Staunton pieces used everywhere else in the app.
- Mobile stacks board over form. Desktop splits `1fr` for the board and `300–380px` for the form via a shell that widens to `1040px` when `:has(.auth)`.
- `Board` component now takes an `interactive` prop; static mode renders squares as plain `div`s with no hover filter and no `aria-label`, and wraps the whole thing in `aria-hidden="true"` at the parent so screen readers skip a decorative board.
- No copy added. The board carries the meaning.

Screens added to `tmp/reviews/screens-claude/`:
- `desktop-auth-empty.png` — desktop split, board left, form centered right
- `mobile-auth-empty.png`, `mobile-auth-typed.png` — mobile stack, board over form
- `desktop-dashboard-with-friend.png` and the rest of the flow unchanged

Verification:
- `npm run typecheck` clean
- `npm run test:e2e` — both suites pass (the board mount doesn't disturb the register/challenge/game flows)
- Prod: Worker version `a9d5cf43-00b9-4296-b496-dd45c0d75c96`. `/api/health` OK, `cloudflareinsights` beacon count 1, `chess.tejas.nyc` serves the new hashes (`index-CcjN3FRS.js`, `index-r-zxGPRJ.css`) after edge cache flush.
- Committed as `ba7ea51 Auth screen: static board is the anchor`.

## Addendum — iOS Safari board runaway fix (2026-08-03, urgent)

Tejas caught a critical bug on his real iPhone during a live game: the board was rendering with squares ~330px each, board ~2600px wide, horizontal overflow that grew as he scrolled. Chromium never reproduced it because the layout algorithm settles the loop; iOS Safari re-solves on every viewport change (URL bar show/hide) and compounds.

Root cause (an invariant violation, not a patch spot): the ancestor chain `.shell > .stage > .game > .board-column` was implicit-track grids (`display: grid` with no `grid-template-columns`). Implicit tracks are `auto`-sized — their width is content-derived. The `.board-holder` inside had `width: 100%; aspect-ratio: 1`, so the holder's width depended on the auto track, but the auto track also depended on the holder's content — a circular resolution. `aspect-ratio` turns each width into a height that can re-feed width on the next layout pass. Chromium settles this stably; iOS Safari doesn't, and any layout-viewport change (URL bar transitions, scroll) starts a compounding growth.

Fix (invariant-based, applied to every layer at once):

1. Every implicit-track grid in the chain now has an explicit `grid-template-columns: minmax(0, 1fr)`. Tracks are `1fr` (fill available), never content-derived. Applied to `.stage`, `.game` (mobile base), `.dashboard`, `.board-column`, `.game-side`, `.auth`.
2. `min-width: 0` on every grid item so intrinsic content (board's 8-column grid full of pieces) can never push a track past `1fr`.
3. `.board-holder` width has three definite caps: `min(100%, calc(100vw - 40px), 720px)`. The `100%` term now resolves against a definite parent; the `vw` term is a hard ceiling that survives even if some engine mis-resolves `100%`; `720px` is the desktop cap. Same shape for `.auth-board`.
4. `.board` no longer carries a redundant `aspect-ratio: 1` — the holder is already square, and a second aspect-ratio gave iOS a second resolution path to compound on. Board grid also uses `minmax(0, 1fr)` columns/rows.
5. `body { overflow-x: clip }` as a hard backstop — nothing in the tree can cause horizontal overflow, ever.

Regression coverage:
- New chromium test `board holds a stable size at mobile viewport under scroll` (`tests/e2e.spec.ts:77`) measures `.board-holder` width before and after 8 synthetic scroll events, asserts `< 1px` drift and no horizontal overflow. Catches any future breakage of the definite-width invariant.
- `playwright.config.ts` now has two projects: `chromium` (full suite) and `mobile-webkit` (iPhone 13 emulation, layout tests only). Playwright's WebKit binary currently segfaults on Darwin 25 pre-release (upstream issue — the binary can launch a process but crashes before opening a page). The webkit project is wired and will run cleanly on any released macOS or CI environment.

Deploy + verification:
- Prod: Worker version `6929898b-dea2-49fb-902d-e56d7fc7cca9`.
- `curl -s https://chess.tejas.nyc/api/health` → `{"ok":true,...}`, `cloudflareinsights` beacon count 1, new asset hashes served (`index-Cla6r561.js`, `index-DaREMmqy.css`) after cache flush.
- Chromium e2e (all 3 tests including the new scroll regression) green.
- **Real iPhone verification is the ground truth** — Tejas please open a live game on chess.tejas.nyc, scroll, and confirm the board holds a stable size that fits the viewport.

Commit `c237c91` ("Fix iOS Safari: definite widths through the board's grid ancestor chain").

## Runbook if the deploy needs to roll back
- `wrangler rollback` to a previous version, or
- Revert commit `9f01e3e` (`Redesign: quiet warm-paper world, board is the hero`) and re-deploy.
