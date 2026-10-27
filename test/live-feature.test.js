const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { createLiveFeature } = require('../src/live/live-feature');
function fixture(t) {
  const handlers = new Map(), service = new EventEmitter(); let disposed = 0, prepared = 0;
  service.prepare = async force => { prepared++; return { refreshed: force }; };
  service.dispose = () => { disposed++; }; service.stop = async () => {};
  const powerMonitor = new EventEmitter();
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new EventEmitter();
      this.webContents.mainFrame = {}; this.webContents.send = () => {};
      this.webContents.session = { setPermissionCheckHandler: fn => { this.check = fn; }, setPermissionRequestHandler: fn => { this.permission = fn; } };
      this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; };
      this.webContents.getURL = () => this.webContents.mainFrame.url;
    }
    isDestroyed() { return false; }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    close() { this.emit('closed'); }
    isMinimized() { return false; }
    show() {} focus() {}
  }
  const feature = createLiveFeature({ electron: { BrowserWindow: Window, powerMonitor, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } },
    root: 'fixture', getAccount: () => ({}), getAppearance: () => ({ workMode: true }), makeService: () => service });
  t.after(() => feature.shutdown()); feature.registerIpcHandlers(); feature.openWindow();
  const win = feature.getWindow(), event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  return { feature, win, event, powerMonitor, invoke: (channel, input, caller = event) => handlers.get(channel)(caller, input),
    getDisposed: () => disposed, getPrepared: () => prepared };
}
test('Live IPC accepts only its exact local main frame and returns appearance with fresh catalog', async t => {
  const f = fixture(t);
  assert.equal((await f.invoke('live:catalog', {}, { ...f.event, sender: {} })).ok, false);
  assert.equal((await f.invoke('live:catalog', {}, { ...f.event, senderFrame: { url: f.event.senderFrame.url } })).ok, false);
  const expected = pathToFileURL(path.resolve('src/live.html')).href;
  f.event.senderFrame.url = 'https://untrusted.example'; assert.equal((await f.invoke('live:catalog')).ok, false);
  f.event.senderFrame.url = expected;
  assert.deepEqual(await f.invoke('live:catalog', { refresh: true }), { ok: true, data: { refreshed: true, appearance: { workMode: true } } });
  assert.equal(f.getPrepared(), 1);
  assert.equal(f.win.options.webPreferences.sandbox, true);
  assert.equal(f.win.options.webPreferences.contextIsolation, true);
});
test('only audio is allowed, navigation is blocked, suspend/close dispose the voice runtime', async t => {
  const f = fixture(t); await f.invoke('live:catalog');
  assert.equal(f.win.check(f.win.webContents, 'media', '', { mediaType: 'audio' }), true);
  assert.equal(f.win.check(f.win.webContents, 'media', '', { mediaType: 'video' }), false);
  assert.equal(f.win.check({}, 'media', '', { mediaType: 'audio' }), false);
  assert.equal(f.win.check(f.win.webContents, 'geolocation', '', {}), false);
  let approved;
  f.win.permission(f.win.webContents, 'media', value => { approved = value; }, { mediaTypes: ['audio', 'video'] });
  assert.equal(approved, false);
  assert.deepEqual(f.win.openHandler({ url: 'https://example.com' }), { action: 'deny' });
  let prevented = false; f.win.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }); assert.equal(prevented, true);
  f.powerMonitor.emit('suspend'); assert.equal(f.getDisposed(), 1);
  await f.invoke('live:window', 'close'); assert.equal(f.getDisposed(), 2); assert.equal(f.feature.getWindow(), null);
  assert.equal(f.win.check(f.win.webContents, 'media', '', { mediaType: 'audio' }), false);
});
