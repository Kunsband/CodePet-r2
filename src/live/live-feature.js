const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { LiveService, publicError } = require('./live-service');

function createLiveFeature({ electron, root, getAccount, getAppearance, makeService, onWindowReady }) {
  const { BrowserWindow, ipcMain, powerMonitor } = electron;
  const page = pathToFileURL(path.join(__dirname, '..', 'live.html')).href;
  let window = null, service = null;
  const ensureService = () => {
    if (!service) {
      service = makeService ? makeService() : new LiveService({ root, getAccount });
      service.on('event', payload => { if (window && !window.isDestroyed()) window.webContents.send('live:event', payload); });
    }
    return service;
  };
  function authorized(event) {
    return !!window && !window.isDestroyed() && event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === page;
  }
  function openWindow() {
    if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); return; }
    const win = new BrowserWindow({
      width: 440, height: 560, minWidth: 300, minHeight: 480, frame: false, resizable: true,
      show: false, title: 'CodePet Live', backgroundColor: '#fafafa', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, '..', 'live-preload.js'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: 'persist:codepet-live' },
    });
    window = win;
    const session = win.webContents.session;
    const mediaAllowed = (contents, permission, details = {}) => contents === win.webContents &&
      permission === 'media' && win.webContents.getURL() === page &&
      (!details.mediaTypes || (details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio'))) &&
      (!details.mediaType || details.mediaType === 'audio');
    session.setPermissionCheckHandler((contents, permission, origin, details) => mediaAllowed(contents, permission, details));
    session.setPermissionRequestHandler((contents, permission, callback, details) => callback(mediaAllowed(contents, permission, details)));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('render-process-gone', () => service?.dispose());
    win.on('maximize', () => win.webContents.send('live:maximized', true));
    win.on('unmaximize', () => win.webContents.send('live:maximized', false));
    win.once('ready-to-show', () => { win.show(); win.focus(); onWindowReady?.(); });
    win.on('closed', () => {
      service?.dispose(); service = null;
      session.setPermissionCheckHandler(() => false);
      session.setPermissionRequestHandler((contents, permission, callback) => callback(false));
      if (window === win) window = null;
    });
    win.loadFile(path.join(__dirname, '..', 'live.html'));
  }
  function registerIpcHandlers() {
    const handle = (channel, fn) => ipcMain.handle(channel, async (event, input) => {
      if (!authorized(event)) return { ok: false, error: '허용되지 않은 Live 요청입니다.' };
      try { return { ok: true, data: await fn(input) }; }
      catch (error) { return { ok: false, error: publicError(error) }; }
    });
    handle('live:catalog', async input => ({ ...await ensureService().prepare(input?.refresh === true), appearance: getAppearance() }));
    handle('live:start', input => ensureService().start(input));
    handle('live:text', input => ensureService().text(input));
    handle('live:stop', input => service?.stop(input?.key));
    handle('live:window', action => {
      if (action === 'close') window.close();
      else if (action === 'minimize') window.minimize();
      else if (action === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
    });
    powerMonitor?.on('suspend', () => {
      if (window && !window.isDestroyed()) window.webContents.send('live:event', { type: 'suspended' });
      service?.dispose();
    });
  }
  return { openWindow, registerIpcHandlers, getWindow: () => window && !window.isDestroyed() ? window : null,
    shutdown: () => service?.dispose() };
}
module.exports = { createLiveFeature };
