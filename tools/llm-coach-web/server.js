const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const { Chess } = require("chess.js");
const fs = require("fs");
const { analyzePosition } = require("./engineAnalysisService");
const {
  describeTauntForLlm,
  buildTauntDescriptorFromEngine,
} = require("./tauntDescriptor");
const {
  completeCoachReply,
  completeTaunt,
  streamCoachReply,
  streamTaunt,
} = require("./llmGateway");

const app = express();
const port = process.env.PORT || 4100;

const fsp = fs.promises;
const ROOT = path.resolve(__dirname, "..", "..");
const CHARACTERS_DIR = path.join(ROOT, "characters");
const THINK_START = "<think>";
const THINK_END = "</think>";

// Optional prompt overrides loaded from plain text files so prompts can be
// tuned without touching code. If these files are missing, we fall back to
// the built-in prompt strings below.
const PROMPTS_DIR = path.join(ROOT, "prompts");
const promptCache = new Map();

function loadPromptText(filename) {
  if (promptCache.has(filename)) {
    return promptCache.get(filename);
  }
  try {
    const filePath = path.join(PROMPTS_DIR, filename);
    const text = fs.readFileSync(filePath, "utf8");
    promptCache.set(filename, text);
    return text;
  } catch {
    promptCache.set(filename, null);
    return null;
  }
}

// Coach/chat prompts
const systemPromptOverride = loadPromptText("coach-system.txt");
const fallbackUserPromptOverride = loadPromptText("coach-fallback.txt");

// Taunt prompts
const tauntSystemPromptOverride = loadPromptText("taunt-system.txt");
const tauntFallbackPromptOverride = loadPromptText("taunt-fallback.txt");

function safeChessBool(chess, methodName) {
  const fn =
    chess && typeof chess[methodName] === "function" ? chess[methodName] : null;
  if (!fn) return false;
  try {
    return !!fn.call(chess);
  } catch (_) {
    return false;
  }
}

function buildPiecePlacementSummary(chess) {
  if (!chess || typeof chess.board !== "function") {
    return "";
  }

  let board;
  try {
    board = chess.board();
  } catch (_) {
    return "";
  }

  if (!Array.isArray(board) || board.length !== 8) {
    return "";
  }

  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const pieces = {
    w: { k: [], q: [], r: [], b: [], n: [], p: [] },
    b: { k: [], q: [], r: [], b: [], n: [], p: [] },
  };

  for (let rankIndex = 0; rankIndex < 8; rankIndex += 1) {
    const row = board[rankIndex] || [];
    const rank = 8 - rankIndex;
    for (let fileIndex = 0; fileIndex < 8; fileIndex += 1) {
      const square = row[fileIndex];
      if (!square) continue;
      const fileLetter = files[fileIndex] || "?";
      const coord = `${fileLetter}${rank}`;
      const color = square.color === "b" ? "b" : "w";
      const type = square.type && pieces[color][square.type] ? square.type : null;
      if (!type) continue;
      pieces[color][type].push(coord);
    }
  }

  function formatSide(label, sidePieces) {
    const order = ["k", "q", "r", "b", "n", "p"];
    const names = {
      k: "King",
      q: "Queens",
      r: "Rooks",
      b: "Bishops",
      n: "Knights",
      p: "Pawns",
    };
    const segments = [];
    for (const key of order) {
      const squares = sidePieces[key] || [];
      if (squares.length === 0) continue;
      const pieceLabel = key === "k" && squares.length === 1 ? "King" : names[key];
      segments.push(`${pieceLabel}: ${squares.join(" ")}`);
    }
    if (segments.length === 0) {
      return `${label}: (no pieces on the board)`;
    }
    return `${label}: ${segments.join("; ")}`;
  }

  const whiteLine = formatSide("White", pieces.w);
  const blackLine = formatSide("Black", pieces.b);

  return ["Piece placements:", whiteLine, blackLine].join("\n");
}

function summarizeGameState(chess) {
  if (!chess) {
    return {
      gameStatus: "unknown (no position available).",
      legalMovesSan: [],
      piecePlacement: "",
    };
  }

  const turnColor = chess.turn && chess.turn() === "w" ? "White" : "Black";
  const opponentColor = turnColor === "White" ? "Black" : "White";

  const isCheckmate = safeChessBool(chess, "isCheckmate");
  const isStalemate = safeChessBool(chess, "isStalemate");
  const isDraw = safeChessBool(chess, "isDraw");
  const inCheck =
    safeChessBool(chess, "isCheck") || safeChessBool(chess, "inCheck");

  let gameStatus;
  if (isCheckmate) {
    gameStatus = `checkmate: ${opponentColor} has delivered checkmate; ${turnColor} is checkmated and has no legal moves. The game is over.`;
  } else if (isStalemate) {
    gameStatus = `stalemate: it is ${turnColor}'s turn, but they have no legal moves and are not in check. The game is over (draw).`;
  } else if (isDraw) {
    gameStatus =
      "drawn position: the game is over (draw by rules such as fifty-move, repetition, or insufficient material).";
  } else if (inCheck) {
    gameStatus = `${turnColor} to move and currently in check; the game is not over yet.`;
  } else {
    gameStatus = "ongoing position: the game is not over.";
  }

  let legalMovesSan = [];
  if (typeof chess.moves === "function") {
    try {
      const verboseMoves = chess.moves({ verbose: true }) || [];
      legalMovesSan = verboseMoves
        .map((mv) =>
          mv && typeof mv.san === "string" ? mv.san.trim() : ""
        )
        .filter((san) => san.length > 0);
    } catch (_) {
      // ignore move generation errors
    }
  }

  const piecePlacement = buildPiecePlacementSummary(chess);

  return { gameStatus, legalMovesSan, piecePlacement };
}

function normalizeReasoningEffort(raw) {
  if (!raw || typeof raw !== "string") return null;
  const value = raw.toLowerCase();
  if (value === "none" || value === "off") return null;
  if (value === "low") return "low";
  if (value === "mid" || value === "medium") return "medium";
  if (value === "high") return "high";
  return null;
}

