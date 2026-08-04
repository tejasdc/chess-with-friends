// Verifies src/data/positions.json — each entry parses in chess.js,
// the sideToMove matches the FEN's side-to-move field, and the solution
// move is a legal one-mover that DELIVERS CHECKMATE (this shelf is
// mate-in-1 only for launch; endgame studies come later). Fails hard
// on any entry that doesn't verify so the shelf can't ship broken.

import { readFileSync } from "node:fs";
import { Chess } from "chess.js";

const positions = JSON.parse(readFileSync("src/data/positions.json", "utf8"));
const failures = [];

for (const entry of positions) {
  let chess;
  try {
    chess = new Chess(entry.fen);
  } catch (error) {
    failures.push(`${entry.id}: FEN did not parse — ${error.message}`);
    continue;
  }
  if (chess.turn() !== entry.sideToMove) {
    failures.push(`${entry.id}: sideToMove '${entry.sideToMove}' does not match FEN turn '${chess.turn()}'`);
    continue;
  }
  const legal = chess.moves({ square: entry.solution.from, verbose: true });
  const target = legal.find((m) => m.to === entry.solution.to && (!entry.solution.promotion || m.promotion === entry.solution.promotion));
  if (!target) {
    failures.push(`${entry.id}: solution ${entry.solution.from}→${entry.solution.to} is not a legal move`);
    continue;
  }
  chess.move({ from: entry.solution.from, to: entry.solution.to, promotion: entry.solution.promotion });
  if (!chess.isCheckmate()) {
    failures.push(`${entry.id}: solution move did not deliver mate (in-check=${chess.inCheck()}, over=${chess.isGameOver()})`);
  }
  // preMoves invariant (optional per entry, but if present must chain):
  // applying preMoves.moves to preMoves.fen must reproduce entry.fen and
  // every intermediate move must be legal. Enforced here so the shipped
  // JSON's replay data can never desync from the puzzle FEN.
  if (entry.preMoves) {
    const { fen: preFen, moves } = entry.preMoves;
    if (!preFen || !Array.isArray(moves) || moves.length === 0) {
      failures.push(`${entry.id}: preMoves malformed (need { fen, moves: [...] })`);
    } else {
      try {
        const pre = new Chess(preFen);
        let ok = true;
        for (const move of moves) {
          if (!pre.move(move)) { failures.push(`${entry.id}: preMove '${move}' illegal from ${pre.fen()}`); ok = false; break; }
        }
        if (ok && pre.fen() !== entry.fen) {
          failures.push(`${entry.id}: preMoves apply → ${pre.fen()}, expected puzzle fen ${entry.fen}`);
        }
      } catch (error) {
        failures.push(`${entry.id}: preMoves.fen did not parse — ${error.message}`);
      }
    }
  }
}

if (failures.length) {
  console.error("Position shelf verification FAILED:");
  for (const line of failures) console.error("  - " + line);
  console.error(`\n${failures.length} of ${positions.length} entries failed.`);
  process.exit(1);
}

// Report the piece-count profile of the shelf and the transition-density
// heuristic (how many squares change between adjacent entries).
function pieceCount(fen) {
  return fen.split(" ")[0].replace(/[^a-zA-Z]/g, "").length;
}
function squareDelta(fenA, fenB) {
  const a = expand(fenA.split(" ")[0]);
  const b = expand(fenB.split(" ")[0]);
  let d = 0;
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++;
  return d;
}
function expand(rows) {
  let out = "";
  for (const ch of rows) {
    if (ch === "/") continue;
    if (/\d/.test(ch)) out += " ".repeat(Number(ch));
    else out += ch;
  }
  return out;
}
let totalDelta = 0;
for (let i = 1; i < positions.length; i++) totalDelta += squareDelta(positions[i - 1].fen, positions[i].fen);
console.log(`Position shelf verified: ${positions.length} entries, all deliver mate-in-1.`);
console.log(`Piece counts: min ${Math.min(...positions.map(p => pieceCount(p.fen)))}, max ${Math.max(...positions.map(p => pieceCount(p.fen)))}, mean ${(positions.reduce((s, p) => s + pieceCount(p.fen), 0) / positions.length).toFixed(1)}.`);
console.log(`Adjacent-position square-delta: total ${totalDelta}, mean ${(totalDelta / (positions.length - 1)).toFixed(1)} squares differ between neighbours.`);
