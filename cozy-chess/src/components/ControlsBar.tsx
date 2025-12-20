import React from "react";
import type { SessionCharacterProfile } from "./PersonalityPanel";

interface ControlsBarProps {
  playerColor: "white" | "black";
  onPlayerColorChange: (color: "white" | "black") => void;
  onNewGame: (profile: SessionCharacterProfile | null) => void;
}

export const ControlsBar: React.FC<ControlsBarProps> = ({
  playerColor,
  onPlayerColorChange,
  onNewGame
}) => {
  return (
    <section className="cozy-controls">
      <div className="cozy-controls-row">
        <button
          type="button"
          className="cozy-btn"
          onClick={() => onNewGame(null)}
        >
          New game
        </button>
        <button
          type="button"
          className="cozy-btn secondary"
          onClick={() => onPlayerColorChange(playerColor === "white" ? "black" : "white")}
        >
          Play as {playerColor === "white" ? "Black" : "White"}
        </button>
      </div>
    </section>
  );
};


