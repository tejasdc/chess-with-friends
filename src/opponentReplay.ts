import { useEffect, useMemo, useState } from "react";
import { Chess, type Move, type PieceSymbol } from "chess.js";

type ReplayGame = {
  id: string;
  fen: string;
  status: string;
  moves: Array<{ by: string; san: string; fen: string }>;
};

export type ReplayFrame = {
  positionKey: string;
  move: Move;
  phase: "before" | "moving" | "after";
};

export function useOpponentReplay(game: ReplayGame | null, opponentId: string) {
  const [frame, setFrame] = useState<ReplayFrame | null>(null);
  const positionKey = game ? `${game.id}:${game.fen}:${game.status}:${game.moves.length}` : "";
  const lastOpponentMove = useMemo(() => {
    if (!game) return null;
    for (let index = game.moves.length - 1; index >= 0; index--) {
      const entry = game.moves[index];
      if (entry.by !== opponentId) continue;
      try {
        const chess = index === 0 ? new Chess() : new Chess(game.moves[index - 1].fen);
        return chess.move(entry.san);
      } catch {
        return null;
      }
    }
    return null;
  }, [game?.moves, opponentId]);

  // A live position always supersedes its temporary replay, even before effects run.
  const replay = frame?.positionKey === positionKey ? frame : null;

  useEffect(() => {
    if (!frame || frame.positionKey !== positionKey) {
      setFrame(null);
      return;
    }
    const advance = (phase: ReplayFrame["phase"]) => setFrame((current) => current ? { ...current, phase } : null);
    const timers = [
      window.setTimeout(() => advance("moving"), 180),
      window.setTimeout(() => advance("after"), 600),
      window.setTimeout(() => setFrame(null), 850),
    ];
    const cancelWhenHidden = () => {
      if (document.hidden) setFrame(null);
    };
    document.addEventListener("visibilitychange", cancelWhenHidden);
    return () => {
      timers.forEach(window.clearTimeout);
      document.removeEventListener("visibilitychange", cancelWhenHidden);
    };
  }, [frame?.move, frame?.positionKey, positionKey]);

  return {
    replay,
    lastOpponentMove,
    startReplay() {
      if (lastOpponentMove && !replay) setFrame({ positionKey, move: lastOpponentMove, phase: "before" });
    },
  };
}

export function replayPieces(move: Move): Array<{ from: string; to: string; type: PieceSymbol }> {
  const pieces: Array<{ from: string; to: string; type: PieceSymbol }> = [{ from: move.from, to: move.to, type: move.piece }];
  const rank = move.from[1];
  if (move.isKingsideCastle()) pieces.push({ from: `h${rank}`, to: `f${rank}`, type: "r" });
  if (move.isQueensideCastle()) pieces.push({ from: `a${rank}`, to: `d${rank}`, type: "r" });
  return pieces;
}
