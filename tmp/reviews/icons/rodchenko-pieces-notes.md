# Notes on Rodchenko's chess pieces

**Attribution first.** Rodchenko designed the *table*, chairs, and chessboard in 1925 for the Workers' Club at the Paris International Exhibition. The pieces in every photo you'll see online are the **1976 constructivist set** by **Alexander Lavrentyev** (Rodchenko's grandson) and **Irina Vasnetsova**, made to complete the table for later reconstructions. Rodchenko's own 1925 drawings — the ones Tejas provided — show the *furniture* only. Pieces are not in that sheet.

That does not disqualify them from being interesting for our own piece set. They are the most fully-committed constructivist interpretation of the chess piece that has ever survived on a real board, and they are consistent with the Rodchenko/VKhUTEMAS visual language. Treat them as a companion object, not an original.

## What the 1976 pieces actually look like

Studying `refs/wiki-03-chessboard-pieces.jpg` and `refs/fide-02.jpg`:

- **Uniform cubic base** on every piece. Same footprint, same height. All pieces stand on the same podium — the identity comes from what rises off it.
- **Vertical wooden slabs** (thin rectangular boards) rise from the base at right angles, sometimes crossed, sometimes stacked. The character of the piece is encoded by the *count, orientation, and stacking* of these slabs, never by curves.
- **Silhouette bank** (reading left-to-right on the board, best I can make out at photo resolution):
  - **Pawn** — smallest. Cubic base plus a single short vertical slab. Almost a rounded-off cube.
  - **Rook** — cubic base plus a taller square-topped block, reading like a cornerstone. Squat.
  - **Knight** — asymmetric. Cubic base with a horizontal slab jutting to one side (an L-shape, seen from the front). Only piece where the horizontal thrust is essential to the ID.
  - **Bishop** — a slab standing on its narrow edge, taller than the rook, thin from the front. Reads almost as a domino on end.
  - **Queen** — two crossed vertical slabs (a +) rising from the base. Tallest of the "many-slab" pieces.
  - **King** — the tallest. Same crossed-slabs idea as the queen, plus a small crowning cube on top.
- **Zero curves. Zero symbolism.** No horse-heads, no crosses, no crowns as ornament — the crown on the king is just a *cube*. Every recognizable chess-piece cliché has been substituted with a piece of stacked geometry that a joiner could make with a table saw. That is the whole design.
- **Colour is the only decoration.** Deep red (matching the table's red side) vs. black. No tone, no grain highlighted, no varnish sheen.

## Why they matter for our set

- They collapse the identity of each piece to the smallest possible orthogonal geometry — perfect for a screen at 40–60 px per square, where anti-aliased horse heads and mitres turn to mud. Cubes and slabs stay crisp at any size.
- The uniform base is a *system* — it says "these pieces belong together" the way Staunton says it, but with a completely different vocabulary. If we ever ship a piece set, this is a legible precedent for one.
- Two-tone palette (buff/teak vs navy, or the app's cream vs navy) maps cleanly.

## Cautions if we ever build our own

- **The knight is the whole test.** In Staunton it's the only figurative piece; in constructivist sets the knight is the piece that most often falls back on a horse-head cliché and breaks the system. Rodchenko/Lavrentyev's knight (asymmetric L) is the answer — solve the knight first, everything else follows.
- **The king–queen distinction has to survive a glance.** In the 1976 set it's "small cube crowning the crossed slabs" vs. "no cube" — that's a *very* subtle differentiator at board scale. On a screen, we'd probably need to bias one of them taller or add a second differentiator (a slab rotated 45°, an inset colour) to keep them separable at a distance.
- **These are not Rodchenko's.** If we adopt this piece language we should say so plainly in our credits — the table is Rodchenko 1925, the pieces are Lavrentyev/Vasnetsova 1976. That matters both ethically and because it's a better story than pretending.

## Reference files

- `refs/wiki-01-chess-table.jpg` — full table with pieces set up, red side view
- `refs/wiki-03-chessboard-pieces.jpg` — closest shot of the pieces
- `refs/fide-02.jpg` — pieces mid-game, both colours visible, board notation just visible on the frame
