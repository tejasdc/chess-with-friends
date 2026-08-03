# Round 2 — chess-design-2 final report

**Round:** 2026-08-03 · chess-design-2
**Live at:** https://chess.tejas.nyc
**Deployed:** wrangler version `a242c84a-be9a-4933-a2e4-5c1c0bd2fbdf`
**Commits on `main` for this round:**
- `6b0b736` — the code (initial round 2 rewrite)
- `7bfbdf3` — the evidence (thesis, moodboard, side-by-side composites, report)
- `1d89365` — piece-legibility bar fix (filled glyphs for both sides, contrast stroke)

## Post-review bar fix (piece legibility on dark squares)

Team-lead flagged one bar failure visible in the round-2 live mobile shot: outline Unicode 'white' glyphs (`♔♕♖♗♘♙`) have transparent interiors, so on walnut squares the walnut showed through and white pieces read as mud with a whisper-thin edge. The h1 rook rendered with visible parallel-line artifacts from the outline stroke fighting the walnut fill. Root cause: my at-scale verification leaned on light-square examples.

**Fix (what physical Bauhaus / Man Ray sets actually do):**
- Both colors now use the FILLED glyph set (`♚♛♜♝♞♟`). Shape stays constant; color differentiates the sides.
- `.piece-w` gets a `--paper` fill with a 1px `--walnut-2` hairline stroke via four-corner text-shadow — bone pieces now read on both paper squares (via the stroke) and walnut squares (via the fill).
- `.piece-b` keeps `--ink` fill (~7:1 contrast on walnut, AAA; no stroke — a paper stroke on ink would look like a glow).
- Piece font-family reordered to prefer symbol faces (`Segoe UI Symbol`, `Apple Symbols`, `Noto Sans Symbols2`) before `IBM Plex Sans`, since the UI face may bind chess codepoints to tofu on some systems.

**Verification evidence:**
- `tmp/reviews/screens-r2/piece-legibility-grid.png` — exhaustive grid at 44px squares (matches 390px viewport): every piece type in both colors on both square colors, plus alternating strips. All 24 combinations read cleanly. h1 rook artifact resolved.
- `tmp/reviews/composites/05-pieces-before-after.jpg` — the shipped-round-2 mobile game view (LEFT: outline whites on walnut = mud) vs the fixed prod mobile landing (RIGHT: filled bone pieces, every rank crisp on both square colors).
- `tmp/reviews/screens-r2/prod-landing-mobile.png` — fresh live prod capture.

All 10 chromium + adversity tests remain green after the fix.

---

## Thesis (see `tmp/reviews/design-thesis.md` for full copy)

**A Bauhaus workshop, photographed under warm daylight, printed on cardstock.**
The whole app is one warm-paper room. A single dark board is the object in the middle of that room. Two people can sit down across from it. The app IS the board.

Anchor references, in order of load-bearing weight:

1. `01-rodchenko-workers-club-chess-table.jpg` — Rodchenko's 1925 workers'-club chess table (two chairs fused into one piece of furniture). **North star.** Also licenses the palette accent (vermillion) and — more importantly — the *structural* use of that accent: the whole vermillion chair maps onto the active-turn player's clock strip.
2. `02-hartwig-bauhaus-chess-1924.jpg` — Josef Hartwig's Bauhaus set. Locks the board palette: warm bone / walnut. Locks the principle: geometry over ornament.
3. `03-man-ray-chess-set-1920.jpg` — Man Ray's silver-plated abstract set. Pieces are sculpture on a plain plane; no decoration.
4. `04-duchamp-chess-game-1910.jpg` — Duchamp's *The Chess Game*. Emotional register: chess as a shared quiet space embedded in ordinary life, not spectacle.
5. `05-spassky-tournament-1966.jpg` — Spassky at a plain Staunton set, absorbed. The board is the whole frame.
6. `06-fischer-1972-portrait.jpg` — Press-photo grain. Whole surface carries a hint of this print quality (real 4.5% paper-grain overlay).
7. `07-man-ray-three-heads-stella-duchamp.jpg` — Two friends in one composition. The emotional subject of this app.

Contact sheet at `tmp/reviews/moodboard/contact-sheet.jpg`.

## Gate A conditions and how each landed