function parsePgnToChessOrThrow(pgnText) {
  const normalized = String(pgnText || "");
  const chess = new Chess();

  try {
    chess.loadPgn(normalized, { strict: false });
  } catch (err) {
    console.warn(
      "Chess.js threw while parsing PGN:",
      err && err.message ? err.message : err
    );
    const error = new Error("Could not parse PGN.");
    error.status = 400;
    throw error;
  }

  return chess;
}

function buildPgnPositions(chess) {
  if (!chess) return [];

  let headers = {};
  if (typeof chess.header === "function") {
    try {
      headers = chess.header() || {};
    } catch (_) {
      headers = {};
    }
  }

  const hasCustomStart =
    headers &&
    typeof headers.FEN === "string" &&
    headers.FEN.trim().length > 0;

  const startFen = hasCustomStart ? headers.FEN.trim() : undefined;

  let replay;
  try {
    replay = startFen ? new Chess(startFen) : new Chess();
  } catch (_) {
    replay = new Chess();
  }

  let verboseMoves = [];
  if (typeof chess.history === "function") {
    try {
      verboseMoves = chess.history({ verbose: true }) || [];
    } catch (_) {
      verboseMoves = [];
    }
  }

  const positions = [];

  positions.push({
    index: 0,
    fen: replay.fen(),
    ply: 0,
    san: null,
    moveNumber: 0,
    color: replay.turn && replay.turn() === "w" ? "White" : "Black",
    // No last move for the initial position.
    lastMove: null,
  });

  for (let i = 0; i < verboseMoves.length; i += 1) {
    const mv = verboseMoves[i] || {};
    try {
      replay.move(mv);
    } catch (_) {
      break;
    }

    const san =
      typeof mv.san === "string" && mv.san.trim().length > 0
        ? mv.san.trim()
        : null;

    const color =
      typeof mv.color === "string" && mv.color.toLowerCase() === "b"
        ? "Black"
        : "White";

    const moveNumber = Math.floor(i / 2) + 1;

    const lastMove =
      mv &&
      typeof mv.from === "string" &&
      typeof mv.to === "string" &&
      mv.from.trim() &&
      mv.to.trim()
        ? {
            from: mv.from.trim(),
            to: mv.to.trim(),
          }
        : null;

    positions.push({
      index: i + 1,
      fen: replay.fen(),
      ply: i + 1,
      san,
      moveNumber,
      color,
      lastMove,
    });
  }

  return positions;
}

function normalizeId(rawId) {
  const id = String(rawId || "").trim();
  if (!id) return "";
  return id.replace(/[^A-Za-z0-9_\-]/g, "_");
}

async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (_) {}
}

async function listCharacters() {
  try {
    await ensureDir(CHARACTERS_DIR);
    const entries = await fsp.readdir(CHARACTERS_DIR, { withFileTypes: true });
    const result = [];

    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.toLowerCase().endsWith(".json")) continue;

      const filePath = path.join(CHARACTERS_DIR, ent.name);
      let raw;
      try {
        raw = await fsp.readFile(filePath, "utf8");
      } catch {
        continue;
      }

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        continue;
      }

      const base = path.basename(ent.name, path.extname(ent.name));
      const id = data.id || base;
      const elo =
        data.strength && typeof data.strength.targetElo === "number"
          ? data.strength.targetElo
          : null;

      result.push({
        id,
        description: data.description || "",
        elo,
      });
    }

    result.sort((a, b) => a.id.localeCompare(b.id));
    return result;
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function loadCharacterProfile(id) {
  const safeId = normalizeId(id);
  if (!safeId) {
    const err = new Error("Invalid character id");
    err.status = 400;
    throw err;
  }

  const filePath = path.join(CHARACTERS_DIR, `${safeId}.json`);
  const raw = await fsp.readFile(filePath, "utf8");
  const data = JSON.parse(raw);
  data.id = safeId;
  return data;
}

function buildPersonalityPrompt(profile) {
  if (!profile) return "";

  const lines = [];
  const id = profile.id || "Unknown";
  const description = profile.description || "";
  const strength = profile.strength || {};
  const taunts = profile.taunts || {};

  lines.push(`You are role-playing the Rodent IV character "${id}".`);

  if (description) {
    lines.push(`Character description: ${description}`);
  }

  if (typeof strength.targetElo === "number") {
    lines.push(
      `Your approximate playing strength is around ${strength.targetElo} Elo.`
    );
  }

  let tone = "neutral, instructive, and encouraging";
  if (taunts && taunts.enabled) {
    const rudeness = typeof taunts.rudeness === "number" ? taunts.rudeness : 0;
    if (rudeness >= 70) {
      tone =
        "sharp but still playful, with occasional teasing (always PG-13 and non-abusive)";
    } else if (rudeness >= 40) {
      tone =
        "playful and lightly teasing while remaining friendly and supportive";
    } else {
      tone = "friendly, encouraging, and lightly humorous";
    }
  }

  lines.push(
    `Your coaching tone should be ${tone}. Do not use profanity, slurs, or explicit content, and keep all comments focused on chess.`
  );

  lines.push(
    "You are not a chess engine and you must never calculate or choose moves yourself. You only rephrase and explain facts that are explicitly present in the ENGINE_STATE block."
  );

  return lines.join("\n");
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/pgn/final-position", (req, res) => {
  try {
    const { pgnText } = req.body || {};

    if (!pgnText || typeof pgnText !== "string") {
      return res
        .status(400)
        .json({ error: "pgnText (string) is required." });
    }

    let chess;
    try {
      chess = parsePgnToChessOrThrow(pgnText);
    } catch (err) {
      const status =
        err.status && Number.isInteger(err.status) ? err.status : 400;
      return res.status(status).json({
        error: err.message || "Could not parse PGN.",
      });
    }

    const fen = chess.fen();
    const sideToMove = chess.turn() === "w" ? "White" : "Black";
    const history = chess.history();
    const moveHistory = history.join(" ");
    const positions = buildPgnPositions(chess);

    res.json({ fen, sideToMove, moveHistory, positions });
  } catch (err) {
    console.error("Error in /api/pgn/final-position:", err);
    res.status(500).json({
      error: "Failed to parse PGN.",
      details: err.message,
    });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const {
      pgnText,
      message,
      personalityId,
      playerColor,
      commentTarget,
      reasoningEffort,
      llmSource,
      lanHost,
      lanPort,
    } = req.body || {};

    if (!pgnText || typeof pgnText !== "string") {
      return res.status(400).json({ error: "pgnText (string) is required." });
    }

    let chess;
    try {
      chess = parsePgnToChessOrThrow(pgnText);
    } catch (err) {
      const status = err.status && Number.isInteger(err.status) ? err.status : 400;
      return res.status(status).json({
        error: err.message || "Could not parse PGN.",
      });
    }

    const engineStateBlock = await buildCoachEngineStateBlock({
      chess,
      personalityId,
      playerColor,
      commentTarget,
    });

    const userQuestion =
      typeof message === "string" && message.trim().length > 0
        ? message.trim()
        : "";

    const userContent = buildUserContent(engineStateBlock, userQuestion);
    const systemPrompt = await buildSystemPrompt(
      personalityId,
      reasoningEffort
    );

    const result = await completeCoachReply({
      systemPrompt,
      userContent,
      reasoningEffort,
      llmSource,
      lanHost,
      lanPort,
    });

    res.json({
      reply: result.answerText,
      reasoning: result.reasoningText,
    });
  } catch (err) {
    console.error("Error in /api/chat:", err.response?.data || err.message);
    res.status(500).json({
      error: "LLM request failed.",
      details: err.message,
    });
  }
});

