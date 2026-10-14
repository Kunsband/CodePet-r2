const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("usageApi", {
  get: () => ipcRenderer.invoke("usage-monitor:get"),
  refresh: () => ipcRenderer.invoke("usage-monitor:refresh"),
  action: (action) => ipcRenderer.send("usage-monitor:action", action),
  onUpdate: (handler) => {
    const listener = (_event, value) => handler(value);
    ipcRenderer.on("usage-monitor:update", listener);
    return () => ipcRenderer.removeListener("usage-monitor:update", listener);
  },
});
