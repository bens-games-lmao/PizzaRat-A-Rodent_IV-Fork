#!/usr/bin/env node

// Simple CLI harness to run all PGNs in tools/llm/pgn through the
// LLM taunt pipeline (same as the web UI), without using the browser.
//
// For each *.pgn file in tools/llm/pgn, this script:
//   - Calls /api/taunt/stream on the local taunt server
//   - Captures the final taunt text, reasoning stream, and engine debug block
//   - Writes a .txt file alongside the PGNs containing the full output
//
// Defaults:
//   - Character: WSP_Hustler_1800
//   - Player color: white (player is White, LLM is Black)
//   - Reasoning effort: high
//   - LLM source: LAN (same model, hosted at 192.168.1.192:1234/v1)
//
// Usage (from tools/llm directory):
//   node pgnTestHarness.js
//
// The taunt web server must be running on http://127.0.0.1:4100
// (e.g., via `npm start` in tools/llm).

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const ROOT = path.resolve(__dirname, "..", "..");
const LLM_DIR = __dirname;
const PGN_DIR = path.join(LLM_DIR, "pgn");
const OUTPUT_DIR = path.join(PGN_DIR, "output");

// Base URL for the taunt server; override with TAUNT_BASE_URL if needed.
const TAUNT_BASE_URL =
  process.env.TAUNT_BASE_URL || "http://127.0.0.1:4100";

// Default harness settings.
const DEFAULT_CHARACTER_ID = "WSP_Hustler_1800";
const DEFAULT_PLAYER_COLOR = "white"; // player: White, LLM: Black
const DEFAULT_REASONING = "high";
// Prefer a LAN-hosted Responses server by default; override with LLM_SOURCE
// env var if you want "local" or "remote" instead.
const DEFAULT_LLM_SOURCE = process.env.LLM_SOURCE || "lan";
// Default LAN coordinates; override with LLM_LAN_HOST / LLM_LAN_PORT env vars.
const DEFAULT_LAN_HOST = process.env.LLM_LAN_HOST || "192.168.1.192";
const DEFAULT_LAN_PORT = process.env.LLM_LAN_PORT || "1234";
const DEFAULT_REMOTE_FALLBACK = false;

/**
 * Stream a single taunt request via /api/taunt/stream and write
 * results incrementally into an output file, while also collecting
 * a summary object for callers.
 *
 * @param {string} pgnText
 * @param {object} [options]
 * @param {string} options.outPath - Absolute path of the output file.
 * @param {string} [options.pgnFileName]
 * @returns {Promise<{
 *   tauntText: string,
 *   reasoningText: string,
 *   engineDebugText: string,
 *   errors: string[]
 * }>}
 */
