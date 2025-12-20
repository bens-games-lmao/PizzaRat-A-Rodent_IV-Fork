const path = require("path");
const { app, BrowserWindow, ipcMain } = require("electron");
const {
  loadCharacterList,
  loadCharacter,
  characterToSetoptionScriptNoTaunts
} = require("./characterConfig");
const { runEngineMove } = require("./rodentEngineBridge");

let mainWindow = null;
let currentProfile = null;
let currentPlayerColor = "white";

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: "Cozy Chess",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js")
    }
  });

  if (app.isPackaged) {
    const indexPath = path.join(__dirname, "..", "dist", "index.html");
    void mainWindow.loadFile(indexPath);
  } else {
    void mainWindow.loadURL("http://localhost:5173");
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("ready", () => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("cozy:listCharacters", async () => {
  try {
    return await loadCharacterList();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to load character list:", err);
    return [];
  }
});

ipcMain.handle("cozy:getCharacter", async (_event, id) => {
  try {
    return await loadCharacter(id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to load character:", err);
    throw err;
  }
});

ipcMain.handle("cozy:startNewGame", async (_event, options) => {
  const { profile, playerColor } = options || {};
  currentProfile = profile || null;
  currentPlayerColor = playerColor === "black" ? "black" : "white";
});

ipcMain.handle("cozy:requestEngineMove", async (_event, payload) => {
  const { fen, sideToMove, targetElo } = payload || {};

  const profile = currentProfile;
  let setoptionScript = "";
  let effectiveElo = targetElo;

  if (profile) {
    try {
      setoptionScript = characterToSetoptionScriptNoTaunts(profile);
      if (
        !effectiveElo &&
        profile.strength &&
        typeof profile.strength.targetElo === "number"
      ) {
        effectiveElo = profile.strength.targetElo;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Failed to build setoption script from profile:", err);
    }
  }

  try {
    const result = await runEngineMove({
      fen,
      sideToMove,
      targetElo: effectiveElo || null,
      setoptionScript
    });
    return result;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Engine move failed:", err);
    return { bestmove: null };
  }
});


