#!/usr/bin/env node

/**
 * Character Manager HTTP service
 *
 * Responsibilities:
 *  - CRUD over characters/*.json (canonical CharacterProfile storage)
 *  - Export selected characters to personalities/*.txt using a setoption script
 *  - Optionally keep personalities/characters.txt aliases in sync
 *
 * By default this serves:
 *  - API under /api/characters
 *  - Static web editor from profiles/ (so you can open http://localhost:4000/)
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const Ajv = require("ajv");

const ROOT = path.resolve(__dirname, "..", "..");
const CHARACTERS_DIR = path.join(ROOT, "characters");
const PERSONALITIES_DIR = path.join(ROOT, "personalities");
const CHARACTERS_TXT = path.join(PERSONALITIES_DIR, "characters.txt");
const PROFILES_DIR = path.join(ROOT, "profiles");

const schema = require(path.join(CHARACTERS_DIR, "schema.json"));

const ajv = new Ajv({
  allErrors: true,
  strict: false
});
const validateProfile = ajv.compile(schema);

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(msg);
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

async function loadCharacterList() {
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
    } catch (e) {
      continue;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      log(`Skipping invalid JSON character file: ${filePath} (${e.message})`);
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
      fileName: ent.name
    });
  }

  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

async function loadCharacter(id) {
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

function assertValidProfile(profile) {
  const ok = validateProfile(profile);
  if (ok) return;
  const err = new Error("CharacterProfile JSON failed validation.");
  err.status = 400;
  err.details = validateProfile.errors || [];
  throw err;
}

async function saveCharacter(id, profile, opts) {
  const options = Object.assign({ overwrite: true }, opts || {});
  const safeId = normalizeId(id);
  if (!safeId) {
    const err = new Error("Invalid character id");
    err.status = 400;
    throw err;
  }

  await ensureDir(CHARACTERS_DIR);
  const filePath = path.join(CHARACTERS_DIR, `${safeId}.json`);

  if (!options.overwrite && fs.existsSync(filePath)) {
    const err = new Error("Character already exists");
    err.status = 409;
    throw err;
  }

  const profileCopy = Object.assign({}, profile, { id: safeId });
  assertValidProfile(profileCopy);
  await fsp.writeFile(filePath, JSON.stringify(profileCopy, null, 2) + "\n", "utf8");
  return profileCopy;
}

function createDefaultProfile(id) {
  const safeId = normalizeId(id) || "NewCharacter";
  return {
    id: safeId,
    description: `New character '${safeId}'`,
    strength: {
      targetElo: 1800,
      useWeakening: true,
      searchSkill: 10,
      selectivity: 175,
      slowMover: 100
    },
    books: {
      guideBookFile: "guide.bin",
      mainBookFile: "rodent.bin",
      maxGuideBookPly: -1,
      maxMainBookPly: -1,
      bookFilter: 20
    },
    time: {
      timePercentage: 100,
      timeNervousness: 50,
      blitzHustle: 50,
      minThinkTimePercent: 100
    },
    taunts: {
      enabled: true,
      tauntFile: "taunts.txt",
      intensity: 100,
      rudeness: 50,
      whenLosing: 50,
      userBlunderDelta: 200,
      engineBlunderDelta: 200,
      smallGainMin: 30,
      smallGainMax: 60,
      balanceWindow: 15,
      advantageThreshold: 50,
      winningThreshold: 100,
      crushingThreshold: 300
    }
  };
}

function characterToSetoptionScript(character) {
  const c = character || {};
  const s = c.strength || {};
  const b = c.books || {};
  const t = c.time || {};
  const ta = c.taunts || {};

  const lines = [];

  function isNumber(x) {
    return typeof x === "number" && !isNaN(x);
  }

  if (isNumber(s.targetElo)) {
    lines.push(`setoption name UCI_Elo value ${s.targetElo}`);
  }
  if (typeof s.useWeakening === "boolean") {
    lines.push(
      `setoption name UCI_LimitStrength value ${s.useWeakening ? "true" : "false"}`
    );
  }
  if (isNumber(s.searchSkill)) {
    lines.push(`setoption name SearchSkill value ${s.searchSkill}`);
  }
  if (isNumber(s.selectivity)) {
    lines.push(`setoption name Selectivity value ${s.selectivity}`);
  }
  if (isNumber(s.slowMover)) {
    lines.push(`setoption name SlowMover value ${s.slowMover}`);
  }

  if (b.guideBookFile) {
    lines.push(`setoption name GuideBookFile value ${b.guideBookFile}`);
  }
  if (b.mainBookFile) {
    lines.push(`setoption name MainBookFile value ${b.mainBookFile}`);
  }
  if (isNumber(b.maxMainBookPly) && b.maxMainBookPly >= 0) {
    lines.push(
      `; MaxMainBookPly currently driven via CharacterProfile only (not a direct UCI option)`
    );
  }
  if (isNumber(b.bookFilter)) {
    lines.push(`setoption name BookFilter value ${b.bookFilter}`);
  }

  if (isNumber(t.timePercentage)) {
    lines.push(`setoption name SlowMover value ${t.timePercentage}`);
  }
  if (isNumber(t.timeNervousness)) {
    lines.push(`setoption name TimeNervousness value ${t.timeNervousness}`);
  }
  if (isNumber(t.blitzHustle)) {
    lines.push(`setoption name BlitzHustle value ${t.blitzHustle}`);
  }
  if (isNumber(t.minThinkTimePercent)) {
    lines.push(`setoption name MinThinkTimePercent value ${t.minThinkTimePercent}`);
  }

  if (typeof ta.enabled === "boolean") {
    lines.push(`setoption name Taunting value ${ta.enabled ? "true" : "false"}`);
  }
  if (ta.tauntFile) {
    lines.push(`setoption name TauntFile value ${ta.tauntFile}`);
  }
  if (isNumber(ta.intensity)) {
    lines.push(`setoption name TauntIntensity value ${ta.intensity}`);
  }
  if (isNumber(ta.rudeness)) {
    lines.push(`setoption name TauntRudeness value ${ta.rudeness}`);
  }

  return lines.join("\n");
}

async function upsertCharactersAlias(alias, personalityFile) {
  const safeAlias = normalizeId(alias);
  if (!safeAlias) return;

  await ensureDir(PERSONALITIES_DIR);

  let lines = [];
  try {
    const raw = await fsp.readFile(CHARACTERS_TXT, "utf8");
    lines = raw.split(/\r?\n/);
  } catch (e) {
    if (e.code !== "ENOENT") {
      throw e;
    }
    lines = [
      "; PIZZARAT character aliases",
      "; Format: CharacterAlias=PersonalityFile",
      ""
    ];
  }

  const targetPrefix = `${safeAlias}=`;
  let found = false;

  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";")) return line;
    if (trimmed.startsWith(targetPrefix)) {
      found = true;
      return `${safeAlias}=${personalityFile}`;
    }
    return line;
  });

  if (!found) {
    updated.push(`${safeAlias}=${personalityFile}`);
  }

  await fsp.writeFile(CHARACTERS_TXT, updated.join("\n") + "\n", "utf8");
}

async function exportCharacterToPersonality(id, personalityFileName) {
  const character = await loadCharacter(id);
  const script = characterToSetoptionScript(character);

  const fileName = personalityFileName || `${normalizeId(id)}.txt`;
  const outPath = path.join(PERSONALITIES_DIR, fileName);

  await ensureDir(PERSONALITIES_DIR);
  await fsp.writeFile(outPath, script + "\n", "utf8");
  await upsertCharactersAlias(id, fileName);

  return {
    personalityFile: fileName,
    path: outPath,
    script
  };
}

async function start() {
  await ensureDir(CHARACTERS_DIR);

  const app = express();
  const port = process.env.CHARACTER_MANAGER_PORT || 4269;

  app.use(cors());
  app.use(express.json({ limit: "256kb" }));
  app.use(morgan("dev"));

  // --- API routes ---

  app.get("/api/characters", async (req, res, next) => {
    try {
      const list = await loadCharacterList();
      res.json(list);
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/characters/:id", async (req, res, next) => {
    try {
      const profile = await loadCharacter(req.params.id);
      res.json(profile);
    } catch (e) {
      if (e.code === "ENOENT") {
        res.status(404).json({ error: "Character not found" });
      } else {
        next(e);
      }
    }
  });

  app.post("/api/characters", async (req, res, next) => {
    try {
      const body = req.body || {};
      let id = body.id || req.query.id;
      if (!id) {
        id = `Character_${Date.now()}`;
      }
      const safeId = normalizeId(id);

      const profile =
        body && Object.keys(body).length > 0 ? body : createDefaultProfile(safeId);

      const stored = await saveCharacter(safeId, profile, { overwrite: false });
      res.status(201).json(stored);
    } catch (e) {
      if (e.status === 409) {
        res.status(409).json({ error: e.message });
      } else if (e.status === 400) {
        res.status(400).json({ error: e.message, details: e.details || [] });
      } else {
        next(e);
      }
    }
  });

  app.put("/api/characters/:id", async (req, res, next) => {
    try {
      const id = req.params.id;
      const body = req.body || {};
      const stored = await saveCharacter(id, body, { overwrite: true });
      res.json(stored);
    } catch (e) {
      if (e.status === 400) {
        res.status(400).json({ error: e.message, details: e.details || [] });
      } else {
        next(e);
      }
    }
  });

  app.delete("/api/characters/:id", async (req, res, next) => {
    try {
      const safeId = normalizeId(req.params.id);
      if (!safeId) {
        res.status(400).json({ error: "Invalid character id" });
        return;
      }

      const filePath = path.join(CHARACTERS_DIR, `${safeId}.json`);
      await fsp.unlink(filePath);
      res.status(204).end();
    } catch (e) {
      if (e.code === "ENOENT") {
        res.status(404).json({ error: "Character not found" });
      } else {
        next(e);
      }
    }
  });

  app.post("/api/characters/:id/copy", async (req, res, next) => {
    try {
      const sourceId = req.params.id;
      const sourceProfile = await loadCharacter(sourceId);

      let newId =
        (req.body && req.body.id) ||
        `${sourceId}_copy_${Math.floor(Math.random() * 10000)}`;
      newId = normalizeId(newId);

      const copyProfile = JSON.parse(JSON.stringify(sourceProfile));
      copyProfile.id = newId;

      const stored = await saveCharacter(newId, copyProfile, { overwrite: false });
      res.status(201).json(stored);
    } catch (e) {
      if (e.status === 409) {
        res.status(409).json({ error: e.message });
      } else if (e.code === "ENOENT") {
        res.status(404).json({ error: "Source character not found" });
      } else {
        next(e);
      }
    }
  });

  app.post("/api/characters/:id/export-txt", async (req, res, next) => {
    try {
      const id = req.params.id;
      const body = req.body || {};
      const personalityFileName = body.fileName;

      const result = await exportCharacterToPersonality(id, personalityFileName);
      res.json({
        personalityFile: result.personalityFile
      });
    } catch (e) {
      if (e.code === "ENOENT") {
        res.status(404).json({ error: "Character not found" });
      } else if (e.status === 400) {
        res.status(400).json({ error: e.message, details: e.details || [] });
      } else {
        next(e);
      }
    }
  });

  // Serve the web editor as static files.
  app.use("/", express.static(PROFILES_DIR));

  // Generic error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // eslint-disable-next-line no-console
    console.error(err && err.stack ? err.stack : err);
    res
      .status(err.status || 500)
      .json({ error: err.message || "Internal server error" });
  });

  app.listen(port, () => {
    log(`Character manager listening on http://localhost:${port}/`);
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});


