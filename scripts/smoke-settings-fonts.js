// Run with: electron scripts/smoke-settings-fonts.js
// Reads installed font names; settings and save operations use isolated fixtures.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { getInstalledFonts } = require("../src/installed-fonts");
const output = path.join(__dirname, "..", "artifacts", "settings-fonts-smoke", String(Date.now()));
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "profile"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await pause(30); }
  throw new Error("Settings condition timed out");
}
async function main() {
  const fonts = await getInstalledFonts();
  if (!fonts.length) fonts.push("Arial");
  const originalFont = fonts.at(-1);
  const state = { appearance: { fontFamily: originalFont, fontSize: 14, workMode: false },
    pets: [{ key: "default", label: "기본 펫 (내장)" }], petKey: "default",
    activityBubbleMode: "full", autoStart: false, providers: [], usage: [] };
  let releaseFonts, saved;
  ipcMain.handle("settings:get", () => ({ ok: true, data: state }));
  ipcMain.handle("settings:fonts", () => new Promise(resolve => { releaseFonts = resolve; }));
  ipcMain.handle("settings:save", (_event, value) => {
    saved = value; state.appearance.fontFamily = value.fontFamily;
    state.appearance.fontSize = value.fontSize;
    return { ok: true, data: state };
  });
  const errors = [];
  const makeWindow = async () => {
    const win = new BrowserWindow({ show: false, width: 1000, height: 800, frame: false,
      webPreferences: { preload: path.join(__dirname, "..", "src", "settings-preload.js"),
        contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
    await win.loadFile(path.join(__dirname, "..", "src", "settings.html"));
    return win;
  };
  const win = await makeWindow();
  const js = source => win.webContents.executeJavaScript(source);
  await until(() => js("state !== null"));
  assert.equal(await js("fontsReady"), false);
  assert.equal(await js("fontSelect.value"), originalFont);
  await js("fontSizeInput.value = '16'; fontSizeInput.dispatchEvent(new Event('input')); document.querySelector('#save').click()");
  await until(() => Boolean(saved));
  assert.equal(saved.fontFamily, originalFont);
  assert.equal(saved.fontSize, 16);
  await js("window.frames=[]; window.previousFrame=performance.now(); window.recordFrames=true; requestAnimationFrame(function frame(t){frames.push(t-previousFrame);previousFrame=t;if(recordFrames)requestAnimationFrame(frame)})");
  releaseFonts({ ok: true, data: fonts });
  await until(() => js("fontsReady && fontSelect.options.length > 1"));
  await js("fontSelect.scrollIntoView({block:'center'})");
  await pause(300);
  const performance = await js("recordFrames=false; ({maxFrameMs:Math.max(...frames),over50:frames.filter(t=>t>50).length})");
  assert.equal(await js("fontSelect.options.length"), fonts.length + 1);
  assert.equal(await js("fontSelect.value"), originalFont);
  const styledCount = () => js("[...fontSelect.options].filter(option=>option.style.fontFamily).length");
  assert.ok(await styledCount() <= 12);
  await js("fontSelect.scrollTop=0");
  await until(() => js("!!fontSelect.options[1].style.fontFamily"));
  assert.ok(await styledCount() <= 12);
  await js("fontSelect.scrollTop=fontSelect.scrollHeight/2");
  if (fonts.length > 30) await until(() => js("!fontSelect.options[1].style.fontFamily"));
  assert.ok(await styledCount() <= 12);
  await js("fontSelect.focus()");
  for (const code of ["Home", "End"]) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: code });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: code });
    await pause(40);
  }
  assert.equal(await js("fontSelect.value"), originalFont);
  await js("fontSearch.value='__no_such_font__';fontSearch.dispatchEvent(new Event('input'))");
  await until(() => js("!!fontSelect.querySelector('option:disabled')"));
  assert.equal(await js("fontSelect.value"), originalFont);
  await js("fontSearch.value='';fontSearch.dispatchEvent(new Event('input'))");
  await until(() => js("!fontSelect.querySelector('option:disabled')"));
  await js("window.retainedOption=fontSelect.options[0];renderGeneral();renderGeneral();void 0");
  assert.equal(await js("fontSelect.options[0]===window.retainedOption"), true);
  await js("fontSelect.value='';fontSelect.dispatchEvent(new Event('change'));document.querySelector('#save').click()");
  await until(() => saved.fontFamily === null);
  for (const width of [1000, 560]) {
    win.setSize(width, 800); await pause(100);
    await js("fontSelect.scrollIntoView({block:'center'})"); await pause(100);
    assert.equal(await js("document.documentElement.scrollWidth > innerWidth"), false);
    fs.writeFileSync(path.join(output, `settings-${width}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  }
  win.destroy();
  state.appearance.fontFamily = originalFont;
  const failed = await makeWindow();
  const failedJs = source => failed.webContents.executeJavaScript(source);
  await until(() => failedJs("state !== null"));
  releaseFonts({ ok: false });
  await until(() => failedJs("fontsFailed"));
  assert.equal(await failedJs("selectedFont"), originalFont);
  assert.equal(await failedJs("fontSelect.value"), originalFont);
  failed.destroy();
  assert.deepEqual(errors, []);
  const report = { passed: true, installedFonts: fonts.length, performance, widths: [1000, 560], errors };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output }));
  app.quit();
}
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1); });
