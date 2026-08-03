# Progress

## Prior round (Codex chaturanga redesign) — REJECTED
Tejas: "still looks super rudimentary… ugly boxes." Custom chaturanga piece
glyphs rejected as illegible; "Chaturanga lineage", "Sit down when your friend
is ready", "Board table", "Circle", "Time & place" copy rejected as self-annotating;
the whole cards-with-kicker-labels layout rejected. Two-button auth (Create passkey /
Sign in) rejected as confusing.

## This round — chess-designer (Claude)
- Direction: one quiet warm-paper world, board is the hero, no boxes, no ornament,
  copy is functional labels only. Standard Unicode Staunton pieces
  (outline ♔♕♖♗♘♙ for white, filled ♚♛♜♝♞♟ for black) — universally legible on
  every device, zero custom glyphs needed.
- Palette: paper #f5f1e8, ink #17140f, walnut board #7a6248, moss accent #3f5d4a
  used sparingly; terracotta #b04a2f only for destructive/error.
- Type: system-ui for UI, New York/Iowan Old Style serif for the auth title only,
  monospace for clocks + moves.
- Auth flow: single input + single primary button. Button says "Continue"; on
  "no account with that handle" from the server, it morphs to "Create passkey"
  with an inline explainer. Same button element throughout — no more forked
  register/login choice on first sight.
- Dashboard: unified single column with type + whitespace hierarchy. No boxed
  cards, no kickers. Sections: play (friend + time control + Send / Schedule),
  friends (add + list), incoming (requests + challenges shown as inline callouts
  only when present), games (minimal rows), install prompt only when needed.
- Game screen: board centered; two thin clock rows above/below carry only the
  handle and time; a compact side rail holds only Home + Resign + moves.

## Selectors preserved for e2e (never weakened)
- placeholders: `your_handle`, `friend_handle`
- buttons: `Enable notifications`, `Accept`, `Add`, `Send`, `Propose`,
  `Resign`, `Confirm resign`, `Home`, `Send friend request`, `Create passkey`
- text signals: `Friend request sent.`,
  `Notifications enabled for friend requests, challenges, and scheduled games.`,
  `checkmate`, `timeout`, `resigned`, `accepted`, `ready`, `connected`,
  `reconnecting`, `online`, `offline`
- classes / attrs: `.friend-card`, `.board`, `[data-square="…"]`

## Test change
- `register()` helper now clicks Continue first (server confirms handle is
  unknown), then Create passkey. Same flow the real UX will surface.

## Files touched
- src/main.tsx — full rewrite
- src/styles.css — full rewrite
- index.html — theme-color updated
- tests/e2e.spec.ts — register() helper: Continue then Create passkey

## Done
- Typecheck + build + full e2e all green.
- Two rounds of Playwright screenshots at 390px and 1200px, inspected and iterated
  (mobile topbar wordmark wrap fixed, disabled primary made ghost, tabs turned into
  underline instead of pill, desktop game shell widened to 1040px so the board
  breathes).
- Committed as `9f01e3e Redesign: quiet warm-paper world, board is the hero`.
- Deployed to Cloudflare Worker `chess-with-friends`, version
  `6b3db249-a41a-4709-b955-eced5421a9d0`. Prod smoke checks green:
  `/api/health`, CF Insights beacon count = 1, `chess.tejas.nyc` serves the new
  asset hashes after CF edge cache flush.
- Final report at `tmp/reviews/claude-redesign-report.md`.

## Round: Villalba build (2026-08-03, chess-design-2)

Register decided: Villalba wins with palette from tejas.nyc/projects (not the photo). Locked tokens:

- Grounds: `#081a18` deepest / `#0F201E` deep / `#1b2a26` panel
- Teals: `#3E8C82` mid (site ground) / `#4E9E92` teal-2 / `#57A89B` teal-light
- Cream: `#E9DFA0` (khaki-cream — jewel accent, ex-vermillion)
- Board light = cream `#E9DFA0`, board dark = deep teal `#0F201E`
- Ink for text: `#081a18` on light grounds; cream on deep

Vermillion DEAD (except perhaps as a still-red pin state signal — TBD by masterwork bar).

Scope:
- Drop incision line unless it earns place on dark ground (default drop).
- Sandbox landing board — real chess.js legal moves, no goal, 20s idle reset.
- ONE ⋯ menu pattern top-right on every screen; build open state (Sign out / Install / Inspirations).
- New /inspirations attribution page (Rodchenko / Hartwig / Villalba + photo credits).
- Game screen fixed viewport, captured pieces stay BIG.
- Carry over untouched: auth matrix, morph, toast, presence, reconnect.
