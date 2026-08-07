# Landing CTA fix summary

## Changes

- Removed side-to-move text from landing puzzle citations.
- Kept black-to-move puzzles in the landing shelf.
- Oriented the landing board by `position.sideToMove`, so the side to move is always at the bottom.
- Updated landing piece coordinate math, route animation coordinates, and tray placement to use the active orientation.
- Added a short opacity fade when the shelf changes orientation so the walk-through does not show a raw mid-animation board flip.
- Tightened CTA headline rendering so the first caption line reads `YOUR MOVE ↑`.

## Verification

- `npm run typecheck` passed.
- Headed Chromium via Playwright loaded `http://127.0.0.1:5173/` with `/api/me` intercepted as signed out for landing verification.
- Initial caption verified as:
  - `YOUR MOVE ↑`
  - `Scholar's Mate — 1656`
- Advanced through Scholar's Mate and Opera-house Mate to Fool's Mate.
- Fool's Mate verified with `data-orientation="b"`, top-left square `h1`, bottom-right square `a8`, black queen below board center, and white king above board center.
- Walk transitions completed to the next puzzle without runtime errors.