app.post("/api/chat/stream", async (req, res) => {
  try {
    const {
      pgnText,
      message,
      personalityId,
      playerColor,
      commentTarget,
      reasoningEffort,
      llmSource,
      lanHost,
      lanPort,
    } = req.body || {};

    if (!pgnText || typeof pgnText !== "string") {
      res.status(400).json({ error: "pgnText (string) is required." });
      return;
    }

    let chess;
    try {
      chess = parsePgnToChessOrThrow(pgnText);
    } catch (err) {
      const status = err.status && Number.isInteger(err.status) ? err.status : 400;
      res.status(status).json({
        error: err.message || "Could not parse PGN.",
      });
      return;
    }

    const engineStateBlock = await buildCoachEngineStateBlock({
      chess,
      personalityId,
      playerColor,
      commentTarget,
    });

    const userQuestion =
      typeof message === "string" && message.trim().length > 0
        ? message.trim()
        : "";

    const userContent = buildUserContent(engineStateBlock, userQuestion);
    const systemPrompt = await buildSystemPrompt(
      personalityId,
      reasoningEffort
    );

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");

    function writeEvent(obj) {
      try {
        res.write(JSON.stringify(obj) + "\n");
      } catch (e) {}
    }

    // Send a one-shot debug event so the frontend can display exactly what
    // engine state and prompt content we are giving to the LLM.
    writeEvent({
      type: "engine_debug",
      text: [
        "ENGINE_STATE block sent to coach LLM:",
        "",
        engineStateBlock,
        "",
        "User content sent to coach LLM:",
        "",
        userContent,
      ].join("\n"),
    });

    await streamCoachReply({
      systemPrompt,
      userContent,
      reasoningEffort,
      llmSource,
      lanHost,
      lanPort,
      onTyping: (state) => {
        writeEvent({ type: "typing", state });
      },
      onSentence: (text) => {
        writeEvent({ type: "sentence", text });
      },
      onReasoning: (text) => {
        writeEvent({ type: "reasoning", text });
      },
      onEnd: (info) => {
        if (info && info.error) {
          writeEvent({
            type: "error",
            message:
              "LLM streaming request failed: " +
              (info.error.message || String(info.error)),
          });
        }
        writeEvent({ type: "typing", state: "end" });
        res.end();
      },
    });
  } catch (err) {
    console.error("Error in /api/chat/stream:", err.response?.data || err.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: "LLM streaming request failed.",
        details: err.message,
      });
    } else {
      try {
        res.write(
          JSON.stringify({
            type: "error",
            message: "LLM streaming request failed: " + err.message,
          }) + "\n"
        );
        res.write(JSON.stringify({ type: "typing", state: "end" }) + "\n");
        res.end();
      } catch {}
    }
  }
});

async function buildSystemPrompt(personalityId, reasoningEffort) {
  const harness = [
    "You are a narration layer over a chess engine, not a chess engine yourself.",
    "You MUST NOT calculate or choose moves on your own.",
    "You ONLY rephrase and explain information that is explicitly present in the ENGINE_STATE block.",
    "If a move, evaluation, piece square, or game result is not literally written in ENGINE_STATE, you must say you do not know it.",
    "You must not discuss real-world topics, politics, religion, or other sensitive content.",
    "You must always use PG-13 language and avoid profanity, slurs, or explicit content.",
    "If the player asks about anything non-chess, politely refuse and steer the discussion back to chess.",
    "",
  ].join("\n");

  const coachCore = [
    "Treat yourself as a writing assistant that ONLY rewrites and explains what is already written in the ENGINE_STATE block.",
    "You NEVER invent engine evaluations, moves, or piece locations.",
    "You only explain and discuss what is contained in the ENGINE_STATE block.",
    "If a fact (such as a piece square, evaluation, or move) is not explicitly present in ENGINE_STATE, you must not state it.",
    "Do NOT decode or interpret the FEN yourself; treat it as opaque text.",
    "When talking about where pieces are, you MUST only use the squares listed in the `Piece placements:` section of ENGINE_STATE and repeat them accurately.",
    "When suggesting or describing moves, you MUST only use moves that appear in either the `Legal moves for side to move (SAN):` list or the `Top lines:` section of ENGINE_STATE.",
    "If a move is not present in those lists, treat it as illegal for this position and do not recommend it.",
    "If ENGINE_STATE says the game is over (for example, checkmate, stalemate, or draw), clearly explain the final result and do NOT suggest any further moves for the side to move.",
    "Use the terminology and numeric information already present in ENGINE_STATE; you can vary phrasing, but you must not change the underlying facts.",
    "Any internal reasoning you do is about how to explain things clearly, not about calculating or discovering new chess moves or evaluations.",
    "",
  ].join("\n");

  let personalityBlock = "";
  if (personalityId) {
    try {
      const profile = await loadCharacterProfile(personalityId);
      personalityBlock = buildPersonalityPrompt(profile);
    } catch (err) {
      console.warn(
        "Failed to load personality profile for LLM coach:",
        err && err.message ? err.message : err
      );
    }
  }

  const basePrompt =
    systemPromptOverride && systemPromptOverride.trim().length > 0
      ? systemPromptOverride
      : [harness, coachCore].join("\n\n");

  const sections = [basePrompt, personalityBlock];

  const rawReasoning =
    typeof reasoningEffort === "string"
      ? reasoningEffort.trim().toLowerCase()
      : "";

  if (rawReasoning === "none" || rawReasoning === "off") {
    // Explicitly discourage chain-of-thought when reasoning is disabled.
    sections.push(
      "Reasoning mode: /no_think. Answer directly and concisely, without writing out any step-by-step internal reasoning."
    );
  } else {
    const effort = normalizeReasoningEffort(reasoningEffort);
    if (effort) {
      sections.push(
        "Any internal reasoning you perform should follow: Reasoning mode: /think. This is only for structuring your explanation, not for discovering new chess facts."
      );
    }
  }

  return sections.filter(Boolean).join("\n\n");
}