async function runTauntForPgn(pgnText, options = {}) {
  const {
    outPath,
    pgnFileName = "(unknown PGN)",
    characterId = DEFAULT_CHARACTER_ID,
    playerColor = DEFAULT_PLAYER_COLOR,
    reasoningEffort = DEFAULT_REASONING,
    llmSource = DEFAULT_LLM_SOURCE,
    remoteFallback = DEFAULT_REMOTE_FALLBACK,
    lanHost = DEFAULT_LAN_HOST,
    lanPort = DEFAULT_LAN_PORT,
  } = options;

  if (!outPath) {
    throw new Error("outPath is required for runTauntForPgn.");
  }

  const url = `${TAUNT_BASE_URL.replace(/\/+$/, "")}/api/taunt/stream`;

  // Some LAN-hosted Responses servers (e.g., basic SmolLM builds) do not
  // support the "reasoning" field at all and will throw errors like:
  //   "No valid custom reasoning fields found ... Reasoning setting 'high'"
  // To avoid that, we disable explicit reasoning for LLM source "lan" by
  // default, unless the caller opts back in via LAN_REASONING env.
  let effectiveReasoningEffort = reasoningEffort;
  if (llmSource === "lan") {
    effectiveReasoningEffort =
      process.env.LAN_REASONING || "none";
  }

  const payload = {
    pgnText,
    tauntTargetSide: "player",
    playerColor,
    characterId,
    reasoningEffort: effectiveReasoningEffort,
    playerMessage: "",
    llmSource,
    lanHost,
    lanPort,
    remoteFallback,
  };

  const outStream = fs.createWriteStream(outPath, { encoding: "utf8" });

  // File header (mirrors the old summary header, but written up-front).
  outStream.write(`PGN file: ${pgnFileName}\n`);
  outStream.write(`Character: ${characterId}\n`);
  outStream.write(`Player color: ${playerColor}\n`);
  outStream.write(`Reasoning effort: ${effectiveReasoningEffort}\n`);
  outStream.write(`LLM source: ${llmSource}\n`);
  if (llmSource === "lan") {
    outStream.write(`LLM LAN host: ${lanHost || "(unset)"}:${lanPort || "(unset)"}\n`);
  }
  outStream.write("\n");

  let tauntSectionOpened = false;
  let reasoningSectionOpened = false;
  let engineDebugSectionOpened = false;

  let tauntText = "";
  let reasoningText = "";
  let engineDebugText = "";
  const errors = [];

  function openTauntSectionIfNeeded() {
    if (tauntSectionOpened) return;
    outStream.write("=== TAUNT (streamed) ===\n");
    tauntSectionOpened = true;
  }

  function openReasoningSectionIfNeeded() {
    if (reasoningSectionOpened) return;
    outStream.write("\n=== REASONING (dev-only, streamed) ===\n");
    reasoningSectionOpened = true;
  }

  function openEngineDebugSectionIfNeeded() {
    if (engineDebugSectionOpened) return;
    outStream.write("\n=== ENGINE DEBUG (descriptor + prompt) ===\n");
    engineDebugSectionOpened = true;
  }

  function finalizeFile() {
    const uniqueErrors = Array.from(new Set(errors)).filter(Boolean);
    outStream.write("\n=== ERRORS ===\n");
    if (uniqueErrors.length === 0) {
      outStream.write("(none)\n");
    } else {
      outStream.write(uniqueErrors.join("\n") + "\n");
    }
    outStream.end();
  }

  return new Promise((resolve, reject) => {
    let finished = false;

    function safeResolve(result) {
      if (finished) return;
      finished = true;
      try {
        finalizeFile();
      } catch (_) {
        // Ignore file finalization errors; the core result is still useful.
      }
      resolve(result);
    }

    function safeReject(err) {
      if (finished) return;
      finished = true;
      try {
        errors.push(
          err && err.message ? `Stream error: ${err.message}` : String(err)
        );
        finalizeFile();
      } catch (_) {
        // Ignore file finalization errors on rejection.
      }
      reject(err);
    }

    axios({
      method: "post",
      url,
      data: payload,
      responseType: "stream",
      timeout: 0,
    })
      .then((response) => {
        const stream = response.data;
        let buffer = "";

        stream.on("data", (chunk) => {
          buffer += chunk.toString("utf8");

          let newlineIndex;
          while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
            const rawLine = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);

            const line = rawLine.trim();
            if (!line) continue;

            let evt;
            try {
              evt = JSON.parse(line);
            } catch {
              // Ignore malformed JSON lines.
              continue;
            }

            if (!evt || typeof evt.type !== "string") continue;

            switch (evt.type) {
              case "sentence":
                if (typeof evt.text === "string" && evt.text.length > 0) {
                  openTauntSectionIfNeeded();
                  tauntText += evt.text;
                  outStream.write(evt.text);
                }
                break;
              case "reasoning":
                if (typeof evt.text === "string" && evt.text.length > 0) {
                  openReasoningSectionIfNeeded();
                  reasoningText += evt.text;
                  outStream.write(evt.text);
                }
                break;
              case "engine_debug":
                if (typeof evt.text === "string" && evt.text.length > 0) {
                  openEngineDebugSectionIfNeeded();
                  if (engineDebugText) {
                    engineDebugText += "\n\n";
                    outStream.write("\n\n");
                  }
                  engineDebugText += evt.text;
                  outStream.write(evt.text);
                }
                break;
              case "error":
                if (evt.message) {
                  const msg = String(evt.message);
                  errors.push(msg);
                }
                break;
              case "typing":
              default:
                // typing / unknown types are ignored for the harness.
                break;
            }
          }
        });

        stream.on("end", () => {
          safeResolve({
            tauntText: tauntText.trim(),
            reasoningText: reasoningText.trim(),
            engineDebugText: engineDebugText.trim(),
            errors,
          });
        });

        stream.on("error", (err) => {
          safeReject(err);
        });
      })
      .catch((err) => {
        // Connection / HTTP-level failure before we ever got a stream.
        errors.push(
          err && err.message
            ? `Request error: ${err.message}`
            : String(err)
        );
        try {
          finalizeFile();
        } catch (_) {
          // ignore
        }
        reject(err);
      });
  });
}

