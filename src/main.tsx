import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Chess, type Color, type Move as ChessMove, type PieceSymbol, type Square } from "chess.js";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import shelfPositions from "./data/positions.json";
import "./styles.css";

type ShelfPosition = {
  id: string;
  title: string;
  credit: string;
  fen: string;
  sideToMove: Color;
  solution: { from: Square; to: Square; promotion?: "q" | "r" | "b" | "n" };
  preMoves?: { fen: string; moves: string[] };
};

type ShelfPiece = {
  id: string;
  sq: Square | null;
  color: Color;
  type: PieceSymbol;
  char: string;
  x: number;
  y: number;
  rot: number;
  live: boolean;
  fadeIn?: boolean;
};

type ShelfMetrics = {
  stageW: number;
  stageH: number;
  boardX: number;
  boardY: number;
  boardW: number;
  boardH: number;
  sqSize: number;
};

type WalkPoint = { x: number; y: number };
type LegalPathResult = { ok: true; waypoints: WalkPoint[] } | { ok: false; waypoints?: undefined };
type LandingWalk = {
  piece: ShelfPiece;
  waypoints: WalkPoint[];
  segCount: number;
  startAt: number;
  duration: number;
  endCX: number;
  endCY: number;
  startAngle: number;
  isTray: boolean;
  fadeIn: boolean;
  isKnight: boolean;
};

const WALK_SEG_MS = 380;
const WALK_MAX_SEGS = 6;
const WALK_SETTLE_MS = 200;
const REPLAY_SEG_MS = 520;
const REPLAY_BEAT_MS = 420;
const KNIGHT_ARC_RATIO = 0.16;
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const LANDING_COPY = "No infinite pool of opponents. A game happens when two friends sit down.";
const shelf = shelfPositions as ShelfPosition[];

// Belt-and-suspenders around the shelf. The ownership refactor above is
// the real fix for the ~round-3 NotFoundError; this boundary catches any
// future ownership violation (or unrelated shelf error) and hard-resets
// via a fresh key so the crash degrades to a stutter, never a dead page.
class LandingShelfErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { resetKey: number }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { resetKey: 0 };
  }
  static getDerivedStateFromError() { return {}; }
  componentDidCatch(error: unknown) {
    // Bump the key so the child unmounts + remounts fresh. Log for
    // observability; do NOT surface to the user — the reset IS the UX.
    // eslint-disable-next-line no-console
    console.error("LandingPuzzleShelf error — resetting shelf:", error);
    this.setState((prev) => ({ resetKey: prev.resetKey + 1 }));
  }
  render() {
    return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>;
  }
}

