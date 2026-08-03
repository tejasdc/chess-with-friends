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
