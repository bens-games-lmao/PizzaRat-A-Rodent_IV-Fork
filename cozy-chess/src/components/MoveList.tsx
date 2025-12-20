import React from "react";
import type { MoveListItem } from "../state/gameState";

interface MoveListProps {
  moves: MoveListItem[];
}

export const MoveList: React.FC<MoveListProps> = ({ moves }) => {
  return (
    <section>
      <div className="cozy-movelist">
        {moves.length === 0 ? (
          <div className="cozy-card-subtitle">Movement History</div>
        ) : (
          <div className="cozy-movelist-grid">
            {moves.map((m) => (
              <React.Fragment key={m.index}>
                <div className="cozy-move-index">{m.index}.</div>
                <div className="cozy-move-san">
                  {m.white ?? "\u00a0"} {m.black ?? ""}
                </div>
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};