function LandingPuzzleShelf() {
  // OWNERSHIP MODEL (fix for pre-`live-crash` NotFoundError):
  //
  // The animation code (walkLandingPieces, applyLandingMove, wobble) is
  // imperative — it creates, moves, and removes piece DOM nodes directly.
  // Previously React ALSO owned those nodes (rendered them via a keyed
  // `pieces.map(...)` under `piecesLayerRef`), so React tried to unmount
  // detached nodes → `removeChild` NotFoundError → the whole shelf
  // unmounted on ~round 3.
  //
  // Fix: the pieces layer is now an OPAQUE ref'd container React never
  // enumerates. React renders the outer wrapper only; every piece under
  // it is created, mutated, and destroyed exclusively by the imperative
  // code below (piecesLayerRef.current.appendChild / removeChild / style
  // writes / pieceEls map). React reconciliation touches nothing under
  // that ref. Single writer per DOM node — the crash's root cause is
  // eliminated by ownership discipline, not patched at the symptom.
  //
  // React state that remains (index, selected, animating, metrics) drives
  // things React DOES own — the caption, the squares grid, the shelf's
  // data-puzzle-id, the animating flag on the outer div. Those never
  // require touching the pieces layer's children through React.
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<Square | null>(null);
  const [animating, setAnimating] = useState(false);
  const [metrics, setMetrics] = useState<ShelfMetrics | null>(null);
  // Last-move wash on the from + to squares of the LAST preMove that led
  // to the current puzzle FEN. Set on first mount (position is already
  // post-preMove — the walk hasn't run, but the wash represents the
  // implied history) and after each replay completes. Cleared during
  // the walk so the transitioning board doesn't hold a wash from the
  // OUTGOING position.
  const [lastMove, setLastMove] = useState<{ from: Square; to: Square } | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const piecesLayerRef = React.useRef<HTMLDivElement | null>(null);
  const pieceEls = React.useRef(new Map<string, HTMLSpanElement>());
  const piecesRef = React.useRef<ShelfPiece[]>([]);
  const trayRef = React.useRef<ShelfPiece[]>([]);
  const gameRef = React.useRef(new Chess(shelf[0].fen));
  const selectedRef = React.useRef<Square | null>(null);
  const animatingRef = React.useRef(false);
  const moveTimer = React.useRef<number | null>(null);
  const rafRef = React.useRef<number | null>(null);

  const position = shelf[index];

  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { animatingRef.current = animating; }, [animating]);

  useEffect(() => {
    function measure() {
      const node = stageRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const stageW = rect.width;
      const stageH = rect.height;
      // Stage is now aspect-ratio 1/1.18 (see .puzzle-stage in styles.css)
      // to reserve vertical space for tray zones above and below the
      // board. Board frame is fixed 88% wide and self-square (CSS
      // aspect-ratio 1/1) — position it centered in the stage box so
      // the top/bottom margins hold the tray pieces without clipping.
      const framePad = stageW * 0.0175;
      const frameW = stageW * 0.88;
      const boardW = frameW - framePad * 2;
      const boardH = boardW;
      const boardX = (stageW - boardW) / 2;
      const boardY = (stageH - boardH) / 2;
      const sqSize = boardW / 8;
      setMetrics({ stageW, stageH, boardX, boardY, boardW, boardH, sqSize });
    }
    measure();
    const observer = new ResizeObserver(measure);
    if (stageRef.current) observer.observe(stageRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Imperative mount/reset of the pieces layer. Runs when metrics land
  // (first measure) and when the puzzle index changes NOT via the walk
  // (index=0 first mount, or a manual reset from the error boundary).
  // Wipes any prior pieces from the layer and creates fresh DOM nodes
  // for the current position. React NEVER runs after this — the layer's
  // children are ours alone.
  useEffect(() => {
    if (!metrics) return;
    const layer = piecesLayerRef.current;
    if (!layer) return;
    // If a walk is in-flight, don't yank the DOM out from under it.
    if (animatingRef.current) return;
    // Wipe stale nodes (also drops the pieceEls map so refs point at
    // real DOM only).
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    pieceEls.current.clear();
    const onBoard = piecesFromFen(position.fen, metrics);
    // First-load / non-animated re-seed: populate the trays with the
    // full off-board complement (every piece from a standard 32-piece
    // set not currently on the board) so the initial view of the sparse
    // opener reads with the same visual honesty as later transitions
    // — captured/absent pieces sit BESIDE the board, not missing.
    const initialTray = offBoardPieces(position.fen, metrics);
    piecesRef.current = onBoard;
    trayRef.current = initialTray;
    gameRef.current = new Chess(position.fen);
    for (const piece of onBoard) {
      const el = createLandingPieceEl(piece, metrics);
      layer.appendChild(el);
      pieceEls.current.set(piece.id, el);
    }
    for (const piece of initialTray) {
      const el = createLandingPieceEl(piece, metrics);
      layer.appendChild(el);
      pieceEls.current.set(piece.id, el);
    }
    setSelected(null);
    // Wash represents the implied history of the current puzzle FEN —
    // the last move that led to it. This fires on first mount (index=0)
    // and on any non-animated reset (error boundary bump); it does NOT
    // fire during a normal transition (guarded by animatingRef above),
    // where transitionToNext manages the wash lifecycle explicitly.
    setLastMove(computeLastMove(position));
  }, [metrics, index]);

  useEffect(() => {
    if (!metrics || animatingRef.current) return;
    for (const piece of [...piecesRef.current, ...trayRef.current]) {
      if (piece.sq) {
        const { x, y } = squareToXY(piece.sq, metrics);
        piece.x = x;
        piece.y = y;
      }
      const el = pieceEls.current.get(piece.id);
      if (el) sizeAndPlacePiece(el, piece, metrics);
    }
  }, [metrics]);

  useEffect(() => {
    return () => {
      if (moveTimer.current !== null) window.clearTimeout(moveTimer.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Imperative selected-class effect. React can't map `selected` → the
  // piece's `.selected` class because it doesn't render pieces. Do it
  // ourselves via the pieceEls map: drop the class from every piece
  // that carries it, add it to the one on the currently-selected sq.
  useEffect(() => {
    for (const el of pieceEls.current.values()) el.classList.remove("selected");
    if (!selected) return;
    const piece = piecesRef.current.find((p) => p.sq === selected);
    if (!piece) return;
    const el = pieceEls.current.get(piece.id);
    if (el) el.classList.add("selected");
  }, [selected]);

  const legalTargets = useMemo(() => {
    if (!selected || animating) return new Map<string, "move" | "capture">();
    const moves = gameRef.current.moves({ square: selected, verbose: true }) as Array<{ to: string; captured?: string; flags: string }>;
    const map = new Map<string, "move" | "capture">();
    for (const move of moves) {
      map.set(move.to, move.captured || move.flags.includes("e") ? "capture" : "move");
    }
    return map;
  }, [selected, animating]);

  function clearSelection() {
    setSelected(null);
    selectedRef.current = null;
  }

  function wobble(square: Square) {
    const piece = piecesRef.current.find((p) => p.sq === square);
    if (!piece) return;
    const el = pieceEls.current.get(piece.id);
    if (!el) return;
    el.classList.add("stuck");
    const start = performance.now();
    const dur = 360;
    const amp = 4;
    const tick = (now: number) => {
      const t = (now - start) / dur;
      if (t >= 1) {
        piece.rot = 0;
        el.style.transform = landingPieceTransform(piece.x, piece.y, 0, 1);
        el.classList.remove("stuck");
        return;
      }
      const angleDeg = Math.sin(t * Math.PI * 1.5) * amp * (1 - t);
      el.style.transform = landingPieceTransform(piece.x, piece.y, angleDeg, 1);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function choose(square: Square) {
    if (animatingRef.current || !metrics) return;
    const chess = gameRef.current;
    const targetPiece = chess.get(square);
    const solution = position.solution;
    const selectedSquare = selectedRef.current;

    if (!selectedSquare) {
      if (!targetPiece) return;
      if (targetPiece.color !== chess.turn()) {
        wobble(square);
        clearSelection();
        return;
      }
      const moves = chess.moves({ square, verbose: true }) as Array<{ to: string }>;
      if (!moves.some((move) => move.to === solution.to && square === solution.from)) {
        wobble(square);
        clearSelection();
        return;
      }
      setSelected(square);
      selectedRef.current = square;
      return;
    }

    if (selectedSquare === square) {
      clearSelection();
      return;
    }

    if (targetPiece && targetPiece.color === chess.turn()) {
      const moves = chess.moves({ square, verbose: true }) as Array<{ to: string }>;
      if (moves.some((move) => move.to === solution.to && square === solution.from)) {
        setSelected(square);
        selectedRef.current = square;
      } else {
        wobble(square);
        clearSelection();
      }
      return;
    }

    const legalMoves = chess.moves({ square: selectedSquare, verbose: true }) as Array<{ to: string }>;
    if (!legalMoves.some((move) => move.to === square)) {
      clearSelection();
      return;
    }
    if (selectedSquare !== solution.from || square !== solution.to) {
      clearSelection();
      return;
    }

    try {
      const move = chess.move({ from: selectedSquare, to: square, promotion: solution.promotion ?? "q" });
      if (!move) return clearSelection();
      applyLandingMove(selectedSquare, square, metrics);
      clearSelection();
      moveTimer.current = window.setTimeout(() => {
        void transitionToNext();
      }, 280);
    } catch {
      clearSelection();
    }
  }

  async function transitionToNext() {
    if (!metrics || animatingRef.current) return;
    setAnimating(true);
    animatingRef.current = true;
    // A new puzzle is a NEW GAME. Clear every trace of the outgoing
    // puzzle's transient state (Tejas 2026-08-04: after solving, the
    // next puzzle showed the previous move's square marked "kind of
    // like selected"). React-owned state: selected, lastMove. Ref-
    // mirrored: selectedRef. Imperative DOM: the piece-selected class
    // added by the [selected] effect on the pieces layer. Belt-and-
    // suspenders — clear all four synchronously here so nothing lingers
    // across the walk. The [selected] effect will also fire and drop
    // classes, but doing it imperatively too guards against React
    // scheduling gaps on mobile Safari.
    setSelected(null);
    selectedRef.current = null;
    setLastMove(null);
    for (const el of pieceEls.current.values()) el.classList.remove("selected");
    const nextIndex = (index + 1) % shelf.length;
    const nextPosition = shelf[nextIndex];
    setIndex(nextIndex);
    const setupFen = nextPosition.preMoves?.fen ?? nextPosition.fen;
    setWalkPhase("setup");
    await walkToFen(setupFen, metrics);
    if (nextPosition.preMoves) {
      setWalkPhase("replay");
      gameRef.current = new Chess(nextPosition.preMoves.fen);
      await replayMoves(nextPosition.preMoves.moves, metrics);
    }
    setWalkPhase("idle");
    gameRef.current = new Chess(nextPosition.fen);
    setAnimating(false);
    animatingRef.current = false;
    setLastMove(computeLastMove(nextPosition));
  }

  function applyLandingMove(from: Square, to: Square, m: ShelfMetrics) {
    const mover = piecesRef.current.find((piece) => piece.sq === from);
    if (!mover) return;
    const captured = piecesRef.current.find((piece) => piece.sq === to && piece !== mover);
    if (captured) {
      // Safe now that the pieces layer is opaque to React (see the
      // ownership comment at the top of LandingPuzzleShelf). Nobody
      // else claims this node, so removing it here can't collide with
      // React reconciliation.
      const capturedEl = pieceEls.current.get(captured.id);
      capturedEl?.remove();
      pieceEls.current.delete(captured.id);
      piecesRef.current = piecesRef.current.filter((piece) => piece !== captured);
    }
    mover.sq = to;
    const { x, y } = squareToXY(to, m);
    mover.x = x;
    mover.y = y;
    const el = pieceEls.current.get(mover.id);
    if (el) {
      el.dataset.square = to;
      el.style.transition = "transform 220ms cubic-bezier(0.16, 1, 0.3, 1)";
      el.style.transform = landingPieceTransform(x, y, 0, 1);
      window.setTimeout(() => { el.style.transition = ""; }, 260);
    }
  }

  function ensurePieceElement(piece: ShelfPiece, m: ShelfMetrics) {
    if (pieceEls.current.has(piece.id)) return;
    const layer = piecesLayerRef.current;
    if (!layer) return;
    const el = createLandingPieceEl(piece, m);
    layer.appendChild(el);
    pieceEls.current.set(piece.id, el);
  }

  function setWalkPhase(phase: "idle" | "setup" | "replay") {
    const layer = piecesLayerRef.current;
    if (layer) layer.dataset.walkPhase = phase;
  }

  function syncPieceElement(piece: ShelfPiece, m: ShelfMetrics) {
    const el = pieceEls.current.get(piece.id);
    if (!el) return;
    el.classList.toggle("live", piece.live);
    el.dataset.square = piece.sq || "tray";
    el.dataset.piece = `${piece.color}${piece.type}`;
    el.textContent = filledGlyphs[piece.type];
    sizeAndPlacePiece(el, piece, m);
  }

  function makeWalk(piece: ShelfPiece, waypoints: WalkPoint[], opts: {
    startAt?: number;
    segMs?: number;
    isTray?: boolean;
    fadeIn?: boolean;
    isKnight?: boolean;
    forceEvenIfShort?: boolean;
  } = {}): LandingWalk | null {
    if (!waypoints || waypoints.length < 2) return null;
    const first = waypoints[0];
    const last = waypoints[waypoints.length - 1];
    const dist = Math.hypot(last.x - first.x, last.y - first.y);
    if (dist < currentRouteMetrics().sqSize * 0.06 && waypoints.length === 2 && !opts.forceEvenIfShort) return null;
    let route = waypoints;
    let segCount = route.length - 1;
    if (segCount > WALK_MAX_SEGS) {
      const stride = Math.ceil(segCount / WALK_MAX_SEGS);
      const collapsed = [route[0]];
      for (let i = stride; i < route.length; i += stride) collapsed.push(route[i]);
      if (collapsed[collapsed.length - 1] !== route[route.length - 1]) collapsed.push(route[route.length - 1]);
      route = collapsed;
      segCount = route.length - 1;
    }
    const segMs = opts.segMs ?? WALK_SEG_MS;
    return {
      piece,
      waypoints: route,
      segCount,
      endCX: last.x,
      endCY: last.y,
      startAngle: piece.rot,
      startAt: opts.startAt ?? performance.now(),
      duration: segCount * segMs,
      isTray: opts.isTray ?? false,
      fadeIn: opts.fadeIn ?? false,
      isKnight: opts.isKnight ?? false,
    };
  }

  function runWalkAnimation(walks: LandingWalk[], m: ShelfMetrics) {
    return new Promise<void>((resolve) => {
      if (!walks.length) {
        window.setTimeout(resolve, WALK_SETTLE_MS);
        return;
      }
      for (const walk of walks) {
        const el = pieceEls.current.get(walk.piece.id);
        if (el) el.style.transition = "none";
      }
      void piecesLayerRef.current?.offsetHeight;

      const arcAmp = m.sqSize * KNIGHT_ARC_RATIO;
      const now = performance.now();
      const globalEnd = walks.reduce((acc, walk) => Math.max(acc, walk.startAt + walk.duration + WALK_SETTLE_MS), now) + 160;

      function easeInOut(t: number) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
      function easeOutCubic(t: number) { return 1 - Math.pow(1 - t, 3); }

      function frame(tNow: number) {
        for (const walk of walks) {
          const t = tNow - walk.startAt;
          if (t < 0) continue;
          const total = walk.duration + WALK_SETTLE_MS;
          if (t >= total) {
            const tx = walk.endCX - m.sqSize / 2;
            const ty = walk.endCY - m.sqSize / 2;
            walk.piece.x = tx;
            walk.piece.y = ty;
            walk.piece.rot = 0;
            const el = pieceEls.current.get(walk.piece.id);
            if (el) {
              el.style.opacity = "1";
              el.style.transform = landingPieceTransform(tx, ty, 0, 1);
            }
            continue;
          }

          let point: WalkPoint;
          if (t < walk.duration) {
            const globalFrac = t / walk.duration;
            const segFloat = globalFrac * walk.segCount;
            const segIdx = Math.min(walk.segCount - 1, Math.floor(segFloat));
            const rawT = segFloat - segIdx;
            const segT = easeInOut(rawT);
            const a = walk.waypoints[segIdx];
            const b = walk.waypoints[segIdx + 1];
            const x = a.x + (b.x - a.x) * segT;
            let y = a.y + (b.y - a.y) * segT;
            if (walk.isKnight) y -= Math.sin(rawT * Math.PI) * arcAmp;
            point = { x, y };
          } else {
            point = walk.waypoints[walk.waypoints.length - 1];
          }

          const settleT = t >= walk.duration ? (t - walk.duration) / WALK_SETTLE_MS : 0;
          const scale = t >= walk.duration ? 1 - 0.04 * Math.sin(settleT * Math.PI) : 1;
          let angleDeg = 0;
          if (walk.startAngle) {
            const standDur = Math.min(240, walk.duration);
            if (t < standDur) angleDeg = walk.startAngle * (1 - easeOutCubic(t / standDur));
          }
          const tx = point.x - m.sqSize / 2;
          const ty = point.y - m.sqSize / 2;
          walk.piece.x = tx;
          walk.piece.y = ty;
          const el = pieceEls.current.get(walk.piece.id);
          if (el) {
            if (walk.fadeIn) el.style.opacity = String(Math.min(1, t / 260));
            el.style.transform = landingPieceTransform(tx, ty, angleDeg, scale);
          }
        }

        if (tNow < globalEnd) {
          rafRef.current = requestAnimationFrame(frame);
        } else {
          for (const walk of walks) {
            const el = pieceEls.current.get(walk.piece.id);
            if (el) el.style.transition = "";
          }
          resolve();
        }
      }
      rafRef.current = requestAnimationFrame(frame);
    });
  }

  async function walkToFen(targetFen: string, m: ShelfMetrics) {
    setRouteMetrics(m);
    const targets = piecesFromFen(targetFen, m).map((piece) => ({
      sq: piece.sq as Square,
      color: piece.color,
      type: piece.type,
      char: piece.char,
      end: squareCenter(piece.sq as Square, m),
      assigned: null as ShelfPiece | null,
      path: null as LegalPathResult | null,
      fadeIn: false,
    }));

    const pool: Array<ShelfPiece | null> = [...piecesRef.current, ...trayRef.current];
    for (const target of targets) {
      let bestI = -1;
      let bestD = Infinity;
      let bestPath: LegalPathResult | null = null;
      for (let i = 0; i < pool.length; i++) {
        const piece = pool[i];
        if (!piece || piece.color !== target.color || piece.type !== target.type) continue;
        if (!piece.sq) continue;
        const path = legalPath(piece.sq, target.sq, piece.type, piece.color);
        if (!path.ok) continue;
        const pcx = piece.x + m.sqSize / 2;
        const pcy = piece.y + m.sqSize / 2;
        const distance = (pcx - target.end.x) ** 2 + (pcy - target.end.y) ** 2;
        if (distance < bestD) {
          bestD = distance;
          bestI = i;
          bestPath = path;
        }
      }
      if (bestI >= 0 && bestPath) {
        target.assigned = pool[bestI];
        target.path = bestPath;
        pool[bestI] = null;
      }
    }

    for (const target of targets) {
      if (target.assigned) continue;
      let bestI = -1;
      let bestD = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const piece = pool[i];
        if (!piece || piece.color !== target.color || piece.type !== target.type) continue;
        if (piece.sq !== null) continue;
        const pcx = piece.x + m.sqSize / 2;
        const pcy = piece.y + m.sqSize / 2;
        const distance = (pcx - target.end.x) ** 2 + (pcy - target.end.y) ** 2;
        if (distance < bestD) {
          bestD = distance;
          bestI = i;
        }
      }
      if (bestI < 0) continue;
      const piece = pool[bestI];
      if (!piece) continue;
      pool[bestI] = null;
      const entrySq = chooseEntrySquare(target.type, target.color, target.sq);
      const entryCenter = centerSq(entrySq);
      const legal = legalPath(entrySq, target.sq, target.type, target.color);
      const waypoints = [{ x: piece.x + m.sqSize / 2, y: piece.y + m.sqSize / 2 }, entryCenter];
      if (legal.ok) waypoints.push(...legal.waypoints.slice(1));
      target.assigned = piece;
      target.path = { ok: true, waypoints };
    }

    for (const target of targets) {
      if (target.assigned) continue;
      const entrySq = chooseEntrySquare(target.type, target.color, target.sq);
      const entryCenter = centerSq(entrySq);
      const trayStart = target.color === "w"
        ? { x: entryCenter.x, y: m.boardY + m.boardH + m.sqSize * 0.7 }
        : { x: entryCenter.x, y: m.boardY - m.sqSize * 0.7 };
      const spawned: ShelfPiece = {
        id: `landing-piece-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        sq: target.sq,
        color: target.color,
        type: target.type,
        char: target.char,
        x: trayStart.x - m.sqSize / 2,
        y: trayStart.y - m.sqSize / 2,
        rot: 0,
        live: false,
        fadeIn: true,
      };
      ensurePieceElement(spawned, m);
      const legal = legalPath(entrySq, target.sq, target.type, target.color);
      const waypoints = [trayStart, entryCenter];
      if (legal.ok) waypoints.push(...legal.waypoints.slice(1));
      target.assigned = spawned;
      target.path = { ok: true, waypoints };
      target.fadeIn = true;
    }

    const walks: LandingWalk[] = [];
    const nextLive: ShelfPiece[] = [];
    const nextTray: ShelfPiece[] = [];
    const stragglers = pool.filter((piece): piece is ShelfPiece => Boolean(piece));
    const now = performance.now();

    for (const target of targets) {
      const piece = target.assigned;
      if (!piece || !target.path?.ok) continue;
      piece.sq = target.sq;
      piece.color = target.color;
      piece.type = target.type;
      piece.char = target.char;
      piece.live = false;
      piece.fadeIn = target.fadeIn || piece.fadeIn;
      ensurePieceElement(piece, m);
      syncPieceElement(piece, m);
      const rankHint = Number(target.sq[1]);
      const walk = makeWalk(piece, target.path.waypoints, {
        startAt: now + (8 - rankHint) * 90 + Math.random() * 220,
        isKnight: piece.type === "n",
        fadeIn: Boolean(piece.fadeIn),
      });
      if (walk) walks.push(walk);
      nextLive.push(piece);
    }

    const trayGap = m.sqSize * 0.5;
    const trayYWhite = m.boardY + m.boardH + m.sqSize * 0.5;
    const trayYBlack = m.boardY - m.sqSize * 0.55;
    stragglers.filter((piece) => piece.color === "w").forEach((piece, i) => {
      const endCX = m.boardX + m.sqSize * 0.5 + i * trayGap;
      const startC = { x: piece.x + m.sqSize / 2, y: piece.y + m.sqSize / 2 };
      piece.sq = null;
      piece.live = false;
      piece.fadeIn = false;
      ensurePieceElement(piece, m);
      syncPieceElement(piece, m);
      const walk = makeWalk(piece, [startC, { x: endCX, y: trayYWhite }], {
        startAt: now + 8 * 90 + Math.random() * 220,
        isTray: true,
      });
      if (walk) walks.push(walk);
      nextTray.push(piece);
    });
    stragglers.filter((piece) => piece.color === "b").forEach((piece, i) => {
      const endCX = m.boardX + m.sqSize * 0.5 + i * trayGap;
      const startC = { x: piece.x + m.sqSize / 2, y: piece.y + m.sqSize / 2 };
      piece.sq = null;
      piece.live = false;
      piece.fadeIn = false;
      ensurePieceElement(piece, m);
      syncPieceElement(piece, m);
      const walk = makeWalk(piece, [startC, { x: endCX, y: trayYBlack }], {
        startAt: now + 8 * 90 + Math.random() * 220,
        isTray: true,
      });
      if (walk) walks.push(walk);
      nextTray.push(piece);
    });

    piecesRef.current = nextLive;
    trayRef.current = nextTray;
    await runWalkAnimation(walks, m);
    for (const piece of nextLive) {
      piece.live = true;
      piece.fadeIn = false;
      syncPieceElement(piece, m);
    }
    for (const piece of nextTray) {
      piece.live = false;
      piece.fadeIn = false;
      syncPieceElement(piece, m);
    }
  }

  function replayPathForMove(move: ChessMove, mover: ShelfPiece): LegalPathResult {
    if (mover.type === "p" && move.from[0] !== move.to[0]) {
      return { ok: true, waypoints: [centerSq(move.from), centerSq(move.to)] };
    }
    return legalPath(move.from, move.to, mover.type, mover.color);
  }

  async function playOneMove(moveStr: string, m: ShelfMetrics) {
    setRouteMetrics(m);
    let move: ChessMove;
    try {
      move = gameRef.current.move(moveStr);
    } catch {
      console.warn("[landing-v7] replay move rejected:", moveStr);
      return;
    }
    const mover = piecesRef.current.find((piece) => piece.sq === move.from);
    if (!mover) {
      console.warn("[landing-v7] no piece to replay from", move.from);
      return;
    }
    const path = replayPathForMove(move, mover);
    if (!path.ok) {
      console.warn("[landing-v7] illegal path for replay:", moveStr);
      return;
    }

    let capturedSq: Square = move.to;
    if (move.flags.includes("e")) {
      const rank = Number(move.to[1]) + (move.color === "w" ? -1 : 1);
      capturedSq = `${move.to[0]}${rank}` as Square;
    }
    const captured = move.flags.includes("c") || move.flags.includes("e")
      ? piecesRef.current.find((piece) => piece.sq === capturedSq && piece !== mover)
      : null;

    const now = performance.now();
    const walks: LandingWalk[] = [];
    const moverWalk = makeWalk(mover, path.waypoints, {
      startAt: now,
      segMs: REPLAY_SEG_MS,
      isKnight: mover.type === "n",
      forceEvenIfShort: true,
    });
    if (moverWalk) walks.push(moverWalk);

    const rookWalk = castleRookWalk(move, m, now);
    if (rookWalk) walks.push(rookWalk);

    mover.sq = move.to;
    if (captured) {
      const trayY = captured.color === "w"
        ? m.boardY + m.boardH + m.sqSize * 0.5
        : m.boardY - m.sqSize * 0.55;
      const trayGap = m.sqSize * 0.5;
      const existing = trayRef.current.filter((piece) => piece.color === captured.color).length;
      const endCX = m.boardX + m.sqSize * 0.5 + existing * trayGap;
      const startC = { x: captured.x + m.sqSize / 2, y: captured.y + m.sqSize / 2 };
      const capturedWalk = makeWalk(captured, [startC, { x: endCX, y: trayY }], {
        startAt: now + (moverWalk?.duration ?? REPLAY_SEG_MS) * 0.55,
        segMs: REPLAY_SEG_MS,
        isTray: true,
      });
      if (capturedWalk) walks.push(capturedWalk);
      piecesRef.current = piecesRef.current.filter((piece) => piece !== captured);
      captured.sq = null;
      captured.live = false;
      trayRef.current.push(captured);
      const capturedEl = pieceEls.current.get(captured.id);
      if (capturedEl) {
        capturedEl.dataset.square = "tray";
        capturedEl.dataset.replayCapture = move.san;
        capturedEl.classList.remove("live");
      }
    }

    await runWalkAnimation(walks, m);
    if (move.promotion) {
      mover.type = move.promotion;
      mover.char = move.color === "w" ? move.promotion.toUpperCase() : move.promotion;
    }
    mover.live = true;
    syncPieceElement(mover, m);
    for (const piece of trayRef.current) syncPieceElement(piece, m);
  }

  function castleRookWalk(move: ChessMove, m: ShelfMetrics, now: number) {
    if (!move.flags.includes("k") && !move.flags.includes("q")) return null;
    const rank = move.color === "w" ? "1" : "8";
    const rookFrom = `${move.flags.includes("k") ? "h" : "a"}${rank}` as Square;
    const rookTo = `${move.flags.includes("k") ? "f" : "d"}${rank}` as Square;
    const rook = piecesRef.current.find((piece) => piece.sq === rookFrom && piece.type === "r" && piece.color === move.color);
    if (!rook) return null;
    const path = legalPath(rookFrom, rookTo, "r", move.color);
    if (!path.ok) return null;
    rook.sq = rookTo;
    return makeWalk(rook, path.waypoints, {
      startAt: now + REPLAY_SEG_MS * 0.18,
      segMs: REPLAY_SEG_MS,
      forceEvenIfShort: true,
    });
  }

  async function replayMoves(moveStrs: string[], m: ShelfMetrics) {
    for (let i = 0; i < moveStrs.length; i++) {
      await playOneMove(moveStrs[i], m);
      if (i < moveStrs.length - 1) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, REPLAY_BEAT_MS));
      }
    }
  }

  return (
    <div
      className="puzzle-shelf"
      data-puzzle-id={position.id}
      data-animating={animating ? "true" : "false"}
      data-last-from={lastMove?.from ?? ""}
      data-last-to={lastMove?.to ?? ""}
    >
      <div className="puzzle-stage" ref={stageRef}>
        <div className="landing-board-frame">
          <div className="landing-board" role="grid" aria-label="Landing chess puzzle">
            {ranks.flatMap((rank) =>
              files.map((file) => {
                const square = `${file}${rank}` as Square;
                const dark = (files.indexOf(file) + Number(rank)) % 2 === 0;
                const target = legalTargets.get(square);
                const showFile = rank === "1";
                const showRank = file === "a";
                const isFromLast = lastMove?.from === square;
                const isToLast = lastMove?.to === square;
                return (
                  <button
                    className={[
                      "landing-square",
                      dark ? "dark" : "light",
                      selected === square ? "selected" : "",
                      isFromLast ? "last-from" : "",
                      isToLast ? "last-to" : "",
                    ].filter(Boolean).join(" ")}
                    data-square={square}
                    key={square}
                    onClick={() => choose(square)}
                    aria-label={square}
                    disabled={animating}
                    type="button"
                  >
                    {showRank ? <span className="coord coord-rank" aria-hidden="true">{rank}</span> : null}
                    {showFile ? <span className="coord coord-file" aria-hidden="true">{file}</span> : null}
                    {target === "move" ? <span className="legal-dot" aria-hidden="true" /> : null}
                    {target === "capture" ? <span className="legal-capture" aria-hidden="true" /> : null}
                  </button>
                );
              }),
            )}
          </div>
        </div>
        {/* Pieces layer — OPAQUE to React. Empty in the render tree; every
            child inside is created and destroyed imperatively by the
            animation code (see useEffect on [metrics, index] and
            walkLandingPieces). React must never enumerate these nodes,
            or removeChild reconciliation clashes with the imperative
            .remove() and NotFoundError kills the shelf on ~round 3. */}
        <div className="landing-pieces" ref={piecesLayerRef} aria-hidden="true" />
      </div>
      <p className="puzzle-caption">{formatPuzzleCaption(position)}</p>
    </div>
  );
}

// Caption vocabulary:
//   Lichess entries (id starts with "lichess-") — side-to-move only.
//     The lichess.org · <id> handle is random-puzzle noise for a landing
//     audience; CC0 compliance is carried by the /inspirations page.
//   Named classics — side-to-move · TITLE · YEAR. The name is the point.
function formatPuzzleCaption(pos: ShelfPosition): string {
  const side = pos.sideToMove === "w" ? "WHITE TO MOVE" : "BLACK TO MOVE";
  if (pos.id.startsWith("lichess-")) return side;
  return `${side} · ${pos.title.toUpperCase()} · ${extractYear(pos.credit)}`;
}

function extractYear(credit: string): string {
  const match = credit.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  return match ? match[1] : credit;
}

function piecesFromFen(fen: string, metrics: ShelfMetrics): ShelfPiece[] {
  const placement = fen.split(" ")[0];
  const pieces: ShelfPiece[] = [];
  let fileIndex = 0;
  let rank = 8;
  for (const char of placement) {
    if (char === "/") {
      rank -= 1;
      fileIndex = 0;
      continue;
    }
    if (/\d/.test(char)) {
      fileIndex += Number(char);
      continue;
    }
    const file = files[fileIndex];
    const sq = `${file}${rank}` as Square;
    const { x, y } = squareToXY(sq, metrics);
    pieces.push({
      id: `landing-piece-${pieces.length}-${char}-${sq}`,
      sq,
      color: char === char.toUpperCase() ? "w" : "b",
      type: char.toLowerCase() as PieceSymbol,
      char,
      x,
      y,
      rot: 0,
      live: true,
    });
    fileIndex += 1;
  }
  return pieces;
}

// Standard 32-piece set per color. Used by offBoardPieces to compute
// what pieces "should" be in the position and populate the tray zones
// with the complement not currently on the board.
const STANDARD_SET: Record<PieceSymbol, number> = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
const PIECE_ORDER: PieceSymbol[] = ["q", "r", "b", "n", "p", "k"];

function offBoardPieces(fen: string, metrics: ShelfMetrics): ShelfPiece[] {
  const board = new Chess(fen).board();
  const present: Record<Color, Partial<Record<PieceSymbol, number>>> = { w: {}, b: {} };
  for (const row of board) {
    for (const cell of row) {
      if (!cell) continue;
      present[cell.color][cell.type] = (present[cell.color][cell.type] ?? 0) + 1;
    }
  }
  const missing: Array<{ color: Color; type: PieceSymbol }> = [];
  for (const color of ["w", "b"] as const) {
    for (const type of PIECE_ORDER) {
      const need = STANDARD_SET[type] - (present[color][type] ?? 0);
      for (let i = 0; i < need; i++) missing.push({ color, type });
    }
  }
  const trayGap = metrics.sqSize * 0.5;
  const trayYWhite = metrics.boardY + metrics.boardH + metrics.sqSize * 0.5;
  const trayYBlack = metrics.boardY - metrics.sqSize * 0.55;
  const half = metrics.sqSize / 2;
  const startX = metrics.boardX + half;
  const pieces: ShelfPiece[] = [];
  const whiteMissing = missing.filter((m) => m.color === "w");
  const blackMissing = missing.filter((m) => m.color === "b");
  whiteMissing.forEach((m, i) => {
    pieces.push({
      id: `landing-tray-w-${m.type}-${i}`,
      sq: null,
      color: "w",
      type: m.type,
      char: m.type.toUpperCase(),
      x: startX + i * trayGap - half,
      y: trayYWhite - half,
      rot: 0,
      live: false,
      fadeIn: false,
    });
  });
  blackMissing.forEach((m, i) => {
    pieces.push({
      id: `landing-tray-b-${m.type}-${i}`,
      sq: null,
      color: "b",
      type: m.type,
      char: m.type,
      x: startX + i * trayGap - half,
      y: trayYBlack - half,
      rot: 0,
      live: false,
      fadeIn: false,
    });
  });
  return pieces;
}

// Compute the from+to of the LAST preMove that led to the current puzzle
// FEN. This is the "last move" the wash on the shelf represents. Returns
// null when a position has no preMoves (shouldn't happen for shipped
// entries — verify-positions gates it, but keep the guard).
function computeLastMove(pos: ShelfPosition): { from: Square; to: Square } | null {
  if (!pos.preMoves || !pos.preMoves.moves.length) return null;
  const game = new Chess(pos.preMoves.fen);
  let last: { from: Square; to: Square } | null = null;
  for (const san of pos.preMoves.moves) {
    try {
      const move = game.move(san);
      if (move) last = { from: move.from as Square, to: move.to as Square };
    } catch {
      return null;
    }
  }
  return last;
}

function squareToXY(sq: Square, metrics: ShelfMetrics) {
  const file = sq.charCodeAt(0) - 97;
  const rank = Number(sq[1]);
  return {
    x: metrics.boardX + file * metrics.sqSize,
    y: metrics.boardY + (8 - rank) * metrics.sqSize,
  };
}

function squareCenter(sq: Square, metrics: ShelfMetrics) {
  const { x, y } = squareToXY(sq, metrics);
  return { x: x + metrics.sqSize / 2, y: y + metrics.sqSize / 2 };
}

let routeMetrics: ShelfMetrics | null = null;

function setRouteMetrics(metrics: ShelfMetrics) {
  routeMetrics = metrics;
}

function currentRouteMetrics() {
  if (!routeMetrics) throw new Error("landing route metrics unavailable");
  return routeMetrics;
}

function sqFR(sq: Square) { return { f: sq.charCodeAt(0) - 97, r: Number(sq[1]) }; }
function frToSq(f: number, r: number) { return `${FILES[f]}${r}` as Square; }
function centerFR(f: number, r: number) {
  const { boardX, boardY, sqSize } = currentRouteMetrics();
  return {
    x: boardX + f * sqSize + sqSize / 2,
    y: boardY + (8 - r) * sqSize + sqSize / 2,
  };
}
function centerSq(sq: Square) { const c = sqFR(sq); return centerFR(c.f, c.r); }

function legalPath(fromSq: Square, toSq: Square, type: PieceSymbol, color: Color): LegalPathResult {
  if (fromSq === toSq) return { ok: true, waypoints: [centerSq(fromSq)] };
  const a = sqFR(fromSq), b = sqFR(toSq);
  switch (type) {
    case "n": return knightPath(a, b);
    case "r": return rookPath(a, b);
    case "b": return bishopPath(a, b);
    case "q": return queenPath(a, b);
    case "k": return kingPath(a, b);
    case "p": return pawnPath(a, b, color);
    default: return { ok: false };
  }
}

function knightPath(a: { f: number; r: number }, b: { f: number; r: number }): LegalPathResult {
  const offsets = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const key = (f: number, r: number) => f * 10 + r;
  const start = key(a.f, a.r);
  const seen = new Set([start]);
  const parent = new Map<number, { f: number; r: number }>();
  const queue = [{ f: a.f, r: a.r }];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.f === b.f && cur.r === b.r) {
      const pathFR = [{ f: cur.f, r: cur.r }];
      let node = key(cur.f, cur.r);
      while (node !== start) {
        const par = parent.get(node)!;
        pathFR.unshift(par);
        node = key(par.f, par.r);
      }
      return { ok: true, waypoints: pathFR.map((p) => centerFR(p.f, p.r)) };
    }
    for (const [df, dr] of offsets) {
      const nf = cur.f + df, nr = cur.r + dr;
      if (nf < 0 || nf > 7 || nr < 1 || nr > 8) continue;
      const k = key(nf, nr);
      if (seen.has(k)) continue;
      seen.add(k);
      parent.set(k, { f: cur.f, r: cur.r });
      queue.push({ f: nf, r: nr });
    }
  }
  return { ok: false };
}

function rookPath(a: { f: number; r: number }, b: { f: number; r: number }): LegalPathResult {
  const wps = [centerFR(a.f, a.r)];
  if (a.f === b.f || a.r === b.r) {
    wps.push(centerFR(b.f, b.r));
  } else {
    const corner = Math.random() < 0.5
      ? { f: b.f, r: a.r }
      : { f: a.f, r: b.r };
    wps.push(centerFR(corner.f, corner.r));
    wps.push(centerFR(b.f, b.r));
  }
  return { ok: true, waypoints: wps };
}

function bishopPath(a: { f: number; r: number }, b: { f: number; r: number }): LegalPathResult {
  if ((a.f + a.r) % 2 !== (b.f + b.r) % 2) return { ok: false };
  const df = b.f - a.f, dr = b.r - a.r;
  const wps = [centerFR(a.f, a.r)];
  if (Math.abs(df) === Math.abs(dr)) {
    wps.push(centerFR(b.f, b.r));
    return { ok: true, waypoints: wps };
  }
  for (let cf = 0; cf < 8; cf++) {
    for (let cr = 1; cr <= 8; cr++) {
      if (cf === a.f && cr === a.r) continue;
      if (cf === b.f && cr === b.r) continue;
      const df1 = cf - a.f, dr1 = cr - a.r;
      const df2 = b.f - cf, dr2 = b.r - cr;
      if (df1 !== 0 && Math.abs(df1) === Math.abs(dr1) &&
          df2 !== 0 && Math.abs(df2) === Math.abs(dr2)) {
        wps.push(centerFR(cf, cr));
        wps.push(centerFR(b.f, b.r));
        return { ok: true, waypoints: wps };
      }
    }
  }
  return { ok: false };
}

function queenPath(a: { f: number; r: number }, b: { f: number; r: number }): LegalPathResult {
  if (a.f === b.f || a.r === b.r) return rookPath(a, b);
  if (Math.abs(a.f - b.f) === Math.abs(a.r - b.r)) return bishopPath(a, b);
  return rookPath(a, b);
}

function kingPath(a: { f: number; r: number }, b: { f: number; r: number }): LegalPathResult {
  const MAX_STEPS = 4;
  const steps = Math.max(Math.abs(b.f - a.f), Math.abs(b.r - a.r));
  if (steps > MAX_STEPS) return { ok: false };
  const wps = [centerFR(a.f, a.r)];
  let f = a.f, r = a.r;
  while (f !== b.f || r !== b.r) {
    if (f < b.f) f++; else if (f > b.f) f--;
    if (r < b.r) r++; else if (r > b.r) r--;
    wps.push(centerFR(f, r));
  }
  return { ok: true, waypoints: wps };
}

function pawnPath(a: { f: number; r: number }, b: { f: number; r: number }, color: Color): LegalPathResult {
  if (a.f !== b.f) return { ok: false };
  const dir = color === "w" ? +1 : -1;
  const advance = (b.r - a.r) * dir;
  if (advance <= 0) return { ok: false };
  const wps = [centerFR(a.f, a.r)];
  for (let i = 1; i <= advance; i++) {
    wps.push(centerFR(a.f, a.r + i * dir));
  }
  return { ok: true, waypoints: wps };
}

function chooseEntrySquare(type: PieceSymbol, color: Color, targetSq: Square) {
  const t = sqFR(targetSq);
  if (type === "p") {
    const startRank = color === "w" ? 2 : 7;
    const dir = color === "w" ? +1 : -1;
    if ((t.r - startRank) * dir >= 0) return frToSq(t.f, startRank);
    return frToSq(t.f, color === "w" ? 2 : 7);
  }
  const edges: Array<{ f: number; r: number }> = [];
  for (let f = 0; f < 8; f++) { edges.push({ f, r: 1 }); edges.push({ f, r: 8 }); }
  for (let r = 2; r <= 7; r++) { edges.push({ f: 0, r }); edges.push({ f: 7, r }); }
  if (type === "b") {
    const parity = (t.f + t.r) % 2;
    const valid = edges.filter((e) => (e.f + e.r) % 2 === parity && !(e.f === t.f && e.r === t.r));
    return nearestSq(valid, t);
  }
  if (type === "r") {
    const opts = [
      { f: 0, r: t.r }, { f: 7, r: t.r },
      { f: t.f, r: 1 }, { f: t.f, r: 8 },
    ].filter((e) => !(e.f === t.f && e.r === t.r));
    return nearestSq(opts, t);
  }
  const valid = edges.filter((e) => !(e.f === t.f && e.r === t.r));
  return nearestSq(valid, t);
}

function nearestSq(candidates: Array<{ f: number; r: number }>, t: { f: number; r: number }) {
  let best = candidates[0], bestD = Infinity;
  for (const c of candidates) {
    const d = (c.f - t.f) ** 2 + (c.r - t.r) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return frToSq(best.f, best.r);
}

function pickEdgeSpawn(dest: { x: number; y: number }, metrics: ShelfMetrics) {
  const half = metrics.sqSize / 2;
  const options = [
    { x: half, y: dest.y },
    { x: metrics.stageW - half, y: dest.y },
    { x: dest.x, y: half },
    { x: dest.x, y: metrics.stageH - half },
  ];
  let best = options[0];
  let bestD = Infinity;
  for (const option of options) {
    const distance = Math.hypot(option.x - dest.x, option.y - dest.y);
    if (distance < bestD) {
      best = option;
      bestD = distance;
    }
  }
  return best;
}

function sizeAndPlacePiece(el: HTMLElement, piece: ShelfPiece, metrics: ShelfMetrics) {
  el.style.width = `${metrics.sqSize}px`;
  el.style.height = `${metrics.sqSize}px`;
  el.style.fontSize = `${Math.round(metrics.sqSize * 0.82)}px`;
  el.style.opacity = piece.fadeIn ? "0" : "1";
  el.style.transform = landingPieceTransform(piece.x, piece.y, piece.rot, 1);
  // Sync dataset.square so selectors like [data-square="g2"] track the
  // piece's current logical square. React used to keep this in sync via
  // re-render; now we do it explicitly wherever we touch the DOM.
  el.dataset.square = piece.sq || "tray";
}

// Imperative piece element factory — pieces are React-invisible so we
// build the DOM ourselves. Mirrors the classes and data attributes the
// previous JSX rendered (kept for CSS + repro-selector compatibility).
function createLandingPieceEl(piece: ShelfPiece, metrics: ShelfMetrics): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = `landing-piece landing-piece-${piece.color}${piece.live ? " live" : ""}`;
  el.dataset.pieceId = piece.id;
  el.dataset.square = piece.sq || "tray";
  el.dataset.piece = `${piece.color}${piece.type}`;
  el.textContent = filledGlyphs[piece.type];
  sizeAndPlacePiece(el, piece, metrics);
  return el;
}

function landingPieceTransform(x: number, y: number, angleDeg: number, scale: number) {
  return `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${angleDeg.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
}

function seededWalkChoice(a: string, b: string) {
  let hash = 2166136261;
  const input = `${a}:${b}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

type TimeControl = "10|0" | "5|0";
type GameStatus = "active" | "checkmate" | "resigned" | "timeout" | "draw";

// Pipe notation stays code-only — humans read minutes. Every surface that
// renders a TimeControl to the user MUST call this. Sweep script in CI
// checks the compiled bundle for "10|0"/"5|0" appearing in user-visible
// contexts.
function formatTimeControl(tc: TimeControl): string {
  return tc === "5|0" ? "5 min" : "10 min";
}
type PushStatus = "checking" | "ready" | "enabled" | "blocked" | "unsupported";
type ToastKind = "info" | "error";
type SetMessage = (value: string, kind?: ToastKind) => void;

interface Friend { id: string; handle: string; online: boolean }
interface FriendRequest { id: string; fromHandle?: string; toHandle?: string }
interface Challenge { id: string; fromHandle?: string; toHandle?: string; timeControl: TimeControl }
type Recurrence =
  | { kind: "once" }
  | { kind: "weekly"; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: "daily" };

interface Schedule {
  id: string;
  fromId: string;
  toId: string;
  fromHandle?: string;
  toHandle?: string;
  timeControl: TimeControl;
  startAt: number;
  nextFireAt?: number;
  recurrence?: Recurrence;
  status: "pending" | "accepted" | "fired" | "declined" | "cancelled";
  gameId?: string;
  lastGameId?: string;
  cancelledBy?: string;
}
interface GameMeta {
  id: string;
  whiteId: string;
  blackId: string;
  timeControl: TimeControl;
  status: GameStatus;
  result?: string;
}
interface HomeData {
  user: { id: string; handle: string; inviteToken: string };
  inviteUrl: string;
  friends: Friend[];
  requests: FriendRequest[];
  sentRequests: FriendRequest[];
  challenges: Challenge[];
  sentChallenges: Challenge[];
  schedules: Schedule[];
  games: GameMeta[];
  pushPublicKey: string;
  pushTypes: string[];
}
interface GameState {
  id: string;
  whiteId: string;
  blackId: string;
  whiteHandle: string;
  blackHandle: string;
  timeControl: TimeControl;
  fen: string;
  moves: Array<{ from: string; to: string; san: string; by: string; at: number; fen: string }>;
  whiteMs: number;
  blackMs: number;
  lastTickAt: number;
  turn: "w" | "b";
  status: GameStatus;
  result?: string;
  winnerId?: string;
  loserId?: string;
  connectionState: Record<string, "connected" | "reconnecting" | "gone">;
}

const files = [...FILES];
const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"];
const pieceNames: Record<PieceSymbol, string> = {
  p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king",
};
// FILLED Unicode glyphs used for BOTH colors — the outline "white" glyphs
// (♔♕♖♗♘♙) have transparent interiors, so on walnut squares the walnut
// bleeds through and white pieces read as mud with a whisper-thin edge.
// This is what physical sets do: Hartwig's whites are pale wood, not
// wireframes. Colour differentiates the sides; the glyph is the same shape.
const filledGlyphs: Record<PieceSymbol, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
// Legacy names kept in case anything else in the module reaches for them.
const whiteGlyphs = filledGlyphs;
const blackGlyphs = filledGlyphs;

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    // Explicit — modern browsers default to same-origin, but Safari's
    // service-worker fetch interception has bit us before. Being explicit
    // guarantees the session cookie rides on every /api call.
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data as T;
}

function App() {
  const [home, setHome] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessageState] = useState("");
  const [messageKind, setMessageKind] = useState<ToastKind>("info");
  // Widened setter — callers pass "error" as the second arg from catch
  // blocks to tint the toast vermillion. Default is "info" (paper toast,
  // hairline border) so existing setMessage("...") calls stay valid.
  const setMessage = React.useCallback<SetMessage>((value, kind = "info") => {
    setMessageState(value);
    setMessageKind(kind);
  }, []);
  // Auto-dismiss transient toasts after 4s. Re-fires whenever `message`
  // changes (single source of truth for the timer). Errors and info both
  // dismiss on the same cadence — team-lead's spec.
  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessageState(""), 4000);
    return () => window.clearTimeout(t);
  }, [message]);
  const path = usePathname();
  const gameMatch = path.match(/^\/game\/([^/]+)/);
  const inviteMatch = path.match(/^\/invite\/([^/]+)/);
  const waitingMatch = path.match(/^\/waiting\/([^/]+)/);

  async function refresh() {
    try {
      const data = await api<HomeData>("/api/me");
      setHome(data);
    } catch {
      setHome(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void api<HomeData>("/api/presence/heartbeat", { method: "POST", body: "{}" })
        .then(setHome)
        .catch(() => undefined);
    }, 10000);
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
    return () => window.clearInterval(timer);
  }, []);

  const isInspirations = path === "/inspirations";

  if (loading) return <Shell onSignedOut={() => setHome(null)}><LoadingLine /></Shell>;
  // /inspirations is reachable authenticated OR not — attribution has no
  // gating. Renders inside a Shell (with topbar + ⋯) for consistency.
  if (isInspirations) {
    return (
      <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage} onSignedOut={() => setHome(null)}>
        <InspirationsPage />
      </Shell>
    );
  }
  if (!home) return <AuthScreen onSignedIn={refresh} message={message} messageKind={messageKind} setMessage={setMessage} />;
  if (gameMatch) return <GameScreen gameId={gameMatch[1]} home={home} message={message} messageKind={messageKind} setMessage={setMessage} onHome={() => navigate("/", refresh)} />;
  if (waitingMatch) return <WaitingRoom challengeId={waitingMatch[1]} home={home} message={message} messageKind={messageKind} setMessage={setMessage} onHome={() => navigate("/", refresh)} />;

  return (
    <Shell
      home={home}
      message={message}
      messageKind={messageKind}
      setMessage={setMessage}
      onSignedOut={() => setHome(null)}
    >
      <Dashboard home={home} inviteToken={inviteMatch?.[1]} refresh={refresh} setMessage={setMessage} />
    </Shell>
  );
}

function Shell({
  children,
  home,
  message,
  messageKind,
  setMessage,
  onSignedOut,
  menuExtras,
  hideMenu,
}: {
  children?: React.ReactNode;
  home?: HomeData | null;
  message?: string;
  messageKind?: ToastKind;
  setMessage?: SetMessage;
  onSignedOut?: () => void;
  /* Optional menu items to inject above the universal Sign out / state /
     Inspirations items. Used by GameScreen to expose Home + Resign inside
     the same ⋯ menu (team-lead: one menu pattern, one position). */
  menuExtras?: (closeMenu: () => void) => React.ReactNode;
  /* Landing screen suppresses chrome — signed-out visitors need no menu.
     The footer carries attribution + the one useful link (inspirations). */
  hideMenu?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Close menu when route changes.
  const path = usePathname();
  useEffect(() => { setMenuOpen(false); }, [path]);
  // Close on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <main className="shell">
      <header className="topbar">
        <button className="wordmark" onClick={() => navigate("/")}>two chairs</button>
        <div className="topbar-right">
          {home ? <span className="handle">@{home.user.handle}</span> : null}
          {/* Universal ⋯ menu — top-right on every screen per team-lead.
              Kept as one pattern so users learn "menu lives here" once.
              Landing suppresses it via hideMenu — signed-out visitors
              need no chrome; the footer carries the one useful link. */}
          {hideMenu ? null : (
            <button
              className="menu-dot"
              type="button"
              aria-label="Open menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(v => !v)}
            >···</button>
          )}
        </div>
      </header>
      {menuOpen && !hideMenu ? (
        <MenuSheet
          home={home || null}
          onClose={() => setMenuOpen(false)}
          onSignedOut={onSignedOut}
          extras={menuExtras}
        />
      ) : null}
      {message ? (
        <div className={`toast ${messageKind === "error" ? "toast-error" : "toast-info"}`} role="status" aria-live="polite">
          <span>{message}</span>
          {setMessage ? (
            <button className="toast-dismiss" aria-label="Dismiss" onClick={() => setMessage("")}>×</button>
          ) : null}
        </div>
      ) : null}
      <div className="stage">{children}</div>
    </main>
  );
}

// Bottom sheet menu — one pattern, one position (⋯ top-right on every
// screen). Order (top → bottom): Notifications (interactive, opens the
// confidence-promise popover), Installed (info), Inspirations, then
// Sign out at the very bottom (destructive-ish; kept out of the top
// thumb-tap zone). Copy-invite-link lives on the Add-a-friend
// disclosure in the friends section, not here.
function MenuSheet({
  home,
  onClose,
  onSignedOut,
  extras,
}: {
  home: HomeData | null;
  onClose: () => void;
  onSignedOut?: () => void;
  extras?: (closeMenu: () => void) => React.ReactNode;
}) {
  const [notifState, setNotifState] = useState<"unknown" | "granted" | "denied" | "default" | "unsupported">("unknown");
  const [installed, setInstalled] = useState<boolean>(() => detectInstalled());
  const [notifInfoOpen, setNotifInfoOpen] = useState(false);
  useEffect(() => {
    if (!("Notification" in window)) { setNotifState("unsupported"); return; }
    setNotifState(Notification.permission as "granted" | "denied" | "default");
    const media = window.matchMedia("(display-mode: standalone)");
    const update = () => setInstalled(detectInstalled());
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  const notifValueLabel =
    notifState === "granted" ? "on"
      : notifState === "denied" ? "blocked"
      : notifState === "unsupported" ? "unsupported"
      : "not yet";

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="menu-sheet" role="dialog" aria-label="App menu">
        <ul className="menu-list">
          {extras ? extras(onClose) : null}
          <li>
            <button
              type="button"
              className="menu-state-button"
              aria-expanded={notifInfoOpen}
              onClick={() => setNotifInfoOpen((v) => !v)}
            >
              <span className="menu-state-label">Notifications</span>
              <span className="menu-state-value">{notifValueLabel}</span>
            </button>
            {notifInfoOpen ? <NotificationInfo state={notifState} installed={installed} /> : null}
          </li>
          <li>
            <div className="menu-state">
              <span className="menu-state-label">Installed</span>
              <span className="menu-state-value">{installed ? "yes" : "not yet"}</span>
            </div>
          </li>
          <li>
            <button
              className="menu-item"
              onClick={() => { onClose(); navigate("/inspirations"); }}
            >
              Inspirations
            </button>
          </li>
          {home ? (
            <li className="menu-signout">
              <button className="menu-item" onClick={() => { onClose(); void signOut(onSignedOut || (() => undefined)); }}>
                Sign out
              </button>
            </li>
          ) : null}
        </ul>
      </div>
    </>
  );
}

// Notification info popover — opens inline under the Notifications row
// in the ⋯ menu. Two parts: (1) platform how-to for the CURRENT state
// (granted / default / denied / unsupported / installed-but-off), and
// (2) the confidence promise — the four notifications this app sends,
// spelled out. Tejas's word: "people must feel safe enabling."
function NotificationInfo({ state, installed }: { state: "unknown" | "granted" | "denied" | "default" | "unsupported"; installed: boolean }) {
  const howTo =
    state === "granted"
      ? "Notifications are on. You'll get pushes for the four events below and nothing else."
      : state === "denied"
        ? "Notifications are blocked. Delete this app from your Home Screen and add it back to enable them again."
        : state === "unsupported"
          ? "This browser doesn't support notifications. Install the app to your Home Screen for pushes."
          : !installed
            ? "Install the app to your Home Screen first, then open it and enable notifications."
            : "Enable notifications so you know when a friend invites you or a scheduled game starts.";
  return (
    <div className="menu-notif-info" role="region" aria-label="Notification policy">
      <p className="menu-notif-howto">{howTo}</p>
      <p className="menu-notif-promise">No spam. Only these notifications:</p>
      <ul className="menu-notif-list">
        <li>friend request</li>
        <li>game invite</li>
        <li>invite accepted</li>
        <li>scheduled game starting</li>
      </ul>
    </div>
  );
}

// Attribution page. Plain prose. No designer voice.
// Layout constraint (Tejas 2026-08-04): no-scroll on both mobile
// viewports (390x844, 430x932) AND desktop (1440x900). Desktop uses two
// columns — all prose LEFT, photograph + caption RIGHT. Mobile stacks
// single column with the image scaled down. The strict no-scroll shell
// (padding 12/8 + overflow:hidden) is enabled by setting
// data-screen="inspirations" on body.
function InspirationsPage() {
  useEffect(() => {
    document.body.dataset.screen = "inspirations";
    return () => {
      if (document.body.dataset.screen === "inspirations") delete document.body.dataset.screen;
    };
  }, []);
  return (
    <div className="inspirations">
      <button className="link insp-back" onClick={() => navigate("/")}>← back</button>
      <h1 className="insp-title">Inspirations</h1>
      <div className="insp-content">
        <div className="insp-prose">
          <p className="insp-body">
            Most apps are engagement machines. Playing a simple game with a
            friend means walking through a casino to reach them. This app is
            built to avoid that.
          </p>
          <p className="insp-body">
            The design and the icon come from Alexander Rodchenko's Workers'
            Club, 1925. The Workers' Club reconceived leisure as active and
            collective rather than passive and solitary, and chess was part of
            it.
          </p>
          <p className="insp-body">
            The palette comes from Virgilio Villalba's Untitled, 1955:
            celadon, cream, teak, navy.
          </p>
          <p className="insp-body">
            Puzzle positions from{" "}
            <a href="https://lichess.org/database">lichess.org/database</a>, CC0.
          </p>
        </div>
        <figure className="insp-figure">
          <img
            src="/rodchenko-chess-table.jpg"
            alt="Rodchenko's chess table for the USSR Workers' Club, 1925 design. Two chairs and a chess table built as one piece of furniture. Photograph of a 2021 reconstruction at Château La Gaffelière."
            loading="lazy"
            width={683}
            height={582}
          />
          <figcaption className="insp-figcaption">
            <span className="insp-figcaption-desc">
              The chess table for the USSR Workers' Club. Two chairs and a
              board built as one piece of furniture. A 2021 reconstruction.
            </span>
            <span className="insp-figcaption-attr">
              Photograph by Bapak Alex,{" "}
              <a href="https://commons.wikimedia.org/wiki/File:Chess_table_From_the_Workers_Club.jpg" target="_blank" rel="noreferrer">
                Wikimedia Commons
              </a>
              {", "}
              <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a>.
            </span>
          </figcaption>
        </figure>
      </div>
      <MadeByTejas />
    </div>
  );
}

function LoadingLine() {
  return <p className="muted center">Opening board…</p>;
}

// Realtime game channel — resilient WebSocket that reconnects on
// close/error with backoff, resyncs on every reconnect (both by sending
// "sync" and by requesting a fresh REST snapshot via onResync), wakes
// on visibilitychange when the tab comes back, and detects silent
// half-open sockets via a ping/pong heartbeat. Every path re-arms
// itself, so the board can never silently freeze — the failure mode
// this replaces was a dead socket that never noticed it was dead.
function useRealtimeGame(
  gameId: string,
  {
    onGame,
    onResync,
    enabled,
  }: {
    onGame: (game: GameState) => void;
    onResync: () => Promise<void> | void;
    enabled: boolean;
  },
) {
  const onGameRef = React.useRef(onGame);
  const onResyncRef = React.useRef(onResync);
  onGameRef.current = onGame;
  onResyncRef.current = onResync;

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let backoffMs = 250;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let livenessTimer: number | null = null;
    let disposed = false;
    let lastInboundAt = Date.now();

    const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/games/${gameId}/socket`;

    function clearTimers() {
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
      if (livenessTimer !== null) window.clearInterval(livenessTimer);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      heartbeatTimer = null;
      livenessTimer = null;
      reconnectTimer = null;
    }

    function scheduleReconnect() {
      if (disposed) return;
      clearTimers();
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, 5000);
      reconnectTimer = window.setTimeout(connect, delay);
    }

    function connect() {
      if (disposed) return;
      try {
        socket = new WebSocket(wsUrl);
      } catch {
        scheduleReconnect();
        return;
      }
      const s = socket;
      s.addEventListener("open", () => {
        backoffMs = 250;
        lastInboundAt = Date.now();
        try { s.send("sync"); } catch { /* dead almost immediately */ }
        // Belt-and-suspenders REST resync in case a broadcast fired
        // between the last disconnect and this reconnect.
        void onResyncRef.current();
        // Heartbeat: send a ping every 15s so the server has a reason to
        // reply and we can see inbound traffic on a healthy socket.
        heartbeatTimer = window.setInterval(() => {
          try { s.send("ping"); } catch { /* will surface via liveness */ }
        }, 15000);
        // Liveness: if no inbound frame for 25s during an active game,
        // treat the socket as half-open. Close it (that fires close →
        // scheduleReconnect).
        livenessTimer = window.setInterval(() => {
          if (Date.now() - lastInboundAt > 25000) {
            try { s.close(); } catch { /* ignored */ }
          }
        }, 5000);
      });
      s.addEventListener("message", (event) => {
        lastInboundAt = Date.now();
        const raw = typeof event.data === "string" ? event.data : "";
        if (!raw || raw === "pong") return;
        try {
          const payload = JSON.parse(raw);
          if (payload && payload.game) onGameRef.current(payload.game as GameState);
        } catch { /* non-JSON frame ignored */ }
      });
      s.addEventListener("close", () => {
        clearTimers();
        scheduleReconnect();
      });
      s.addEventListener("error", () => {
        try { s.close(); } catch { /* already closing */ }
      });
    }

    function onVisibility() {
      if (document.visibilityState !== "visible") return;
      // Coming back into the foreground: if the socket isn't already
      // OPEN, force an immediate reconnect (don't wait for backoff).
      const state = socket?.readyState;
      if (state === WebSocket.OPEN) {
        try { socket?.send("sync"); } catch { /* trigger reconnect */ }
        void onResyncRef.current();
        return;
      }
      try { socket?.close(); } catch { /* ignored */ }
      backoffMs = 250;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connect();
    }

    document.addEventListener("visibilitychange", onVisibility);
    connect();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimers();
      try { socket?.close(); } catch { /* ignored */ }
      socket = null;
    };
  }, [gameId, enabled]);
}

function presenceLabel(state: "connected" | "reconnecting" | "gone", _handle: string): string {
  // Aria-label wording only — the visible signal is a colored dot. Words
  // like "here"/"away" fought "offline" as antonyms; a dot doesn't lie.
  // These strings are consumed by screen readers and by the e2e suite via
  // getByRole("status", { name: ... }).
  if (state === "connected") return "opponent connected";
  if (state === "reconnecting") return "opponent reconnecting";
  return "opponent offline";
}

function usePathname() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return path;
}

function AuthScreen({
  onSignedIn,
  message,
  messageKind,
  setMessage,
}: {
  onSignedIn: () => void;
  message: string;
  messageKind: ToastKind;
  setMessage: SetMessage;
}) {
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  // Preflight probe result: does this handle already have an account? Determined
  // silently on input-debounce so Continue can run the right flow inside a
  // single click's user activation (WebAuthn will not chain two credential
  // prompts across separate activations reliably on all engines).
  const [flow, setFlow] = useState<"login" | "register" | "unknown">("unknown");

  // Landing borrows the no-scroll shell — everything must fit in one
  // viewport at 390, footer pinned to the bottom. Tejas's general law:
  // "if you don't need scrolling, let's not add scrolling."
  useEffect(() => {
    document.body.dataset.screen = "landing";
    return () => {
      if (document.body.dataset.screen === "landing") delete document.body.dataset.screen;
    };
  }, []);

  useEffect(() => {
    const trimmed = handle.trim();
    if (!trimmed) {
      setFlow("unknown");
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        await api("/api/auth/login/options", { method: "POST", body: JSON.stringify({ handle: trimmed }) });
        if (!cancelled) setFlow("login");
      } catch (error) {
        if (cancelled) return;
        const text = error instanceof Error ? error.message : "";
        setFlow(/no account/i.test(text) ? "register" : "login");
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [handle]);

  async function submit() {
    if (!handle || busy) return;
    setBusy(true);
    // `decided` is declared outside the try so the catch block can tailor
    // its toast to the flow that was actually attempted (Sarah-typing-taken-
    // handle case: the login path can fail with NotAllowedError when she
    // cancels the sheet or has no credential; the tailored recovery text
    // needs to know we were on the login branch).
    let decided: "login" | "register" = flow === "register" ? "register" : "login";
    try {
      // If the probe hasn't landed yet, do it inline — still a single user
      // gesture from the browser's perspective for the credential call that
      // follows, and cheaper than forcing a second click.
      if (flow === "unknown") {
        try {
          await api<PublicKeyCredentialRequestOptionsJSON>("/api/auth/login/options", {
            method: "POST",
            body: JSON.stringify({ handle }),
          });
          decided = "login";
        } catch (error) {
          const text = error instanceof Error ? error.message : "";
          decided = /no account/i.test(text) ? "register" : "login";
        }
      }

      if (decided === "register") {
        const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>("/api/auth/register/options", {
          method: "POST",
          body: JSON.stringify({ handle }),
        });
        const response = await startRegistration({ optionsJSON });
        await api("/api/auth/register/verify", { method: "POST", body: JSON.stringify({ handle, response }) });
      } else {
        const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>("/api/auth/login/options", {
          method: "POST",
          body: JSON.stringify({ handle }),
        });
        const response = await startAuthentication({ optionsJSON });
        await api("/api/auth/login/verify", { method: "POST", body: JSON.stringify({ handle, response }) });
      }
      await onSignedIn();
    } catch (error) {
      // Explicit terminal-error matrix (team-lead's verbatim phrases).
      // Reverses the earlier silence-on-cancel policy: user-dismissal is
      // rare, so on failure default to the truthful interpretation and
      // say it immediately. Never the platform's own words.
      const name = error instanceof Error ? error.name : "";
      const msg = error instanceof Error ? error.message : "";
      const isNotAllowed = name === "NotAllowedError"
        || /not allowed by the user agent|cancel|timeout|no.*credential/i.test(msg);
      const isPlatform = error instanceof DOMException
        || /^(Not|Invalid|Security|Timeout|Constraint|Abort|Unknown)[A-Z][A-Za-z]*Error$/.test(name)
        || /\bDOMException\b/i.test(msg);

      if (decided === "register") {
        // Sign-up flow terminals:
        if (isNotAllowed) {
          setMessage("Passkey wasn't created — try again.", "error");
        } else if (isPlatform) {
          setMessage("Couldn't create a passkey on this device.", "error");
        } else {
          // Server error — includes "That handle is already taken."
          // race when two clients register the same handle at once.
          setMessage(msg || "Sign up failed.", "error");
        }
      } else {
        // Sign-in flow terminals — cancel / no-credential is guidance,
        // not failure ("info" tint per team-lead — it reads calmer than
        // vermillion and matches the "handle may be taken" intent).
        if (isNotAllowed || isPlatform) {
          setMessage("That handle may be taken — try a different one.", "info");
        } else {
          setMessage(msg || "Sign in failed.", "error");
        }
      }
    } finally {
      setBusy(false);
    }
  }

  // Morphing button label — driven by the debounced handle-probe result.
  // Width is reserved in CSS (auth-primary min-width) so the row does NOT
  // jump when the label transitions. Empty/invalid state falls back to the
  // parallel-construction default.
  const trimmedHandle = handle.trim();
  const buttonLabel = busy
    ? "Working…"
    : !trimmedHandle
      ? "Sign in or sign up"
      : flow === "login"
        ? `Sign in as @${trimmedHandle}`
        : flow === "register"
          ? `Sign up as @${trimmedHandle}`
          : "Sign in or sign up";

  return (
    <Shell message={message} messageKind={messageKind} setMessage={setMessage} hideMenu>
      <section className="auth">
        {/* Composition per mockup Register A: shelf + copy grouped tight
            at the top (copy pinned UNDERNEATH the board — they read as
            one unit: puzzle + its thesis); auth row + footer grouped
            tight at the bottom edge (row is what to do, footer is who
            made it). The center gap between the two groups IS the
            composition — not dead space, not a void. Signed-out user's
            eye lands on the puzzle, reads the one-line thesis below,
            then descends to the auth affordance where their thumb sits
            on mobile. */}
        <div className="auth-top">
          <div className="auth-scene">
            <LandingShelfErrorBoundary><LandingPuzzleShelf /></LandingShelfErrorBoundary>
          </div>
        </div>
        {/* BOTTOM GROUP (Tejas 2026-08-04): copy + auth row + footer read
            as one unit at the bottom of the viewport. Reverses the
            earlier geometric-centering pass — grouped-with-buttons won.
            .auth is space-between over TWO children (auth-top, auth-
            bottom); .auth-bottom stacks copy → auth-row → made-by. On
            desktop (>=900px) the right column is the same stack; the
            left column is the puzzle-shelf. */}
        <div className="auth-bottom">
          <p className="landing-copy">{LANDING_COPY}</p>
          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {/* One-line auth: input flexes, button fixed. Together they
                read as ONE composed unit. Button label morphs via the
                debounce probe ("Sign in or sign up" → "Sign in as @x"
                / "Sign up as @x"); width reserved via min-width so the
                row does not jump when the label changes. */}
            <div className="auth-row">
              <input
                className="auth-input"
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
                placeholder="your_handle"
                autoComplete="username webauthn"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Handle"
              />
              <button className="auth-primary" type="submit" disabled={busy || !handle}>
                {buttonLabel}
              </button>
            </div>
          </form>
          <LandingFooter />
        </div>
      </section>
    </Shell>
  );
}

// Landing footer — pinned to the bottom of the viewport. Both attribution
// and the one useful signed-out link (inspirations) in one quiet line.
function LandingFooter() {
  return (
    <p className="made-by landing-footer">
      made by{" "}
      <a href="https://tejas.nyc" target="_blank" rel="noreferrer">tejas.nyc</a>
      {" · "}
      <button className="linkish" type="button" onClick={() => navigate("/inspirations")}>inspirations</button>
    </p>
  );
}

function Dashboard({
  home,
  inviteToken,
  refresh,
  setMessage,
}: {
  home: HomeData;
  inviteToken?: string;
  refresh: () => void;
  setMessage: SetMessage;
}) {
  return (
    <div className="dashboard">
      <InstallPrompt home={home} setMessage={setMessage} />
      {inviteToken ? <InvitePanel token={inviteToken} home={home} refresh={refresh} setMessage={setMessage} /> : null}
      {/* Ordering: (1) INCOMING actions the user must respond to, (2) games
          already IN PLAY — an accepted invite must not require scrolling
          past a Play form to find, (3) PLAY to start something new,
          (4) friends list, (5) PAST games collapsed. Passive material
          sinks; the user's current obligations rise. */}
      <IncomingPanel home={home} refresh={refresh} />
      <LiveGamesSection games={home.games} />
      {/* PlaySection (Schedule) now lives INSIDE FriendsSection as a
          bottom-of-list button — Tejas's decision. Kept as its own
          component so the schedule form logic is unchanged. */}
      <FriendsSection home={home} refresh={refresh} setMessage={setMessage} />
      <PastGamesSection games={home.games} />
      {/* No <MadeByTejas /> on the dashboard — Tejas ordered it removed
          from home. The attribution lives on exactly two surfaces now:
          the landing (LandingFooter) and /inspirations. Never dashboard,
          never game. See docs/requirements-ledger.md. */}
    </div>
  );
}

// "made by tejas.nyc" — quiet attribution line. Renders on exactly
// two surfaces: the landing (via LandingFooter, one-line footer with
// inspirations link) and /inspirations. NEVER on the dashboard (removed
// per Tejas's directive), NEVER on the game screen (the game stays
// pure). Style follows Tejas's own site convention: small, mono, muted.
function MadeByTejas() {
  return (
    <p className="made-by">
      made by{" "}
      <a href="https://tejas.nyc" target="_blank" rel="noreferrer">tejas.nyc</a>
    </p>
  );
}

const INSTALL_DISMISSED_KEY = "chess.install-dismissed";

function InstallPrompt({ home, setMessage }: { home: HomeData; setMessage: SetMessage }) {
  const [pushStatus, setPushStatus] = useState<PushStatus>("checking");
  const [installed, setInstalled] = useState<boolean>(() => detectInstalled());
  // Persist dismissal in localStorage so it sticks across reloads for this
  // browser. Cleared naturally when the user installs (dismissal becomes
  // moot — showInstall is already false) or manually via storage clear.
  const [installDismissed, setInstallDismissed] = useState<boolean>(() => {
    try { return window.localStorage.getItem(INSTALL_DISMISSED_KEY) === "true"; } catch { return false; }
  });

  async function checkPushStatus() {
    if (!home.pushPublicKey || !("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushStatus("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setPushStatus("blocked");
      return;
    }
    if (Notification.permission !== "granted") {
      setPushStatus("ready");
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    setPushStatus(subscription ? "enabled" : "ready");
  }

  useEffect(() => {
    void checkPushStatus().catch(() => setPushStatus("ready"));
    const media = window.matchMedia("(display-mode: standalone)");
    const update = () => setInstalled(detectInstalled());
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [home.pushPublicKey]);

  async function enablePush() {
    try {
      if (!home.pushPublicKey) throw new Error("Push key is not configured on this deployment.");
      if (!("Notification" in window)) throw new Error("Notifications are not supported in this browser.");
      if (Notification.permission === "denied") throw new Error("Notifications are blocked in this browser.");
      if (Notification.permission !== "granted") {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") throw new Error("Notification permission was not granted.");
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(home.pushPublicKey),
      });
      await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription }) });
      await checkPushStatus();
      setMessage("Notifications enabled for friend requests, challenges, and scheduled games.");
    } catch (error) {
      await checkPushStatus().catch(() => undefined);
      setMessage(error instanceof Error ? error.message : "Notification setup failed.", "error");
    }
  }

  // Install guidance and notification enablement are independent. Show
  // install guidance whenever the app isn't launched from the Home Screen
  // AND the user hasn't dismissed it (dismissal persists in localStorage
  // per Tejas's iPhone-test order — "cannot dismiss it and it drives him
  // nuts").
  const showInstall = !installed && !installDismissed;
  const showEnablePush = pushStatus === "ready";
  const showBlocked = pushStatus === "blocked";
  const showEnabled = pushStatus === "enabled";

  function dismissInstall() {
    try { window.localStorage.setItem(INSTALL_DISMISSED_KEY, "true"); } catch { /* private-mode → session-only dismissal is fine */ }
    setInstallDismissed(true);
  }

  if (!showInstall && !showEnablePush && !showBlocked) return null;

  return (
    <div className="install-strip">
      {showInstall ? (
        <div className="install-block">
          <button
            className="install-dismiss"
            aria-label="Dismiss install prompt"
            onClick={dismissInstall}
            type="button"
          >
            ×
          </button>
          <p className="install-title">Install to your Home Screen</p>
          <p className="install-body">
            Install to get notified — game invites and scheduled games reach you as notifications.
          </p>
          <p className="install-body install-how">
            iPhone: Share → Add to Home Screen. Android/Chrome: menu → Install app.
          </p>
        </div>
      ) : null}
      {showEnablePush ? (
        <div className="notif-block">
          <button className="ghost" onClick={enablePush}>Enable notifications</button>
          <p className="install-body notif-reason">so you know when a friend invites you</p>
        </div>
      ) : null}
      {showBlocked && !showInstall ? (
        <div className="notif-block">
          <p className="install-title">Notifications are off</p>
          {/* Tejas's simplified recovery: reinstall resets iOS permission
              state entirely, and the passkey makes re-login trivial. One
              instruction, the easy one — no Settings-path spelunking. */}
          <p className="install-body">
            Delete the app from your Home Screen and add it back — you'll be asked again.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function detectInstalled(): boolean {
  if (typeof window === "undefined") return false;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return Boolean(standalone || iosStandalone);
}

// Invite-link landing panel. Signed-in visitor with a token in the URL
// hits POST /api/friends/invite ON MOUNT — the endpoint is idempotent
// and IS the friendship completion (see requestByInvite server-side).
// Ceremony is gone; the panel just reports what happened and offers
// the natural next action (invite the new friend to a game).
function InvitePanel({
  token,
  home,
  refresh,
  setMessage,
}: {
  token: string;
  home: HomeData;
  refresh: () => void;
  setMessage: SetMessage;
}) {
  const [state, setState] = useState<
    | { kind: "working" }
    | { kind: "ok"; status: "created" | "accepted" | "already-friends"; friend: { id: string; handle: string } }
    | { kind: "error"; message: string }
  >({ kind: "working" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await api<{ status: "created" | "accepted" | "already-friends"; friend: { id: string; handle: string } }>(
          "/api/friends/invite",
          { method: "POST", body: JSON.stringify({ token }) },
        );
        if (cancelled) return;
        setState({ kind: "ok", status: result.status, friend: result.friend });
        // Refresh home so the new friendship + any accepted requests
        // reconcile into the dashboard behind the panel.
        void refresh();
      } catch (error) {
        if (cancelled) return;
        setState({ kind: "error", message: error instanceof Error ? error.message : "Invite failed." });
      }
    })();
    return () => { cancelled = true; };
  }, [token, refresh]);

  async function invite(friendId: string, handle: string) {
    try {
      const { challenge } = await api<{ challenge: { id: string } }>("/api/challenges", {
        method: "POST",
        body: JSON.stringify({ friendId, timeControl: "10|0" }),
      });
      navigate(`/waiting/${challenge.id}`, refresh);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Couldn't invite @${handle}.`, "error");
    }
  }

  function dismiss() { navigate("/", refresh); }

  if (state.kind === "working") {
    return (
      <section className="invite">
        <p className="muted">Connecting you…</p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section className="invite">
        <p>{state.message}</p>
        <button className="ghost" onClick={dismiss}>Home</button>
      </section>
    );
  }
  // ok: three sub-messages, one for each terminal status.
  const { friend, status } = state;
  const line =
    status === "already-friends" ? <>You and <strong>@{friend.handle}</strong> are already friends.</> :
    status === "accepted"        ? <>You and <strong>@{friend.handle}</strong> are now friends.</> :
                                    <>You and <strong>@{friend.handle}</strong> are now friends.</>;
  // Offer Invite regardless of presence — the challenge push IS the
  // come-online request (see FriendsSection.invite button rationale).
  return (
    <section className="invite">
      <p>{line}</p>
      <div className="invite-actions">
        <button className="primary" onClick={() => void invite(friend.id, friend.handle)}>
          Invite @{friend.handle} to a game
        </button>
        <button className="ghost" onClick={dismiss}>Home</button>
      </div>
    </section>
  );
}

function IncomingPanel({ home, refresh }: { home: HomeData; refresh: () => void }) {
  async function acceptFriend(id: string) {
    await api(`/api/friends/${id}/accept`, { method: "POST", body: "{}" });
    await refresh();
  }
  async function acceptChallenge(id: string) {
    const { game } = await api<{ game: GameMeta }>(`/api/challenges/${id}/accept`, { method: "POST", body: "{}" });
    navigate(`/game/${game.id}`);
  }
  async function acceptSchedule(id: string) {
    await api(`/api/schedules/${id}/accept`, { method: "POST", body: "{}" });
    await refresh();
  }

  const items: Array<{ key: string; label: React.ReactNode; onAccept: () => void }> = [
    ...home.requests.map((request) => ({
      key: `f-${request.id}`,
      label: <><strong>@{request.fromHandle}</strong> wants to be friends</>,
      onAccept: () => void acceptFriend(request.id),
    })),
    ...home.challenges.map((challenge) => ({
      key: `c-${challenge.id}`,
      label: <><strong>@{challenge.fromHandle}</strong> invited you to a game · {formatTimeControl(challenge.timeControl)}</>,
      onAccept: () => void acceptChallenge(challenge.id),
    })),
    ...home.schedules
      .filter((schedule) => schedule.toId === home.user.id && schedule.status === "pending")
      .map((schedule) => ({
        key: `s-${schedule.id}`,
        label: (
          <>
            <strong>@{schedule.fromHandle}</strong> proposed{" "}
            {formatScheduleWhen(schedule.startAt, schedule.recurrence, schedule.nextFireAt)}
          </>
        ),
        onAccept: () => void acceptSchedule(schedule.id),
      })),
  ];

  if (!items.length) return null;

  return (
    <section className="incoming">
      {items.map((item) => (
        <div className="incoming-row" key={item.key}>
          <span>{item.label}</span>
          <button className="primary compact" onClick={item.onAccept}>Accept</button>
        </div>
      ))}
    </section>
  );
}

// Split into two: LIVE games shout at the top of the dashboard so an
// accepted invitation is unmissable; past games get their own collapsed
// section far below. Never mixed — mixing them buries the one thing the
// user was told about into the noise of games they already know about.
function LiveGamesSection({ games }: { games: GameMeta[] }) {
  const active = games.filter((game) => game.status === "active");
  if (!active.length) return null;
  return (
    <section className="games games-live">
      <h2 className="section-title">In play</h2>
      <div className="game-rows">
        {active.map((game) => (
          <GameRow key={game.id} game={game} accent />
        ))}
      </div>
    </section>
  );
}

function PastGamesSection({ games }: { games: GameMeta[] }) {
  const past = games.filter((game) => game.status !== "active");
  const [open, setOpen] = useState(false);
  if (!past.length) return null;
  return (
    <section className="games games-past">
      <button
        className="section-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span className="section-title">Past games</span>
        <span className="section-toggle-count">{past.length}</span>
        <span className="section-toggle-caret" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="game-rows">
          {past.slice(0, 20).map((game) => (
            <GameRow key={game.id} game={game} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function GameRow({ game, accent }: { game: GameMeta; accent?: boolean }) {
  const status = game.status === "active" ? "in play" : game.result || game.status;
  return (
    <button className={`game-row ${accent ? "accent" : ""}`} onClick={() => navigate(`/game/${game.id}`)}>
      <span className="row-mono">{formatTimeControl(game.timeControl)}</span>
      <span className="row-status">{status}</span>
      <span className="row-arrow" aria-hidden="true">→</span>
    </button>
  );
}

function PlaySection({
  home,
  refresh,
  setMessage,
}: {
  home: HomeData;
  refresh: () => void;
  setMessage: SetMessage;
}) {
  // "Play now" is a per-friend row action on the Friends list — Play here
  // is now ONLY the "propose a time" surface. Kept as a compact form
  // because "day + time" needs two inputs; hidden by default behind a
  // Schedule toggle so it doesn't fight for space with the friends list.
  const [friendId, setFriendId] = useState(home.friends[0]?.id || "");
  const [day, setDay] = useState<string>(() => defaultDayValue());
  const [time, setTime] = useState<string>("19:00");
  const [repeat, setRepeat] = useState<"once" | "weekly" | "daily">("once");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!friendId && home.friends[0]) setFriendId(home.friends[0].id);
  }, [friendId, home.friends]);

  async function propose() {
    try {
      const startAt = dayTimeToMillis(day, time);
      if (!Number.isFinite(startAt)) throw new Error("Pick a valid day and time.");
      // TIME CONTROL is hardcoded — 10 min IS the game. Server type still
      // accepts the union for future flexibility; UI never asks.
      const recurrence: Recurrence =
        repeat === "daily"  ? { kind: "daily" } :
        repeat === "weekly" ? { kind: "weekly", weekday: new Date(startAt).getDay() as 0|1|2|3|4|5|6 } :
                              { kind: "once" };
      await api("/api/schedules", { method: "POST", body: JSON.stringify({ friendId, timeControl: "10|0", startAt, recurrence }) });
      setMessage("Game time proposed.");
      setOpen(false);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Schedule failed.", "error");
    }
  }

  async function cancelSeries(schedule: Schedule) {
    try {
      await api(`/api/schedules/${schedule.id}/cancel`, { method: "POST", body: "{}" });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't end the series.", "error");
    }
  }

  const outgoingSchedules = home.schedules.filter(
    (schedule) => schedule.fromId === home.user.id || (schedule.toId === home.user.id && schedule.status !== "pending"),
  );

  if (home.friends.length === 0 && outgoingSchedules.length === 0) return null;

  return (
    <section className="play">
      <button
        type="button"
        className="section-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={home.friends.length === 0}
      >
        <span className="section-title">Schedule a game</span>
        <span className="section-toggle-caret" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>

      {open && home.friends.length > 0 ? (
        <div className="play-form">
          <label className="field">
            <span className="field-label">Friend</span>
            <FriendSelect friends={home.friends} value={friendId} onChange={setFriendId} />
          </label>
          {/* Day + Time + Repeat share one flex-wrap row so they lay out
              cleanly at every width — 3 per row on desktop, 2 or 1 as the
              container narrows. Fixed-column grid was the bug Tejas hit
              2026-08-04: at wide widths the 3rd field crushed under the
              previous one and Propose orphaned to the right. */}
          <div className="field-row">
            <label className="field">
              <span className="field-label">Day</span>
              <select value={day} onChange={(event) => setDay(event.target.value)}>
                {dayOptions().map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Time</span>
              <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Repeat</span>
              <select value={repeat} onChange={(event) => setRepeat(event.target.value as "once" | "weekly" | "daily")}>
                <option value="once">Once</option>
                <option value="weekly">Weekly on {WEEKDAY_LONG[new Date(dayTimeToMillis(day, time)).getDay()]}</option>
                <option value="daily">Daily</option>
              </select>
            </label>
          </div>
          <div className="play-action">
            <button className="primary" onClick={propose} disabled={!friendId}>Propose</button>
          </div>
        </div>
      ) : null}

      {outgoingSchedules.length ? (
        <ul className="pending">
          {outgoingSchedules.map((schedule) => {
            const gameLink = schedule.lastGameId || schedule.gameId;
            const recurringActive = schedule.recurrence && schedule.recurrence.kind !== "once" && schedule.status === "accepted";
            return (
              <li key={schedule.id}>
                @{schedule.fromHandle} → @{schedule.toHandle}{" "}
                · {formatScheduleWhen(schedule.startAt, schedule.recurrence, schedule.nextFireAt)}{" "}
                · {scheduleStatus(schedule.status)}
                {gameLink ? (
                  <button className="link" onClick={() => navigate(`/game/${gameLink}`)}>Open</button>
                ) : null}
                {recurringActive ? (
                  <button className="link" onClick={() => void cancelSeries(schedule)}>End series</button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

// Day picker options: today, tomorrow, then each of the next five
// named weekdays (Tue, Wed, ..., Sun). Encodes the friction Tejas wanted
// — "a real day + time, not minutes from now." A future round adds
// recurrence (every Tuesday 9pm); the schedule shape already allows an
// optional `recurrence` field on the server side (documented invariant,
// not yet populated), so recurring can layer on without a data change.
function dayOptions(): Array<{ value: string; label: string }> {
  const now = new Date();
  const out: Array<{ value: string; label: string }> = [];
  const iso = (offset: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
  };
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  out.push({ value: iso(0), label: "Today" });
  out.push({ value: iso(1), label: "Tomorrow" });
  for (let i = 2; i <= 6; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    out.push({ value: iso(i), label: weekday[d.getDay()] });
  }
  return out;
}
function defaultDayValue(): string { return dayOptions()[0].value; }
function dayTimeToMillis(day: string, time: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const d = new Date();
  d.setFullYear(year, month - 1, date);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatScheduleWhen(startAt: number, recurrence?: Recurrence, nextFireAt?: number): string {
  const timeLabel = new Date(startAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // For recurring schedules the SHAPE of the label changes: it's about
  // the cadence, not the specific date. The next fire time is a
  // secondary line the caller can render if useful; we just describe
  // the series here.
  if (recurrence?.kind === "daily") return `every day · ${timeLabel}`;
  if (recurrence?.kind === "weekly") return `every ${WEEKDAY_LONG[recurrence.weekday]} · ${timeLabel}`;
  const d = new Date(nextFireAt ?? startAt);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const dayLabel = sameDay ? "Today" : isTomorrow ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return `${dayLabel} · ${timeLabel}`;
}

// Friends list IS the action surface (Tejas's simplification directive):
// no dropdown, no separate Send form. Each friend row has an Invite
// button. Online friends sort first and their button is enabled — the
// button's presence IS the presence signal, with the dot as a second
// cue. Offline rows still list the handle so you know they exist, but
// the button is disabled — you can't play a friend who isn't around.
//
// Scale guard: show N rows (INITIAL_VISIBLE), rest behind a "more
// friends" disclosure — designed for hundreds without dashboard spam.
const INITIAL_VISIBLE_FRIENDS = 8;

function FriendsSection({
  home,
  refresh,
  setMessage,
}: {
  home: HomeData;
  refresh: () => void;
  setMessage: SetMessage;
}) {
  const [handle, setHandle] = useState("");
  const [showAll, setShowAll] = useState(false);

  async function requestFriend() {
    try {
      await api("/api/friends/request", { method: "POST", body: JSON.stringify({ handle }) });
      setHandle("");
      setMessage("Friend request sent.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Friend request failed.", "error");
    }
  }

  async function invite(friend: Friend) {
    try {
      const { challenge } = await api<{ challenge: { id: string } }>("/api/challenges", {
        method: "POST",
        // 10 min is the game — no choice to render, no choice to make.
        body: JSON.stringify({ friendId: friend.id, timeControl: "10|0" }),
      });
      navigate(`/waiting/${challenge.id}`, refresh);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Invite failed.", "error");
    }
  }

  // Online first, then offline; each group alphabetized so the order
  // stays stable across refreshes.
  const sortedFriends = [...home.friends].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.handle.localeCompare(b.handle);
  });
  const visibleFriends = showAll ? sortedFriends : sortedFriends.slice(0, INITIAL_VISIBLE_FRIENDS);
  const hiddenCount = sortedFriends.length - visibleFriends.length;

  return (
    <section className="friends">
      <h2 className="section-title">Friends</h2>

      {home.sentRequests.length ? (
        <ul className="pending">
          {home.sentRequests.map((request) => (
            <li key={request.id}>Request sent to @{request.toHandle}</li>
          ))}
        </ul>
      ) : null}

      {home.friends.length ? (
        <>
          <ul className="friend-list">
            {visibleFriends.map((friend) => (
              <li className="friend-card" key={friend.id}>
                <span
                  className={`presence ${friend.online ? "online" : "offline"}`}
                  role="status"
                  aria-label={friend.online ? "online" : "offline"}
                />
                <span className="friend-handle">@{friend.handle}</span>
                {/* Invite is active regardless of presence — the challenge push
                    IS the come-online request. Offline state shows via the
                    status dot only. Challenges persist on the server until
                    answered or withdrawn (no TTL), so an offline friend gets
                    the invite in their incoming list on their next open. */}
                <button
                  className="primary compact friend-invite"
                  onClick={() => void invite(friend)}
                  aria-label={`Invite @${friend.handle}`}
                >
                  Invite
                </button>
              </li>
            ))}
          </ul>
          {hiddenCount > 0 && !showAll ? (
            <button className="ghost more-friends" onClick={() => setShowAll(true)}>
              More friends ({hiddenCount})
            </button>
          ) : null}
        </>
      ) : (
        <p className="muted">No friends yet. Add one below.</p>
      )}

      {/* Add-a-friend + copy-invite-link both live behind a disclosure at
          the bottom of the friends section, mirroring the Schedule
          disclosure below. The pair is "reach out for the first time";
          the friends list itself is "reach out again". Copy-invite-link
          moved OUT of the ⋯ menu (didn't belong there — it's a friends
          action, not a settings action). */}
      <AddFriendSection
        handle={handle}
        setHandle={setHandle}
        requestFriend={requestFriend}
        inviteUrl={home.inviteUrl}
        setMessage={setMessage}
      />

      {/* Schedule entry point — one button at the BOTTOM of the friends
          section (Tejas's decision). Tapping expands the day + time
          picker. Visible enough to be discovered, out of the way when
          the user isn't scheduling. */}
      <PlaySection home={home} refresh={refresh} setMessage={setMessage} />
    </section>
  );
}

function AddFriendSection({
  handle,
  setHandle,
  requestFriend,
  inviteUrl,
  setMessage,
}: {
  handle: string;
  setHandle: (value: string) => void;
  requestFriend: () => Promise<void>;
  inviteUrl: string;
  setMessage: SetMessage;
}) {
  const [open, setOpen] = useState(false);

  async function copyInvite() {
    const invite = `${window.location.origin}${inviteUrl}`;
    try {
      await navigator.clipboard.writeText(invite);
      setMessage("Invite link copied.");
    } catch {
      // Clipboard permission blocked — fall back to a toast with the
      // full link so the user can select-and-copy manually.
      setMessage(invite);
    }
  }

  return (
    <section className="add-friend-section">
      <button
        type="button"
        className="section-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="section-title">Add a friend</span>
        <span className="section-toggle-caret" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="add-friend-form">
          <div className="add-friend">
            <input
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="friend_handle"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <button className="primary" onClick={() => void requestFriend()} disabled={!handle}>Add</button>
          </div>
          <button type="button" className="ghost add-friend-copy" onClick={() => void copyInvite()}>
            Copy invite link
          </button>
        </div>
      ) : null}
    </section>
  );
}

// Waiting room — the sender lands here IMMEDIATELY after sending a
// challenge. Full board visible, opponent bar reads "waiting for @x".
// The point of the flow (Tejas's directive): inviting means sitting
// down. Polls the challenge state every 2s and transitions to the live
// game in-place when the invitee accepts; if the invitee accepts while
// the sender walked away, the challenge_accepted push brings them back.
function WaitingRoom({
  challengeId,
  home,
  message,
  messageKind,
  onHome,
  setMessage,
}: {
  challengeId: string;
  home: HomeData;
  message: string;
  messageKind: ToastKind;
  onHome: () => void;
  setMessage: SetMessage;
}) {
  const [challenge, setChallenge] = useState<Challenge & { gameId?: string; status?: string; toId?: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Waiting room borrows the game screen's no-scroll shell — same
  // full-viewport board treatment, just with an idle bar.
  useEffect(() => {
    document.body.dataset.screen = "game";
    return () => {
      if (document.body.dataset.screen === "game") delete document.body.dataset.screen;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    async function poll() {
      try {
        const { challenge: next } = await api<{ challenge: Challenge & { gameId?: string; status?: string; toId?: string } }>(`/api/challenges/${challengeId}/state`);
        if (cancelled) return;
        setChallenge(next);
        setLoadError(null);
        if (next.status === "accepted" && next.gameId) {
          navigate(`/game/${next.gameId}`);
          return;
        }
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Could not check the invite.");
      }
      timer = window.setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [challengeId]);

  const menuExtras = (closeMenu: () => void) => (
    <li>
      <button className="menu-item" onClick={() => { closeMenu(); onHome(); }}>
        Home
      </button>
    </li>
  );

  if (loadError) {
    return (
      <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage}>
        <section className="game-error">
          <h2 className="section-title">Can't open this invite</h2>
          <p className="muted">{loadError}</p>
          <div className="game-actions">
            <button className="ghost" onClick={onHome}>Home</button>
          </div>
        </section>
      </Shell>
    );
  }

  if (!challenge) return <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage}><LoadingLine /></Shell>;

  // If we already sent the challenge, the invitee is toHandle from our
  // side. Fall back on the friend list for a handle if the server did
  // not enrich fromHandle/toHandle (it does, but be safe).
  const inviteeHandle = challenge.toHandle
    || home.friends.find((friend) => friend.id === (challenge as unknown as { toId?: string }).toId)?.handle
    || "your friend";
  const invitee = home.friends.find((friend) => friend.handle === inviteeHandle);
  const inviteePresence: string = invitee?.online ? "online" : "offline";

  return (
    <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage} menuExtras={menuExtras}>
      <section className="game game-fixed">
        <div className="board-column">
          <div className="clock-strip top">
            <div className="who">
              <span
                className={`presence ${inviteePresence}`}
                role="status"
                aria-label={inviteePresence}
              />
              <span className="handle-line">waiting for @{inviteeHandle}</span>
            </div>
            <span className="clock waiting-label">{formatTimeControl(challenge.timeControl)}</span>
          </div>

          <div className="board-holder">
            <Board
              fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
              orientation="w"
              selected={null}
              onSquare={() => { /* no-op — no game yet */ }}
              interactive={false}
              lastMove={null}
            />
          </div>

          <div className="clock-strip bottom">
            <div className="who">
              <span className="handle-line">@{home.user.handle}</span>
              <span className="you">you</span>
            </div>
            <span className="clock waiting-label">ready</span>
          </div>
        </div>

        <div className="game-bottom">
          <span className="turn-status">Sit tight — they'll come when they can.</span>
        </div>
      </section>
    </Shell>
  );
}

function GameScreen({
  gameId,
  home,
  message,
  messageKind,
  onHome,
  setMessage,
}: {
  gameId: string;
  home: HomeData;
  message: string;
  messageKind: ToastKind;
  onHome: () => void;
  setMessage: SetMessage;
}) {
  const [game, setGame] = useState<GameState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selected, setSelected] = useState<Square | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [now, setNow] = useState(Date.now());
  const myColor = game?.whiteId === home.user.id ? "w" : "b";
  const opponentId = game ? (game.whiteId === home.user.id ? game.blackId : game.whiteId) : "";
  const opponentRawState = game?.connectionState?.[opponentId] || "gone";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<GameState>(`/api/games/${gameId}/state`);
        if (!cancelled) {
          setGame(data);
          setLoadError(null);
        }
      } catch (error) {
        if (cancelled) return;
        const text = error instanceof Error ? error.message : "Could not load this game.";
        setLoadError(text);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId, loadAttempt]);

  // Resilient realtime channel. Reconnects on close/error with backoff,
  // resyncs (via REST snapshot) on every reconnect, wakes on visibility
  // return, and treats a silent socket as half-open via ping/pong heartbeat.
  useRealtimeGame(gameId, {
    onGame: (next) => {
      setGame(next);
      setLoadError(null);
    },
    onResync: async () => {
      try {
        const data = await api<GameState>(`/api/games/${gameId}/state`);
        setGame(data);
        setLoadError(null);
      } catch {
        // Silent — REST resync failure just means we wait for the next
        // socket message; the socket itself is separately reconnecting.
      }
    },
    enabled: !!game && game.status === "active",
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Lock the viewport to no-scroll while on the game screen. Board sizes
  // itself to fit the remaining budget via CSS; no vertical scroll on any
  // form factor. Attribute is namespaced so other routes are unaffected.
  useEffect(() => {
    document.body.dataset.screen = "game";
    return () => {
      if (document.body.dataset.screen === "game") delete document.body.dataset.screen;
    };
  }, []);

  async function submitMove(from: Square, to: Square, promotion?: "q" | "r" | "b" | "n") {
    try {
      const next = await api<GameState>(`/api/games/${gameId}/move`, {
        method: "POST",
        body: JSON.stringify({ from, to, promotion: promotion || undefined }),
      });
      setGame(next);
      setSelected(null);
      setPendingPromotion(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Move failed.", "error");
      setSelected(null);
      setPendingPromotion(null);
    }
  }

  async function choose(square: Square) {
    if (!game || game.status !== "active") return;
    // Silent-board principle: during play, the BOARD is the only feedback
    // channel. Gameplay taps NEVER produce toasts. Off-turn or illegal
    // taps are silent no-ops so the server-side "Illegal move." / "It is
    // not your turn." responses are unreachable in the normal UI flow
    // (they still exist as an authoritative backstop).
    if (game.turn !== myColor) {
      // Not your turn. The turn strip already tells you whose it is; a
      // tap on your own piece here is silent — no selection, no dots,
      // no move request. Same silence already applies to opponent
      // pieces (below); extend to own-pieces-off-turn.
      return;
    }
    const chess = new Chess(game.fen);
    const targetPiece = chess.get(square);
    if (!selected) {
      // Only YOUR OWN pieces are selectable — empty squares and opponent
      // pieces are silent no-ops. Tapping an opponent piece to "see what
      // it could do" is a chess.com affordance the anti-chess.com thesis
      // explicitly rejects.
      if (!targetPiece || targetPiece.color !== myColor) return;
      setSelected(square);
      return;
    }
    if (selected === square) {
      // Tapping the selected square again cancels the selection.
      setSelected(null);
      return;
    }
    // Tapping another of your OWN pieces retargets the selection —
    // natural correction path when the user changes their mind.
    if (targetPiece && targetPiece.color === myColor) {
      setSelected(square);
      return;
    }
    // Client-side legality gate — chess.js already computes the same
    // legal-target set the dot overlay uses. If the target isn't in
    // that set, the tap is silent: deselect and stop. No doomed move
    // request, no "Illegal move." toast.
    const legalMoves = chess.moves({ square: selected, verbose: true }) as Array<{ to: string; promotion?: string }>;
    const legalTarget = legalMoves.find((m) => m.to === square);
    if (!legalTarget) {
      setSelected(null);
      return;
    }
    // Detect promotion locally so we show the picker instead of
    // silently auto-queening.
    const fromPiece = chess.get(selected);
    const targetRank = square[1];
    if (fromPiece && fromPiece.type === "p" && ((fromPiece.color === "w" && targetRank === "8") || (fromPiece.color === "b" && targetRank === "1"))) {
      if (legalMoves.some((m) => m.to === square && m.promotion)) {
        setPendingPromotion({ from: selected, to: square });
        return;
      }
    }
    await submitMove(selected, square);
  }

  async function resign() {
    const next = await api<GameState>(`/api/games/${gameId}/resign`, { method: "POST", body: "{}" });
    setGame(next);
    setConfirmResign(false);
  }

  if (loadError) {
    return (
      <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage}>
        <section className="game-error">
          <h2 className="section-title">Can't open this game</h2>
          <p className="muted">{loadError}</p>
          <div className="game-actions">
            <button className="primary" onClick={() => setLoadAttempt((n) => n + 1)}>Try again</button>
            <button className="ghost" onClick={onHome}>Home</button>
          </div>
        </section>
      </Shell>
    );
  }
  if (!game) return <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage}><LoadingLine /></Shell>;

  const opponentHandle = myColor === "w" ? game.blackHandle : game.whiteHandle;
  const myHandle = myColor === "w" ? game.whiteHandle : game.blackHandle;
  const opponentColor: "w" | "b" = myColor === "w" ? "b" : "w";
  const opponentClock = liveClock(game, opponentColor, now);
  const myClock = liveClock(game, myColor, now);
  const opponentPresence = presenceLabel(opponentRawState, opponentHandle);
  const lastMove = game.moves.length ? { from: game.moves[game.moves.length - 1].from, to: game.moves[game.moves.length - 1].to } : null;

  // Home + Resign live inside the universal ⋯ menu (team-lead: one menu
  // pattern, one position). Rendered via Shell's menuExtras hook so the
  // game screen doesn't need its own bespoke menu chrome.
  const gameMenuExtras = (closeMenu: () => void) => (
    <>
      <li>
        <button className="menu-item" onClick={() => { closeMenu(); onHome(); }}>
          Home
        </button>
      </li>
      {confirmResign ? (
        <>
          <li>
            <button
              className="menu-item menu-item-danger"
              disabled={game.status !== "active"}
              onClick={() => { closeMenu(); void resign(); }}
            >
              Confirm resign
            </button>
          </li>
          <li>
            <button className="menu-item" onClick={() => setConfirmResign(false)}>
              Cancel
            </button>
          </li>
        </>
      ) : (
        <li>
          <button
            className="menu-item menu-item-warn"
            disabled={game.status !== "active"}
            onClick={() => setConfirmResign(true)}
          >
            Resign
          </button>
        </li>
      )}
    </>
  );

  const activeCount = game.moves.length;

  return (
    <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage} menuExtras={gameMenuExtras}>
      <section className="game game-fixed">
        <div className="board-column">
          {/* active-turn class paints the strip DEEP-INK (Villalba
              incision made large). Cream text on the ink band. */}
          <div
            className={`clock-strip top ${game.status === "active" && game.turn === opponentColor ? "active-turn" : ""}`}
          >
            <div className="who">
              <span
                className={`presence ${opponentRawState}`}
                role="status"
                aria-label={opponentPresence}
              />
              <span className="handle-line">@{opponentHandle}</span>
            </div>
            <time className="clock">{formatClock(opponentClock)}</time>
          </div>

          <CapturedStrip moves={game.moves} color={opponentColor} />

          <div className="board-holder">
            <Board
              fen={game.fen}
              orientation={myColor || "w"}
              selected={selected}
              onSquare={choose}
              lastMove={lastMove}
            />
          </div>

          <CapturedStrip moves={game.moves} color={myColor} />

          <div
            className={`clock-strip bottom ${game.status === "active" && game.turn === myColor ? "active-turn" : ""}`}
          >
            <div className="who">
              {/* No self-presence dot — you're obviously here. Opponent's
                  strip carries the only presence indicator. "you" span
                  preserved for a11y (visually clipped). */}
              <span className="handle-line">@{myHandle}</span>
              <span className="you">you</span>
            </div>
            <time className="clock">{formatClock(myClock)}</time>
          </div>
        </div>

        {pendingPromotion ? (
          <PromotionPicker
            color={myColor || "w"}
            onPick={(piece) => void submitMove(pendingPromotion.from, pendingPromotion.to, piece)}
            onCancel={() => setPendingPromotion(null)}
          />
        ) : null}

        {/* Bottom bar — turn status on the left, quiet Home link on the
            right (Tejas: "no easy way back" from the game; visible Home
            in the game chrome is acceptable). Move count is subsumed
            when the game is over — the terminal state upgrades the bar
            to a prominent action row (Home + Rematch when we have it,
            not just Home buried in the ⋯ menu). */}
        <div className={`game-bottom ${game.status !== "active" ? "game-bottom-terminal" : ""}`}>
          {game.status === "active" ? (
            <>
              <span className="turn-status">
                {game.turn === myColor ? "Your move" : "Their move"}
              </span>
              <div className="game-bottom-right">
                <span className="move-count">{activeCount} move{activeCount === 1 ? "" : "s"}</span>
                <button className="game-bottom-home" onClick={onHome} type="button">Home</button>
              </div>
            </>
          ) : (
            <>
              <span className="turn-status terminal-status">
                <span className="terminal">
                  {game.status}
                  {game.result ? ` · ${game.result}` : ""}
                </span>
              </span>
              <div className="game-bottom-actions">
                <button className="ghost compact" onClick={onHome} type="button">Home</button>
              </div>
            </>
          )}
        </div>
      </section>
    </Shell>
  );
}

function Board({
  fen,
  orientation,
  selected,
  onSquare,
  interactive = true,
  lastMove,
}: {
  fen: string;
  orientation: "w" | "b";
  selected: Square | null;
  onSquare: (square: Square) => void;
  interactive?: boolean;
  lastMove?: { from: string; to: string } | null;
}) {
  const chess = useMemo(() => new Chess(fen), [fen]);
  const board = chess.board();
  const rankList = orientation === "w" ? ranks : [...ranks].reverse();
  const fileList = orientation === "w" ? files : [...files].reverse();

  // Legal destinations for the currently-selected piece — pulled from
  // chess.js so promotion, castling, and en passant are all included.
  const legalTargets = useMemo(() => {
    if (!selected || !interactive) return new Map<string, "move" | "capture">();
    const moves = chess.moves({ square: selected, verbose: true }) as Array<{ to: string; captured?: string; flags: string }>;
    const map = new Map<string, "move" | "capture">();
    for (const m of moves) {
      map.set(m.to, m.captured || m.flags.includes("e") ? "capture" : "move");
    }
    return map;
  }, [chess, selected, interactive]);

  // King-in-check square gets a vermillion glow. chess.js reports the
  // side to move as in check when inCheck() is true.
  const checkedKingSquare = useMemo(() => {
    if (!interactive) return null;
    if (!chess.inCheck()) return null;
    const turn = chess.turn();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const cell = board[r][f];
        if (cell && cell.type === "k" && cell.color === turn) {
          return `${files[f]}${8 - r}`;
        }
      }
    }
    return null;
  }, [chess, board, interactive]);

  return (
    <div
      className={`board ${interactive ? "" : "board-static"}`}
      role={interactive ? "grid" : "presentation"}
      aria-label={interactive ? "Chess board" : undefined}
    >
      {rankList.flatMap((rank) =>
        fileList.map((file) => {
          const square = `${file}${rank}` as Square;
          const piece = board[8 - Number(rank)][files.indexOf(file)];
          const dark = (files.indexOf(file) + Number(rank)) % 2 === 0;
          const showFile = orientation === "w" ? rank === "1" : rank === "8";
          const showRank = orientation === "w" ? file === "a" : file === "h";
          const target = legalTargets.get(square);
          const isFromLast = lastMove?.from === square;
          const isToLast = lastMove?.to === square;
          const isCheck = checkedKingSquare === square;

          if (!interactive) {
            return (
              <div
                className={`square ${dark ? "dark" : "light"}`}
                data-square={square}
                key={square}
              >
                {showRank ? <span className="coord coord-rank">{rank}</span> : null}
                {showFile ? <span className="coord coord-file">{file}</span> : null}
                {piece ? <PieceGlyph color={piece.color} type={piece.type} /> : null}
              </div>
            );
          }
          const classes = [
            "square",
            dark ? "dark" : "light",
            selected === square ? "selected" : "",
            isFromLast ? "last-from" : "",
            isToLast ? "last-to" : "",
            isCheck ? "in-check" : "",
          ].filter(Boolean).join(" ");
          return (
            <button
              className={classes}
              data-square={square}
              key={square}
              onClick={() => void onSquare(square)}
              aria-label={square}
            >
              {showRank ? <span className="coord coord-rank" aria-hidden="true">{rank}</span> : null}
              {showFile ? <span className="coord coord-file" aria-hidden="true">{file}</span> : null}
              {piece ? <PieceGlyph color={piece.color} type={piece.type} /> : null}
              {target === "move" ? <span className="legal-dot" aria-hidden="true" /> : null}
              {target === "capture" ? <span className="legal-capture" aria-hidden="true" /> : null}
            </button>
          );
        }),
      )}
    </div>
  );
}

// Promotion picker — a small celluloid strip that appears when a pawn
// reaches the last rank. Four pins, one per promotion piece; user taps
// the piece to promote. Kills the auto-queen behavior.
function PromotionPicker({
  color,
  onPick,
  onCancel,
}: {
  color: "w" | "b";
  onPick: (piece: "q" | "r" | "b" | "n") => void;
  onCancel: () => void;
}) {
  return (
    <div className="promotion-backdrop" onClick={onCancel} role="dialog" aria-label="Choose promotion piece">
      <div className="promotion-strip" onClick={(e) => e.stopPropagation()}>
        {(["q", "r", "b", "n"] as const).map((t) => (
          <button
            className="promotion-choice"
            key={t}
            onClick={() => onPick(t)}
            aria-label={pieceNames[t]}
          >
            <PieceGlyph color={color} type={t} />
          </button>
        ))}
      </div>
    </div>
  );
}

// Captured-material strip — shows pieces the opponent has taken from
// this player. Displayed above the opponent's clock so the imbalance
// is immediately readable.
function CapturedStrip({ moves, color }: { moves: GameState["moves"]; color: "w" | "b" }) {
  // Rebuild captures by replaying the SAN moves through chess.js.
  const captured = useMemo(() => {
    const c = new Chess();
    const takenFromColor: string[] = [];
    for (const m of moves) {
      const result = c.move(m.san);
      if (result?.captured) {
        // The captured piece belonged to whoever's turn it just was —
        // the side that just made the move captured the OTHER color.
        const capturedColor: "w" | "b" = result.color === "w" ? "b" : "w";
        if (capturedColor === color) takenFromColor.push(result.captured);
      }
    }
    // Sort by piece value so the visual reads left-to-right in strength.
    const rank: Record<string, number> = { q: 5, r: 4, b: 3, n: 2, p: 1 };
    return takenFromColor.sort((a, b) => (rank[b] || 0) - (rank[a] || 0));
  }, [moves, color]);
  // Always render the wrapper so its height is reserved from the very
  // first frame — Tejas reported the whole game screen jumping when the
  // first capture appeared. The wrapper's min-height (see .captured-strip
  // in styles.css) locks the row height whether captured is empty or full.
  return (
    <div className="captured-strip" aria-label={`${color === "w" ? "White" : "Black"} pieces captured`}>
      {captured.map((t, i) => (
        <span className={`captured piece piece-${color}`} key={i}>{color === "w" ? whiteGlyphs[t as never] : blackGlyphs[t as never]}</span>
      ))}
    </div>
  );
}

function FriendSelect({
  friends,
  value,
  onChange,
}: {
  friends: Friend[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Friend">
      <option value="">Choose a friend</option>
      {friends.map((friend) => (
        <option key={friend.id} value={friend.id}>@{friend.handle}</option>
      ))}
    </select>
  );
}

function PieceGlyph({ color, type }: { color: Color; type: PieceSymbol }) {
  // Always the filled shape — CSS tints piece-w bone and piece-b ink.
  const glyph = filledGlyphs[type];
  const title = `${color === "w" ? "white" : "black"} ${pieceNames[type]}`;
  return (
    <span className={`piece piece-${color}`} role="img" aria-label={title}>
      {glyph}
    </span>
  );
}

function formatClock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60).toString();
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function liveClock(game: GameState, color: "w" | "b", now: number) {
  if (game.status !== "active" || game.turn !== color) return color === "w" ? game.whiteMs : game.blackMs;
  return (color === "w" ? game.whiteMs : game.blackMs) - Math.max(0, now - game.lastTickAt);
}

function scheduleStatus(status: Schedule["status"]) {
  if (status === "fired") return "ready";
  if (status === "cancelled") return "ended";
  return status;
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

async function signOut(onSignedOut: () => void) {
  await api("/api/auth/logout", { method: "POST", body: "{}" });
  // Clear in-memory identity FIRST so the AuthScreen renders immediately —
  // the previous version pushState-only'd and left the dashboard mounted
  // with stale home data. Then push the URL so future refresh() sees "/".
  onSignedOut();
  window.history.pushState({}, "", "/");
}

function navigate(path: string, after?: () => void) {
  window.history.pushState({}, "", path);
  if (after) void after();
  window.dispatchEvent(new PopStateEvent("popstate"));
}

createRoot(document.getElementById("root")!).render(<App />);
