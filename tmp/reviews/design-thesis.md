# Design Thesis — Round 2

**Round:** 2026-08-03 · chess-design-2
**Contact sheet:** `tmp/reviews/moodboard/contact-sheet.jpg`
**Full-res references:** `tmp/reviews/moodboard/final/` (7 images, each personally viewed)

---

## The one committed visual world

**A Bauhaus workshop, photographed under warm daylight, printed on cardstock.**

The whole app is one warm-paper room. A single dark board is the object in the middle of that room. Two people can sit down across from it. That is the entire visual argument — the app IS the board and the whole thing is dressed like a well-made object from the workshop, not like a web product.

The world sits on the axis of these seven references, in order of load-bearing weight:

1. **`01-rodchenko-workers-club-chess-table.jpg`** — Rodchenko's 1925 workers' club chess table, where the two chairs and the board are one piece of furniture. This is the north star. Chess is what happens when two specific people sit down together, and the app should feel like the piece of furniture that makes that possible. It also gives us the palette's one accent: **vermillion**, used once, against black.
2. **`02-hartwig-bauhaus-chess-1924.jpg`** — Josef Hartwig's Bauhaus chess set. This gives us the board's palette: **warm bone / ochre** for the light squares, deep walnut for the dark squares. It also gives us the principle that the geometry itself does the semantic work — no ornament.
3. **`03-man-ray-chess-set-1920.jpg`** — Man Ray's silver-plated abstract set. Reinforces: pieces read as sculpture on a plain plane. We do not depict pieces figuratively; we place them like objects.
4. **`04-duchamp-chess-game-1910.jpg`** — Duchamp's *The Chess Game*, four people around a garden table on a green afternoon. Chess as a shared quiet space embedded in ordinary life, not extracted from it. This is the emotional register — calm, absorbed, domestic.
5. **`05-spassky-tournament-1966.jpg`** — Spassky at a plain Staunton set on a plain board, absorbed in the move. A game between two humans is small, focused, and un-theatrical. The board is the frame; nothing decorates it.
6. **`06-fischer-1972-portrait.jpg`** — Mid-century press-photo texture: grain, warm-black gelatin, honest imperfection. The whole surface should have a hint of this print quality — not a Photoshop filter, a real 4% paper-grain overlay.
7. **`07-man-ray-three-heads-stella-duchamp.jpg`** — Two friends photographed close, one composition. The subject of this app is friendship the way this photograph shows it: adjacent, intimate, low-drama. Not networked spectacle.

## Palette (locked)

- `--paper`     `#F0E6D2`   warm bone (from the Hartwig board)
- `--paper-2`   `#E7DBBE`   one shade deeper — used for inputs, hairlines against paper
- `--ink`       `#12100C`   deep black-brown, never `#000`
- `--walnut`    `#4A3826`   dark board squares + subtle rules
- `--vermillion``#C43416`   THE accent. Used once per screen, at most. Whose-turn dot; incoming-request outline; nothing else.
- `--stone`     `#6B6455`   muted warm grey — secondary text only

No blue, no purple, no indigo, no green, no gradient, no glass, no dark mode.

## Type (locked)

- **Wordmark & display**: `"Söhne", "Neue Haas Grotesk", Inter, system-ui, sans-serif` — set in tightly tracked lowercase (`letter-spacing: -0.01em`). NOT Inter first — Söhne first, Inter as fallback because a proper Söhne license isn't in the repo yet. The wordmark is `chess with friends` in lowercase (until Tejas picks the real name).
- **Body**: same stack, `400` weight, warm dark ink.
- **Numbers, clocks, moves**: `"iA Writer Mono", "JetBrains Mono", ui-monospace, monospace` — tabular figures. Clocks are the loudest thing in the game screen after the board itself.
- **No serif anywhere.** The previous round's serif "A quiet board. Only your friends." is dropped — it is self-narrating copy per the standing law, and it reads like an essay landing page. The world is functional, not literary.

## Materiality

- Everything sits on `--paper`. The whole `body` is that color; no white cards, no drop shadows, no glass, no elevation. Sections separate by whitespace and a single walnut hairline (`1px solid var(--walnut)` at 12% opacity) when needed.
- **Paper grain**: one `fixed inset-0 pointer-events-none` layer with an inline SVG turbulence filter at ~4% opacity. Fixed only — never on scrolling containers. Passes the perf guardrail.
- **No rounded corners** larger than `4px` anywhere. Inputs, buttons, and the board are close to sharp. The world is a workshop, not a shopping app.
- **Buttons**: ink text on paper, underlined on hover. The single primary action (Continue / Send / Confirm) is filled ink `#12100C` on paper with white text — one per view. The vermillion is reserved strictly for state signals, never for buttons.

## The board (the object)

