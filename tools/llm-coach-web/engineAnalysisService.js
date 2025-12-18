const fs = require("fs");
const path = require("path");

const fsp = fs.promises;

// Root of the PizzaRAT workspace (same convention as server.js).
const ROOT = path.resolve(__dirname, "..", "..");
const CHARACTERS_DIR = path.join(ROOT, "characters");

/**
 * Normalize a personality id into a safe file-based id.
 * This mirrors the normalizeId behaviour in server.js.
 *
 * @param {string} rawId
 * @returns {string}
 */
function normalizeId(rawId) {
  const id = String(rawId || "").trim();
  if (!id) return "";
  return id.replace(/[^A-Za-z0-9_\-]/g, "_");
}

/**
 * Load the target Elo for a given personality id, if available.
 *
 * @param {string} personalityId
 * @returns {Promise<number|null>}
 */
async function loadPersonalityElo(personalityId) {
  const safeId = normalizeId(personalityId);
  if (!safeId) {
    return null;
  }

  const filePath = path.join(CHARACTERS_DIR, `${safeId}.json`);

  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    const strength = data.strength || {};
    const elo =
      typeof strength.targetElo === "number" && Number.isFinite(strength.targetElo)
        ? strength.targetElo
        : null;
    return elo;
  } catch {
    // If the file is missing or invalid, fall back to null; callers will
    // treat this as "no explicit Elo", and use a default bucket.
    return null;
  }
}

/**
 * Internal configuration table: map Elo bands to engine caps.
 *
 * NOTE: These caps are enforced at the *service* boundary, so even if
 * the underlying engine (Rodent/Stockfish) returns deeper or additional
 * lines, we will discard anything beyond these limits before exposing
 * it to the LLM via ENGINE_STATE.
 */
const ENGINE_CONFIG_TABLE = [
  // Beginner / casual players.
  {
    maxElo: 1200,
    depth: 8,
    maxTopLines: 1,
    maxLinePlies: 6,
  },
  // Improving club players.
  {
    maxElo: 1600,
    depth: 12,
    maxTopLines: 2,
    maxLinePlies: 8,
  },
  // Strong club players.
  {
    maxElo: 2000,
    depth: 16,
    maxTopLines: 3,
    maxLinePlies: 12,
  },
  // Advanced / default.
  {
    maxElo: Infinity,
    depth: 20,
    maxTopLines: 3,
    maxLinePlies: 16,
  },
];

/**
 * Pick an engine configuration for the given target Elo.
 *
 * @param {number|null} targetElo
 * @returns {{ maxElo: number, depth: number, maxTopLines: number, maxLinePlies: number }}
 */
function pickEngineConfig(targetElo) {
  const elo =
    typeof targetElo === "number" && Number.isFinite(targetElo)
      ? targetElo
      : 1800;

  for (let i = 0; i < ENGINE_CONFIG_TABLE.length; i += 1) {
    const cfg = ENGINE_CONFIG_TABLE[i];
    if (elo <= cfg.maxElo) {
      return cfg;
    }
  }

  return ENGINE_CONFIG_TABLE[ENGINE_CONFIG_TABLE.length - 1];
}

/**
 * Cap a collection of raw engine lines according to the engine config.
 *
 * This function ensures we never expose more lines or deeper PVs than the
 * configured limits, even if the underlying engine returns richer data.
 *
 * @param {Array<Object>} rawLines
 * @param {{ maxTopLines: number, maxLinePlies: number }} config
 * @returns {Array<{ move: string, centipawnEval: number, line: string, depth?: number }>}
 */
