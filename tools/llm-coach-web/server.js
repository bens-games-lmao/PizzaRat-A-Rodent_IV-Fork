const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const { Chess } = require("chess.js");
const fs = require("fs");
const { analyzePosition } = require("./engineAnalysisService");

const app = express();
const port = process.env.PORT || 4100;

// LLM configuration. Adjust these via env vars if needed.
// Example: LLM_BASE_URL=http://127.0.0.1:1234/v1 LLM_MODEL=smollm3-3b LLM_MAX_TOKENS=4096 npm start
const llmBaseUrl = process.env.LLM_BASE_URL || "http://127.0.0.1:1234/v1";
const llmModel = process.env.LLM_MODEL || "smollm3-3b";
const llmMaxTokens =
  process.env.LLM_MAX_TOKENS != null
    ? Number(process.env.LLM_MAX_TOKENS)
    : 4096;

const fsp = fs.promises;
const ROOT = path.resolve(__dirname, "..", "..");
const CHARACTERS_DIR = path.join(ROOT, "characters");
const THINK_START = "<think>";
const THINK_END = "</think>";

/**
 * Small helper to safely call a boolean-returning method on a chess.js
 * instance. If the method is missing or throws, this returns false.
 *
 * @param {import("chess.js").Chess} chess
 * @param {string} methodName
 * @returns {boolean}
 */
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

/**
 * Build a human-readable summary of where each piece is located on the
 * board. This is intended as ground truth for the LLM, so it doesn't have
 * to (and must not) decode the FEN itself.
 *
 * Example output:
 *   Piece placements:
 *   White: King: e1; Queens: d1; Rooks: a1 h1; Bishops: c1 f1; Knights: b1 g1; Pawns: a2 b2 ...
 *   Black: King: e8; Queens: d8; Rooks: a8 h8; Bishops: c8 f8; Knights: b8 g8; Pawns: a7 b7 ...
 *
 * @param {import("chess.js").Chess} chess
 * @returns {string}
 */
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
    const rank = 8 - rankIndex; // chess.js board()[0] is the 8th rank.
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

/**
 * Derive high-level game status (e.g., checkmate, stalemate, draw, ongoing),
 * the list of legal moves for the side to move, and a summary of piece
 * placements, based on a chess.js position.
 *
 * This information is fed into ENGINE_STATE so the LLM can:
 * - Recognize that the game is already over for checkmates/stalemates.
 * - Restrict suggested moves to those that are actually legal.
 * - Talk about where pieces are without having to decode FEN.
 *
 * @param {import("chess.js").Chess} chess
 * @returns {{ gameStatus: string, legalMovesSan: string[], piecePlacement: string }}
 */
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

function splitSmolReasoning(text) {
  if (!text || typeof text !== "string") {
    return { reasoning: "", answer: text || "" };
  }

  const start = text.indexOf(THINK_START);
  const end = text.indexOf(THINK_END);

  if (start === -1 || end === -1 || end < start) {
    return { reasoning: "", answer: text.trim() };
  }

  const reasoning = text
    .slice(start + THINK_START.length, end)
    .trim();

  const answer = (
    text.slice(0, start) +
    text.slice(end + THINK_END.length)
  ).trim();

  return { reasoning, answer };
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
    // In chess.js v1.x, loadPgn throws on error and does not return a boolean.
    // We rely on the absence of an exception to indicate success.
    chess.loadPgn(normalized, { strict: false });
  } catch (err) {
    // eslint-disable-next-line no-console
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

/**
 * Build a sequence of positions (FENs) corresponding to each half-move in the
 * loaded PGN, starting from the initial position.
 *
 * The first entry (index 0) is the starting position before any moves.
 * Each subsequent entry (index n) is the position after n half-moves.
 *
 * This is used by the web UI to step through the game move-by-move without
 * needing chess.js in the browser.
 *
 * @param {import("chess.js").Chess} chess
 * @returns {Array<{ index: number, fen: string, ply: number, san: string | null, moveNumber: number, color: string }>}
 */
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
    // Fallback: if the custom FEN is invalid, fall back to default start.
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

  // Starting position before any moves.
  positions.push({
    index: 0,
    fen: replay.fen(),
    ply: 0,
    san: null,
    moveNumber: 0,
    color: replay.turn && replay.turn() === "w" ? "White" : "Black",
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

    positions.push({
      index: i + 1,
      fen: replay.fen(),
      ply: i + 1,
      san,
      moveNumber,
      color,
    });
  }

  return positions;
}

function normalizeId(rawId) {
  const id = String(rawId || "").trim();
  if (!id) return "";
  // Keep it simple: only allow a-zA-Z0-9_- in file-based id.
  return id.replace(/[^A-Za-z0-9_\-]/g, "_");
}

async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (_) {
    // ignore
  }
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

  return lines.join("\n");
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, "public")));