function formatEvalInPawns(centipawnEval) {
  const cp = Number.isFinite(centipawnEval) ? centipawnEval : 0;
  const pawns = cp / 100;

  if (pawns === 0) {
    return "0.00";
  }

  const absStr = Math.abs(pawns).toFixed(2);
  return pawns > 0 ? `+${absStr}` : `-${absStr}`;
}

function buildEngineStateBlock(engineState) {
  if (!engineState || typeof engineState !== "object") {
    throw new Error("engineState must be an object.");
  }

  const {
    fen,
    sideToMove,
    centipawnEval,
    evalComment,
    topLines,
    moveHistory,
    gameStatus,
    legalMovesSan,
    piecePlacement,
  } = engineState;

  const safeSideToMove =
    typeof sideToMove === "string" && sideToMove.trim().length > 0
      ? sideToMove.trim()
      : "Unknown";
  const hasNumericEval = Number.isFinite(centipawnEval);
  const cpEval = hasNumericEval ? centipawnEval : 0;

  const lines = [];
  lines.push("[ENGINE_STATE]");
  lines.push(`Side to move: ${safeSideToMove}`);
  lines.push(`Current FEN: ${fen}`);
  if (hasNumericEval) {
    lines.push(`Evaluation (centipawns for side to move): ${cpEval}`);
  } else {
    lines.push(
      "Evaluation (centipawns for side to move): not provided (rely on Game status and engine comments above instead)."
    );
  }

  const trimmedComment =
    typeof evalComment === "string" ? evalComment.trim() : "";
  if (trimmedComment.length > 0) {
    lines.push(`Evaluation comment: ${trimmedComment}`);
  } else {
    lines.push(
      "Evaluation comment: 0.00 (engine eval not attached; this is a structural explanation only)."
    );
  }

  const trimmedStatus =
    typeof gameStatus === "string" ? gameStatus.trim() : "";
  if (trimmedStatus.length > 0) {
    lines.push(`Game status: ${trimmedStatus}`);
  }

  const legalMovesList = Array.isArray(legalMovesSan)
    ? legalMovesSan
        .map((m) => (typeof m === "string" ? m.trim() : ""))
        .filter((m) => m.length > 0)
    : [];
  if (legalMovesList.length > 0) {
    lines.push("");
    lines.push("Legal moves for side to move (SAN):");
    lines.push(legalMovesList.join(" "));
  }

  const trimmedPlacement =
    typeof piecePlacement === "string" ? piecePlacement.trim() : "";
  if (trimmedPlacement.length > 0) {
    lines.push("");
    lines.push(trimmedPlacement);
  }

  if (moveHistory && moveHistory.trim().length > 0) {
    lines.push("");
    lines.push("Recent moves:");
    lines.push(moveHistory.trim());
  }

  const hasTopLines = Array.isArray(topLines) && topLines.length > 0;
  if (hasTopLines) {
    lines.push("");
    lines.push("Top lines:");

    for (let i = 0; i < topLines.length; i += 1) {
      const line = topLines[i] || {};
      const move = typeof line.move === "string" ? line.move : "";
      const lineEvalCp = Number.isFinite(line.centipawnEval)
        ? line.centipawnEval
        : 0;
      const evalInPawns = formatEvalInPawns(lineEvalCp);
      const pv =
        typeof line.line === "string" && line.line.trim().length > 0
          ? line.line.trim()
          : "";

      let row = `${i + 1}) Move: ${move}, Eval: ${evalInPawns}, Line: ${pv}`;

      if (Number.isFinite(line.depth) && line.depth > 0) {
        row += ` (depth ${line.depth})`;
      }

      lines.push(row);
    }
  }

  lines.push("[END_ENGINE_STATE]");
  return lines.join("\n");
}

function centipawnsForSide(engineState, sideLabel) {
  if (
    !engineState ||
    !Number.isFinite(engineState.centipawnEval) ||
    !engineState.sideToMove
  ) {
    return null;
  }

  const cp = engineState.centipawnEval;
  const sideToMove =
    typeof engineState.sideToMove === "string"
      ? engineState.sideToMove.trim()
      : "";

  if (!sideToMove || (sideToMove !== "White" && sideToMove !== "Black")) {
    return null;
  }

  if (sideToMove === sideLabel) {
    return cp;
  }

  return -cp;
}

