// Builds src/data/positions.json by CONSTRUCTING each candidate and
// verifying it delivers mate-in-1 in the same pass. A candidate that
// doesn't verify is REJECTED (never written) — the shelf ships only
// positions I can defend. Hand-typed FEN was too error-prone, so
// positions are built either by playing SAN moves through chess.js
// or by composing a 64-square placement grid.

import { writeFileSync } from "node:fs";
import { Chess } from "chess.js";

function playedFrom(moves) {
  const chess = new Chess();
  for (const move of moves) chess.move(move);
  return chess.fen();
}

// Compose a valid FEN from a 64-square placement string (rank 8 first,
// left-to-right, dot for empty).
function custom(placement, turn) {
  if (placement.length !== 64) throw new Error(`custom placement must be 64 chars, got ${placement.length}`);
  const rows = [];
  for (let r = 0; r < 8; r++) {
    const rank = placement.slice(r * 8, r * 8 + 8);
    let row = "";
    let empty = 0;
    for (const ch of rank) {
      if (ch === ".") { empty++; continue; }
      if (empty) { row += String(empty); empty = 0; }
      row += ch;
    }
    if (empty) row += String(empty);
    rows.push(row);
  }
  return `${rows.join("/")} ${turn} - - 0 1`;
}

const candidates = [
  {
    id: "fools-mate-1836",
    title: "Fool's mate",
    credit: "Traditional; earliest published 1836",
    fen: playedFrom(["f3", "e5", "g4"]),
    solution: { from: "d8", to: "h4" },
  },
  {
    id: "scholars-mate-1656",
    title: "Scholar's mate",
    credit: "Francis Beale, 1656",
    fen: playedFrom(["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6"]),
    solution: { from: "h5", to: "f7" },
  },
  {
    id: "back-rank-mate-white",
    title: "Back-rank mate",
    credit: "Traditional pattern",
    fen: custom(
      "......k." +
      ".....ppp" +
      "........" +
      "........" +
      "........" +
      "........" +
      "........" +
      "R.....K.", "w"),
    solution: { from: "a1", to: "a8" },
  },
  {
    id: "back-rank-mate-black",
    title: "Back-rank mate (Black to move)",
    credit: "Traditional pattern",
    fen: custom(
      "r.....k." +
      "........" +
      "........" +
      "........" +
      "........" +
      "........" +
      ".....PPP" +
      "......K.", "b"),
    solution: { from: "a8", to: "a1" },
  },
  {
    id: "queen-h7-supported",
    title: "Queen-plus-bishop on h7",
    credit: "Traditional pattern",
    // K g1, Bishop b1 (covers h7 via b1-h7 diagonal), Q h6. Bk h8,
    // pawns g7 h7. Qxh7# — bishop supports.
    fen: custom(
      ".......k" +
      "......pp" +
      ".......Q" +
      "........" +
      "........" +
      "........" +
      "........" +
      ".B....K.", "w"),
    solution: { from: "h6", to: "h7" },
  },
  {
    id: "queen-g7-diagonal-support",
    title: "Queen on g7, bishop diagonal support",
    credit: "Traditional pattern",
    // K g1, Q g5, B b2 (b2-h8 diag covers g7). Bk g8, pawn h7 only.
    // Qg7# with king can't escape (Bb2 covers h8 via diagonal to h8).
    fen: custom(
      "......k." +
      ".......p" +
      "........" +
      "......Q." +
      "........" +
      "........" +
      ".B......" +
      "......K.", "w"),
    solution: { from: "g5", to: "g7" },
  },
  {
    id: "damiano-mate",
    title: "Damiano's mate shape",
    credit: "Pedro Damiano, 1512 (pattern)",
    // K g1, N g6, Q h5. Bk h8, black pawn h7 (pawn is the trap).
    // Qxh7# is mate: Nk covers g7/g8 exit; king can't take Q (Ng6 defends).
    fen: custom(
      ".......k" +
      ".......p" +
      "......N." +
      ".......Q" +
      "........" +
      "........" +
      "........" +
      "......K.", "w"),
    solution: { from: "h5", to: "h7" },
  },
  {
    id: "arabian-mate",
    title: "Arabian mate",
    credit: "Traditional pattern (medieval Arabic play)",
    // Bk h8, wN f6 (covers h7 and g8), wR h1. Play Rh1-h8: rook mates
    // because king can't go g7 (wN f6 covers g8 not g7 — need cover
    // for g7 too). Actually Arabian requires king boxed by knight
    // AND rook: N f6 covers g8/h7, R on 7th (say g7) covers king's
    // escape. Setup: Bk h8, wR h7 (already on 7th, checks nothing
    // from h7), no — need Rh1 → h8 with N covering escape.
    // Correct classic: Bk h8, wR h7, wN f7 (covers h6/h8 wait, N f7
    // covers h6, h8, g5, e5, d6, d8). Play... no rook already on h7.
    // Let me set up so Rook DELIVERS the mate from a distance:
    // Bk h8, wR a7 (7th rank), wN g6 (covers h8 and f8), King g1.
    // Play Ra7-a8: king can't move — h7 covered by Ra7 via nothing;
    // actually a7 doesn't cover h7. King moves to h7. Not mate.
    // Use: Bk h8, wR h1, wN g6 (covers h8 and f8). Play Rh1-h8: king
    // can't stay, must go g7. Ng6 doesn't cover g7. Not mate.
    // Skipping — too fiddly to compose reliably without misattribution.
    _skip: true,
  },
  {
    id: "smothered-mate",
    title: "Smothered mate (knight to f7)",
    credit: "Traditional pattern (Philidor's Legacy shape)",
    // Bk h8 SMOTHERED by own pieces: g8 blocked by own rook, h7 by
    // own pawn, g7 by own pawn. wN g5 to move. Play Nf7# — no capture,
    // knight lands and delivers check; king surrounded so no escape.
    fen: custom(
      "......rk" +
      "......pp" +
      "........" +
      "......N." +
      "........" +
      "........" +
      "........" +
      "......K.", "w"),
    solution: { from: "g5", to: "f7" },
  },
  {
    id: "queen-h-file-solo",
    title: "Queen on h-file, king support",
    credit: "Basic pattern",
    // K f6, Q h1. Bk h8. Qh1-h8#: queen delivers, king (f6) covers g7.
    fen: custom(
      ".......k" +
      "........" +
      ".....K.." +
      "........" +
      "........" +
      "........" +
      "........" +
      ".......Q", "w"),
    solution: { from: "h1", to: "h8" },
  },
  {
    id: "queen-supported-g8",
    title: "Queen delivers, king supports",
    credit: "Basic pattern",
    // K g6, Q g1. Bk h8.
    fen: custom(
      ".......k" +
      "........" +
      "......K." +
      "........" +
      "........" +
      "........" +
      "........" +
      "......Q.", "w"),
    solution: { from: "g1", to: "g8" },
  },
  {
    id: "rook-corner-mate",
    title: "Rook mate, king in corner",
    credit: "Basic pattern",
    // K f7 vs Bk h8; wR anywhere on h-file except adjacent. Say Rh1.
    // Play Rh1-h8: king can't go g7 (wK f7 covers it? actually f7-g7
    // are adjacent). Not mate — g7 covered by king. g8 covered by wK
    // via f7-g8 diagonal — yes.
    // Wait check: after Rh8+, king moves. Escape squares from h8:
    // g8 (empty, attacked by wK f7? f7-g8 is diagonal, yes attacked),
    // g7 (empty, attacked by wK f7? f7-g7 is direct, yes attacked),
    // h7 (attacked by Rh8? yes down file).
    // So all escapes blocked. Mate.
    fen: custom(
      ".......k" +
      ".....K.." +
      "........" +
      "........" +
      "........" +
      "........" +
      "........" +
      ".......R", "w"),
    solution: { from: "h1", to: "h8" },
  },
  {
    id: "rook-and-king-vs-king",
    title: "Rook + king vs king, opposite corner",
    credit: "Basic endgame",
    // K a6, R h1. Bk a8. Rh1-h8 wait that's not check on a8. Actually
    // Rh1 to a1 is same rank as king if king were on a1. Skip this
    // one — the classic K+R vs K mate is a longer sequence not
    // mate-in-1.
    _skip: true,
  },
  {
    id: "opera-house-final",
    title: "Opera-house mate",
    credit: "Morphy vs Duke Karl & Count Isouard, Paris 1858",
    // Full game played through chess.js — verify FEN is 17th-move
    // position where Rd8# ends it.
    fen: playedFrom([
      "e4","e5","Nf3","d6","d4","Bg4","dxe5","Bxf3","Qxf3","dxe5",
      "Bc4","Nf6","Qb3","Qe7","Nc3","c6","Bg5","b5","Nxb5","cxb5",
      "Bxb5+","Nbd7","O-O-O","Rd8","Rxd7","Rxd7","Rd1","Qe6","Bxd7+",
      "Nxd7","Qb8+","Nxb8",
    ]),
    solution: { from: "d1", to: "d8" },
  },
  {
    id: "queen-and-rook-h8",
    title: "Queen + rook cooperate",
    credit: "Traditional pattern",
    // Bk g8 in the corner-ish; wQ h5, wR h1. Play Qh5-h8+ Kf7?
    // wait needs Kg8 boxed. Let's set: Bk g8, black pawn f7 g7 h7
    // (all pawns present — natural post-castle shape). wR h1, wQ e5.
    // Play Qe5-h8: attacks king diagonally? e5-h8 diagonal (e5-f6-g7-h8)
    // — g7 blocks. So Qh8 doesn't work as diagonal. Direct file/rank:
    // Qxh8 (rook there?) no. Try: Bk g8, black P f7 g7 h7. wR e1, wB c4
    // (c4-g8 diagonal covers king). Play Re1-e8: king can't take (Bc4
    // covers e8 via c4-e6-f7? no; c4-d5-e6-f7-g8 diagonal covers g8
    // through pawn on f7. Blocked.
    // SKIP — hard to construct without an error.
    _skip: true,
  },
  {
    id: "back-rank-two-rooks",
    title: "Two-rook back rank (Black to move)",
    credit: "Traditional pattern",
    // Bk g1 (mirror). Actually let's do White-mates:
    // Bk g8, wR a1, wR a2. Play Ra1-a8. King can't move: f8 empty
    // attacked by nothing? f8 not covered. Hmm.
    // Setup: Bk g8, black pawn f7 g7 h7. wR a1, wR a2. Ra1-a8+ Kh7?
    // No, king can't move because h7 blocked by pawn, g7 blocked by
    // pawn, f8 empty. So king goes f8. Not mate.
    // Use: Bk g8, pawn f7 g7 h7. wR a1, wQ b2. Ra1-a8+ Q defends
    // nothing on 8th. King → f8? still available. Not mate.
    // SKIP — need better construction.
    _skip: true,
  },
  {
    id: "legal-mate-1750",
    title: "Legal's mate",
    credit: "Kermur de Legal, c. 1750",
    // 1.e4 e5 2.Nf3 d6 3.Bc4 Bg4 4.Nc3 g6 5.Nxe5 Bxd1 6.Bxf7+ Ke7 →
    // white plays 7.Nd5#. Position: after Bxd1 the white knight on e5
    // captures the pawn on f7 and the king is trapped.
    fen: playedFrom(["e4","e5","Nf3","d6","Bc4","Bg4","Nc3","g6","Nxe5","Bxd1","Bxf7+","Ke7"]),
    solution: { from: "c3", to: "d5" },
  },
  {
    id: "morphys-mate-shape",
    title: "Bishop + rook, back-rank check",
    credit: "Traditional pattern",
    // Bk g8, own black rook a8, black pawn f7 g7 h7. wR d1, wB c4
    // (c4 covers g8 through e6-f7 — pawn f7 blocks). Reset: use
    // Bk g8, no defenders on 8, pawn f7 g7 h7. wR d1, wB h6 (h6-g7
    // covers escape? No). Simple: two-rook back-rank
    // Bk g8, pawn f7 g7 h7. wR d1, wR e2. Play Rd1-d8+ Kh7? h7 blocked.
    // Kf7? blocked. Actually king must move: g8 attacked (Rd8),
    // h8 attacked (Rd8), f8 empty attacked (Rd8). All 8th rank attacked.
    // King's other squares: h7 blocked pawn, g7 blocked pawn, f7 blocked
    // pawn. Mate.
    fen: custom(
      "......k." +
      ".....ppp" +
      "........" +
      "........" +
      "........" +
      "........" +
      "........" +
      "...R..K.", "w"),
    solution: { from: "d1", to: "d8" },
  },
  {
    id: "queen-close-mate",
    title: "Queen close, king pinned to edge",
    credit: "Basic pattern",
    // K f6 vs Bk h6 (adjacent king support). Actually kings can't be
    // adjacent, so K on f6 and Bk on h6 = distance 2, that's fine.
    // Q g2. Play Qg2-g6: king in corner-like; escapes h5/h7 attacked
    // by Q on g6. Actually g6 next to king on h6 — Qxg6 or Qg6 checks;
    // king can go h5 (attacked by Qg6? yes adjacent), h7 (Qg6 adj — yes),
    // g5 (adj to Q — yes), g7 (adj — yes). All escapes blocked.
    // But is Qg6 defended? Q sits next to Bk without a defender — Bk
    // could capture: Kxg6? f6 wK attacks g6 via adjacency. So Kxg6
    // would put Bk adjacent to wK — illegal move (Bk can't move to
    // square attacked by wK). So it's mate.
    fen: custom(
      "........" +
      "........" +
      ".....K.k" +
      "........" +
      "........" +
      "........" +
      "......Q." +
      "........", "w"),
    solution: { from: "g2", to: "g6" },
  },
];