// Lightweight helper endpoint: parse a PGN and return the final position.
// This lets the front-end render a board preview without bundling chess.js.
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
    // eslint-disable-next-line no-console
    console.error("Error in /api/pgn/final-position:", err);
    res.status(500).json({
      error: "Failed to parse PGN.",
      details: err.message,
    });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { pgnText, message, personalityId, reasoningEffort } = req.body || {};

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

    const fen = chess.fen();
    const sideToMove = chess.turn() === "w" ? "White" : "Black";
    const history = chess.history();
    const moveHistory = history.join(" ");

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

    const engineStateBlock = buildEngineStateBlock(engineState);

    const userQuestion =
      typeof message === "string" && message.trim().length > 0
        ? message.trim()
        : "";

    const userContent = buildUserContent(engineStateBlock, userQuestion);
    const systemPrompt = await buildSystemPrompt(personalityId, reasoningEffort);

    const effort = normalizeReasoningEffort(reasoningEffort);

    // Responses API: flatten system + user into a single input string.
    const fullPrompt = [systemPrompt, "", userContent].join("\n\n");

    const payload = {
      model: llmModel,
      input: fullPrompt,
      max_output_tokens: Number.isFinite(llmMaxTokens) ? llmMaxTokens : -1,
      temperature: 0.6,
      top_p: 0.95,
    };

    if (effort) {
      payload.reasoning = { effort };
    }

    const url = `${llmBaseUrl.replace(/\/+$/, "")}/responses`;

    const response = await axios.post(url, payload, { timeout: 60000 });
    const data = response.data;

    // Extract answer and reasoning from Responses-style payloads.
    let answerText = "";
    let reasoningText = "";

    if (data) {
      // Preferred: Responses API output array.
      if (Array.isArray(data.output)) {
        for (const out of data.output) {
          if (!out || !Array.isArray(out.content)) continue;
          for (const part of out.content) {
            if (part && typeof part.text === "string") {
              answerText += part.text;
            } else if (part && typeof part.content === "string") {
              answerText += part.content;
            }
          }
        }
      }

      // Top-level reasoning container (OpenAI/LM Studio style).
      if (data.reasoning) {
        const r = data.reasoning;
        if (typeof r.text === "string") {
          reasoningText += r.text;
        }
        if (Array.isArray(r.content)) {
          for (const part of r.content) {
            if (part && typeof part.text === "string") {
              reasoningText += part.text;
            }
          }
        }
      }

      // Fallback: some servers may expose reasoning_content/content at top-level.
      if (!reasoningText && typeof data.reasoning_content === "string") {
        reasoningText = data.reasoning_content;
      }
      if (!answerText && typeof data.content === "string") {
        answerText = data.content;
      }
    }

    // Final fallback: if the server still embeds <think>...</think> inside
    // the visible text, split it out.
    if (!reasoningText) {
      const split = splitSmolReasoning(answerText);
      reasoningText = split.reasoning;
      answerText = split.answer;
    }

    res.json({ reply: answerText, reasoning: reasoningText });
  } catch (err) {
    console.error("Error in /api/chat:", err.response?.data || err.message);
    res.status(500).json({
      error: "LLM request failed.",
      details: err.message,
    });
  }
});

