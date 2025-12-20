import React, { useMemo, useState } from "react";

type Orientation = "white" | "black";

interface ChessBoardProps {
  fen: string;
  orientation: Orientation;
  onUserMove: (from: string, to: string, promotion?: string) => void;
  isEngineThinking: boolean;
}

interface SquareData {
  file: string;
  rank: number;
  coord: string;
  piece: string | null;
}

function parseFenPieces(fen: string): Record<string, string> {
  const [piecePlacement] = fen.split(" ");
  const rows = piecePlacement.split("/");
  const map: Record<string, string> = {};

  for (let rankIndex = 0; rankIndex < 8; rankIndex += 1) {
    const row = rows[rankIndex];
    if (!row) continue;
    let fileIndex = 0;

    for (const ch of row) {
      if (/[1-8]/.test(ch)) {
        fileIndex += parseInt(ch, 10);
      } else {
        const fileChar = String.fromCharCode("a".charCodeAt(0) + fileIndex);
        const rank = 8 - rankIndex;
        const coord = `${fileChar}${rank}`;
        map[coord] = ch;
        fileIndex += 1;
      }
    }
  }

  return map;
}

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

function buildSquares(fen: string, orientation: Orientation): SquareData[] {
  const pieceMap = parseFenPieces(fen);
  const squares: SquareData[] = [];

  const files = orientation === "white" ? FILES : [...FILES].reverse();
  const ranks = orientation === "white" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];

  for (const rank of ranks) {
    for (const file of files) {
      const coord = `${file}${rank}`;
      squares.push({
        file,
        rank,
        coord,
        piece: pieceMap[coord] ?? null
      });
    }
  }

  return squares;
}

function pieceClassName(piece: string | null): string {
  if (!piece) return "";
  const isWhite = piece === piece.toUpperCase();
  const color = isWhite ? "w" : "b";
  const p = piece.toLowerCase();
  return `piece-${color}${p.toUpperCase()}`;
}

export const ChessBoard: React.FC<ChessBoardProps> = ({
  fen,
  orientation,
  onUserMove,
  isEngineThinking
}) => {
  const [selected, setSelected] = useState<string | null>(null);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);

  const squares = useMemo(() => buildSquares(fen, orientation), [fen, orientation]);

  function handleSquareClick(coord: string) {
    if (!selected) {
      setSelected(coord);
      return;
    }

    if (coord === selected) {
      setSelected(null);
      return;
    }

    const from = selected;
    const to = coord;
    setSelected(null);
    setLastMove({ from, to });
    onUserMove(from, to);
  }

  return (
    <div className="cozy-board-wrapper">
      <div className="cozy-board">
        <div className="cozy-board-grid">
          {squares.map((sq) => {
            const isLight = (sq.file.charCodeAt(0) - "a".charCodeAt(0) + sq.rank) % 2 === 0;
            const key = sq.coord;
            const isSelected = selected === key;
            const isLastMove =
              lastMove && (lastMove.from === key || lastMove.to === key) ? true : false;
            const pieceClass = pieceClassName(sq.piece);

            const classNames = [
              "cozy-square",
              isLight ? "cozy-square--light" : "cozy-square--dark",
              pieceClass,
              isSelected ? "cozy-square--selected" : "",
              isLastMove ? "cozy-square--last-move" : ""
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <button
                key={key}
                type="button"
                className={classNames}
                onClick={() => handleSquareClick(key)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};


