# Ledger Verification — landing-production-build SHIPPED
Generated 2026-08-03 by chess-design-2. Updated 2026-08-03 by Codex landing build. Final shipping-time evidence appended 2026-08-03 by chess-design-2.

Landing build committed as `335dd16`, deployed as prod version `14fca60b`, serving both twochairs.club and chess.tejas.nyc.

## Shipping-time prod evidence

**Assets propagated:** `dist/assets/index-D1rkzMf8.js` + `dist/assets/index-4QnGXtvU.css` verified serving from worker.dev origin AND twochairs.club (post-cache-propagation via `until` monitor).

**Prod browser probe at 390×844 and 1440×900** (cache-bypassed):
- wordmark = "two chairs" ✓
- no ⋯ menu on landing ✓
- caption "BLACK TO MOVE · Traditional; earliest published 1836" visible in DOM ✓
- copy "No infinite pool of opponents. A game happens when two friends sit down." present in body innerText at both viewports ✓
- footer "made by tejas.nyc · inspirations" present with both links ✓
- no-scroll: `document.documentElement.scrollHeight === window.innerHeight` at 390 (844=844) and 1440 (900=900) ✓

**Icon endpoints:** `/icon.svg`, `/apple-touch-icon.png`, `/icon-60.png`, `/icon-512.png` all HTTP 200 on worker.dev origin.

**Beacon:** origin-aware picker's runtime bootstrap present; both token strings in served HTML as expected (worker serves single bundle to both hostnames).

**Health:** `/api/health` returns `{"ok":true,"pushTypes":["friend_request","challenge","challenge_accepted","scheduled_start"]}`.

**Full adversity suite:** 11/11 green including new regression `landing puzzle solve walks to a new caption and position without chrome regressions`.

**Non-Playwright gates:** typecheck (0), push-policy (0), verify-positions (0 — 11 mate-in-1s confirmed), build (0).

---

## Pre-build audit context

Prior prod version before this ship: `6d5888ad` (commit `25f3cae`). Serving twochairs.club and chess.tejas.nyc.

Each item marked:
- **VERIFIED** — with an evidence pointer (test name / screenshot path / prod probe / commit).
- **PENDING (landing build)** — will land with the landing-production-build deploy; not yet applicable to current prod.
- **N/A** — with reason.

## World / design tokens

- [x] **Palette is mockup tokens exactly.** VERIFIED. `src/styles.css:56-68` defines `--ground #7CA898`, `--paper #E8DBBE`, `--walnut #5F8A7A`, `--ink #2E2A3D`, `--cream #EEE3C4`, `--teak #8C5A2E`. No yellow-khaki `#E9DFA0` anywhere (`grep`). Legacy `#3E2F1E` removed in commit `7c3b720`. Dashboard screenshot `tmp/reviews/screens-r2/dash-round-390.png`, game screenshots `tmp/reviews/screens-r2/ok-{390,1280,1440}.png`.
- [x] **Teak frame at all sizes, never hairline.** VERIFIED. `src/styles.css` `.board { box-shadow: 0 0 0 5px var(--teak) }` desktop; `@media (max-width: 480px) { .board { box-shadow: 0 0 0 3px var(--teak) } }` mobile. Was 1px hairline pre-`7c3b720`. Visible in `ok-390.png`.
- [x] **IBM Plex Mono voice; no serif; no thesis-narrating copy.** VERIFIED. `@font` imports Plex Mono + Plex Sans only. `grep -rn "thesis" src/` returns nothing. Copy across dashboard/game/inspirations reviewed — no meta-narrative lines about the app itself.
- [x] **No scrolling anywhere unnecessary.** VERIFIED for landing + game via `body[data-screen]` cap + adversity regression `game screen never scrolls at 390x844, 1280x700, or 1440x900`. Inspirations intentionally allows scroll (content wins, per team-lead directive). Dashboard scrolls only when content demands (natural flow). Landing probe: `document.scrollHeight === innerHeight` at 390.
- [x] **Fixes apply to the PATTERN everywhere.** VERIFIED via `.made-by` global pin (commit `25f3cae`). Standing rule internalized. One live regression corrected (dashboard was scoped-out); no known pattern-scope leaks remaining.
- [x] **"made by tejas.nyc" on landing + dashboard + inspirations only, pinned to bottom.** VERIFIED. Prod probe: dashboard `made-by` bottom=748, top=707.5, viewport=844 (pinned to safe-area bottom). Landing carries `LandingFooter` with paired `· inspirations` link. Game screen has NO `.made-by` component. Screenshots: `prod-dash-madeby-FIXED.png`, `land_.png`, `land_inspirations.png`.
- [x] **No ⋯ menu on landing; ⋯ top-right on dashboard + game.** VERIFIED. `Shell` accepts `hideMenu` prop; `AuthScreen` passes it (commit `595d519`). Landing screenshot shows no menu-dot. Dashboard/game screenshots show `···` top-right.
- [x] **Name is "two chairs" everywhere.** VERIFIED across surfaces: wordmark (`Shell` topbar), `<title>` (`index.html`), manifest `name`/`short_name` (both "two chairs"), APP_NAME (`wrangler.jsonc` → runtime `env.APP_NAME="two chairs"` → passkey `rpName`). Prod probe on all three origins returns `"rp":{"name":"two chairs",...}`.
- [x] **Icon: Rodchenko elevation TRACE in app tokens, bent-tube arc CONNECTED, verified at zoom.** VERIFIED. Final icon-smith assets from `tmp/reviews/icons/final/{icon.svg,icon-60.png,apple-touch-icon.png,icon-512.png}` are wired into `public/` as `public/icon.svg`, `public/icon-60.png`, `public/apple-touch-icon.png`, `public/icon-512.png`. `public/manifest.webmanifest` includes SVG, 60×60, 180×180, and 512×512 entries and uses approved celadon `#7CA898` for background/theme. Source zoom evidence remains `tmp/reviews/icons/final/final-zoom-evidence.png`; file dimensions confirmed by `file public/icon.svg public/icon-60.png public/apple-touch-icon.png public/icon-512.png`.