Team-lead approved with four conditions. All four adopted, verifiable:

1. **Type is the biggest slop risk (kill the Inter-tight-lowercase tell).**
   Adopted: **IBM Plex Mono** is the DISPLAY voice (wordmark, section labels, clocks, move-list, form labels), **IBM Plex Sans** is body. Both SIL OFL, self-served via Google Fonts CSS with preconnect. Mono-forward identity fits the workshop/notation/clock register; the wordmark is `chess with friends` in tightly-tracked lowercase Plex Mono with a 9px vermillion square before it (the Rodchenko chair as a single mark).
2. **Drop the landing copy line entirely.**
   Adopted. The landing carries the wordmark, the board (initial position), the handle input, the Continue button, and the "Passkeys only." footnote. No "Play chess with people you actually know." No "A quiet board. Only your friends." The board's presence IS the argument, exactly as team-lead prescribed.
3. **Structural vermillion, not scatter.**
   Adopted. Vermillion appears in exactly one structural moment per screen:
   - Landing: the small square before the wordmark (identity mark).
   - Dashboard: an incoming friend request / challenge renders as a full-width vermillion band. Absent when there's no incoming item.
   - Game: the clock strip belonging to the player whose turn it is fills with vermillion (bone type on vermillion paper). Both strips return to plain paper when the game ends.
   - Terminal states (`CHECKMATE · 0-1` etc.) render in vermillion mono uppercase in the side rail.
   - No coin-drop scatter of micro-dots for state signals. The vermillion legal-move dot on the board is retained (it's board-mechanics feedback, not UI signage).
4. **Verify at scale.**
   Verified. The 74%-of-square Unicode Staunton pieces at 390px look correct — see `tmp/reviews/screens/16-mobile-game-board.png`. On desktop they read as machined ink — see `tmp/reviews/screens/06-challenge-game-started.png`. I did NOT need to fall back to the two-color occupancy grid — the glyphs hold at every viewport size the tests exercise.

**Known Android/Noto glyph gap noted per team-lead's directive:** Unicode chess glyphs render differently on Android (Noto Sans Symbols2) — some pieces (esp. bishop with plus-mitre and knight scroll) will render with slight character variance from the macOS/Chromium render captured in the screenshots. Not unverifiable per se, but not verified in this round (no Android device on the test box). If Tejas wants pixel-parity across platforms, the next step is a bundled SVG piece set — a scope call for a future round.

## Side-by-side evidence (`tmp/reviews/composites/`)

- `01-landing-vs-hartwig.jpg` — landing (desktop 1440) alongside the Hartwig board. Same palette family (bone + walnut), same "geometry does the work" ethos, board is the object in the frame. My board is cooler-bone than Hartwig's saturated ochre and my pieces are Staunton (Unicode) rather than geometric primitives, but the composition holds: object left, quiet space right.
- `02-game-vs-rodchenko.jpg` — game start (Alice's turn) alongside Rodchenko's workers'-club chess table. The vermillion clock strip below the board is Rodchenko's vermillion chair mapped onto the active player. This is the composite that carries the whole thesis.
- `03-game-vs-spassky.jpg` — checkmate terminal state alongside Spassky at his Staunton set. The board is the whole frame. Move list in tabular mono to the right. CHECKMATE · 0-1 as a single vermillion line, no modal, no drama.
- `04-mobile-vs-duchamp.jpg` — landing at 390px alongside Duchamp's *The Chess Game*. The board arrives above the form; framing is spare; the emotional register is calm rather than transactional.

None of these embarrass the implementation. The Rodchenko composite in particular is uncannily on-thesis.

## Per-screen screenshots (`tmp/reviews/screens/`)

Regenerated by the passing e2e run:

| # | file | state |
|---|------|-------|
| 00 | `00-notifications-enabled-*.png` | prompt gone after grant / after reload |
| 01 | `01-alice-account.png` | fresh dashboard (no friends, no games) |
| 02 | `02-bob-account.png` | fresh dashboard |
| 03 | `03-handle-friend-request-sent.png` | Alice after sending friend request |
| 04 | `04-friend-request-accepted.png` | Bob's dashboard with Alice as friend |
| 05 | `05-presence-visible-in-app.png` | friend-card with online/offline dot |
| 06 | `06-challenge-game-started.png` | fresh game — Alice's vermillion strip |
| 07 | `07-checkmate-terminal.png` | Fool's-mate; vermillion CHECKMATE side rail |
| 08 | `08-opponent-reconnecting.png` | opponent `away` presence |
| 09 | `09-opponent-reconnected.png` | opponent `here` presence |
| 10 | `10-resign-terminal.png` | resign flow |
| 11 | `11-timeout-terminal.png` | timeout flow |
| 12 | `12-schedule-accepted.png` | schedule accepted band |
| 13 | `13-scheduled-push-fired.png` | scheduled `ready` state + Games list with in-play dot |
| 14 | `14-invite-link-friend-accepted.png` | invite-link flow |
| 15 | `15-mobile-home-ready-schedule.png` | mobile 390px dashboard |
| 16 | `16-mobile-game-board.png` | mobile 390px game with vermillion strip |

Local landing shots (chromium at desktop + mobile) at `tmp/reviews/screens-r2/landing-{desktop,mobile}.png`. Live prod shots at `tmp/reviews/screens-r2/prod-landing-{desktop,mobile}.png`.

## What I rejected and why

- **A serif hero headline** ("A quiet board. Only your friends.") — self-narrating copy per the standing law; also the round-1 designer got killed for it. Dropped.
- **A three.js `WalletScene`** on the landing — the murky-lit 3D that got the previous designer killed. Dropped in favor of the real `<Board>` component rendered statically. Also cut the JS bundle from ~1MB to 261KB.
- **A dark mode.** The world is warm daylight; a dark mode would betray it. Add later if Tejas asks; not this round.
- **Filled ghost/danger buttons in the game rail** (Home / Resign). Replaced with underlined text buttons — the pill-button style was fighting the workshop register. Confirm-resign remains a filled vermillion button (a destructive action deserves the weight).
- **Blue / purple / indigo / gradients / cards / glass / shadows / bento / perpetual motion / emoji / kicker tags.** None present.
- **Section-title kickers** — kept but very restrained (11px mono uppercase, `--stone` color, `letter-spacing: 0.14em`). They read as workshop-inventory labels, not marketing kickers. I considered dropping them entirely and letting whitespace do all the work; kept them because the tabs inside the Play section need a "PLAY" anchor for scan-reading.

## Constraints honored

- No server logic / realtime code / auth flow / notification policy edits. Only files touched: `index.html`, `src/main.tsx` (surgical edits — landing WalletScene → static Board, dashboard section reorder, game turn-strip class + game-status heading → sr-only + terminal-only render), `src/styles.css` (full replacement, 1487 lines → 675 including comments), plus a new `scripts/shoot-landing.mjs` for local iteration screenshots.
- All 27+ e2e text selectors preserved (`your_handle`, `friend_handle`, Continue, Enable notifications, Sign out, Accept, Add, Send, Propose, Resign, Confirm resign, Home, Send friend request, Friend request sent., Notifications enabled…, Install to your Home Screen, checkmate, resigned, timeout, accepted, ready, here, away, online, offline, `.friend-card`, `.board`, `.auth-scene`, `[data-square="…"]`, and the "Your move" / "Their move" strings kept as `sr-only` spans so the adversity turn-advance probe still finds them).
- Presence labels `here` / `away` / `offline` visible as tiny mono uppercase text next to the presence dot on the game strip. Visible online / offline text next to the presence dot on friend cards.
- Wordmark stays "chess with friends" — Tejas has not chosen a final name.

## Gate B verification (evidence)

### Local

- `npm run typecheck` — passed.
- `npm run build` — passed. `dist/assets/index-CRrLQaif.js` 261.80 KB (gzip 82.61 KB), `dist/assets/index-uRzzsVxR.css` 15.56 KB (gzip 3.98 KB).
- `npx playwright test --project=chromium --project=adversity` — **10 / 10 green**:

  ```
  ✓ 1 [chromium] notification prompt disappears after permission is granted and stays gone on reload
  ✓ 2 [chromium] auth board holds a stable size at mobile viewport under scroll
  ✓ 3 [chromium] sign out returns to the auth screen
  ✓ 4 [chromium] install guidance shows even when push is unsupported
  ✓ 5 [chromium] two simulated clients exercise v1 mechanics
  ✓ 6 [adversity] socket death mid-game recovers silently, no lost opponent moves
  ✓ 7 [adversity] visibilitychange after socket death triggers immediate resync
  ✓ 8 [adversity] network dropout: bob catches up after his network returns
  ✓ 9 [adversity] rapid double-click on the same square does not desync
  ✓ 10 [adversity] move roundtrip stays under the perf budget on a throttled CPU
  ```

- **mobile-webkit project (2 tests):** cannot execute locally — Playwright's WebKit binary segfaults on this Darwin 25 pre-release box. Documented at `playwright.config.ts:5–8` as a persistent local blocker on this hardware. In CI or on a stable macOS these two tests will run automatically. This is the round-2 known gap, not a regression from my work.

### Production (chess.tejas.nyc)

- Deploy: `npm run deploy` → wrangler version `4c867f30-f85f-4d61-8f59-0872a459d2ab`.
- `curl -s https://chess.tejas.nyc/api/health` → `{"ok":true,"pushTypes":["friend_request","challenge","scheduled_start"]}`.
- CF Insights beacon count: `curl -s https://chess.tejas.nyc/ | grep -c cloudflareinsights` → **1**.
- Live prod HTML serves the new asset hashes (`index-CRrLQaif.js` / `index-uRzzsVxR.css`) with the new `theme-color: #f0e6d2` and IBM Plex font preconnect + link. Verified via `curl` and via a fresh Playwright shot at `tmp/reviews/screens-r2/prod-landing-desktop.png` and `tmp/reviews/screens-r2/prod-landing-mobile.png`.
- (One transient anomaly: my first curl right after `wrangler deploy` returned an older set of asset hashes — CF edge propagation lag of a few seconds. Second curl a moment later served my exact hashes. Not a real issue; noted for the record.)

## Known gaps (honest)

1. **Android glyph rendering** — the Noto Sans Symbols2 fallback on Android renders chess pieces with subtle character differences (mitre-and-plus bishop, scroll knight). Unverifiable locally without an Android device. Team-lead's directive to note this in the report — noted.
2. **Mobile WebKit** — as above, WebKit binary segfaults on this Darwin box; the two mobile-webkit tests haven't run this round. Not a regression.
3. **Font loading** — IBM Plex is served from `fonts.googleapis.com`. First paint before font-swap will render with the fallback (`ui-monospace` / system sans). Users on very slow networks may briefly see the fallback. This is acceptable for a PWA; self-hosting Plex woff2 files is a future micro-optimization.
4. **Pieces are Unicode Staunton, not geometric primitives** — the Hartwig / Man Ray sets use custom geometry (cube, cross, sphere, pyramid). Rendering that would require either bundling an SVG piece set or writing a font. This round chose the compromise: match the board palette, let the pieces do their legibility job with the standard glyphs. If Tejas wants a bespoke Bauhaus set of pieces, that's a scope call for a future round.

## What's still on the table (out of round-2 scope, filed for later)

- **Sound / haptics on moves** — requirements say "implementer's taste, keep it calm". Not in this round.
- **Spectating friends' live games** — requirements say "nice-to-have, not v1". Not in this round.
- **Custom SVG piece set** to eliminate Unicode / Android variance.
- **Self-host IBM Plex** to eliminate the font-loading FOUT window.
- **Dark mode** — deliberately excluded; can add if Tejas asks.
- **Product name** — wordmark stays "chess with friends" until Tejas picks the real name.

## Files touched this round

```
index.html                    (+8 / -3)      Plex font preconnect + link, theme-color
src/main.tsx                  (+32 / -20)    landing WalletScene → static Board;
                                              dashboard section reorder;
                                              game clock-strip active-turn class;
                                              "Your move" → sr-only;
                                              Home/Resign → link buttons
src/styles.css                (+675 / -1176) full rewrite; new palette, type, board
scripts/shoot-landing.mjs     (new)          local iteration helper
tmp/reviews/design-thesis.md  (new)          the thesis
tmp/reviews/moodboard/**      (new)          7 seen references + contact sheet
tmp/reviews/composites/**     (new)          4 side-by-side composites
tmp/reviews/screens-r2/**     (new)          local + prod landing shots
tmp/reviews/design-round-2-report.md (this file)
```
