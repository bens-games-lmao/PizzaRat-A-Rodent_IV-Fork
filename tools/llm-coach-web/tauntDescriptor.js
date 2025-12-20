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
 * @property {string} [baseLine]
 *   Short, canonical taunt line from the existing Rodent taunt tables,
 *   such as "your king looks exposed here".
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

const EventTypeLabels = {
  KingSafety: "their king looking exposed or unsafe",
  Blunder: "a recent big mistake or blunder",
  MaterialSwing: "a big change in material balance",
  FlagDanger: "time trouble on the clock",
  ConversionGloat: "converting a clearly winning position",
  GeneralNeedling: "general needling about their play so far",
};

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
    return "[TAUNT_IDEA]\nA light, playful taunt about their last move.\n[END_TAUNT_IDEA]";
  }

  const lines = [];
  lines.push("[TAUNT_IDEA]");

  const eventLabel =
    (td.eventType && EventTypeLabels[td.eventType]) || td.eventType || "general needling about their play";
  const target =
    td.targetSide === "engine"
      ? "the engine's position"
      : "the human player's position";

  lines.push(`Theme: a taunt about ${target}, focused on ${eventLabel}.`);

  if (td.severity) {
    lines.push(`Intensity: ${td.severity} (treat this as how sharp or bold the tone can be).`);
  }

  if (td.piece) {
    lines.push(`Piece focus: their ${td.piece}.`);
  }

  // If we know exactly which move the engine has targeted for this taunt,
  // surface that explicitly so the LLM never has to guess which move is in
  // scope.
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
    lines.push(`Target move: ${moveLabel}.`);
  }

  if (td.moveQualityLabel) {
    lines.push(`Engine move-quality label for that move: ${td.moveQualityLabel}.`);
  }

  if (td.moveQualityDetail) {
    lines.push(td.moveQualityDetail);
  }

  if (td.baseLine && typeof td.baseLine === "string") {
    lines.push(`Base taunt idea: "${td.baseLine.trim()}".`);
  }

  if (td.extraContext && typeof td.extraContext === "string") {
    lines.push(`Extra context: ${td.extraContext.trim()}`);
  }

  lines.push("[END_TAUNT_IDEA]");
  return lines.join("\n");
}

/**
 * Placeholder heuristic mapper from a generic engine state into a
 * TauntDescriptor. In the full Rodent integration this logic should
 * live alongside the existing taunt subsystem and use its enums and
 * rudeness knobs; this helper is mainly here to document the mapping
 * shape and enable lightweight web/experimental usage.
 *
 * @param {Object} engineState
 * @param {Object} [options]
 * @param {("player"|"engine"|string)} [options.targetSide]
 * @returns {TauntDescriptor}
 */
function buildTauntDescriptorFromEngine(engineState, options = {}) {
  const targetSide = options.targetSide || "player";

  if (!engineState || typeof engineState !== "object") {
    return {
      eventType: "GeneralNeedling",
      targetSide,
      severity: "mild",
      baseLine: "Not your finest moment there.",
    };
  }

  const gameStatus =
    typeof engineState.gameStatus === "string"
      ? engineState.gameStatus.toLowerCase()
      : "";
  const cp = Number.isFinite(engineState.centipawnEval)
    ? engineState.centipawnEval
    : 0;

  let eventType = "GeneralNeedling";
  let severity = "mild";
  let baseLine = "Not your finest moment there.";
  let piece = null;

  if (gameStatus.includes("checkmate")) {
    eventType = "ConversionGloat";
    severity = "severe";
    baseLine = "This one is completely over for you.";
  } else if (gameStatus.includes("stalemate") || gameStatus.includes("draw")) {
    eventType = "GeneralNeedling";
    severity = "medium";
    baseLine = "You barely escaped there.";
  } else {
    const absCp = Math.abs(cp);
    if (absCp >= 400) {
      eventType = "MaterialSwing";
      severity = "severe";
      baseLine = "You just threw away a huge chunk of material.";
    } else if (absCp >= 200) {
      eventType = "Blunder";
      severity = "medium";
      baseLine = "That move really hurt your position.";
    } else {
      eventType = "GeneralNeedling";
      severity = "mild";
      baseLine = "You might want to rethink your strategy.";
    }
  }

  if (engineState.piecePlacement && typeof engineState.piecePlacement === "string") {
    if (engineState.piecePlacement.toLowerCase().includes("king")) {
      piece = "king";
    }
  }

  return {
    eventType,
    targetSide,
    severity,
    piece: piece || undefined,
    baseLine,
  };
}

module.exports = {
  describeTauntForLlm,
  buildTauntDescriptorFromEngine,
};