function classifyMoveQuality(deltaCp) {
  if (!Number.isFinite(deltaCp)) {
    return {
      label: "unknown",
      description:
        "Move quality is unknown because the engine did not provide a numeric evaluation for the before/after positions.",
    };
  }

  const pawns = deltaCp / 100;
  const absPawns = Math.abs(pawns);

  let label;
  if (pawns >= 1.5) {
    label = "brilliant";
  } else if (pawns >= 0.75) {
    label = "excellent";
  } else if (pawns >= 0.25) {
    label = "good";
  } else if (absPawns < 0.25) {
    label = "neutral";
  } else if (pawns <= -1.75) {
    label = "blunder";
  } else if (pawns <= -1.0) {
    label = "mistake";
  } else {
    label = "inaccuracy";
  }

  const direction = pawns >= 0 ? "improved" : "worsened";
  const absText = absPawns.toFixed(2);

  return {
    label,
    description: `From the engine's perspective for that side, this move ${direction} the evaluation by about ${absText} pawns (centipawn delta: ${deltaCp}).`,
  };
}

function inferPieceNameFromSan(san) {
  if (!san || typeof san !== "string") return null;
  const s = san.trim();
  if (!s) return null;

  // Handle promotion like d8=Q+ first.
  const promoMatch = s.match(/=([QRBN])/i);
  const lead = promoMatch ? promoMatch[1] : s[0];
  const c = String(lead).toUpperCase();

  if (c === "K") return "king";
  if (c === "Q") return "queen";
  if (c === "R") return "rook";
  if (c === "B") return "bishop";
  if (c === "N") return "knight";

  // No explicit piece letter → pawn move.
  return "pawn";
}

function buildCommentMetaFromPositions(
  positions,
  playerColorRaw,
  commentTargetRaw
) {
  if (!Array.isArray(positions) || positions.length < 2) {
    return null;
  }

  const playerColor =
    typeof playerColorRaw === "string" &&
    playerColorRaw.toLowerCase() === "black"
      ? "Black"
      : "White";

  const targetKind =
    typeof commentTargetRaw === "string" &&
    commentTargetRaw.toLowerCase() === "llm"
      ? "llm"
      : "player";

  const targetSide =
    targetKind === "player"
      ? playerColor
      : playerColor === "White"
      ? "Black"
      : "White";

  // Search from the end for the last move played by targetSide.
  for (let i = positions.length - 1; i >= 1; i -= 1) {
    const node = positions[i];
    if (!node || typeof node.color !== "string") continue;
    if (node.color !== targetSide) continue;

    const prev = positions[i - 1];
    if (!prev || !prev.fen || !node.fen) continue;

    const ply = Number.isInteger(node.ply) ? node.ply : i;
    const moveNumber =
      Number.isInteger(node.moveNumber) && node.moveNumber > 0
        ? node.moveNumber
        : Math.floor((ply + 1) / 2);

    const san = typeof node.san === "string" ? node.san.trim() : "";

    return {
      targetKind,
      targetSide,
      moveSan: san,
      moveNumber,
      plyIndex: i,
      beforeFen: prev.fen,
      afterFen: node.fen,
    };
  }

  return null;
}

async function buildCoachEngineStateBlock({
  chess,
  personalityId,
  playerColor,
  commentTarget,
}) {
  const fen = chess.fen();
  const sideToMove = chess.turn() === "w" ? "White" : "Black";
  const historySan = chess.history() || [];
  const moveHistory = Array.isArray(historySan) ? historySan.join(" ") : "";

  const { gameStatus, legalMovesSan, piecePlacement } = summarizeGameState(
    chess
  );

  const engineState = await analyzePosition({
    fen,
    sideToMove,
    moveHistory,
    personalityId,
    gameStatus,
    legalMovesSan,
    piecePlacement,
  });

  let engineStateBlock = buildEngineStateBlock(engineState);

  // Optionally add a focused before/after analysis for the selected move.
  try {
    const positions = buildPgnPositions(chess);
    const meta = buildCommentMetaFromPositions(
      positions,
      playerColor,
      commentTarget
    );
    if (!meta) {
      return engineStateBlock;
    }

    const historyLength = Array.isArray(historySan) ? historySan.length : 0;
    if (!historyLength || !Number.isInteger(meta.plyIndex)) {
      return engineStateBlock;
    }

    const plyIndex = meta.plyIndex;
    const moveHistoryBefore =
      plyIndex > 1
        ? historySan.slice(0, plyIndex - 1).join(" ")
        : "";
    const moveHistoryAfter =
      plyIndex > 0
        ? historySan.slice(0, plyIndex).join(" ")
        : historySan.join(" ");

    let chessBefore;
    let chessAfter;
    try {
      chessBefore = new Chess(meta.beforeFen);
    } catch (_) {}
    try {
      chessAfter = new Chess(meta.afterFen);
    } catch (_) {}

    if (!chessBefore || !chessAfter) {
      return engineStateBlock;
    }

    const sideToMoveBefore = chessBefore.turn() === "w" ? "White" : "Black";
    const sideToMoveAfter = chessAfter.turn() === "w" ? "White" : "Black";

    const summaryBefore = summarizeGameState(chessBefore);
    const summaryAfter = summarizeGameState(chessAfter);

    const [beforeState, afterState] = await Promise.all([
      analyzePosition({
        fen: meta.beforeFen,
        sideToMove: sideToMoveBefore,
        moveHistory: moveHistoryBefore,
        personalityId,
        gameStatus: summaryBefore.gameStatus,
        legalMovesSan: summaryBefore.legalMovesSan,
        piecePlacement: summaryBefore.piecePlacement,
      }),
      analyzePosition({
        fen: meta.afterFen,
        sideToMove: sideToMoveAfter,
        moveHistory: moveHistoryAfter,
        personalityId,
        gameStatus: summaryAfter.gameStatus,
        legalMovesSan: summaryAfter.legalMovesSan,
        piecePlacement: summaryAfter.piecePlacement,
      }),
    ]);

    if (!beforeState || !afterState) {
      return engineStateBlock;
    }

    const beforeBlock = buildEngineStateBlock(beforeState);
    const afterBlock = buildEngineStateBlock(afterState);

    let qualityLine = "";
    if (meta.targetSide) {
      const beforeForSide = centipawnsForSide(beforeState, meta.targetSide);
      const afterForSide = centipawnsForSide(afterState, meta.targetSide);
      if (
        Number.isFinite(beforeForSide) &&
        Number.isFinite(afterForSide)
      ) {
        const delta = afterForSide - beforeForSide;
        const quality = classifyMoveQuality(delta);
        qualityLine = `Engine move-quality label for this move (for ${meta.targetSide}): ${quality.label}. ${quality.description}`;
      }
    }

    const subjectLabel =
      meta.targetKind === "llm"
        ? "the LLM's most recent move"
        : "the player's most recent move";

    const descriptorParts = [];
    if (Number.isInteger(meta.moveNumber) && meta.moveNumber > 0) {
      descriptorParts.push(`move ${meta.moveNumber}`);
    }
    if (meta.targetSide) {
      descriptorParts.push(meta.targetSide);
    }
    if (meta.moveSan) {
      descriptorParts.push(meta.moveSan);
    }
    const moveDescriptor =
      descriptorParts.length > 0
        ? descriptorParts.join(" ")
        : "the last relevant move in the PGN";

    let commentHeader = "[COMMENT_TARGET]\n";
    commentHeader += `The engine has identified ${subjectLabel} (${moveDescriptor}) as the move to talk about.\n`;
    if (qualityLine) {
      commentHeader += `${qualityLine}\n`;
    }
    if (meta.targetKind === "player") {
      commentHeader +=
        "You are role-playing the AI opponent. Comment on the human player's move strictly from the AI opponent's point of view.\n";
    } else {
      commentHeader +=
        "You are role-playing the AI opponent. Briefly reflect on your own (engine) last move from that point of view.\n";
    }
    commentHeader +=
      "Here is the engine evaluation immediately BEFORE that move:\n\n";
    commentHeader += beforeBlock;
    commentHeader +=
      "\n\nHere is the engine evaluation immediately AFTER that move:\n\n";
    commentHeader += afterBlock;
    commentHeader +=
      "\nYou must only rephrase and explain this engine-provided information and move-quality label; do not perform any additional chess calculation or decide for yourself whether the move was a blunder or brilliancy.\n";
    commentHeader += "\n[END_COMMENT_TARGET]";

    engineStateBlock = `${engineStateBlock}\n\n${commentHeader}`;
  } catch (err) {
    console.warn("Failed to build comment-target block for coach:", err);
  }

  return engineStateBlock;
}

