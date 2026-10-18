// Run with: electron scripts/smoke-chat-feedback.js
// Uses the real renderer and keyboard events, with isolated synthetic sessions.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const output = path.join(__dirname, "..", "artifacts", "chat-feedback-smoke", String(Date.now()));
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "electron-profile"));
app.disableHardwareAcceleration();
const agents = ["codex", "claude", "agy", "grok"].map(id => ({
  id, name: id, mention: id, providerId: id, available: true, enabled: true, aliases: [id], model: "default", effort: "default",
}));
const sessions = [{ id: "fixture", title: "이름 편집 확인", updatedAt: Date.now() }];
const state = () => ({ ok: true, activeSessionId: "fixture", sessions, providers: [], providersLoading: true,
  session: { meta: { id: "fixture" }, messages: [], agents, history: {}, typing: [] } });
let renameCalls = 0, selectCalls = 0;
ipcMain.handle("chat:state", state);
ipcMain.handle("chat:sessions:rename", (_e, { title }) => {
  renameCalls++; sessions[0].title = title; return { ok: true, sessions };
});
ipcMain.handle("chat:sessions:select", () => { selectCalls++; return state(); });
ipcMain.handle("chat:providers:refresh", () => ({ ok: true, providers: [] }));
const pause = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await pause(); }
  throw new Error("UI condition timed out");
}

async function main() {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, frame: false,
    webPreferences: { preload: path.join(__dirname, "..", "src", "chat-preload.js"),
      backgroundThrottling: false, offscreen: true, contextIsolation: true, nodeIntegration: false },
  });
  const errors = [];
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  win.webContents.on("render-process-gone", (_e, details) => errors.push(details.reason));
  const js = source => win.webContents.executeJavaScript(source);
  const key = (code, char) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: code });
    if (char) win.webContents.sendInputEvent({ type: "char", keyCode: char });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: code });
  };
  await win.loadFile(path.join(__dirname, "..", "src", "chat.html"));
  await until(() => js("!!document.querySelector('.session-select')"));
  await js("localStorage.setItem(DOCTOR_SEEN_KEY, 'true'); doctorBackdrop.hidden = true");
  for (const area of ["sidebar", "header"]) {
    const open = area === "sidebar" ? "document.querySelector('.session-action').click()"
      : "sessionTitleEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))";
    const title = `새 대화 ${area}`;
    await js(`${open}; document.querySelector('.session-rename-input').value = ${JSON.stringify(title)}; document.querySelector('.session-rename-input').setSelectionRange(${title.length},${title.length})`);
    const before = renameCalls;
    key("Space", " ");
    await pause();
    assert.equal(await js("document.querySelector('.session-rename-input')?.value"), `${title} `);
    assert.equal(renameCalls, before);
    await js("document.querySelector('.session-rename-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))");
    assert.equal(await js("!!document.querySelector('.session-rename-input')"), true);
    key("Enter");
    await until(() => renameCalls === before + 1);
    assert.equal(sessions[0].title, title);
    await js(`${open}; document.querySelector('.session-rename-input').value = '취소할 이름'`);
    key("Escape");
    await pause();
    assert.equal(renameCalls, before + 1);
    assert.equal(await js("!!document.querySelector('.session-rename-input')"), false);
  }
  assert.equal(selectCalls, 0, "editing must not select/reload the session");
  await js("window.selectedBefore = document.querySelector('.session-select'); window.selectedBefore.focus()");
  key("Space", " ");
  await until(() => js("window.selectedBefore !== document.querySelector('.session-select')"));

  // Late discovery must not reset the current input or rendered messages.
  await js("composerInput.value = '쓰던 내용'; appendMessage({ id:'kept', author:'user', authorType:'user', text:'기존 대화' })");
  win.webContents.send("chat:providers-changed", { sessionId: "fixture", providers: [], diagnostics: [] });
  await until(() => js("!providersLoading"));
  assert.equal(await js("composerInput.value"), "쓰던 내용");
  assert.equal(await js("messageList.querySelector('[data-message-id=kept]').textContent.includes('기존 대화')"), true);

  const streaming = await js(`(async () => {
    renderAllMessages([]); composerInput.focus();
    for (const agent of agents) handleRunEvent({sessionId:activeSessionId,runId:agent.id,agentId:agent.id,kind:'run-start'});
    let mutations = 0;
    const observer = new MutationObserver(records => { mutations += records.length; });
    for (const live of liveRuns.values()) observer.observe(live.textEl, { characterData:true, subtree:true });
    const frames = []; let last = performance.now();
    for (let i = 0; i < 40; i++) {
      for (const agent of agents) handleRunEvent({sessionId:activeSessionId,runId:agent.id,agentId:agent.id,kind:'delta',text:'실시간 응답과 코드 설명 확인입니다. '.repeat(10)});
      composerInput.value = '입력 확인 '.repeat(i % 10 + 1); composerInput.dispatchEvent(new Event('input'));
      await new Promise(requestAnimationFrame); const now = performance.now(); frames.push(now-last); last = now;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    observer.disconnect();
    return {maxFrameMs:Math.max(...frames),meanFrameMs:frames.reduce((a,b)=>a+b)/frames.length,
      over50:frames.filter(x=>x>50).length,mutations,deltas:160,
      textMatches:[...liveRuns.values()].every(live=>live.textNode.data===live.text)};
  })()`);
  assert.equal(streaming.textMatches, true);
  assert.ok(streaming.mutations < streaming.deltas, "streaming DOM updates should be coalesced");
  await js("handleRunEvent({sessionId:activeSessionId,runId:'codex',agentId:'codex',kind:'delta',text:'가'.repeat(70000)})");
  await until(() => js("liveRuns.get('codex').textNode.data === liveRuns.get('codex').text"));
  assert.ok(await js("liveRuns.get('codex').textNode.length <= 65536"));
  const finalText = "최종 응답 ".repeat(15000);
  win.webContents.send("chat:message", { sessionId: "fixture", message: {
    id: "final", runId: "codex", author: "codex", authorType: "agent", text: finalText, ts: Date.now(),
  } });
  await until(() => js("!liveRuns.has('codex')"));
  assert.equal(await js("messageList.querySelector('[data-message-id=final] .bubble').textContent.trim()"), finalText.trim());
  await js("handleRunEvent({sessionId:activeSessionId,runId:'claude',agentId:'claude',kind:'delta',text:'pending'})");
  win.webContents.send("chat:turn-state", { sessionId: "fixture", current: null, queue: [], deferred: [] });
  await until(() => js("liveRuns.size === 0 && liveTimer === null && liveFrame === null"));

  await js("renderAllMessages([{id:'visible',author:'codex',authorType:'agent',ts:Date.now(),agentMeta:{model:'default',effort:'default'},text:'여러 에이전트의 답변을 확인하며 대화를 입력할 수 있어요.'}]); composerInput.value='다음 작업도 확인해줘'; autoresize()");
  for (const width of [1000, 560]) {
    win.setSize(width, 800);
    await pause(150);
    const layout = await js("({overflow:document.documentElement.scrollWidth>innerWidth,composerBottom:document.querySelector('.composer').getBoundingClientRect().bottom,height:innerHeight})");
    fs.writeFileSync(path.join(output, `chat-${width}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
    assert.equal(layout.overflow, false);
    assert.ok(layout.composerBottom <= layout.height + 1, JSON.stringify({ width, ...layout, output }));
  }
  assert.deepEqual(errors, []);
  const report = { passed: true, renameCalls, selectCalls, streaming, widths: [1000, 560], rendererErrors: errors };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output }));
  win.destroy(); app.quit();
}
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1); });
