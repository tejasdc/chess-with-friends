// Stream-filter the Lichess puzzle CSV from stdin and write reproducible
// source rows for src/data/positions.json.
//
// Usage:
//   curl -L https://database.lichess.org/lichess_db_puzzle.csv.zst \
//     | zstd -dc \
//     | node scripts/harvest-lichess-mate-in-1.mjs

import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { Chess } from "chess.js";

const OUT_PATH = "src/data/lichess-mate-in-1-sources.json";
const CANDIDATE_LIMIT = Number(process.env.CANDIDATE_LIMIT ?? 40);
const KEEP_LIMIT = Number(process.env.KEEP_LIMIT ?? 20);
const MIN_POPULARITY = Number(process.env.MIN_POPULARITY ?? 90);
const MIN_PLAYS = Number(process.env.MIN_PLAYS ?? 1000);
const MIN_RATING = Number(process.env.MIN_RATING ?? 800);
const MAX_RATING = Number(process.env.MAX_RATING ?? 1500);

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

function uciToMove(uci) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error(`invalid UCI move '${uci}'`);
  const move = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
  if (uci.length === 5) move.promotion = uci[4];
  return move;
}

function verifiedPostSetup(row) {
  const moves = row.moves.trim().split(/\s+/);
  if (moves.length !== 2) throw new Error(`expected setup + one solution, got ${moves.length}`);

  const chess = new Chess(row.fen);
  const setup = chess.move(uciToMove(moves[0]));
  if (!setup) throw new Error(`setup move ${moves[0]} is illegal`);

  const fen = chess.fen();
  const sideToMove = chess.turn();
  if (fen.split(" ")[1] !== sideToMove) throw new Error("post-setup turn mismatch");

  const solution = uciToMove(moves[1]);
  const legal = chess.moves({ square: solution.from, verbose: true });
  const target = legal.find((m) => (
    m.to === solution.to
    && (!solution.promotion || m.promotion === solution.promotion)
  ));
  if (!target) throw new Error(`solution ${moves[1]} is illegal`);

  chess.move(solution);
  if (!chess.isCheckmate()) throw new Error(`solution ${moves[1]} did not deliver mate`);
  return { fen, sideToMove, solution };
}

function asSource(row) {
  return {
    puzzleId: row.puzzleId,
    fen: row.fen,
    moves: row.moves.trim().split(/\s+/),
    rating: row.rating,
    ratingDeviation: row.ratingDeviation,
    popularity: row.popularity,
    nbPlays: row.nbPlays,
    themes: row.themes,
    gameUrl: row.gameUrl,
    openingTags: row.openingTags,
  };
}

const candidates = [];
let lines = 0;
let filtered = 0;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  lines++;
  if (lines === 1 && line.startsWith("PuzzleId,")) continue;
  if (!line) continue;

  const cells = parseCsvLine(line);
  if (cells.length < 10) continue;
  const [
    puzzleId,
    fen,
    moves,
    ratingRaw,
    ratingDeviationRaw,
    popularityRaw,
    nbPlaysRaw,
    themes,
    gameUrl,
    openingTags,
  ] = cells;

  const themeTokens = themes.split(/\s+/);
  if (!themeTokens.includes("mateIn1")) continue;

  const rating = Number(ratingRaw);
  const ratingDeviation = Number(ratingDeviationRaw);
  const popularity = Number(popularityRaw);
  const nbPlays = Number(nbPlaysRaw);
  if (
    popularity < MIN_POPULARITY
    || nbPlays < MIN_PLAYS
    || rating < MIN_RATING
    || rating > MAX_RATING
  ) continue;

  filtered++;
  candidates.push({
    puzzleId,
    fen,
    moves,
    rating,
    ratingDeviation,
    popularity,
    nbPlays,
    themes,
    gameUrl,
    openingTags,
  });
}

candidates.sort((a, b) => b.nbPlays - a.nbPlays || b.popularity - a.popularity || a.rating - b.rating);

const selected = [];
const rejected = [];
const seenFens = new Set();
for (const row of candidates.slice(0, CANDIDATE_LIMIT)) {
  try {
    const verified = verifiedPostSetup(row);
    if (seenFens.has(verified.fen)) {
      rejected.push(`${row.puzzleId}: duplicate post-setup FEN`);
      continue;
    }
    seenFens.add(verified.fen);
    selected.push(asSource(row));
    if (selected.length >= KEEP_LIMIT) break;
  } catch (error) {
    rejected.push(`${row.puzzleId}: ${error.message}`);
  }
}

if (selected.length < KEEP_LIMIT) {
  console.error(`Only selected ${selected.length}/${KEEP_LIMIT}; raise CANDIDATE_LIMIT or relax filters.`);
  if (rejected.length) {
    console.error("Rejected:");
    for (const line of rejected) console.error(`  - ${line}`);
  }
  process.exit(1);
}

writeFileSync(OUT_PATH, JSON.stringify(selected, null, 2) + "\n");
console.log(`Read ${lines} CSV lines; ${filtered} matched filters.`);
console.log(`Wrote ${OUT_PATH} with ${selected.length} verified Lichess mate-in-1 sources from top ${CANDIDATE_LIMIT} by NbPlays.`);
console.log(`PuzzleIds: ${selected.map((row) => row.puzzleId).join(", ")}`);
if (rejected.length) {
  console.log(`Rejected ${rejected.length} candidates before selection:`);
  for (const line of rejected) console.log(`  - ${line}`);
}
