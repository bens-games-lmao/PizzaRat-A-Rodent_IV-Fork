#!/usr/bin/env node

/**
 * Migration tool:
 *  - Iterates over personalities/*.txt (and characters.txt aliases)
 *  - For each personality, runs the Rodent engine, loads the personality,
 *    calls `characterjson`, and captures the JSON dump.
 *  - Writes characters/ID.json matching characters/schema.json.
 *
 * Run from repo root (or via `npm run migrate` from this directory).
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const childProcess = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const PERSONALITIES_DIR = path.join(ROOT, "personalities");
const CHARACTERS_DIR = path.join(ROOT, "characters");
const CHARACTERS_TXT = path.join(PERSONALITIES_DIR, "characters.txt");

function log(msg) {
  process.stderr.write(String(msg) + "\n");
}

function findEngineCommand() {
  const candidatesWin = [
    "rodent-iv-x64.exe",
    "rodent-iv-plain.exe",
    "rodent-iv-x32.exe"
  ];
  const candidatesUnix = [
    "rodentiii",
    "rodent-iv-plain",
    "rodent-iv-x64"
  ];

  const candidates = process.platform === "win32" ? candidatesWin : candidatesUnix;

  for (const name of candidates) {
    const full = path.join(ROOT, name);
    if (fs.existsSync(full)) {
      return full;
    }
  }

  throw new Error(
    "Could not find Rodent engine executable. " +
      "Expected one of: " +
      candidates.join(", ") +
      " in " +
      ROOT
  );
}

function extractCharacterJson(output) {
  // Fast path: try the widest JSON-looking slice from the first '{'
  // to the last '}' in the output. This should correspond to the
  // single CharacterProfile dump the engine prints.
  const firstBrace = output.indexOf("{");
  const lastBrace = output.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = output.slice(firstBrace, lastBrace + 1);
    try {
      const obj = JSON.parse(candidate);
      if (
        obj &&
        typeof obj === "object" &&
        obj.strength &&
        obj.books &&
        obj.time &&
        obj.taunts
      ) {
        return obj;
      }
    } catch (_) {
      // fall through to more defensive scanning below
    }
  }

  // Fallback: scan for any smaller JSON object blocks that might match
  // the expected CharacterProfile shape, in case the engine output
  // changes format or additional JSON snippets are printed.
  const re = /\{[\s\S]*?\}/g;
  let match;
  while ((match = re.exec(output))) {
    try {
      const obj = JSON.parse(match[0]);
      if (
        obj &&
        typeof obj === "object" &&
        obj.strength &&
        obj.books &&
        obj.time &&
        obj.taunts
      ) {
        return obj;
      }
    } catch (e) {
      // ignore JSON parse errors, keep scanning
    }
  }

  throw new Error("Failed to locate a valid CharacterProfile JSON block in engine output.");
}

function runEngineForPersonality(engineCmd, personalityFile) {
  return new Promise((resolve, reject) => {
    log(`Running engine for personality '${personalityFile}'...`);

    const proc = childProcess.spawn(engineCmd, [], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "inherit"]
    });

    const chunks = [];

    proc.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.on("exit", (code) => {
      if (code !== 0) {
        log(`Engine exited with code ${code} while processing ${personalityFile}`);
      }

      const buffer = Buffer.concat(chunks);

      // Try UTF-8 first; if that fails to yield a valid JSON block,
      // fall back to UTF-16LE, which is what the Windows build of
      // the engine currently uses for stdout.
      let lastError = null;
      for (const encoding of ["utf8", "utf16le"]) {
        try {
          const text = buffer.toString(encoding);
          const profile = extractCharacterJson(text);
          return resolve(profile);
        } catch (e) {
          lastError = e;
        }
      }

      reject(lastError || new Error("Failed to decode engine output."));
    });

    function send(line) {
      proc.stdin.write(line + "\n");
    }

    // Simple UCI session: init, load personality, dump JSON, quit.
    send("uci");
    send("isready");
    send(`setoption name PersonalityFile value ${personalityFile}`);
    send("isready");
    send("characterjson");
    send("quit");
  });
}

async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (_) {
    // ignore
  }
}

function sanitizeId(id) {
  return id.replace(/[^A-Za-z0-9_\-]/g, "_");
}

async function parseCharactersAliases() {
  const result = [];

  try {
    const raw = await fsp.readFile(CHARACTERS_TXT, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(";")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const alias = trimmed.slice(0, eq).trim();
      const fileName = trimmed.slice(eq + 1).trim();
      if (!alias || !fileName) continue;
      result.push({ alias, fileName });
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      throw e;
    }
  }

  return result;
}

async function migrateSingle(engineCmd, id, personalityFile) {
  const safeId = sanitizeId(id);
  const outPath = path.join(CHARACTERS_DIR, `${safeId}.json`);

  if (fs.existsSync(outPath)) {
    log(`Skipping '${id}' -> ${personalityFile} (characters/${safeId}.json already exists).`);
    return;
  }

  try {
    const profile = await runEngineForPersonality(engineCmd, personalityFile);

    // Normalise id / description for canonical storage.
    profile.id = safeId;
    if (
      !profile.description ||
      profile.description === "Default Rodent IV character profile"
    ) {
      profile.description = `Imported from ${personalityFile}`;
    }

    await fsp.writeFile(outPath, JSON.stringify(profile, null, 2) + "\n", "utf8");
    log(`Wrote ${path.relative(ROOT, outPath)}`);
  } catch (e) {
    log(
      `ERROR migrating '${id}' from '${personalityFile}': ` +
        (e && e.message ? e.message : String(e))
    );
  }
}

async function main() {
  await ensureDir(CHARACTERS_DIR);

  const engineCmd = findEngineCommand();
  log(`Using engine: ${engineCmd}`);

  const aliasMappings = await parseCharactersAliases();
  const seenFiles = new Set();

  // 1) Migrate aliases from personalities/characters.txt first.
  for (const { alias, fileName } of aliasMappings) {
    await migrateSingle(engineCmd, alias, fileName);
    seenFiles.add(fileName.toLowerCase());
  }

  // 2) Migrate any remaining personalities/*.txt that aren't covered by aliases.
  const entries = await fsp.readdir(PERSONALITIES_DIR, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const name = ent.name;
    const lower = name.toLowerCase();
    if (!lower.endsWith(".txt")) continue;
    if (lower === "characters.txt") continue;
    if (seenFiles.has(name.toLowerCase())) continue;

    const base = name.slice(0, -4); // strip .txt
    await migrateSingle(engineCmd, base, name);
  }

  log("Migration completed.");
}

main().catch((err) => {
  log(err && err.stack ? err.stack : String(err));
  process.exit(1);
});


