# Mockup notes

**Round:** 2026-08-03 · chess-design-2
**Six surfaces × two registers = 8 images** (three surfaces have a desktop variant too).
**Villalba reference used:** `reference-villalba-untitled-1955.jpg` — Tejas's photograph of Virgilio Villalba, *Untitled*, 1955 (MoMA). Muted celadon-teal field with a subtle tonal split near a vertical seam; a tall narrow deep-navy incision descending from the top-right; a tiny cream chip and a minute white arc near the base of the incision; warm teak frame edge.

## Current-world register (A/B/C)

### A — Landing, mobile + desktop
`mock-a-landing-mobile.png` (390×844) · `mock-a-landing-desktop.png` (1440×900)

- Board fills the upper two-thirds, framing copy pinned underneath, input+button on ONE row pinned to the bottom edge. Everything visible without scrolling on iPhone.
- Copy is the placeholder line from you ("No infinite pool of opponents. A game happens when two friends sit down.") — layout-only, not proposed as final copy.
- Desktop takes the same architecture but splits horizontally: board left, copy + input+button right. Board stays the object of gravity.
- Wordmark stays lowercase Plex Mono with the vermillion identity-mark square. `···` menu top-right (the converged corner menu you asked about — same pattern as B/C).

### B — Game, mobile, fixed viewport
`mock-b-game-mobile.png` (390×844)

- **No wordmark, no sign-out** on this screen. The board and clocks are the frame.
- Opponent strip (top): presence dot · @handle · inline captured pieces · clock. All within 60px of vertical.
- Own strip (bottom): filled vermillion — the whole strip **IS** the turn indicator (Rodchenko chair-color mapped onto whose turn). Captures inline here too.
- **Captured pieces moved into the opponent strips** — kills the two separate rows below/above the board that were causing the layout jump *and* halves the vertical chrome.
- Slim bottom action row: `YOUR MOVE` (tiny mono tag on the left) · `MOVES · N` toggle (collapsed move list) · `···` menu. Home, Resign, and attribution live inside the `···` menu.
- The move list is collapsed behind a tap by default so the board area gets the full remaining viewport height.

### C — Dashboard, mobile, information hierarchy
`mock-c-dashboard-mobile.png` (390×844)

Sections top-down, actionable-first:
1. **Incoming** (needs response) — full-width vermillion band with the invitation and an Accept button. Only rendered when non-empty.
2. **Friends online now** — the actual social layer. Green dot + @handle + `Invite` inline ghost button per row. This is the reason someone opens the app.
3. **Play (start a game)** — Now/Schedule tab, friend select (chevron affordance shipped), time control toggle, `Send challenge` primary.
4. **Collapsed rows** — Past games, Manage friends, Invite link — one tap each. Past games doesn't burn primary real estate.
5. `···` **corner menu** (top-right) — sign out, install/notification state, attribution/inspirations. Bottom hint line explains the pattern for this mockup only.

The **online-now-plus-actionable-incoming** pair at the top is the whole answer to "what shows on login."

## Villalba register (D/E/F) — same layouts

Bridge fact you gave me held: the classic tournament vinyl green+buff maps cleanly onto Villalba's field-and-chip. The board becomes club-chess material culture and the app becomes a mid-century painting.

**Villalba tokens (from the reference photo):**
- Field: `#7CA898` celadon-teal (matches the ground). Grain overlay disabled — the surface is flat oil, not paper.
- Light squares: `#E8DBBE` **buff** (club vinyl).
- Dark squares: `#5F8A7A` **teal-dark** (club vinyl).
- Ink / pieces: `#2E2A3D` **navy-purple** (the incision color, not black).
- Accent — vermillion **shrunk and replaced**: `#EEE3C4` **cream chip** does the state-signal work.
- Warm wood frame: `#8C5A2E` teak — subtle `box-shadow: 0 0 0 6px var(--wood)` around every board, matching the reference's frame edge.

### D — Landing, Villalba, mobile + desktop
`mock-d-landing-villalba-mobile.png` · `mock-d-landing-villalba-desktop.png`

- Same architecture as A. Board on the field, wordmark + `···` at top, copy + input+button below.
- **Villalba's navy incision made literal**: a narrow navy bar descends from the top edge, one-third from the right, with a cream chip at its base. Directly quotes the reference — an editorial gesture, not an ornament.
- Wordmark's identity-mark square swaps from vermillion to cream chip (`#EEE3C4`) to stay in-register.
- Input has navy border on the field, button is filled navy with buff text.

### E — Game, Villalba, mobile
`mock-e-game-villalba-mobile.png`

- Same architecture as B.
- **Active-turn strip becomes DEEP NAVY** (`#2E2A3D`) instead of vermillion — much quieter, much closer to Villalba's incision made large. Cream-chip presence dot on the navy strip.
- Board has the warm teak frame edge — grounds the entire game in physical material culture (a Marshall House Staunton on a vinyl mat with a mahogany trim).
- The register trade-off vs current world: less "look at me", more "sit down and think."

### F — Dashboard, Villalba, mobile
`mock-f-dashboard-villalba-mobile.png`

- Same architecture as C.
- Incoming band = **navy on field, cream-chip Accept**. Reads as an editorial cut rather than a shout, but still commands attention.
- Green presence dots swap to cream chips. Kept the muscle memory (a bright pip in the corner of a row) without the color noise.

---

## Recommendations (yours + Tejas's call)

- **Current world (A/B/C)** is a refinement of the shipped app. Low risk, correct answer to the specific mechanical asks (no-scroll landing, no-scroll game, converged `···` menu, information hierarchy on dashboard).
- **Villalba (D/E/F)** is a bigger swing. It reads editorial / museum / club-chess, not workshop / cardstock. Best mockup of the six is arguably E — the navy turn strip on the celadon field is genuinely on-thesis with the reference *and* with the "friends sitting down to think" product character.
- The `···` menu pattern works identically in both registers. The board component works identically. If you pick Villalba, the migration is a token swap + one small chrome addition (the incision on landing) — not a rewrite.
- If we ship Villalba, I'd want to shrink the wood-frame `box-shadow` slightly on mobile — the reference's frame is thin enough to be a hairline; my current 6px band reads honest on desktop but too heavy at 390px. Would tune in build.

## Files

```
tmp/reviews/mockups/
├── NOTES.md                            (this file)
├── reference-villalba-untitled-1955.jpg
├── mock-a-landing-mobile.png           (current, 390×844)
├── mock-a-landing-desktop.png          (current, 1440×900)
├── mock-b-game-mobile.png              (current, 390×844)
├── mock-c-dashboard-mobile.png         (current, 390×844)
├── mock-d-landing-villalba-mobile.png  (villalba, 390×844)
├── mock-d-landing-villalba-desktop.png (villalba, 1440×900)
├── mock-e-game-villalba-mobile.png     (villalba, 390×844)
├── mock-f-dashboard-villalba-mobile.png (villalba, 390×844)
└── src/
    ├── _tokens.css                     (both registers, one file)
    ├── _shared.js                      (board renderer + fake state)
    └── mock-*.html                     (one per surface)
```
