// Run with: electron scripts/smoke-settings-update.js
// Uses isolated settings and a fake download; never replaces or quits the user's app.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const output = path.join(__dirname, "..", "artifacts", "settings-update-smoke", String(Date.now()));
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "profile"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await pause(30); }
  throw new Error("Settings update condition timed out");
}
async function main() {
  const state = { appearance: { fontFamily: null, fontSize: 14, workMode: false },
    pets: [{ key: "default", label: "기본 펫 (내장)" }], petKey: "default", activityBubbleMode: "full", autoStart: false, providers: [], usage: [] };
  const release = { status: "available", currentVersion: "1.1.2", latestVersion: "1.1.3", automatic: true, update: { phase: "idle" } };
  let finish, calls = 0;
  ipcMain.handle("settings:get", () => ({ ok: true, data: state }));
  ipcMain.handle("settings:fonts", () => ({ ok: true, data: ["Arial"] }));
  ipcMain.handle("settings:check-update", () => release);
  ipcMain.handle("settings:download-update", () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const errors = [];
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, frame: false,
    webPreferences: { preload: path.join(__dirname, "..", "src", "settings-preload.js"),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  await win.loadFile(path.join(__dirname, "..", "src", "settings.html"));
  const js = source => win.webContents.executeJavaScript(source);
  await until(() => js("!document.querySelector('#download-update').hidden && state !== null"));
  assert.match(await js("document.querySelector('#download-update').title"), /업데이트 후 재시작/);
  await js("document.querySelector('#download-update').click(); document.querySelector('#download-update').click()");
  await until(() => Boolean(finish)); assert.equal(calls, 1);
  for (const width of [1000, 560]) {
    win.setSize(width, 800);
    win.webContents.send("settings:update-progress", { phase: "downloading", percent: 42 });
    await until(() => js("document.querySelector('#app-version').textContent === '다운로드 42%'"));
    await pause(150);
    assert.equal(await js("document.documentElement.scrollWidth > innerWidth"), false);
    assert.equal(await js("document.querySelector('#download-update').disabled"), true);
    const layout = await js(`(() => {
      const foot = document.querySelector('.sidebar-foot').getBoundingClientRect();
      const brand = document.querySelector('.brand-lockup > span:last-child').getBoundingClientRect();
      return { inside: foot.left >= 0 && foot.right <= innerWidth,
        overlap: foot.left < brand.right && foot.right > brand.left && foot.top < brand.bottom && foot.bottom > brand.top };
    })()`);
    assert.equal(layout.inside, true); assert.equal(layout.overlap, false);
    fs.writeFileSync(path.join(output, `downloading-${width}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  }
  finish({ ok: false, error: "다운로드를 완료하지 못했습니다. 다시 시도해 주세요." });
  await until(() => js("!document.querySelector('#download-update').disabled"));
  assert.equal(await js("document.querySelector('#app-version').textContent"), "VERSION 1.1.2");
  await js("document.querySelector('#download-update').click()");
  await until(() => calls === 2);
  finish({ ok: true, restarting: true });
  await until(() => js("document.querySelector('#app-version').textContent === '재시작 중…'"));
  assert.equal(await js("document.querySelector('#download-update').disabled"), true);
  assert.deepEqual(errors, []);
  win.destroy();
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ passed: true, widths: [1000, 560], calls, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, output }));
  app.quit();
}
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1); });
