import React, { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import {
  GameHistory,
  Ply,
  createInitialHistory,
  getCurrentFen,
  recordEngineMove,
  recordHumanMove,
  canUndo,
  canRedo,
  undoLast,
  redoLast,
  flattenPliesToMoveList
} from "./state/gameState";
import { ChessBoard } from "./components/ChessBoard";
import { ControlsBar } from "./components/ControlsBar";
import { PersonalityPanel, SessionCharacterProfile } from "./components/PersonalityPanel";
import { MoveList } from "./components/MoveList";
import { RadioWidget } from "./components/RadioWidget";
import { cozyApi } from "./cozyApi";

type PlayerColor = "white" | "black";

const BackgroundVideo: React.FC = () => (
  <div className="cozy-bg-video">
    <img
      src="public/bg.png"
      alt="Cozy Chess background"
      className="cozy-bg-image"
    />
  </div>
);

export const App: React.FC = () => {
  const [playerColor, setPlayerColor] = useState<PlayerColor>("white");
  const chessRef = useRef(new Chess());
  const [history, setHistory] = useState<GameHistory>(() =>
    createInitialHistory(chessRef.current.fen())
  );
  const [fen, setFen] = useState<string>(() => chessRef.current.fen());
  const [isEngineThinking, setIsEngineThinking] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [sessionProfile, setSessionProfile] = useState<SessionCharacterProfile | null>(null);
  const requestIdRef = useRef(0);

  // Ensure chess.js state tracks the canonical FEN.
  useEffect(() => {
    chessRef.current.load(fen);
  }, [fen]);

  const moveList = useMemo(() => flattenPliesToMoveList(history.done), [history.done]);

  const sideToMoveLabel = useMemo(() => {
    const fenParts = fen.split(" ");
    const side = fenParts[1] === "b" ? "Black" : "White";
    return side;
  }, [fen]);

  const canUndoMove = canUndo(history);
  const canRedoMove = canRedo(history);

  async function handleStartNewGame(profile: SessionCharacterProfile | null, color: PlayerColor) {
    const profileToUse = profile ?? sessionProfile;
    const game = new Chess();
    const initialFen = game.fen();

    chessRef.current = game;
    setHistory(createInitialHistory(initialFen));
    setFen(initialFen);
    setEngineError(null);
    setIsEngineThinking(false);
    setPlayerColor(color);
    if (profileToUse) {
      setSessionProfile(profileToUse);
    }

    try {
      await cozyApi.startNewGame({
        profile: profileToUse,
        playerColor: color
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Failed to start new game in main process:", err);
    }

    // If the user chooses Black, let the engine play the first move.
    if (color === "black") {
      await requestEngineMoveForCurrentPosition(initialFen, null);
    }
  }

  async function requestEngineMoveForCurrentPosition(currentFen: string, targetElo: number | null) {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setIsEngineThinking(true);
    setEngineError(null);

    try {
      const sideToMove = currentFen.split(" ")[1] === "b" ? "Black" : "White";
      const result = await cozyApi.requestEngineMove({
        fen: currentFen,
        sideToMove,
        targetElo: targetElo ?? null
      });

      if (!result || !result.bestmove) {
        setIsEngineThinking(false);
        return;
      }

      // Drop stale responses (for example, if the user hit Undo while the engine was thinking).
      if (requestIdRef.current !== requestId) {
        setIsEngineThinking(false);
        return;
      }

      const moveUci = result.bestmove;
      const from = moveUci.slice(0, 2);
      const to = moveUci.slice(2, 4);
      const promotion = moveUci.length > 4 ? moveUci[4] : undefined;

      const engineGame = new Chess();
      engineGame.load(currentFen);
      const move = engineGame.move({ from, to, promotion });
      if (!move) {
        setEngineError("Engine produced an illegal move.");
        setIsEngineThinking(false);
        return;
      }

      const fenAfter = engineGame.fen();
      const enginePly: Ply = {
        by: "engine",
        san: move.san,
        uci: moveUci,
        fenBefore: currentFen,
        fenAfter
      };

      setHistory((prev) => {
        const next = recordEngineMove(prev, enginePly);
        const updatedFen = getCurrentFen(next);
        setFen(updatedFen);
        return next;
      });
    } catch (err: any) {
      const msg = err && err.message ? err.message : String(err);
      setEngineError(msg);
    } finally {
      setIsEngineThinking(false);
    }
  }

  async function handleUserMove(from: string, to: string, promotion?: string) {
    const game = new Chess();
    game.load(fen);

    const move = game.move({ from, to, promotion });
    if (!move) {
      return;
    }

    const fenBefore = fen;
    const fenAfter = game.fen();
    const humanPly: Ply = {
      by: "human",
      san: move.san,
      uci: `${from}${to}${move.promotion || ""}`,
      fenBefore,
      fenAfter
    };

    setHistory((prev) => {
      const { history: nextHistory, appliedPlies, reusedEngine } = recordHumanMove(prev, humanPly);
      const newFen = getCurrentFen(nextHistory);
      setFen(newFen);

      // If we reused an engine move from the undo stack, there is nothing more to do.
      if (reusedEngine) {
        return nextHistory;
      }

      // Otherwise, we will request a new engine move from the current position.
      const targetElo =
        sessionProfile && sessionProfile.strength && typeof sessionProfile.strength.targetElo === "number"
          ? sessionProfile.strength.targetElo
          : null;

      const engineStartFen = appliedPlies[appliedPlies.length - 1]?.fenAfter ?? newFen;
      void requestEngineMoveForCurrentPosition(engineStartFen, targetElo);

      return nextHistory;
    });
  }

  function handleUndo() {
    setHistory((prev) => {
      const next = undoLast(prev);
      const updatedFen = getCurrentFen(next);
      setFen(updatedFen);
      // Invalidate any in-flight engine evaluation.
      requestIdRef.current += 1;
      setIsEngineThinking(false);
      return next;
    });
  }

  function handleRedo() {
    setHistory((prev) => {
      const next = redoLast(prev);
      const updatedFen = getCurrentFen(next);
      setFen(updatedFen);
      return next;
    });
  }

  return (
    <>
      <BackgroundVideo />
      <div className="cozy-app">
        <main className="cozy-layout">
          <aside className="cozy-side-panel">
            <ControlsBar
              playerColor={playerColor}
              onPlayerColorChange={setPlayerColor}
              onNewGame={(profile) => handleStartNewGame(profile, playerColor)}
            />

            <RadioWidget />

            {engineError && <div className="cozy-status cozy-status--error">{engineError}</div>}

            <PersonalityPanel
              sessionProfile={sessionProfile}
              onSessionProfileChange={setSessionProfile}
              onApplyProfile={(profile) => handleStartNewGame(profile, playerColor)}
            />
          </aside>

          <section className="cozy-main-panel">
            <ChessBoard
              fen={fen}
              orientation={playerColor}
              onUserMove={handleUserMove}
              isEngineThinking={isEngineThinking}
            />
          </section>

          <aside className="cozy-side-panel">
            <section className="cozy-controls">
              <div className="cozy-controls-row">
                <button
                  type="button"
                  className="cozy-btn secondary"
                  onClick={handleUndo}
                  disabled={!canUndoMove}
                >
                  UNDO
                </button>
                <button
                  type="button"
                  className="cozy-btn secondary"
                  onClick={handleRedo}
                  disabled={!canRedoMove}
                >
                  REDO
                </button>
                {isEngineThinking && <span className="cozy-controls-label">Thinking…</span>}
              </div>
            </section>

            <div className="cozy-board-caption">
              {isEngineThinking ? "Engine is thinking..." : "Click to select, click to move."}
            </div>

            <MoveList moves={moveList} />
          </aside>
        </main>
      </div>
    </>
  );
};


