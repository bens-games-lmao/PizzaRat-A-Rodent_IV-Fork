const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

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
 * Locate a Rodent / PizzaRAT engine executable we can talk UCI to. We mirror
 * the search strategy from tools/character-manager/migrate.js but also accept
 * the PizzaRAT front-end binary, which is built from the same UCI engine.
 *
 * This runs at request time (not module load) so that users can drop a new
 * engine binary into the repo root without restarting Node.
 */
function findEngineCommand() {
  // Optional explicit override so advanced users can point at any UCI engine,
  // e.g. a Stockfish binary installed elsewhere.
  const override = process.env.CHESS_EVAL_ENGINE;
  if (override && typeof override === "string") {
    const trimmed = override.trim();
    if (trimmed && fs.existsSync(trimmed)) {
      return trimmed;
    }
  }

  // By default, prefer Stockfish if present in the workspace root, then fall
  // back to the PizzaRAT / Rodent binaries. All of these speak standard UCI
  // so the rest of the analysis pipeline does not need to change.
  const candidatesWin = [
    "stockfish.exe",
    "PizzaRAT.exe",
    "rodent-iv-x64.exe",
    "rodent-iv-plain.exe",
    "rodent-iv-x32.exe",
  ];
  const candidatesUnix = [
    "stockfish",
    "rodentiii",
    "rodent-iv-plain",
    "rodent-iv-x64",
  ];

  const candidates =
    process.platform === "win32" ? candidatesWin : candidatesUnix;

  for (const name of candidates) {
    const full = path.join(ROOT, name);
    if (fs.existsSync(full)) {
      return full;
    }
  }

  throw new Error(
    "Could not find a UCI engine executable for evaluation. " +
      "Set CHESS_EVAL_ENGINE to a full path, or place one of: " +
      candidates.join(", ") +
      " in " +
      ROOT
  );
}

/**
 * Decode a Buffer of engine output, trying UTF-8 first and then UTF-16LE,
 * which is what the Windows build currently uses for stdout.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeEngineOutput(buffer) {
  let lastError = null;
  for (const encoding of ["utf8", "utf16le"]) {
    try {
      const text = buffer.toString(encoding);
      // Heuristic: if this looks even vaguely like UCI output, accept it.
      if (
        text.includes("uciok") ||
        text.includes("readyok") ||
        text.includes("bestmove")
      ) {
        return text;
      }
      // Even if we don't see those tokens, keep the first successful decode.
      if (!lastError) {
        return text;
      }
    } catch (e) {
      lastError = e;
    }
  }

  // Fall back to UTF-8 if everything else failed.
  return buffer.toString("utf8");
}

/**
 * Extract a single principal variation, evaluation, and (optionally) a Rodent
 * taunt descriptor from raw UCI output.
 *
 * If we cannot find a numeric score ("info ... score cp/mate ...") in the
 * engine output, or the last score line cannot be parsed, this function throws
 * instead of silently fabricating a stub evaluation.
 *
 * @param {string} text
 * @param {string} sideToMove Human-readable side label ("White" | "Black")
 * @param {{ maxTopLines: number, maxLinePlies: number }} config
 * @returns {{
 *   centipawnEval: number,
 *   evalComment: string,
 *   topLines: Array<{ move: string, centipawnEval: number, line: string, depth?: number }>,
 *   tauntEvent?: string | null,
 *   tauntSeverity?: string | null,
 *   tauntText?: string | null
 * }}
 */
function extractEngineEvalFromOutput(text, sideToMove, config) {
  const lines = String(text || "").split(/\r?\n/);
  let lastScoreLine = null;
  let lastTauntLine = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("info")) {
      if (line.includes("score")) {
        lastScoreLine = line;
      }
      if (line.includes("taunt_llm|")) {
        lastTauntLine = line;
      }
    }
  }

  if (!lastScoreLine) {
    throw new Error(
      "Engine output did not contain any 'info ... score' line; cannot build ENGINE_STATE."
    );
  }

  let tauntEvent = null;
  let tauntSeverity = null;
  let tauntText = null;

  if (lastTauntLine) {
    // Expected format from taunt.cpp:
    //   info string taunt_llm|EventName|severity|text...
    const idx = lastTauntLine.indexOf("taunt_llm|");
    if (idx >= 0) {
      const payload = lastTauntLine.slice(idx + "taunt_llm|".length);
      const parts = payload.split("|");
      if (parts.length >= 1) {
        const ev = parts[0].trim();
        if (ev) tauntEvent = ev;
      }
      if (parts.length >= 2) {
        const sev = parts[1].trim();
        if (sev) tauntSeverity = sev;
      }
      if (parts.length >= 3) {
        const rest = parts.slice(2).join("|").trim();
        if (rest) tauntText = rest;
      }
    }
  }

  const tokens = lastScoreLine.split(/\s+/);
  let depth = null;
  let cp = null;
  let mate = null;
  let pvStart = -1;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === "depth" && i + 1 < tokens.length) {
      const v = parseInt(tokens[i + 1], 10);
      if (Number.isFinite(v)) depth = v;
    } else if (t === "score" && i + 2 < tokens.length) {
      const type = tokens[i + 1];
      const v = parseInt(tokens[i + 2], 10);
      if (!Number.isFinite(v)) continue;
      if (type === "cp") {
        cp = v;
      } else if (type === "mate") {
        mate = v;
      }
    } else if (t === "pv") {
      pvStart = i + 1;
      break;
    }
  }

  const pvMoves =
    pvStart >= 0 && pvStart < tokens.length
      ? tokens.slice(pvStart).filter(Boolean)
      : [];
  const firstMove = pvMoves[0] || "";

  let centipawnEval = null;
  let evalComment = "";

  if (mate === null && cp === null) {
    throw new Error(
      "Could not parse numeric score from engine 'info ... score' output."
    );
  }

  if (mate !== null) {
    const ply = Math.abs(mate);

    // Work out which side is actually winning according to the mate score.
    // Positive mate means a win for the side to move, negative for the
    // opponent; map to a very large centipawn value with the same sign and
    // report the *winner* in evalComment.
    let winnerSide = "the side to move";
    if (sideToMove && typeof sideToMove === "string") {
      const label = sideToMove.trim();
      if (label === "White" || label === "Black") {
        if (mate > 0) {
          winnerSide = label;
        } else if (mate < 0) {
          winnerSide = label === "White" ? "Black" : "White";
        }
      } else if (label) {
        winnerSide = label;
      }
    }

    const sign = mate > 0 ? 1 : -1;
    centipawnEval = sign * 32000;
    evalComment = `Mate in ${ply} for ${winnerSide}.`;
  } else if (cp !== null) {
    centipawnEval = cp;
  }

  const rawLine = pvMoves.join(" ");
  const capped = capEngineLines(
    [
      {
        move: firstMove,
        centipawnEval: centipawnEval !== null ? centipawnEval : 0,
        line: rawLine,
        depth,
      },
    ],
    config
  );

  return {
    centipawnEval,
    evalComment,
    topLines: capped,
    tauntEvent,
    tauntSeverity,
    tauntText,
  };
}

