const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  const listener = (event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('liveApi', {
  catalog: refresh => ipcRenderer.invoke('live:catalog', { refresh: refresh === true }),
  chooseWorkspace: () => ipcRenderer.invoke('live:workspace:choose'),
  historyList: () => ipcRenderer.invoke('live:history:list'),
  historySelect: id => ipcRenderer.invoke('live:history:select', { id }),
  start: input => ipcRenderer.invoke('live:start', input),
  stop: key => ipcRenderer.invoke('live:stop', { key }),
  text: (key, text) => ipcRenderer.invoke('live:text', { key, text }),
  approval: (key, id, approve) => ipcRenderer.invoke('live:approval', { key, id, approve }),
  window: action => ipcRenderer.invoke('live:window', action),
  onEvent: callback => subscribe('live:event', callback),
  onAppearance: callback => subscribe('appearance:update', callback),
  onMaximized: callback => subscribe('live:maximized', callback),
});