function buildUserContent(engineStateBlock, question) {
  const parts = [];
  parts.push("Here is the current game state and engine analysis:");
  parts.push("");
  parts.push(engineStateBlock);
  parts.push("");

  if (question && question.length > 0) {
    parts.push("Player question:");
    parts.push(question);
  } else {
    if (
      fallbackUserPromptOverride &&
      typeof fallbackUserPromptOverride === "string" &&
      fallbackUserPromptOverride.trim().length > 0
    ) {
      parts.push(fallbackUserPromptOverride.trim());
    } else {
      parts.push(
        "Explain, in plain language, what the ENGINE_STATE block says. Describe the evaluation, game status, and the engine's top lines, and summarize the typical plans they suggest, without inventing any new moves, evaluations, or piece locations."
      );
    }
  }

  return parts.join("\n");
}

function buildTauntSystemPrompt(personalityPrompt, reasoningEffort) {
  const base =
    tauntSystemPromptOverride && tauntSystemPromptOverride.trim().length > 0
      ? tauntSystemPromptOverride.trim()
      : [
          "Your conversation partner is a human chess player using Rodent IV.",
          "You are playing the role of their computer opponent, speaking in the voice of the Rodent character described in the persona.",
          "",
          "You are given short descriptions of what the chess engine thinks is happening in the game and a simple taunt idea.",
          "Treat this description and taunt idea as everything you need to know about the position.",
          "Focus entirely on wording, style, and personality; the engine and taunt idea already handle the chess details.",
          "",
          "Your job is to turn each taunt idea into one vivid, in-character sentence directed at the player.",
          "Keep the tone playful and competitive, in line with the character's rudeness level.",
          "Use plain language instead of technical chess notation.",
          "Keep all comments PG-13 and clearly related to the game.",
        ].join("\n");

  const sections = [base];
  if (personalityPrompt) {
    sections.push(personalityPrompt);
  }

  const rawReasoning =
    typeof reasoningEffort === "string"
      ? reasoningEffort.trim().toLowerCase()
      : "";

  if (rawReasoning === "none" || rawReasoning === "off") {
    sections.push(
      "Reasoning mode: /no_think. Write the taunt sentence directly without exposing any internal step-by-step reasoning."
    );
  } else {
    const effort = normalizeReasoningEffort(reasoningEffort);
    if (effort) {
      sections.push(
        "You may internally think step-by-step about how to phrase the taunt, but you still rely entirely on the taunt idea for chess details."
      );
    }
  }

  return sections.filter(Boolean).join("\n\n");
}

function buildTauntUserContent(tauntDescriptor, extraUserText) {
  const parts = [];

  const descriptionBlock = describeTauntForLlm(tauntDescriptor);
  parts.push("Here is the taunt idea to base your reply on:");
  parts.push("");
  parts.push(descriptionBlock);
  parts.push("");

  if (
    tauntFallbackPromptOverride &&
    typeof tauntFallbackPromptOverride === "string" &&
    tauntFallbackPromptOverride.trim().length > 0
  ) {
    parts.push(tauntFallbackPromptOverride.trim());
  } else {
    parts.push(
      "Using the taunt idea and persona, write one short taunt sentence (5–25 words) directed at the player."
    );
    parts.push(
      "Highlight the described theme in playful language that fits the character, and use plain language instead of technical chess notation."
    );
  }

  if (extraUserText && extraUserText.trim().length > 0) {
    parts.push("");
    parts.push("Player message (extra flavor, not for chess facts):");
    parts.push(extraUserText.trim());
  }

  return parts.join("\n");
}