// Streaming variant: sentence-buffered reply, similar to the Unity integration.
// Protocol: newline-delimited JSON objects with shape:
// { "type": "typing", "state": "start" | "end" }
// { "type": "sentence", "text": "..." }
// { "type": "error", "message": "..." }
app.post("/api/chat/stream", async (req, res) => {
  try {
    const { pgnText, message, personalityId, reasoningEffort } = req.body || {};

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

    const fen = chess.fen();
    const sideToMove = chess.turn() === "w" ? "White" : "Black";
    const history = chess.history();
    const moveHistory = history.join(" ");

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

    const engineStateBlock = buildEngineStateBlock(engineState);

    const userQuestion =
      typeof message === "string" && message.trim().length > 0
        ? message.trim()
        : "";

    const userContent = buildUserContent(engineStateBlock, userQuestion);
    const systemPrompt = await buildSystemPrompt(personalityId, reasoningEffort);

    const effort = normalizeReasoningEffort(reasoningEffort);

    const fullPrompt = [systemPrompt, "", userContent].join("\n\n");

    const payload = {
      model: llmModel,
      input: fullPrompt,
      max_output_tokens: Number.isFinite(llmMaxTokens) ? llmMaxTokens : -1,
      temperature: 0.6,
      top_p: 0.95,
      stream: true,
    };

    if (effort) {
      payload.reasoning = { effort };
    }

    const url = `${llmBaseUrl.replace(/\/+$/, "")}/responses`;

    // Set up chunked response to the browser.
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");

    const upstream = await axios.post(url, payload, {
      responseType: "stream",
      timeout: 0,
    });

    let sseBuffer = "";
    let sentenceBuffer = "";
    let fullAnswer = "";
    let reasoningBuffer = "";
    let firstDeltaSeen = false;
    let reasoningStreamed = false;
    let ended = false;

    function writeEvent(obj) {
      try {
        res.write(JSON.stringify(obj) + "\n");
      } catch (e) {
        // Ignore write errors (e.g., client disconnected).
      }
    }

    function flushSentenceIfAny() {
      const raw = sentenceBuffer;
      if (!raw) return;
      if (!/\S/.test(raw)) {
        sentenceBuffer = "";
        return;
      }
      writeEvent({ type: "sentence", text: raw });
      sentenceBuffer = "";
    }

    function isSentenceTerminator(ch) {
      return ch === "." || ch === "!" || ch === "?";
    }

    function handleVisibleDelta(deltaText) {
      if (!deltaText) return;

      if (!firstDeltaSeen) {
        firstDeltaSeen = true;
        writeEvent({ type: "typing", state: "start" });
      }

      for (const ch of deltaText) {
        sentenceBuffer += ch;
        if (isSentenceTerminator(ch)) {
          flushSentenceIfAny();
        }
      }
    }

    function handleResponsesEvent(evt) {
      if (!evt || typeof evt !== "object") return;
      const type = typeof evt.type === "string" ? evt.type : "";

      // Text deltas for the visible answer.
      if (type.includes("output_text.delta")) {
        let deltaText = "";

        if (typeof evt.delta === "string") {
          // LM Studio often uses a bare string for output_text.delta.
          deltaText = evt.delta;
        } else if (evt.delta && typeof evt.delta.text === "string") {
          deltaText = evt.delta.text;
        } else if (evt.delta && typeof evt.delta.output_text === "string") {
          deltaText = evt.delta.output_text;
        }

        if (!deltaText) return;

        fullAnswer += deltaText;
        handleVisibleDelta(deltaText);
        return;
      }

      // Reasoning text (may arrive as a string delta, an object with .text,
      // or as a final event with a full text field).
      if (type.includes("reasoning")) {
        let textChunk = "";

        if (typeof evt.delta === "string") {
          // LM Studio often uses a bare string for reasoning_text.delta.
          textChunk = evt.delta;
        } else if (evt.delta && typeof evt.delta.text === "string") {
          textChunk = evt.delta.text;
        } else if (typeof evt.text === "string") {
          textChunk = evt.text;
        }

        if (!textChunk) return;

        reasoningBuffer += textChunk;
        // Stream reasoning incrementally to the dev console.
        writeEvent({ type: "reasoning", text: textChunk });
        reasoningStreamed = true;
        return;
      }
    }

    upstream.data.on("data", (chunk) => {
      if (ended) return;

      sseBuffer += chunk.toString("utf8");

      let newlineIndex;
      while ((newlineIndex = sseBuffer.indexOf("\n")) >= 0) {
        let line = sseBuffer.slice(0, newlineIndex);
        sseBuffer = sseBuffer.slice(newlineIndex + 1);

        line = line.trimEnd();
        if (!line) continue;

        if (!line.toLowerCase().startsWith("data:")) continue;

        const dataPart = line.slice("data:".length).trim();
        if (dataPart === "[DONE]") {
          ended = true;
          flushSentenceIfAny();
          writeEvent({ type: "typing", state: "end" });
          res.end();
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(dataPart);
        } catch {
          continue;
        }

        handleResponsesEvent(parsed);
      }
    });

    upstream.data.on("end", () => {
      if (ended) return;
      ended = true;

      flushSentenceIfAny();
      writeEvent({ type: "typing", state: "end" });

      // Send reasoning (if any) as a dev-only event. If we've already streamed
      // reasoning chunks, avoid duplicating them here; otherwise, fall back to
      // a single aggregated event.
      if (!reasoningStreamed) {
        let reasoningText = reasoningBuffer;
        if (!reasoningText) {
          const split = splitSmolReasoning(fullAnswer);
          reasoningText = split.reasoning;
        }
        if (reasoningText) {
          writeEvent({ type: "reasoning", text: reasoningText });
        }
      }

      res.end();
    });

    upstream.data.on("error", (err) => {
      if (ended) return;
      ended = true;
      writeEvent({
        type: "error",
        message: "Upstream LLM stream error: " + err.message,
      });
      writeEvent({ type: "typing", state: "end" });
      res.end();
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
      } catch {
        // Ignore.
      }
    }
  }
});

