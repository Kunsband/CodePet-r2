// Run with: electron scripts/smoke-usage-ui.js
// Synthetic data only. Does not start watchers, read credentials, or change settings.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const electron = require("electron");
const { app, BrowserWindow } = electron;
const { createUsageWindows } = require("../src/usage-windows");
const output = path.join(__dirname, "..", "artifacts", "usage-smoke");
app.setPath("userData", path.join(output, "electron-profile"));
app.disableHardwareAcceleration();
const pause = () => new Promise((resolve) => setTimeout(resolve, 80));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await pause(); }
  throw new Error("UI condition timed out");
}
async function run() {
  fs.mkdirSync(output, { recursive: true });
  let settings = { usageBarVisible: false };
  let settingsOpened = false;
  let nativeBar, clickBar;
  const monitor = new EventEmitter();
  let rows = [
    { id: "codex", label: "Codex", account: "demo@example.com", plan: "Pro", connected: true, updatedAt: Date.now(),
      gauges: [{ label: "5시간", usedPercent: 24, resetText: "2026-10-15T09:00:00Z" }, { label: "주간", usedPercent: 73, resetText: "2026-10-20T09:00:00Z" }] },
    { id: "agy", label: "AGY", account: "demo@example.com", plan: "Antigravity", connected: true, updatedAt: Date.now(),
      gauges: [{ label: "Gemini Models · Weekly Limit Remaining", usedPercent: 46 }] },
    { id: "claude", label: "Claude", account: "demo@example.com", connected: true, stale: true, error: "조회 불가", updatedAt: Date.now() - 600000,
      gauges: [{ label: "5시간", usedPercent: 92 }, { label: "7일", usedPercent: 59 }] },
    { id: "grok", label: "Grok", connected: false, error: "로그인 필요", gauges: [] },
  ];
  monitor.snapshot = () => ({ providers: rows, intervalMs: 60000 });
  monitor.start = monitor.stop = () => {};
  monitor.refresh = async () => monitor.emit("update", monitor.snapshot());
  monitor.invalidate = monitor.refresh;
  const feature = createUsageWindows({ electron, monitor, readSettings: () => settings,
    writeSettings: (patch) => { settings = { ...settings, ...patch }; }, openSettings: () => { settingsOpened = true; },
    taskbarFactory: ({ onClick }) => { clickBar = onClick; nativeBar = { update(value) { this.value = value; }, setVisible(value) { this.visible = value; }, resetPosition() {}, dispose() {} }; return nativeBar; } });
  const windows = () => BrowserWindow.getAllWindows();
  assert.equal(nativeBar.visible, true, "Hiding the old overlay must not hide the taskbar widget");
  assert.equal(windows().length, 0, "No floating usage BrowserWindow may be created");
  const errors = [];
  const watchErrors = (win) => {
    win.webContents.on("console-message", (_event, level, message) => { if (level === 3) errors.push(message); });
    win.webContents.on("render-process-gone", (_event, details) => errors.push(details.reason));
  };
  clickBar({ x: 1400, y: 1032, width: 227, height: 48 });
  await until(() => windows().length === 1);
  const popup = windows()[0]; watchErrors(popup);
  await until(() => !popup.webContents.isLoading() && popup.isVisible());
  await until(() => popup.webContents.executeJavaScript("document.querySelectorAll('progress').length === 5"));
  for (const width of [380, 300]) {
    popup.setBounds({ ...popup.getBounds(), width, height: 560 }); await pause();
    const layout = await popup.webContents.executeJavaScript(`({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
      footer: document.querySelector('footer').getBoundingClientRect().bottom > innerHeight,
      error: document.body.innerText.includes('이전 조회값'), progress: document.querySelectorAll('progress').length })`);
    assert.equal(layout.overflow, false); assert.equal(layout.footer, false); assert.equal(layout.error, true); assert.equal(layout.progress, 5);
    fs.writeFileSync(path.join(output, `popup-${width}.png`), (await popup.webContents.capturePage()).toPNG());
  }
  await popup.webContents.executeJavaScript("document.getElementById('refresh').click()"); await pause();
  await popup.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  await until(() => !popup.isVisible());
  feature.togglePopup(); await until(() => popup.isVisible());
  await popup.webContents.executeJavaScript("document.getElementById('accounts').click()");
  await until(() => settingsOpened); assert.equal(popup.isVisible(), false);
  rows = [{ id: "codex", label: "Codex", connected: false, error: "로그인 필요", gauges: [] }];
  monitor.emit("update", monitor.snapshot()); await pause();
  assert.equal(nativeBar.value.providers[0].connected, false);
  feature.toggleBar(); assert.equal(nativeBar.visible, false); assert.equal(settings.taskbarUsageVisible, false);
  feature.toggleBar(); assert.equal(nativeBar.visible, true); assert.equal(settings.taskbarUsageVisible, true);
  assert.deepEqual(errors, []);
  feature.dispose();
  console.log("PASS: no overlay window, native click callback, real Electron popup/preload/IPC, refresh, Escape, accounts, hide/show, 380/300px overflow, stale/empty states; no renderer errors.");
  app.quit();
}
app.whenReady().then(run).catch((error) => { console.error(error); app.exit(1); });
