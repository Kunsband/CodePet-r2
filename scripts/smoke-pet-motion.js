// Run with Electron. Isolated Claude events -> real main handlers -> IPC -> real pet canvas.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { ClaudeWatcher, parseClaudeRow } = require("../src/claude-watcher");
const { applyActivityPrivacy } = require("../src/activity-bubble-state");
const { createPetMotionHarness } = require("./lib/pet-motion-harness");
const sourceRoot = process.env.CODEPET_SMOKE_APP_ROOT || path.join(__dirname, "..", "src");
const { releaseHiddenWindow } = require(path.join(sourceRoot, "idle-window-release"));
const output = path.join(__dirname, "..", "artifacts", "pet-motion-smoke", String(Date.now()));
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "electron-profile"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  let releaseConfig;
  const configReady = new Promise(resolve => { releaseConfig = resolve; });
  const spritePath = path.join(sourceRoot, "default-pet", "spritesheet.webp");
  ipcMain.handle("pet:get-app-config", async () => {
    await configReady;
    return { assetExists: true, spritePath, spriteVersionNumber: 2,
      spriteUrl: `data:image/webp;base64,${fs.readFileSync(spritePath).toString("base64")}`,
      windowWidth: 192, windowHeight: 208 };
  });
  const win = new BrowserWindow({ width: 192, height: 208, show: false, frame: false,
    webPreferences: { preload: path.join(sourceRoot, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  const js = script => win.webContents.executeJavaScript(script);
  async function until(predicate) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if (await predicate()) return; await pause(30); }
    throw new Error(`Timed out; evidence: ${output}`);
  }
  await win.loadFile(path.join(sourceRoot, "index.html"));
  const watcher = new ClaudeWatcher({ roots: [] });
  const h = createPetMotionHarness({ manualPaused: true, claudeWatcher: watcher, mainPath: path.join(sourceRoot, "main.js"),
    send: (channel, state) => win.webContents.send(channel, state) });
  h.context.registerExternalWatcher(watcher, "Claude");
  watcher.accept(parseClaudeRow({ sessionId: "motion-smoke", type: "assistant", message: {
    content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }],
  } }), Date.now());
  await pause(80); // Deliver activity before asynchronous sprite initialization finishes.
  releaseConfig();
  await until(() => js("!!spriteImage"));
  await pause(800);
  fs.writeFileSync(path.join(output, "command.png"), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  const report = { bubble: h.bubbles.at(-1), mainState: h.context.runtime.currentState,
    renderer: await js("({state:currentStateName, row:getPetState().cells[0]?.row, frames:getPetState().frames})") };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  assert.equal(report.bubble.title, "Claude 명령 실행 중");
  assert.equal(report.mainState, "running", output);
  assert.equal(report.renderer.state, "running", output);
  assert.equal(report.renderer.row, 7);

  const bubble = new BrowserWindow({ width: 390, height: 150, show: false, frame: false,
    webPreferences: { preload: path.join(sourceRoot, "bubble-preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  await bubble.loadFile(path.join(sourceRoot, "bubble.html"));
  bubble.webContents.send("bubble:update", applyActivityPrivacy(report.bubble, "status"));
  await until(async () => (await bubble.webContents.executeJavaScript("document.body.innerText")).includes("Claude 작업 중입니다."));
  fs.writeFileSync(path.join(output, "bubble.png"), (await bubble.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  const bubblePid = bubble.webContents.getOSProcessId();
  releaseHiddenWindow(bubble, { delayMs: 100 });
  await until(() => bubble.isDestroyed());
  await until(() => !app.getAppMetrics().some((entry) => entry.pid === bubblePid));

  const frames = new Set();
  for (let i = 0; i < 8; i++) {
    frames.add(await js("petCanvas.toDataURL()"));
    await pause(180);
  }
  assert.ok(frames.size >= 3, "working canvas must actually animate");
  win.webContents.send("pet:set-visible", false);
  await until(() => js("animationTimer === null"));
  const hiddenFrame = await js("currentFrame");
  await pause(600);
  assert.equal(await js("currentFrame"), hiddenFrame, "hidden pet must stop animation ticks");
  win.webContents.send("pet:set-state", "review");
  await until(() => js("currentStateName === 'review'"));
  assert.equal(await js("animationTimer"), null, "hidden activity must not restart animation");
  win.webContents.send("pet:set-visible", true);
  await until(() => js("animationTimer !== null"));
  win.webContents.send("pet:set-state", "running");
  await until(() => js("currentStateName === 'running'"));
  h.context.updateMovementTick();
  h.context.beginWalkingPhase();
  assert.deepEqual([h.context.runtime.x, h.context.runtime.y], [100, 100]);
  h.context.playReaction("waving");
  await until(() => js("currentStateName === 'waving'"));
  h.finishReaction();
  await until(() => js("currentStateName === 'running'"));
  h.context.runtime.currentState = "idle";
  h.context.startMovementLoop({ resetPosition: false });
  await until(() => js("currentStateName === 'running'"));
  watcher.accept(parseClaudeRow({ sessionId: "motion-smoke", type: "assistant", message: {
    content: [{ type: "text", text: "완료" }], stop_reason: "end_turn",
  } }), Date.now());
  await until(() => js("currentStateName === 'jumping'"));
  h.finishReaction();
  await until(() => js("currentStateName === 'idle'"));
  await pause(100);
  fs.writeFileSync(path.join(output, "complete.png"), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  assert.deepEqual(errors, []);
  Object.assign(report, { passed: true, sourceRoot, distinctFrames: frames.size, fixedPosition: true,
    reactionRestored: true, hiddenAnimationStopped: true, hiddenRendererReleased: true,
    completeState: "idle", rendererErrors: errors });
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output }));
  win.destroy();
  app.quit();
}

app.whenReady().then(main).catch(error => { console.error(error); app.exit(1); });