async function buildSystemPrompt(personalityId, reasoningEffort) {
  const harness = [
    "You are an in-browser chess coach assisting a human player.",
    "You MUST only talk about chess positions and moves given in the ENGINE_STATE block.",
    "You must not discuss real-world topics, politics, religion, or other sensitive content.",
    "You must always use PG-13 language and avoid profanity, slurs, or explicit content.",
    "If the player asks about anything non-chess, politely refuse and steer the discussion back to chess.",
    "",
  ].join("\n");

  const coachCore = [
    "You are a chess commentator that knows as little chess as possible.",
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
    "",
  ].join("\n");

  let personalityBlock = "";
  if (personalityId) {
    try {
      const profile = await loadCharacterProfile(personalityId);
      personalityBlock = buildPersonalityPrompt(profile);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "Failed to load personality profile for LLM coach:",
        err && err.message ? err.message : err
      );
    }
  }

  const sections = [harness, coachCore, personalityBlock];

  // If the caller requested explicit reasoning effort, nudge SmolLM3 into
  // its thinking mode. The web layer still strips out <think>...</think>
  // from the player-facing answer and only surfaces it in the dev panel.
  const effort = normalizeReasoningEffort(reasoningEffort);
  if (effort) {
    sections.push("Reasoning mode: /think");
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

/**
 * Serialize an engine state object into the ENGINE_STATE text block expected by the LLM.
 *
 * This mirrors the C# SerializeEngineState implementation in docs/llm.md:
 * - Side to move
 * - Current FEN
 * - Evaluation in centipawns for the side to move
 * - Optional evaluation comment
 * - Optional recent moves
 * - Optional top lines with move, eval in pawns, PV, and depth
 *
 * @param {Object} engineState
 * @param {string} engineState.fen
 * @param {string} engineState.sideToMove
 * @param {number} [engineState.centipawnEval]
 * @param {string} [engineState.evalComment]
 * @param {Array<Object>} [engineState.topLines]
 * @param {string} [engineState.moveHistory]
 * @returns {string}
 */
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
    parts.push(
      "Explain the evaluation, the main plan for the side to move, and typical tactical ideas for both sides."
    );
  }

  return parts.join("\n");
}

app.get("/api/personalities", async (req, res) => {
  try {
    const list = await listCharacters();
    res.json(list);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Error in /api/personalities:", err);
    res.status(500).json({
      error: "Failed to load personalities.",
    });
  }
});

app.listen(port, () => {
  console.log(`LLM coach web listening on http://localhost:${port}`);
});
