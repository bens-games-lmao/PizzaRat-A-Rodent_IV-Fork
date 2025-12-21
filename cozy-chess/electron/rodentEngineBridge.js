const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");

const ENGINE_CONFIG_TABLE = [
  {
    maxElo: 1200,
    depth: 8
  },
  {
    maxElo: 1600,
    depth: 12
  },
  {
    maxElo: 2000,
    depth: 16
  },
  {
    maxElo: Infinity,
    depth: 20
  }
];

function pickEngineConfig(targetElo) {
  const elo =
    typeof targetElo === "number" && Number.isFinite(targetElo) ? targetElo : 1800;

  for (let i = 0; i < ENGINE_CONFIG_TABLE.length; i += 1) {
    const cfg = ENGINE_CONFIG_TABLE[i];
    if (elo <= cfg.maxElo) {
      return cfg;
    }
  }

  return ENGINE_CONFIG_TABLE[ENGINE_CONFIG_TABLE.length - 1];
}

function findEngineCommand() {
  const candidatesWin = [
    "PizzaRAT.exe",
    "rodent-iv-x64.exe",
    "rodent-iv-plain.exe",
    "rodent-iv-x32.exe"
  ];
  const candidatesUnix = ["rodentiii", "rodent-iv-plain", "rodent-iv-x64"];

  const candidates = process.platform === "win32" ? candidatesWin : candidatesUnix;

  // In packaged builds, ROOT will usually be the Electron resources directory
  // (where PizzaRAT.exe is copied). In dev, ROOT is the cozy-chess folder, while
  // the engine binaries may live one level up in the monorepo root. Check both.
  const searchRoots = [ROOT];
  const parentRoot = path.resolve(ROOT, "..");
  if (!searchRoots.includes(parentRoot)) {
    searchRoots.push(parentRoot);
  }

  for (const base of searchRoots) {
    for (const name of candidates) {
      const full = path.join(base, name);
      if (fs.existsSync(full)) {
        return full;
      }
    }
  }

  throw new Error(
    `Could not find Rodent engine executable. Expected one of: ${candidates.join(
      ", "
    )} in search roots: ${searchRoots.join(", ")}`
  );
}

function decodeEngineOutput(buffer) {
  let lastError = null;
  for (const encoding of ["utf8", "utf16le"]) {
    try {
      const text = buffer.toString(encoding);
      if (
        text.includes("uciok") ||
        text.includes("readyok") ||
        text.includes("bestmove")
      ) {
        return text;
      }
      if (!lastError) {
        return text;
      }
    } catch (e) {
      lastError = e;
    }
  }
  return buffer.toString("utf8");
}

function extractBestmove(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("bestmove")) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length >= 2) {
      const move = tokens[1];
      if (move && move !== "(none)") {
        return move;
      }
    }
  }
  return null;
}

async function runEngineMove({ fen, sideToMove, targetElo, setoptionScript }) {
  const engineCmd = findEngineCommand();
  const engineDir = path.dirname(engineCmd);
  const config = pickEngineConfig(targetElo);

  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(engineCmd, [], {
      cwd: engineDir,
      stdio: ["pipe", "pipe", "inherit"],
      // On Windows, prevent a console/cmd window from flashing when the engine runs.
      windowsHide: true
    });

    const chunks = [];

    proc.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.on("exit", () => {
      try {
        const buffer = Buffer.concat(chunks);
        const text = decodeEngineOutput(buffer);
        const bestmove = extractBestmove(text);
        resolve({ bestmove });
      } catch (e) {
        reject(e);
      }
    });

    function send(line) {
      try {
        proc.stdin.write(line + "\n");
      } catch {
        // ignore
      }
    }

    send("uci");
    send("isready");
    send("ucinewgame");

    if (setoptionScript && typeof setoptionScript === "string") {
      const lines = setoptionScript.split(/\r?\n/);
      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith(";")) continue;
        send(trimmed);
      }
    }

    send(`position fen ${fen}`);
    const depth = config && Number.isFinite(config.depth) ? config.depth : 12;
    void sideToMove;
    send(`go depth ${depth}`);
    send("quit");
  });
}

module.exports = {
  runEngineMove
};