/**
 * Run a one-shot Rodent / PizzaRAT UCI session to analyse a single position.
 *
 * This follows the same "fire-and-collect" pattern as tools/character-manager:
 *  - spawn the engine
 *  - send a minimal UCI script (uci/isready/position/go/quit)
 *  - wait for process exit
 *  - decode stdout (UTF-8 or UTF-16LE) and parse evaluation / PV.
 *
 * If anything fails (engine missing, crashes, etc.), the caller should fall
 * back to the stub behaviour so the web UI keeps working.
 *
 * @param {Object} params
 * @param {string} params.fen
 * @param {string} params.sideToMove
 * @param {{ depth: number, maxTopLines: number, maxLinePlies: number }} params.config
 * @returns {Promise<{ centipawnEval: number | null, evalComment: string, topLines: Array }>}
 */
async function runEngineAnalysis({ fen, sideToMove, config }) {
  const engineCmd = findEngineCommand();

  // Temporary debug logging to verify which engine binary is being used.
  console.log("Eval engine command:", engineCmd);

  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(engineCmd, [], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "inherit"],
    });

    const chunks = [];
    let sawBestmove = false;

    proc.stdout.on("data", (chunk) => {
      chunks.push(chunk);

      // Try to detect when the engine has finished its search so we can send
      // "quit" *after* it has had a chance to emit full analysis (info/score).
      try {
        const textChunk = decodeEngineOutput(chunk);
        if (!sawBestmove && /\bbestmove\b/.test(textChunk)) {
          sawBestmove = true;
          try {
            proc.stdin.write("quit\n");
          } catch (_) {
            // If stdin is already closed, let the exit handler surface the error.
          }
        }
      } catch (_) {
        // If incremental decode fails for some reason, we still keep the raw
        // bytes in `chunks` and will decode everything on exit.
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.on("exit", (code) => {
      try {
        const buffer = Buffer.concat(chunks);
        const text = decodeEngineOutput(buffer);

        // Temporary debug logging to inspect raw UCI engine output.
        console.log("=== Engine raw output ===");
        console.log(text);
        console.log("=== End engine raw output ===");

        const {
          centipawnEval,
          evalComment,
          topLines,
          tauntEvent,
          tauntSeverity,
          tauntText,
        } = extractEngineEvalFromOutput(text, sideToMove, config);
        resolve({
          centipawnEval,
          evalComment,
          topLines,
          tauntEvent,
          tauntSeverity,
          tauntText,
        });
      } catch (e) {
        reject(e);
      }
    });

    function send(line) {
      try {
        proc.stdin.write(line + "\n");
      } catch (_) {
        // If stdin is already closed, let the exit handler surface the error.
      }
    }

    // Minimal UCI script: initialise, prepare the position, search at the
    // configured depth, then quit. We intentionally do not wait for "uciok"
    // or "readyok" here; the engine will queue commands and process them
    // in order, just like we do in tools/character-manager.
    send("uci");
    send("isready");
    send("ucinewgame");
    send(`position fen ${fen}`);
    const depth = config && Number.isFinite(config.depth) ? config.depth : 12;
    send(`go depth ${depth}`);
  });
}

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
 * If the underlying UCI engine fails (missing binary, crashes, invalid
 * output, etc.), this function throws instead of fabricating a stub
 * ENGINE_STATE. Callers must treat that as a fatal condition.
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

  let centipawnEval = null;
  let evalComment = "";
  let topLines = [];
  let tauntEvent = null;
  let tauntSeverity = null;
  let tauntText = null;

  const engineResult = await runEngineAnalysis({
    fen,
    sideToMove,
    config,
  });
  centipawnEval = engineResult.centipawnEval;
  evalComment = engineResult.evalComment || "";
  topLines = Array.isArray(engineResult.topLines)
    ? engineResult.topLines
    : [];
  tauntEvent =
    typeof engineResult.tauntEvent === "string"
      ? engineResult.tauntEvent
      : null;
  tauntSeverity =
    typeof engineResult.tauntSeverity === "string"
      ? engineResult.tauntSeverity
      : null;
  tauntText =
    typeof engineResult.tauntText === "string"
      ? engineResult.tauntText
      : null;

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
    tauntEvent,
    tauntSeverity,
    tauntText,
  };
}

module.exports = {
  analyzePosition,
  pickEngineConfig,
  capEngineLines,
};