// Verify each candidate; only ship the ones that deliver mate-in-1.
const shipped = [];
const rejected = [];
for (const c of candidates) {
  if (c._skip) continue;
  try {
    const chess = new Chess(c.fen);
    const legal = chess.moves({ square: c.solution.from, verbose: true });
    const target = legal.find((m) => m.to === c.solution.to && (!c.solution.promotion || m.promotion === c.solution.promotion));
    if (!target) {
      rejected.push(`${c.id}: solution ${c.solution.from}→${c.solution.to} is not legal from ${c.fen}`);
      continue;
    }
    chess.move({ from: c.solution.from, to: c.solution.to, promotion: c.solution.promotion });
    if (!chess.isCheckmate()) {
      rejected.push(`${c.id}: solution did not deliver mate (in-check=${chess.inCheck()}, game-over=${chess.isGameOver()})`);
      continue;
    }
    shipped.push({
      id: c.id,
      title: c.title,
      credit: c.credit,
      fen: c.fen,
      sideToMove: new Chess(c.fen).turn(),
      solution: c.solution,
    });
  } catch (error) {
    rejected.push(`${c.id}: exception ${error.message}`);
  }
}

// Simple transition-density sort: greedy nearest-neighbour walk starting
// from the FIRST entry. Each next entry is the one that DIFFERS MOST
// from the current tail (highest square-delta) — the tumble-walk reads
// as more motion when adjacent positions look less alike.
function pieceGrid(fen) {
  const rows = fen.split(" ")[0].split("/");
  let out = "";
  for (const row of rows) for (const ch of row) if (/\d/.test(ch)) out += " ".repeat(Number(ch)); else out += ch;
  return out;
}
function squareDelta(a, b) {
  let d = 0;
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++;
  return d;
}
const ordered = [shipped[0]];
const pool = shipped.slice(1);
while (pool.length) {
  const currentGrid = pieceGrid(ordered[ordered.length - 1].fen);
  let bestIdx = 0, bestDelta = -1;
  for (let i = 0; i < pool.length; i++) {
    const d = squareDelta(currentGrid, pieceGrid(pool[i].fen));
    if (d > bestDelta) { bestDelta = d; bestIdx = i; }
  }
  ordered.push(pool.splice(bestIdx, 1)[0]);
}

writeFileSync("src/data/positions.json", JSON.stringify(ordered, null, 2) + "\n");
console.log(`Wrote src/data/positions.json — ${ordered.length} verified mate-in-1 positions.`);
if (rejected.length) {
  console.log(`\nRejected during build (${rejected.length}):`);
  for (const line of rejected) console.log("  - " + line);
}