- 8×8 grid at exactly `min(90vw, 640px)`. Squares are `--paper` (light) and `--walnut` (dark). Flat fills. No gradient, no bevel, no glow, no shadow.
- Coordinates rendered in `10px` monospace at the outer corners of each edge (not inside squares) — the previous round put tiny 9's *inside* squares, which competes with the pieces.
- Pieces: FILLED Unicode Staunton glyphs (`♚♛♜♝♞♟`) for **both** sides — the outline "white" glyphs (`♔♕♖♗♘♙`) have transparent interiors and turn to mud on walnut squares. Differentiate by color: `--paper` fill for white with a 1px `--walnut-2` contrast stroke via four-corner text-shadow so bone pieces read on paper squares too; `--ink` fill for black (7:1 contrast on walnut — AAA — no stroke needed). Font size = 74% of the square (previously ~55% — pieces looked skeletal). Optical baseline nudge so pawns don't float. Rationale: this is what physical Bauhaus/Man Ray sets do — Hartwig's whites are pale wood, not wireframes.
- **Legal-move indicator**: a single vermillion dot at square center (`8px`, `--vermillion`) — a coin drop, not a fill. If it's a capture: vermillion ring outlining the target square instead. Never both.
- **Last move**: subtle vermillion outline (`1.5px`) on origin + destination squares. Fades after 800ms to a walnut hairline that stays until the next move.
- **Selected square**: walnut hairline outline (`1.5px inset`).

## Landing / auth

This is the surface the last round completely failed on. Fix:

The landing is a **real 8×8 board** rendered by the actual `<Board>` component, statically in the initial position, filling the left half of the desktop viewport. On mobile it sits above the form at ~90vw. On the right (desktop) / below (mobile):

- The wordmark, tightly tracked lowercase.
- **One line of functional copy**, not a poem: `Play chess with people you actually know.`
- Handle input.
- Continue button (morphs to "Create passkey" as the current logic already does).
- One line of small print about passkeys.

That's it. The board's presence IS the argument. No serif hero headline. No "A quiet board. Only your friends." No animation.

Rationale: this maps directly to Rodchenko's chess table — the object arrives before any framing text does.

## Dashboard

- Single narrow paper column, `max-width: 640px`, `padding: 48px 24px`.
- Wordmark top-left; `@handle` + Sign-out top-right; one walnut hairline underneath.
- Sections in this order, separated by whitespace only (never boxed):
  1. **Play** — friend picker (a real list of friend rows, not a select), rapid/blitz toggle as underlined text (10|0 · 5|0), one primary Send button.
  2. **Friends** — list of friend rows: `@handle` left, presence dot right. Add-friend input inline at the top.
  3. **Incoming** — only rendered when non-empty. Friend requests and challenges appear as inline vermillion-outlined blocks — no card chrome, just a 1px vermillion border-left and a bit of padding. When absent, this section renders nothing (not "no incoming").
  4. **Games** — minimal rows: `board thumbnail` (a real miniature `<Board>` at 64px) + `@opponent` + result + time. Clickable. The thumbnails do the visual work; the whole app is the board, at every scale.
- Notification-permission prompt: one inline sentence with an "Enable notifications" ink link, not a banner.
- Install prompt: same treatment.

## Game

- Two thin opponent strips (above/below the board), each carrying only: presence dot · `@handle` · big monospace clock. The **vermillion dot appears next to the handle whose turn it is** — this replaces "Their move" as a heading. State communicated by geometry, not by a sentence.
- Board centered, no visible frame.
- Side rail (desktop only): move list in two monospace columns; below it, `Home` and `Resign` as underlined text buttons. Confirm-resign is a second underlined text button, in vermillion.
- Terminal states (`checkmate`, `resigned`, `timeout`) render as a single line of monospace across the middle of the board area — flat, factual, without a modal.
- Reconnection state ("reconnecting", "opponent gone") shown as the presence dot going hollow, plus one line of muted stone-colored microcopy under the strip.

## What we are NOT doing (explicit rejections)

- No serif hero headlines. The previous round's "A quiet board. Only your friends." is out.
- No blue, purple, indigo. No "AI purple" glow anywhere.
- No cards, no rounded 2xl containers, no `shadow-md`, no glassmorphism.
- No bento grid. This is a chess app, not a SaaS landing.
- No animated backgrounds, no perpetual motion loops, no magnetic buttons.
- No dark mode this round. The world is warm daylight; a dark mode would betray it. Add later if Tejas asks.
- No emoji, no lucide icons except the ones already needed for the passkey/enable-notifications flow.
- No "presence" heading with the word HERE in all-caps under a handle — replaced by the vermillion dot.
- No eyebrow kicker tags, no numbered section headers, no "01. Play" section markers.
- No product-name change. Wordmark stays `chess with friends` until Tejas names the app.

## Constraints honored

- No server logic, no realtime code, no auth flow changes, no notification-policy edits — purely visual + minor markup + functional copy.
- All e2e text selectors preserved (`your_handle`, `friend_handle`, `Continue`, `Create passkey`, `Send`, `Propose`, `Resign`, `Confirm resign`, `Home`, `Send friend request`, `Enable notifications`, `.friend-card`, `.board`, `[data-square="..."]`, `Friend request sent.`, `Notifications enabled ...`, `checkmate`, `timeout`, `resigned`, `accepted`, `ready`, `connected`, `reconnecting`, `online`, `offline`).
- Presence labels stay `here` / `away` / `offline` in the DOM (accessible name preserved) — visually replaced by the dot state, so the label stays as an `aria-label`.

## Sanity check against masterwork bar

Placed side-by-side with the seven references: the landing needs to hold up next to the Rodchenko chess table (object + place-to-sit) and the game screen needs to hold up next to Spassky's photograph (board is the whole frame; nothing else asks for attention). Anything that fails this comparison is iterated or cut.
