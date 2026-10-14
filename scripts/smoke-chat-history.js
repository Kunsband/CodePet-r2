// Run with: electron scripts/smoke-chat-history.js
// Isolated synthetic transcripts; no providers, credentials or user settings.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const electron = require("electron");
const { app, BrowserWindow, ipcMain } = electron;
const { ChatStore } = require("../src/chat/chat-store");
const { createChatFeature } = require("../src/chat/chat-ipc");
const output = path.join(__dirname, "..", "artifacts", "chat-history-smoke", String(Date.now()));
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "electron-profile"));
app.disableHardwareAcceleration();
const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await pause(); }
  throw new Error("UI condition timed out");
}

async function run() {
  const store = new ChatStore({ root: path.join(output, "store") }).init();
  const main = store.createSession({ title: "긴 대화 테스트" });
  const other = store.createSession({ title: "다른 채팅방" });
  const messages = Array.from({ length: 10000 }, (_, i) => ({
    id: `m${i}`, ts: Date.now() + i, authorType: i % 2 ? "agent" : "user",
    author: i % 2 ? "codex" : "user",
    text: i % 2 ? `메시지 ${i}: 확인한 내용을 정리했어요.\n\n- 대화 기록 유지\n- 이전 메시지 불러오기`
      : `메시지 ${i}: 이전 대화도 위로 스크롤해서 확인하고 싶어요.`,
  }));
  fs.writeFileSync(store.transcriptPath(main.id), messages.map((message) =>
    JSON.stringify({ kind: "message", message })).join("\n") + "\n");
  store.appendEvent(other.id, { kind: "message", message: {
    id: "other", ts: Date.now(), authorType: "user", author: "user", text: "다른 채팅방의 메시지",
  } });
  let delay = 0;
  let failNext = false;
  let historyCalls = 0;
  const feature = createChatFeature({ storeRoot: store.root, electron: {
    ...electron, ipcMain: {
      on: ipcMain.on.bind(ipcMain),
      handle(channel, handler) {
        ipcMain.handle(channel, async (event, input) => {
          if (channel === "chat:messages:history") {
            historyCalls++;
            await pause(delay);
            if (failNext) { failNext = false; return { ok: false, error: "test failure" }; }
          }
          return handler(event, input);
        });
      },
    },
  } });
  feature.registerIpcHandlers();
  const state = (id) => {
    const page = store.readMessagesPage(id);
    return { ok: true, activeSessionId: id, sessions: store.listSessions(), providers: [], diagnostics: [],
      session: { meta: store.readMeta(id), messages: page.messages,
        history: { before: page.before, hasMore: page.hasMore },
        agents: [{ id: "codex", name: "Codex", available: true, enabled: true, color: "#168b62", model: "test", effort: "high" }],
        typing: [], pendingAttachments: [], turnState: { current: null, queue: [], deferred: [] },
      },
    };
  };
  ipcMain.removeHandler("chat:state");
  ipcMain.handle("chat:state", () => state(main.id));
  ipcMain.removeHandler("chat:sessions:select");
  ipcMain.handle("chat:sessions:select", (_e, { sessionId }) => state(sessionId));
  const win = new BrowserWindow({ width: 900, height: 700, show: false, frame: false,
    webPreferences: { preload: path.join(__dirname, "..", "src", "chat-preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, offscreen: true },
  });
  const errors = [];
  win.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
  win.webContents.on("render-process-gone", (_e, details) => errors.push(details.reason));
  const js = (source) => win.webContents.executeJavaScript(source);
  const count = () => js("messageList.querySelectorAll('[data-message-id]').length");
  const started = Date.now();
  await win.loadFile(path.join(__dirname, "..", "src", "chat.html"));
  await until(async () => (await count()) === 50);
  await js("document.getElementById('doctor-done').click()");
  const initialMs = Date.now() - started;
  assert.equal(await js("messageList.firstElementChild.dataset.messageId"), "m9950");
  assert.equal(await js("isNearBottom()"), true);
  assert.equal(historyCalls, 0);

  delay = 150;
  const anchor = await js(`(() => {
    chatScroll.scrollTop = 40;
    const item = [...messageList.children].find(el => el.getBoundingClientRect().bottom > chatScroll.getBoundingClientRect().top);
    return { id: item.dataset.messageId, top: item.getBoundingClientRect().top };
  })()`);
  await until(async () => (await count()) === 100);
  const top = await js(`document.querySelector('[data-message-id="${anchor.id}"]').getBoundingClientRect().top`);
  assert.ok(Math.abs(top - anchor.top) < 2, `prepend shifted anchor by ${top - anchor.top}px`);
  assert.equal(historyCalls, 1);
  assert.equal(await js("new Set([...messageList.children].map(el=>el.dataset.messageId)).size"), 100);

  const readingTop = await js("chatScroll.scrollTop = 500; chatScroll.scrollTop");
  const incoming = { id: "incoming", ts: Date.now(), authorType: "agent", author: "codex", text: "새 답변이 도착했어요." };
  store.appendEvent(main.id, { kind: "message", message: incoming });
  win.webContents.send("chat:message", { sessionId: main.id, message: incoming });
  await until(async () => (await count()) === 101);
  assert.ok(Math.abs((await js("chatScroll.scrollTop")) - readingTop) < 2, "incoming stole scroll position");

  // Error and retry, then a late page from a different session.
  failNext = true;
  await js("historyLoadButton.click()");
  await until(() => js("historyLoadButton.textContent.includes('다시')"));
  assert.equal(await count(), 101);
  await js("historyLoadButton.click()");
  await until(async () => (await count()) === 151);
  delay = 300;
  await js("historyLoadButton.click()");
  await js(`selectSession(${JSON.stringify(other.id)})`);
  await pause(450);
  assert.equal(await count(), 1);
  assert.equal(await js("messageList.firstElementChild.dataset.messageId"), "other");
  assert.equal(await js("historyLoadButton.hidden"), true);

  await js(`selectSession(${JSON.stringify(main.id)})`);
  win.webContents.send("chat:run-event", { sessionId: main.id, runId: "live", agentId: "codex", kind: "run-start" });
  await until(() => js("liveRuns.has('live')"));
  for (let i = 0; i < 1000; i++) {
    win.webContents.send("chat:run-event", { sessionId: main.id, runId: "live", agentId: "codex", kind: "delta", text: "가나다라".repeat(50) });
  }
  await until(() => js("liveRuns.get('live').textEl.textContent.length > 0"));
  await pause(200);
  assert.ok(await js("liveRuns.get('live').textEl.textContent.length <= 65536"));
  assert.equal(await js("isNearBottom()"), true);
  win.webContents.send("chat:message", { sessionId: main.id, message: {
    id: "final", ts: Date.now(), runId: "live", authorType: "agent", author: "codex", text: "스트리밍이 끝난 최종 답변입니다.",
  } });
  await until(() => js("!liveRuns.has('live')"));
  assert.equal(await js("isNearBottom()"), true);

  for (const width of [900, 560]) {
    win.setSize(width, 700);
    await new Promise((resolve) => {
      win.webContents.once("paint", resolve);
      win.webContents.invalidate();
    });
    await pause(100);
    const layout = await js(`({ overflow: document.documentElement.scrollWidth > innerWidth,
      chatOverflow: chatScroll.scrollWidth > chatScroll.clientWidth,
      composerBottom: document.querySelector('.composer').getBoundingClientRect().bottom,
      height: innerHeight })`);
    assert.equal(layout.overflow, false);
    assert.equal(layout.chatOverflow, false);
    assert.ok(layout.composerBottom <= layout.height);
    fs.writeFileSync(path.join(output, `chat-${width}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  }
  assert.deepEqual(errors, []);
  const report = { passed: true, messagesOnDisk: 10001, initialRendered: 50, initialMs,
    anchorShiftPx: top - anchor.top, historyCalls, widths: [900, 560], rendererErrors: errors };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output }));
  feature.shutdown();
  win.destroy();
  app.quit();
}
app.whenReady().then(run).catch((error) => { console.error(error); app.exit(1); });
