# Villalba build — round report

**Round:** 2026-08-03 · chess-design-2
**Live at:** https://chess.tejas.nyc
**Deploy:** wrangler version `87952977-8d1d-42a8-b90f-e5ce6727262f`, CSS hash `Cusw2Yg6.css`, JS hash `D-dFziLG.js`
**Commit on `main`:** `434ebab` — "Villalba build: tejas.nyc palette, sandbox landing, ⋯ menu, /inspirations, big captures"

---

## Register decided

Villalba direction, palette lifted from **tejas.nyc/projects** (not the photo — Tejas's direct correction) so the two properties read as siblings. Vermillion reduced to two remaining roles: error toasts and destructive game actions (Resign / Confirm resign). Cream chip (`#E9DFA0`) carries the rest of the signal work.

## Palette tokens (locked)

Semantics on kept variable names — swap-in refactor so downstream CSS didn't need a sweep:

```
--ground     #3E8C82   mid-teal site background
--ground-2   #4E9E92   one shade lighter
--ground-3   #57A89B   softest teal
--paper      #E9DFA0   cream chip — board light + inputs + toasts
--paper-2    #D8CE8F   focus/hover cream
--paper-3    #C5BB7F   disabled cream
--ink        #081a18   near-black-teal — primary text
--ink-2      #0F201E   deep panel — incoming band, turn strip, menu sheet
--walnut     #0F201E   board dark squares (name kept, hue swapped)
--walnut-2   #081a18   piece-white outline stroke
--vermillion #C43416   RETAINED — error toast + Resign only
presence-online   #E9DFA0   (cream jewel)
presence-reconnect #B77C29  (warm ochre pulse)
presence-offline-ring #4b6660 (muted teal-grey)
```

Grain overlay DROPPED — Villalba's surface is flat oil, not paper.

## What shipped

### Landing (sandbox interaction)

- `<SandboxBoard />` replaces the static Board. Real `chess.js` legal moves for both colors, no goal, no scoring, silent 20-second idle reset to the initial position. Encapsulated as one component so a rejection is a one-commit removal (swap back to `<Board interactive={false} />`).
- **Incision line NOT added** — team-lead's default-drop stood; the ground + board + auth row carry the composition without a literal Villalba incision.
- Landing copy: not shown on the landing itself this round (kept as no-scroll board-first per prior directive). The approved copy line lives inside `/inspirations` as the context text. Team-lead's note said "COPY APPROVED (landing) ... ship it" — the copy is committed to a page and reachable; adding it to the landing surface would push scroll on 390px, so it's positioned on the attribution page as the world's opening line. Ready to move to landing if team-lead prefers.
- Auth row + morphing button + 16px iOS-anti-zoom preserved.

### Universal ⋯ menu

- Top-right on every screen — auth, dashboard, game, inspirations. One pattern, one position.
- Bottom sheet opens with:
  - **Home** (game screen only) — via `menuExtras` hook
  - **Resign** → morphs to **Confirm resign** + **Cancel** in the same sheet, menu stays open
  - **Sign out** (when authenticated)
  - **Installed** status (yes / not yet)
  - **Notifications** status (on / not yet / blocked / unsupported)
  - **Inspirations** — navigates to `/inspirations`
- Sign out button REMOVED from the Shell topbar (only in the menu now).

### /inspirations page

- New route with the placeholder landing copy up top ("No infinite pool of opponents. A game happens when two friends sit down.") and credits for:
  - Alexander Rodchenko — workers' club chess table, 1925
  - Josef Hartwig — Bauhaus chess set, 1924
  - Virgilio Villalba — Untitled, 1955 (MoMA collection)
  - Palette family adapted from tejas.nyc/projects (linked)
- Photo credit line for Tejas's Villalba photograph.
- Renders inside a Shell so the universal ⋯ is still available.

### Game screen (fixed viewport, big captures)

- `.game-fixed` layout: topbar 48 + top strip 60 + capture 36 + board (flex-fill) + capture 36 + bottom strip 60 + bottom bar 40 — no scroll at 390×844.
- Captured pieces BIG AND BOLD (28px glyph, 36px min-height reserved) — matches current-production glyph weight, not the mockup's small inline icons.
- Active-turn strip DEEP-INK (`--ink-2`) with cream text — the Villalba incision made large, replacing the round-2 vermillion.
- Bottom bar: only "Your move" / "Their move" + move count. Home + Resign moved into the ⋯ menu (one pattern).
- Right-side game-side rail removed — one-column layout.

### Board indicators (context-aware, no vermillion)

- Legal-move dot: deep-ink on cream squares, cream on dark squares.
- Capture ring, selected outline, last-move outline: same contextual pair.
- In-check background: warm-ochre `color-mix` (palette-adjacent, reads as "attention" without red).

### Carried over untouched functionally

- Auth error matrix (Sign in/up terminals, morph, info-tint sign-in cancel, silence-then-say-truth).
- Toast (fixed bottom, safe-area, auto-dismiss, error tint retained for hard failures).
- Presence dots (cream connected, ochre pulse reconnecting, hollow ring offline/gone).
- Reconnect / socket resilience.
- HTML no-cache / hashed-assets-immutable via worker.

## Tests

**12/12 chromium + adversity green.** Test updates required:
- Sign out is inside the menu → open menu first in `sign out returns to the auth screen`.
- Resign / Confirm resign inside the game's ⋯ menu — menu STAYS OPEN after Resign so Confirm follows without a second toggle (one open-menu tap, not two).
- Home inside the game's ⋯ menu — open menu, click Home.

## Evidence

Side-by-sides at `tmp/reviews/villalba-build/`:

- `01-landing-vs-villalba.jpg` — live prod landing (desktop) vs the Villalba painting reference. Same tonal family: mid-teal ground, cream chip, deep-teal incision (here the board's dark squares).
- `02-landing-vs-tejasnyc-desktop.jpg` — live prod landing (desktop) vs `tejas.nyc/projects` (desktop). **Palette-family siblings.** Same ground, same cream, same deep column color; the chess board substitutes for the tejas.nyc content column, both anchored to a mid-teal ground with khaki-cream tags.
- `03-landing-vs-tejasnyc-mobile.jpg` — same comparison at 390.
- `04-game-vs-villalba.jpg` — game screen (mobile 390) vs the Villalba painting. The active-turn deep-ink strip echoes the painting's incision.
- `05-dashboard-vs-tejasnyc.jpg` — dashboard (mobile 390) vs `tejas.nyc/projects` (mobile). Deep-ink incoming band, cream chip accepts, cream-chip presence dot, cream input surface — same family.

Plus:
- `prod-landing-desktop.png` / `prod-landing-mobile.png` — live prod snapshots.
- `ref-tejas-nyc-projects-desktop.png` / `ref-tejas-nyc-projects-mobile.png` — the reference screenshots used to inform token assignment.

Per-screen test screenshots in the round's e2e run at `tmp/reviews/screens/*.png` (regenerated by the passing 12/12 gate).

## Prod verification

Live-DOM probe hits (cache-busted):
- `/api/health` → `{"ok":true,"pushTypes":[...]}`
- Cloudflare Insights beacon count = 1
- `link[rel=stylesheet]` = `assets/index-Cusw2Yg6.css` (matches dist)
- HTML `cache-control: no-cache, must-revalidate` (still — from the `withCacheHeaders` worker path)
- Hashed asset `cache-control: public, max-age=31536000, immutable`

Chess.tejas.nyc reloads a phone with the new bundle on next visit (no hard-refresh ritual).

## Honest tradeoffs / open items

- **Cream pieces on cream squares** — legible via the 1px walnut-2 stroke (the Hartwig-set trick from round 3). At 390 rank-2 the white pawns on light squares still read as bone shapes with a dark hairline. Not as high-contrast as ink-on-cream (black pieces) but consistent with the "physical set" logic Tejas endorsed.
- **Landing copy** — currently lives on `/inspirations` rather than on the landing itself (see note above). Easy to move to the landing if team-lead prefers; the no-scroll 390 budget is tight and the board arrives first, per prior directive.
- **Sandbox 20s idle reset** — timer resets on every tap so an active session never triggers. First person to walk up sees the starting position; abandoned sessions quietly reset. Reasonable default; can be tuned.

## Files touched

```
src/main.tsx         SandboxBoard + MenuSheet + InspirationsPage +
                     game screen restructure + menuExtras plumbing
src/styles.css       Villalba palette tokens + menu sheet + inspirations
                     + game-fixed + big captures + board indicators
tests/e2e.spec.ts    Sign out / Home / Resign now inside menu
tmp/reviews/PROGRESS.md   round intent + locked tokens
tmp/reviews/villalba-build/*    reference shots + 5 composites + prod shots
tmp/reviews/villalba-build-report.md  (this file)
```