app.get("/api/personalities", async (req, res) => {
  try {
    const list = await listCharacters();
    res.json(list);
  } catch (err) {
    console.error("Error in /api/personalities:", err);
    res.status(500).json({
      error: "Failed to load personalities.",
    });
  }
});

app.listen(port, () => {
  console.log(`LLM coach web listening on http://localhost:${port}`);
});

// LLM-powered taunt endpoints. These accept a pre-digested TauntDescriptor
// and persona information and ask the model to turn it into a single
// colorful taunt sentence. No FEN or ENGINE_STATE is passed here; all
// chess reasoning stays in the engine + taunt classifier layers.

async function buildTauntDescriptorFromPgn({
  pgnText,
  characterId,
  tauntTargetSide,
  playerColor,
}) {
  const targetSide = tauntTargetSide || "player";

  if (!pgnText || typeof pgnText !== "string") {
    const engineState = null;
    return buildTauntDescriptorFromEngine(engineState, {
      targetSide,
    });
  }

  let chess;
  try {
    chess = parsePgnToChessOrThrow(pgnText);
  } catch (err) {
    const error = new Error(err.message || "Could not parse PGN for taunt.");
    error.status = err.status && Number.isInteger(err.status) ? err.status : 400;
    throw error;
  }

  const fen = chess.fen();
  const sideToMove = chess.turn() === "w" ? "White" : "Black";
  const historySan = chess.history() || [];
  const moveHistory = Array.isArray(historySan) ? historySan.join(" ") : "";

  const { gameStatus, legalMovesSan, piecePlacement } = summarizeGameState(
    chess
  );

  // Baseline descriptor from the final position: overall advantage / game
  // status for the side to move.
  const engineState = await analyzePosition({
    fen,
    sideToMove,
    moveHistory,
    personalityId: characterId,
    gameStatus,
    legalMovesSan,
    piecePlacement,
  });

  const baseDescriptor = buildTauntDescriptorFromEngine(engineState, {
    targetSide,
  });

  // Refine the taunt around a specific targeted move by the player, using the
  // same PGN-derived move metadata and before/after engine analysis that the
  // coach path uses. If anything in this block fails, we surface an explicit
  // error so the caller can treat it as a fatal condition instead of guessing.
  const positions = buildPgnPositions(chess);

    // For taunts we always focus on the human player's move, not the engine's
    // move, so we pass commentTargetRaw = "player". The playerColor field
    // comes from the UI ("white" | "black").
    const meta = buildCommentMetaFromPositions(
      positions,
      playerColor || "white",
      "player"
    );
    if (!meta || !Number.isInteger(meta.plyIndex)) {
      const error = new Error(
        "Could not identify a targeted human move in the PGN for taunt analysis."
      );
      error.status = 500;
      error.code = "ENGINE_TAUNT_NO_TARGET_MOVE";
      throw error;
    }

    const historyLength = Array.isArray(historySan) ? historySan.length : 0;
    if (!historyLength) {
      const error = new Error(
        "Engine taunt analysis found no SAN move history for before/after reconstruction."
      );
      error.status = 500;
      error.code = "ENGINE_TAUNT_NO_HISTORY";
      throw error;
    }

    const plyIndex = meta.plyIndex;
    const moveHistoryBefore =
      plyIndex > 1 ? historySan.slice(0, plyIndex - 1).join(" ") : "";
    const moveHistoryAfter =
      plyIndex > 0 ? historySan.slice(0, plyIndex).join(" ") : moveHistory;

    let chessBefore;
    let chessAfter;
    try {
      chessBefore = new Chess(meta.beforeFen);
    } catch (_) {}
    try {
      chessAfter = new Chess(meta.afterFen);
    } catch (_) {}

    if (!chessBefore || !chessAfter) {
      const error = new Error(
        "Engine taunt analysis could not reconstruct before/after positions for the targeted move."
      );
      error.status = 500;
      error.code = "ENGINE_TAUNT_BAD_BEFORE_AFTER";
      throw error;
    }

    const sideToMoveBefore = chessBefore.turn() === "w" ? "White" : "Black";
    const sideToMoveAfter = chessAfter.turn() === "w" ? "White" : "Black";

    const summaryBefore = summarizeGameState(chessBefore);
    const summaryAfter = summarizeGameState(chessAfter);

    const [beforeState, afterState] = await Promise.all([
      analyzePosition({
        fen: meta.beforeFen,
        sideToMove: sideToMoveBefore,
        moveHistory: moveHistoryBefore,
        personalityId: characterId,
        gameStatus: summaryBefore.gameStatus,
        legalMovesSan: summaryBefore.legalMovesSan,
        piecePlacement: summaryBefore.piecePlacement,
      }),
      analyzePosition({
        fen: meta.afterFen,
        sideToMove: sideToMoveAfter,
        moveHistory: moveHistoryAfter,
        personalityId: characterId,
        gameStatus: summaryAfter.gameStatus,
        legalMovesSan: summaryAfter.legalMovesSan,
        piecePlacement: summaryAfter.piecePlacement,
      }),
    ]);

    if (!beforeState || !afterState) {
      const error = new Error(
        "Engine taunt analysis did not return evaluations for the before/after positions of the targeted move."
      );
      error.status = 500;
      error.code = "ENGINE_TAUNT_NO_BEFORE_AFTER_STATE";
      throw error;
    }

    // Measure the change in evaluation for the side that actually played the
    // targeted move (meta.targetSide is "White" or "Black"). This ensures the
    // taunt reflects whether that specific move was a brilliancy or a blunder
    // from the mover's perspective.
    const moveSideLabel = meta.targetSide || "White";
    const inferredPiece = inferPieceNameFromSan(meta.moveSan || "");

    const descriptorBase = {
      ...baseDescriptor,
      piece: inferredPiece || baseDescriptor.piece,
      moveSide: moveSideLabel,
      moveNumber:
        Number.isInteger(meta.moveNumber) && meta.moveNumber > 0
          ? meta.moveNumber
          : undefined,
      moveSan: meta.moveSan || undefined,
    };

    const beforeForMover = centipawnsForSide(beforeState, moveSideLabel);
    const afterForMover = centipawnsForSide(afterState, moveSideLabel);

    if (
      !Number.isFinite(beforeForMover) ||
      !Number.isFinite(afterForMover)
    ) {
      const error = new Error(
        "Engine did not provide numeric evaluations for the before/after positions of the targeted move; cannot classify taunt."
      );
      error.status = 500;
      error.code = "ENGINE_TAUNT_NO_NUMERIC_DELTA";
      throw error;
    }

    const deltaCp = afterForMover - beforeForMover;
    const quality = classifyMoveQuality(deltaCp);

    return {
      ...descriptorBase,
      moveQualityLabel: quality.label,
      moveQualityDetail: quality.description,
      moveDeltaCentipawns: deltaCp,
    };
  }