function capEngineLines(rawLines, config) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    return [];
  }

  const maxTopLines =
    config && Number.isFinite(config.maxTopLines) && config.maxTopLines > 0
      ? config.maxTopLines
      : rawLines.length;
  const maxLinePlies =
    config && Number.isFinite(config.maxLinePlies) && config.maxLinePlies > 0
      ? config.maxLinePlies
      : null;

  const result = [];
  const limit = Math.min(rawLines.length, maxTopLines);

  for (let i = 0; i < limit; i += 1) {
    const line = rawLines[i] || {};
    const move = typeof line.move === "string" ? line.move : "";
    const cpEval = Number.isFinite(line.centipawnEval) ? line.centipawnEval : 0;
    const pv =
      typeof line.line === "string" && line.line.trim().length > 0
        ? line.line.trim()
        : "";

    let truncatedPv = pv;
    if (pv && maxLinePlies != null) {
      const tokens = pv.split(/\s+/).filter(Boolean);
      truncatedPv = tokens.slice(0, maxLinePlies).join(" ");
    }

    const depth =
      Number.isFinite(line.depth) && line.depth > 0 ? line.depth : undefined;

    result.push({
      move,
      centipawnEval: cpEval,
      line: truncatedPv,
      depth,
    });
  }

  return result;
}

/**
 * Analyze the current position and return an EngineState object suitable
 * for serialization via buildEngineStateBlock.
 *
 * For now, this uses a stubbed engine backend (no real Rodent/Stockfish
 * integration) but *does* enforce Elo-based caps so that wiring in a real
 * engine later will automatically stay within the configured limits.
 *
 * NOTE: High-level game metadata such as "game over" status and the list
 * of legal moves is computed by the caller (server.js using chess.js) and
 * passed through here so that the LLM can be explicitly told when a
 * position is checkmate/stalemate and which moves are legal.
 *
 * @param {Object} params
 * @param {string} params.fen
 * @param {string} params.sideToMove
 * @param {string} [params.moveHistory]
 * @param {string} [params.personalityId]
 * @param {string} [params.gameStatus]
 * @param {string[]} [params.legalMovesSan]
 * @param {string} [params.piecePlacement]
 * @returns {Promise<{
 *   fen: string,
 *   sideToMove: string,
 *   centipawnEval: number,
 *   evalComment: string,
 *   topLines: Array,
 *   moveHistory: string,
 *   gameStatus?: string,
 *   legalMovesSan?: string[]
 * }>}
 */
async function analyzePosition({
  fen,
  sideToMove,
  moveHistory,
  personalityId,
  gameStatus,
  legalMovesSan,
  piecePlacement,
}) {
  const targetElo = await loadPersonalityElo(personalityId);
  const config = pickEngineConfig(targetElo);

  // TODO: When integrating a real engine, run it here with the chosen
  // config (depth / time) and collect rawLines + centipawnEval/EvalComment.
  //
  // While we are still using a stubbed backend, we *intentionally* avoid
  // sending a numeric evaluation for game-over positions so the LLM does not
  // misinterpret "0 centipawns" as "balanced and ongoing".
  const statusText =
    typeof gameStatus === "string" ? gameStatus.toLowerCase() : "";
  const isGameOverStub =
    statusText.includes("checkmate") ||
    statusText.includes("stalemate") ||
    statusText.includes("draw");

  let centipawnEval = null;
  let evalComment = "";

  if (isGameOverStub) {
    evalComment =
      "Numeric evaluation is not meaningful here: the game is already over according to the Game status above.";
  } else {
    centipawnEval = 0;
    evalComment =
      "0.00 (no engine evaluation is attached; treat this as a structural explanation only, not a precise score).";
  }

  // No real engine lines yet; apply caps to an empty list so the contract
  // remains the same when we add Rodent/Stockfish later.
  const rawLines = [];
  const topLines = capEngineLines(rawLines, config);

  return {
    fen,
    sideToMove,
    centipawnEval,
    evalComment,
    topLines,
    moveHistory,
    gameStatus,
    legalMovesSan,
    piecePlacement,
  };
}

module.exports = {
  analyzePosition,
  pickEngineConfig,
  capEngineLines,
};

