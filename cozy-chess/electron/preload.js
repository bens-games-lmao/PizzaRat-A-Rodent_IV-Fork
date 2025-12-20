const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cozyChess", {
  listCharacters: () => ipcRenderer.invoke("cozy:listCharacters"),
  getCharacter: (id) => ipcRenderer.invoke("cozy:getCharacter", id),
  startNewGame: (options) => ipcRenderer.invoke("cozy:startNewGame", options),
  requestEngineMove: (payload) => ipcRenderer.invoke("cozy:requestEngineMove", payload)
});