## Board & game screen

- [x] **Board dominant; game screen never scrolls at all three sizes.** VERIFIED. Adversity test `game screen never scrolls at 390x844, 1280x700, or 1440x900` green. Board sizes at prod: 370px @ 390×844, 398px @ 1280×700, 598px @ 1440×900 (commit `1d3ef5a`). Screenshots `tmp/reviews/screens-r2/ok-*.png`.
- [x] **Thick cream border = SELECTION ONLY, scales with square size.** VERIFIED. `src/styles.css`: `.square.selected::after { inset:4px; border:3px solid var(--cream) }` with `@container (max-width: 420px)` → 2px+2px, `@container (max-width: 340px)` → 1.5px+1.5px. Screenshot `exp-selected-e2.png` (mobile selected pawn — border doesn't overlap glyph).
- [x] **Last-move = flat tint wash, no border.** VERIFIED. `.square.last-from.light` / `.dark` set `background: color-mix(in oklab, ...)` — no `border` or `::after` for last-move. Only selection carries a border. Screenshot `exp-lastmove-e2e4.png`.
- [x] **Legal-move dots + off-turn silent + illegal silent + no toasts.** VERIFIED. Client-side gates in `GameScreen.choose()` (commit `1b6ca2c`). Adversity regressions green: `off-turn tap on own piece is silent — no toast, no selection, no request`; `illegal-destination tap deselects silently — no toast, no request`.
- [x] **Captured pieces big + bold; space reserved.** VERIFIED. `.captured-strip { min-height: 26px; ... }` in game-fixed context. Renders reserved even when empty.
- [x] **Presence = filled dots both states, legible at arm's length.** VERIFIED. `--presence-online: cream`, `--presence-offline: #8f8877` (both filled with ink outline). 12px vs prior 9px. Prod dashboard shows offline `@handle Offline`-pill row with visible dot.
- [x] **Opponent connection state = in-game indicator, not push.** VERIFIED. Push policy list (`friend_request, challenge, challenge_accepted, scheduled_start`) contains no `connection`/`presence` type. `GameScreen` renders opponent `presence` in the top clock strip.
- [x] **Promotion picker; check indication; coords outside squares.** VERIFIED. `PromotionPicker` component rendered when `pendingPromotion` set; check glow via `.square.in-check` class; coord spans (`.coord-rank`/`.coord-file`) positioned via `top/bottom/left/right`.
- [x] **Clocks server-authoritative; resilient realtime.** VERIFIED. Adversity test `socket death mid-game recovers silently, no lost opponent moves` green. `useRealtimeGame` implements reconnect+backoff, visibilitychange resync, heartbeat, half-open detection.
- [x] **10 minutes IS the game — no time-control UI.** VERIFIED. `TimeSelect` component deleted (commit `a3145d1`). `formatTimeControl` renders "10 min"; challenge/schedule send sites hardcode `"10|0"`. `grep` for the union values shows internal-only usage.

## Dashboard

- [x] **Live/in-play games at TOP; past games separate collapsed section.** VERIFIED. `LiveGamesSection` in `Dashboard` above `PlaySection`+`FriendsSection`; `PastGamesSection` collapsed at bottom with count chip.
- [x] **Friends list is action surface.** VERIFIED. Per-row `Invite` button (enabled online, disabled+labeled "Offline" otherwise); online sorted first; "More friends (N)" disclosure after 8. Screenshot `dashboard-dots-390.png` shows a disabled Offline row.
- [x] **ONE Schedule-a-game button at bottom of friends.** VERIFIED. `PlaySection` moved from top-level to `FriendsSection` bottom (commit `0122c0e`). Single collapsed button, opens day+time form.
- [x] **Schedule = day+time; recurring once/weekly/daily; End series.** VERIFIED. Adversity test `recurring schedule creates a game on each firing and can be ended by either party` green. Server: `Schedule.recurrence`, `nextFireAt`, `cancelled` status; `POST /api/schedules/:id/cancel`. Client: Repeat selector + End-series action.
- [x] **Copy-invite-link in ⋯ menu only.** VERIFIED. `dashboardMenuExtras()` returns the Copy-invite item; no button on dashboard body.
- [x] **Incoming challenge = prominent band with Accept.** VERIFIED. `IncomingPanel` renders each request/challenge/schedule with `Accept` button at top of dashboard when present.
- [x] **Human copy; no "10|0" user-facing.** VERIFIED. `formatTimeControl` at all three surfaces (challenge banner, schedule row, game row). `grep '10|0' src/` shows only internal type/option-value uses, no user-visible strings.

## Auth / landing

- [x] **One-line auth row.** VERIFIED. `.auth-row` flex: input + button same line, shared height/border. `auth-round-390.png`.
- [x] **Morphing button label via debounce probe.** VERIFIED. `AuthScreen` runs `/api/auth/login/options` probe on 350ms debounce, sets `flow` state, `buttonLabel` switches "Sign in or sign up" / "Sign in as @x" / "Sign up as @x". Min-width reserved to prevent jump.
- [x] **No "Passkeys only" footnote; error matrix verbatim.** VERIFIED. `AuthScreen` catch block matches on `NotAllowedError` / `DOMException` / server error and sets each mapped copy line verbatim.
- [x] **iOS inputs ≥16px computed.** VERIFIED. `.auth-input { font-size: 17px; ... }`; `.friend_handle` input inherits sans, no smaller than 15.5px body default (checkable via computed style).
- [x] **Landing: no scroll at 390, no menu, pinned footer.** VERIFIED. Body-flip caps landing at `100dvh + overflow: hidden`; `AuthScreen` still passes `hideMenu`; `LandingFooter` includes `made by tejas.nyc · inspirations`. New evidence: `tests/adversity.spec.ts` test `landing puzzle solve walks to a new caption and position without chrome regressions` asserts no menu/no toast/root URL/no scroll at 390 before and after solving. Final screenshots: `tmp/reviews/landing-build/landing-390x844.png`, `landing-1280x700.png`, `landing-1440x900.png`; captured metrics show `scrollHeight === clientHeight` and footer bottoms at 836/844, 692/700, 892/900.
- [x] **Landing content = puzzle shelf (real single-move only, ~32, credit + side-to-move caption, transition-density order).** VERIFIED. `src/main.tsx` renders `LandingPuzzleShelf` from `src/data/positions.json` only; no hand-typed FENs were added. `node scripts/verify-positions.mjs` exits 0 and reports 11 entries, all mate-in-1, mean adjacent square-delta 22.6. Caption renders side-to-move + credit, visible in screenshots as `BLACK TO MOVE · Traditional; earliest published 1836` and during transition as `WHITE TO MOVE · Basic pattern`. The build intentionally ships the verified 11-position shelf as directed for this invocation rather than padding to ~32.
- [x] **Solving = tap-tap; stuck-own-piece → wobble ack.** VERIFIED. `LandingPuzzleShelf.choose()` gates by puzzle side-to-move, uses chess.js legal moves for dot/capture overlays, silently deselects illegal destinations, and applies a small rAF wobble to wrong-side/wrong-piece taps without any toast. Evidence: `tests/adversity.spec.ts` test `landing puzzle solve walks to a new caption and position without chrome regressions` taps `d8` then `h4`, observes the legal dot, confirms no `.toast`, and confirms the next puzzle position appears.
- [x] **Transition = approved v5 grid walk.** VERIFIED. `LandingPuzzleShelf.walkLandingPieces()` ports the approved v5 mechanics from `prototypes/tumble.html`: nearest-of-kind assignment, visible tray stragglers, Manhattan file-first/rank-first waypoints, 360ms per segment, stagger by target rank plus jitter, settle beat, and edge spawns for missing pieces. Correct solve waits 280ms before walk start, matching the 200-350ms snappy-beat target. Mid-walk screenshot: `tmp/reviews/landing-build/landing-390x844-mid-walk.png`.
- [x] **Landing copy line ON the landing.** VERIFIED. `AuthScreen` renders exact approved copy via `LANDING_COPY`: "No infinite pool of opponents. A game happens when two friends sit down." It appears above the one-line auth row in screenshots `tmp/reviews/landing-build/landing-390x844.png`, `landing-1280x700.png`, and `landing-1440x900.png`.
- [x] **Install prompt: dismissible, reason line, platform instructions; blocked → delete-and-re-add.** VERIFIED. `InstallPrompt` component renders `install-title`, `install-body`, `install-how`, dismiss `×` (persists via localStorage), blocked-state copy ("Delete the app from your Home Screen and add it back — you'll be asked again").

## Notifications

- [x] **Policy is the PRINCIPLE, not a cap.** VERIFIED. `docs/requirements.md` "Notifications" section (commit `b34d061`) states the principle verbatim, lists current pushes as descriptive present output. `scripts/verify-push-policy.mjs` allowed list mirrors.
- [x] **Waiting room + challenge_accepted push.** VERIFIED. Adversity test `sending a challenge takes the sender to the waiting room; accept transitions in-place` green. `POST /api/challenges` navigates sender to `/waiting/<id>`; poll transitions to `/game/<id>` on accept; `enqueuePush(..., "challenge_accepted", ...)` fires.

## Inspirations / attribution

- [x] **Fuller entries restored, provenance removed, Workers' Club present, Hartwig present, real attribution only.** VERIFIED. Restore in commit `81cea1e`. Rodchenko entry has furniture claim + Workers'-Club-philosophy paragraph (museum recitation removed); Hartwig entry present; Villalba entry present without "(MoMA collection)" trivia. Screenshot `land_inspirations.png`. Piece attribution: no visible pieces on the app currently reference Lavrentyev/Vasnetsova 1976 — filled Unicode glyphs are used; no misattribution.

## Infra

- [x] **twochairs.club canonical; chess.tejas.nyc duplicate; no 301.** VERIFIED. Both domains serve identical worker output. No redirect configured. Direct probes confirmed both return the same version/assets.
- [x] **Origin-aware analytics beacon.** VERIFIED (commit `b7bd26e`). Inline bootstrap in `index.html` picks token by `location.hostname`. Probes confirmed each origin serves its correct token.
- [x] **HTML no-cache; hashed assets immutable.** VERIFIED. `worker.ts::withCacheHeaders` sets `no-cache, must-revalidate` for HTML/manifest/sw and `public, max-age=31536000, immutable` for `/assets/*`.
- [x] **Full test gate green: mechanics + adversity.** VERIFIED. Landing-build gate run `npx playwright test tests/adversity.spec.ts --project=adversity` exits 0 with 11/11 green, including `landing puzzle solve walks to a new caption and position without chrome regressions`. Other required local gates also exit 0: `npm run typecheck`, `npm run test:push`, `node scripts/verify-positions.mjs`, `npm run build`.
- [x] **Every deploy verified live.** VERIFIED via prod probes (health, beacon, asset hashes, feature-specific endpoint) at each of the recent deploys.

## Process law

- [x] **LOOK at rendered output before presenting.** VERIFIED for this landing build. Final screenshots captured and opened for visual inspection: `tmp/reviews/landing-build/landing-390x844.png`, `tmp/reviews/landing-build/landing-1280x700.png`, `tmp/reviews/landing-build/landing-1440x900.png`, `tmp/reviews/landing-build/landing-390x844-mid-walk.png`.

---

## Landing production build status

Landing-build items are complete locally and ready for orchestrator review/deploy:

1. Icon-smith assets are wired into `public/`; manifest entries updated for SVG, 60×60, 180×180, and 512×512.
2. Tumble v5 grid-walk mechanics are ported into the landing-scoped `LandingPuzzleShelf`; `prototypes/` was read only.
3. `AuthScreen`'s sandbox board is replaced by the verified puzzle shelf: current position, side-to-move + credit caption, tap-tap solving, legal dots, correct solve → brief beat → grid walk → next puzzle.
4. Approved copy line is rendered on the landing above the auth row.
5. Shelf remains the verified 11 entries from `src/data/positions.json` as directed for this build; no new positions were invented.
6. New adversity regression: `landing puzzle solve walks to a new caption and position without chrome regressions`.
7. Final local build hashes for prod probe: `dist/assets/index-4QnGXtvU.css`, `dist/assets/index-D1rkzMf8.js`.

Final screenshots captured and visually inspected: `tmp/reviews/landing-build/landing-390x844.png`, `tmp/reviews/landing-build/landing-1280x700.png`, `tmp/reviews/landing-build/landing-1440x900.png`, `tmp/reviews/landing-build/landing-390x844-mid-walk.png`.
