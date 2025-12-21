const fs = require("fs");
const path = require("path");

/**
 * High-level description of what kind of trash talk is appropriate
 * for the current position. This is intentionally small and focused;
 * the LLM only ever sees a natural-language rendering of this, not
 * the raw object.
 *
 * @typedef {Object} TauntDescriptor
 * @property {string} eventType
 *   Broad category such as "KingSafety", "Blunder", "MaterialSwing",
 *   "FlagDanger", "ConversionGloat", or "GeneralNeedling".
 * @property {("player"|"engine"|string)} targetSide
 *   Which side is being taunted (typically the human player).
 * @property {("mild"|"medium"|"severe"|string)} [severity]
 *   How sharp/serious the taunt should feel.
 * @property {string} [piece]
 *   Optional piece focus (e.g., "king", "queen", "rook").
 * @property {string} [extraContext]
 *   Optional extra natural-language hints (e.g., "you just hung a rook",
 *   "your flag is about to fall").
 * @property {string} [moveSide]
 *   Optional human-readable color label ("White" or "Black") for the move being taunted.
 * @property {number} [moveNumber]
 *   Optional move number in the PGN for the move being taunted.
 * @property {string} [moveSan]
 *   Optional SAN notation for the move being taunted.
 * @property {string} [moveQualityLabel]
 *   Optional coarse label such as "brilliant", "good", "inaccuracy", "mistake", "blunder".
 * @property {string} [moveQualityDetail]
 *   Optional one-line explanation of the move quality from the engine's point of view.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const PROMPTS_DIR = path.join(ROOT, "prompts");

let gameStateDetailsTemplateCache = null;

function loadGameStateDetailsTemplate() {
  if (gameStateDetailsTemplateCache !== null) {
    return gameStateDetailsTemplateCache;
  }

  try {
    const filePath = path.join(PROMPTS_DIR, "game-state-details.txt");
    const text = fs.readFileSync(filePath, "utf8");
    if (!text || text.trim().length === 0) {
      throw new Error("prompts/game-state-details.txt is empty.");
    }
    gameStateDetailsTemplateCache = text;
  } catch (err) {
    throw new Error(
      `Failed to load game-state details template from prompts/game-state-details.txt: ${
        err && err.message ? err.message : String(err)
      }`
    );
  }

  return gameStateDetailsTemplateCache;
}

/**
 * Turn a TauntDescriptor into a compact, human-readable block that
 * can be dropped directly into the LLM prompt. This is where we
 * control what the model pays attention to; we keep it natural
 * rather than JSON so the model stays in \"voice\" mode instead of
 * \"data analyst\" mode.
 *
 * @param {TauntDescriptor} td
 * @returns {string}
 */
function describeTauntForLlm(td) {
  if (!td || typeof td !== "object") {
    throw new Error("TauntDescriptor object is required for describeTauntForLlm.");
  }

  const template = loadGameStateDetailsTemplate();

  const eventLabel = td.eventType || "GeneralNeedling";
  const target =
    td.targetSide === "engine"
      ? "engine"
      : "player";

  const intensityLine = td.severity ? `severity=${td.severity}` : "";

  const pieceLine = td.piece ? `piece=${td.piece}` : "";

  // If we know exactly which move the engine has targeted for this taunt,
  // surface that explicitly so the LLM never has to guess which move is in
  // scope.
  let moveLine = "";
  if (td.moveSan || td.moveNumber || td.moveSide) {
    const parts = [];
    if (td.moveNumber != null) {
      parts.push(`move ${td.moveNumber}`);
    }
    if (td.moveSide) {
      parts.push(td.moveSide);
    }
    if (td.moveSan) {
      parts.push(td.moveSan);
    }
    const moveLabel =
      parts.length > 0 ? parts.join(" ") : "the specific move selected by the engine";
    moveLine = `Target move: ${moveLabel}.`;
  }

  const qualityLabelLine = td.moveQualityLabel
    ? `Engine move-quality  ${td.moveQualityLabel}.`
    : "";

  const qualityDetailLine = td.moveQualityDetail ? td.moveQualityDetail : "";

  const extraContextLine =
    td.extraContext && typeof td.extraContext === "string"
      ? `Extra context: ${td.extraContext.trim()}`
      : "";

  return template
    .replace("{{TARGET}}", target)
    .replace("{{EVENT_LABEL}}", eventLabel)
    .replace("{{INTENSITY_LINE}}", intensityLine)
    .replace("{{PIECE_LINE}}", pieceLine)
    .replace("{{MOVE_LINE}}", moveLine)
    .replace("{{QUALITY_LABEL_LINE}}", qualityLabelLine)
    .replace("{{QUALITY_DETAIL_LINE}}", qualityDetailLine)
    .replace("{{EXTRA_CONTEXT_LINE}}", extraContextLine);
}

/**
 * Map a generic engine state (as produced by engineAnalysisService/analyzePosition)
 * into a TauntDescriptor.
 *
 * For production Rodent / PizzaRAT usage, this requires that the underlying
 * engine emit the special "info string taunt_llm|Event|severity|text..."
 * line; if that is missing or malformed, this function throws instead of
 * inventing a heuristic taunt.
 *
 * @param {Object} engineState
 * @param {Object} [options]
 * @param {("player"|"engine"|string)} [options.targetSide]
 * @returns {TauntDescriptor}
 */
function buildTauntDescriptorFromEngine(engineState, options = {}) {
  const targetSide = options.targetSide || "player";

  if (!engineState || typeof engineState !== "object") {
    throw new Error(
      "EngineState object is required to build a TauntDescriptor from engine output."
    );
  }

  // First preference: a machine-readable taunt descriptor from Rodent's own
  // taunt subsystem, if present on the EngineState.
  const rawEvent =
    typeof engineState.tauntEvent === "string"
      ? engineState.tauntEvent.trim()
      : "";
  const rawSeverity =
    typeof engineState.tauntSeverity === "string"
      ? engineState.tauntSeverity.trim().toLowerCase()
      : "";
  const rawText =
    typeof engineState.tauntText === "string"
      ? engineState.tauntText.trim()
      : "";

  if (!rawEvent) {
    throw new Error(
      "EngineState did not include a tauntEvent from the engine taunt subsystem; cannot build TauntDescriptor."
    );
  }

  // Normalise severity to the expected labels where possible; if Rodent
  // adds new labels in future, we still pass them through verbatim.
  let severity = undefined;
  if (
    rawSeverity === "mild" ||
    rawSeverity === "medium" ||
    rawSeverity === "severe"
  ) {
    severity = rawSeverity;
  } else if (rawSeverity) {
    severity = rawSeverity;
  }

  const descriptor = {
    eventType: rawEvent,
    targetSide,
    severity,
  };

  if (rawText) {
    descriptor.extraContext = rawText;
  }

  // We can still opportunistically add a simple piece focus hint based on
  // the coarse piecePlacement summary that the analysis layer already
  // computes.
  if (
    engineState.piecePlacement &&
    typeof engineState.piecePlacement === "string"
  ) {
    const lower = engineState.piecePlacement.toLowerCase();
    if (lower.includes("king")) {
      descriptor.piece = "king";
    }
  }

  return descriptor;
}

module.exports = {
  describeTauntForLlm,
  buildTauntDescriptorFromEngine,
};

