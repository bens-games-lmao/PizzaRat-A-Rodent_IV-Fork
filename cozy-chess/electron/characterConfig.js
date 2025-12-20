const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CHARACTERS_DIR = path.join(ROOT, "characters");

function normalizeId(rawId) {
  const id = String(rawId || "").trim();
  if (!id) return "";
  return id.replace(/[^A-Za-z0-9_\-]/g, "_");
}

async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch {
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
      elo
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

function characterToSetoptionScriptNoTaunts(character) {
  const c = character || {};
  const s = c.strength || {};
  const b = c.books || {};
  const t = c.time || {};

  const lines = [];

  function isNumber(x) {
    return typeof x === "number" && !Number.isNaN(x);
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

  return lines.join("\n");
}

module.exports = {
  loadCharacterList,
  loadCharacter,
  characterToSetoptionScriptNoTaunts
};