/**
 * Read all *.pgn files from the PGN_DIR.
 *
 * @returns {string[]} absolute file paths
 */
function listPgnFiles() {
  let entries;
  try {
    entries = fs.readdirSync(PGN_DIR, { withFileTypes: true });
  } catch (err) {
    console.error(
      `Failed to read PGN directory at ${PGN_DIR}: ${err.message}`
    );
    process.exitCode = 1;
    return [];
  }

  return entries
    .filter((ent) => ent.isFile() && ent.name.toLowerCase().endsWith(".pgn"))
    .map((ent) => path.join(PGN_DIR, ent.name));
}

/**
 * Ensure the output directory exists.
 */
function ensureOutputDir() {
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  } catch (err) {
    console.error(
      `Failed to create output directory at ${OUTPUT_DIR}: ${err.message}`
    );
  }
}

/**
 * Main entry point: process all PGNs and write out one .txt result
 * file per PGN into tools/llm/pgn/output.
 */
async function main() {
  console.log("PizzaRAT taunt PGN harness");
  console.log("---------------------------");
  console.log(`Root: ${ROOT}`);
  console.log(`PGN directory: ${PGN_DIR}`);
  console.log(`Output directory: ${OUTPUT_DIR}`);
  console.log(
    `Taunt server: ${TAUNT_BASE_URL} (override with TAUNT_BASE_URL env var)`
  );
  console.log(
    `Defaults: character=${DEFAULT_CHARACTER_ID}, playerColor=${DEFAULT_PLAYER_COLOR}, reasoning=${DEFAULT_REASONING}`
  );
  console.log(
    `LLM defaults: source=${DEFAULT_LLM_SOURCE}, LAN=${DEFAULT_LAN_HOST}:${DEFAULT_LAN_PORT}`
  );
  console.log("");

  ensureOutputDir();

  const pgnFiles = listPgnFiles();
  if (pgnFiles.length === 0) {
    console.log("No .pgn files found; nothing to do.");
    return;
  }

  for (const filePath of pgnFiles) {
    const fileName = path.basename(filePath);
    console.log(`Processing PGN: ${fileName} ...`);

    let pgnText;
    try {
      pgnText = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      console.error(
        `  Failed to read PGN file ${fileName}: ${err.message}`
      );
      continue;
    }

    try {
      const baseName = path.basename(fileName, path.extname(fileName));
      const outPath = path.join(OUTPUT_DIR, `${baseName}.taunt.txt`);

      await runTauntForPgn(pgnText, {
        outPath,
        pgnFileName: fileName,
        characterId: DEFAULT_CHARACTER_ID,
        playerColor: DEFAULT_PLAYER_COLOR,
        reasoningEffort: DEFAULT_REASONING,
        llmSource: DEFAULT_LLM_SOURCE,
        lanHost: DEFAULT_LAN_HOST,
        lanPort: DEFAULT_LAN_PORT,
        remoteFallback: DEFAULT_REMOTE_FALLBACK,
      });

      console.log(`  Wrote output to ${outPath}`);
    } catch (err) {
      const msgParts = [];
      msgParts.push(`  Taunt request failed for ${fileName}.`);
      if (err.code) {
        msgParts.push(`code=${err.code}`);
      }
      if (err.response && typeof err.response.status === "number") {
        msgParts.push(`HTTP ${err.response.status}`);
      }
      if (err.message) {
        msgParts.push(err.message);
      }
      console.error(msgParts.join(" "));
      console.error(
        "  Make sure the taunt server is running (npm start in tools/llm)."
      );
    }
  }
}

if (require.main === module) {
  // eslint-disable-next-line no-console
  main().catch((err) => {
    console.error("Fatal error in PGN harness:", err);
    process.exitCode = 1;
  });
}

