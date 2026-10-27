const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = Object.freeze({
  GET: "settings:get",
  SAVE: "settings:save",
  FONTS: "settings:fonts",
  ACCOUNT: "settings:account",
  USAGE: "settings:usage",
  CHECK_UPDATE: "settings:check-update",
  DOWNLOAD_UPDATE: "settings:download-update",
  UPDATE_PROGRESS: "settings:update-progress",
  APPEARANCE: "appearance:update",
  NAVIGATE: "settings:navigate",
});

contextBridge.exposeInMainWorld("settingsApi", {
  get: () => ipcRenderer.invoke(CHANNELS.GET),
  save: (value) => ipcRenderer.invoke(CHANNELS.SAVE, value),
  fonts: () => ipcRenderer.invoke(CHANNELS.FONTS),
  account: (value) => ipcRenderer.invoke(CHANNELS.ACCOUNT, value),
  usage: () => ipcRenderer.invoke(CHANNELS.USAGE),
  checkUpdate: (force = false) => ipcRenderer.invoke(CHANNELS.CHECK_UPDATE, { force: force === true }),
  downloadUpdate: () => ipcRenderer.invoke(CHANNELS.DOWNLOAD_UPDATE),
  onUpdateProgress: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, value) => handler(value);
    ipcRenderer.on(CHANNELS.UPDATE_PROGRESS, listener);
    return () => ipcRenderer.removeListener(CHANNELS.UPDATE_PROGRESS, listener);
  },
  onAppearance: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, value) => handler(value);
    ipcRenderer.on(CHANNELS.APPEARANCE, listener);
    return () => ipcRenderer.removeListener(CHANNELS.APPEARANCE, listener);
  },
  onNavigate: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, section) => handler(section);
    ipcRenderer.on(CHANNELS.NAVIGATE, listener);
    return () => ipcRenderer.removeListener(CHANNELS.NAVIGATE, listener);
  },
  minimize: () => ipcRenderer.send("settings:minimize"),
  maximize: () => ipcRenderer.send("settings:maximize"),
  close: () => ipcRenderer.send("settings:close"),
  onMaximizedState: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, isMaximized) => handler(isMaximized);
    ipcRenderer.on("settings:maximized-state", listener);
    return () => ipcRenderer.removeListener("settings:maximized-state", listener);
  },
});
