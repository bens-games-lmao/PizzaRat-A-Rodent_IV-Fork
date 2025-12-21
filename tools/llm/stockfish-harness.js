// Simple test harness to feed a PGN into the evaluation engine (Stockfish or
// Rodent) and print before/after evaluations for a targeted move.
//
// Usage (from repo root):
//   cd tools\llm-coach-web
//   node stockfish-harness.js
//
// It will:
//   - load llm-wrapper/Samples/mate-in-2.pgn
//   - identify the last White move as the targeted human move
//   - reconstruct the FENs immediately before and after that move
//   - call analyzePosition(...) for both and print centipawn eval + comments

const fs = require("fs");
const path = require("path");
const { Chess } = require("chess.js");

const { analyzePosition } = require("./engineAnalysisService");

const ROOT = path.resolve(__dirname, "..", "..");

async function main() {
  const pgnPath = path.join(ROOT, "llm-wrapper", "Samples", "mate-in-2.pgn");

  if (!fs.existsSync(pgnPath)) {
    console.error("PGN file not found:", pgnPath);
    process.exit(1);
  }

  const pgnText = fs.readFileSync(pgnPath, "utf8");
  const chess = new Chess();

  try {
    chess.loadPgn(pgnText, { strict: false });
  } catch (err) {
    console.error("Failed to parse PGN:", err && err.message ? err.message : err);
    process.exit(1);
  }

  const historyVerbose = chess.history({ verbose: true }) || [];
  if (historyVerbose.length === 0) {
    console.error("No moves found in PGN history.");
    process.exit(1);
  }

  // Pick the last White move as the targeted human move.
  let targetIndex = -1;
  for (let i = historyVerbose.length - 1; i >= 0; i -= 1) {
    const mv = historyVerbose[i];
    if (mv && mv.color === "w") {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex < 0) {
    console.error("Could not find a White move in the PGN to target.");
    process.exit(1);
  }

  const targetMove = historyVerbose[targetIndex];

  // Reconstruct the position immediately BEFORE and AFTER the targeted move.
  const beforeReplay = new Chess();
  for (let i = 0; i < targetIndex; i += 1) {
    beforeReplay.move(historyVerbose[i]);
  }
  const beforeFen = beforeReplay.fen();
  const beforeSideToMove =
    beforeReplay.turn() === "w" ? "White" : "Black";

  const afterReplay = new Chess(beforeFen);
  afterReplay.move(targetMove);
  const afterFen = afterReplay.fen();
  const afterSideToMove =
    afterReplay.turn() === "w" ? "White" : "Black";

  console.log("=== Targeted move from PGN ===");
  console.log("SAN:", targetMove.san);
  console.log("From:", targetMove.from, "To:", targetMove.to);
  console.log("Ply index:", targetIndex + 1);
  console.log("");

  console.log("=== BEFORE position ===");
  console.log("FEN:", beforeFen);
  console.log("Side to move:", beforeSideToMove);
  console.log("");

  console.log("=== AFTER position ===");
  console.log("FEN:", afterFen);
  console.log("Side to move:", afterSideToMove);
  console.log("");

  console.log("Running engine analysis using:", process.env.CHESS_EVAL_ENGINE || "(auto-detected engine in repo root)");
  console.log("");

  try {
    const beforeState = await analyzePosition({
      fen: beforeFen,
      sideToMove: beforeSideToMove,
      moveHistory: "", // Not needed for numeric eval in this harness.
      personalityId: null,
      gameStatus: "",
      legalMovesSan: [],
      piecePlacement: "",
    });

    const afterState = await analyzePosition({
      fen: afterFen,
      sideToMove: afterSideToMove,
      moveHistory: "",
      personalityId: null,
      gameStatus: "",
      legalMovesSan: [],
      piecePlacement: "",
    });

    console.log("=== Engine evaluation BEFORE move ===");
    console.log("Centipawn eval:", beforeState.centipawnEval);
    console.log("Eval comment:", beforeState.evalComment);
    console.log("");

    console.log("=== Engine evaluation AFTER move ===");
    console.log("Centipawn eval:", afterState.centipawnEval);
    console.log("Eval comment:", afterState.evalComment);
    console.log("");

    if (
      Number.isFinite(beforeState.centipawnEval) &&
      Number.isFinite(afterState.centipawnEval)
    ) {
      const delta = afterState.centipawnEval - beforeState.centipawnEval;
      console.log(
        "Delta (after - before, from side-to-move perspective in each FEN):",
        delta,
        "centipawns"
      );
    } else {
      console.log(
        "At least one of the evaluations is non-numeric; delta cannot be computed."
      );
    }
  } catch (err) {
    console.error(
      "Engine analysis failed:",
      err && err.message ? err.message : err
    );
    process.exit(1);
  }
}

// Run the harness.
main().catch((err) => {
  console.error("Unexpected error in harness:", err);
  process.exit(1);
});