app.post("/api/taunt", async (req, res) => {
  try {
    const {
      taunt,
      pgnText,
      characterId,
      tauntTargetSide,
      playerColor,
      reasoningEffort,
      playerMessage,
      llmSource,
      lanHost,
      lanPort,
    } = req.body || {};

    let effectiveTaunt = taunt;

    if (!effectiveTaunt) {
      effectiveTaunt = await buildTauntDescriptorFromPgn({
        pgnText,
        characterId,
        tauntTargetSide,
        playerColor,
      });
    }

    if (!effectiveTaunt || typeof effectiveTaunt !== "object") {
      return res.status(400).json({
        error: "taunt (object) or pgnText (string) is required for /api/taunt.",
      });
    }

    let personalityPrompt = "";
    if (characterId) {
      try {
        const profile = await loadCharacterProfile(characterId);
        personalityPrompt = buildPersonalityPrompt(profile);
      } catch (err) {
        console.warn(
          "Failed to load personality profile for taunt:",
          err && err.message ? err.message : err
        );
      }
    }

    const systemPrompt = buildTauntSystemPrompt(
      personalityPrompt,
      reasoningEffort
    );
    const userContent = buildTauntUserContent(
      effectiveTaunt,
      playerMessage || ""
    );

    const result = await completeTaunt({
      systemPrompt,
      userContent,
      reasoningEffort,
      llmSource,
      lanHost,
      lanPort,
    });

    const tauntText =
      typeof result.answerText === "string"
        ? result.answerText.trim()
        : "";

    res.json({ taunt: tauntText });
  } catch (err) {
    console.error("Error in /api/taunt:", err.response?.data || err.message);
    const status =
      err.status && Number.isInteger(err.status) ? err.status : 500;
    res.status(status).json({
      error:
        err.code && String(err.code).startsWith("ENGINE_TAUNT")
          ? err.message
          : "LLM taunt request failed.",
      details: err.message,
    });
  }
});

app.post("/api/taunt/stream", async (req, res) => {
  try {
    const {
      taunt,
      pgnText,
      characterId,
      tauntTargetSide,
      playerColor,
      reasoningEffort,
      playerMessage,
      llmSource,
      lanHost,
      lanPort,
    } = req.body || {};

    let effectiveTaunt = taunt;

    if (!effectiveTaunt) {
      effectiveTaunt = await buildTauntDescriptorFromPgn({
        pgnText,
        characterId,
        tauntTargetSide,
        playerColor,
      });
    }

    if (!effectiveTaunt || typeof effectiveTaunt !== "object") {
      res.status(400).json({
        error:
          "taunt (object) or pgnText (string) is required for /api/taunt/stream.",
      });
      return;
    }

    let personalityPrompt = "";
    if (characterId) {
      try {
        const profile = await loadCharacterProfile(characterId);
        personalityPrompt = buildPersonalityPrompt(profile);
      } catch (err) {
        console.warn(
          "Failed to load personality profile for taunt:",
          err && err.message ? err.message : err
        );
      }
    }

    const systemPrompt = buildTauntSystemPrompt(
      personalityPrompt,
      reasoningEffort
    );
    const userContent = buildTauntUserContent(
      effectiveTaunt,
      playerMessage || ""
    );

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");

    function writeEvent(obj) {
      try {
        res.write(JSON.stringify(obj) + "\n");
      } catch (e) {}
    }

    // Send a one-shot debug event so the frontend can display the engine-driven
    // taunt descriptor and the exact prompt content used for the LLM taunt.
    writeEvent({
      type: "engine_debug",
      text: [
        "Engine-derived taunt descriptor:",
        "",
        JSON.stringify(effectiveTaunt, null, 2),
        "",
        "User content sent to taunt LLM:",
        "",
        userContent,
      ].join("\n"),
    });

    await streamTaunt({
      systemPrompt,
      userContent,
      reasoningEffort,
      llmSource,
      lanHost,
      lanPort,
      onTyping: (state) => {
        writeEvent({ type: "typing", state });
      },
      onSentence: (text) => {
        writeEvent({ type: "sentence", text });
      },
      onReasoning: (text) => {
        writeEvent({ type: "reasoning", text });
      },
      onEnd: (info) => {
        if (info && info.error) {
          writeEvent({
            type: "error",
            message:
              "LLM taunt streaming request failed: " +
              (info.error.message || String(info.error)),
          });
        }
        writeEvent({ type: "typing", state: "end" });
        res.end();
      },
    });
  } catch (err) {
    console.error(
      "Error in /api/taunt/stream:",
      err.response?.data || err.message
    );
    if (!res.headersSent) {
      const status =
        err.status && Number.isInteger(err.status) ? err.status : 500;
      res.status(status).json({
        error:
          err.code && String(err.code).startsWith("ENGINE_TAUNT")
            ? err.message
            : "LLM taunt streaming request failed.",
        details: err.message,
      });
    } else {
      try {
        res.write(
          JSON.stringify({
            type: "error",
            message:
              (err.code && String(err.code).startsWith("ENGINE_TAUNT")
                ? err.message
                : "LLM taunt streaming request failed: " + err.message) || "",
          }) + "\n"
        );
        res.write(JSON.stringify({ type: "typing", state: "end" }) + "\n");
        res.end();
      } catch {}
    }
  }
});

