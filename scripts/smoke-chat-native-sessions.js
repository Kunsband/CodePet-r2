// Opt-in live CLI smoke: three short, tool-free turns per installed provider.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { ChatStore } = require("../src/chat/chat-store");
const runner = require("../src/chat/chat-agent-runner");
const actualRun = runner.runAgentProcess;
const calls = [];
runner.runAgentProcess = (input) => { calls.push(input); return actualRun(input); };
const { createChatFeature } = require("../src/chat/chat-ipc");
const root = path.resolve("artifacts", "native-session-smoke", String(Date.now()));
const liveConfig = path.join(process.env.CODE_PET_HOME || path.join(os.homedir(), ".code-pet"), "config.json");
const cache = JSON.parse(fs.readFileSync(liveConfig, "utf8")).capabilityCache;
const reports = [];

async function check(providerId) {
  const dir = path.join(root, providerId);
  new ChatStore({ root: dir }).init().patchConfig({ capabilityCache: cache });
  const handlers = new Map();
  const options = { storeRoot: dir, timeoutMs: 180000, electron: {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
    dialog: {}, BrowserWindow: class {}, shell: {},
  } };
  let feature;
  const open = () => { feature = createChatFeature(options); feature.registerIpcHandlers(); };
  const invoke = (name, input) => handlers.get(name)({}, input);
  open();
  try {
    const first = await invoke("chat:state");
    if (!first.session.agents.find(agent => agent.id === providerId)?.available) {
      return { providerId, skipped: true };
    }
    const sessionId = first.activeSessionId;
    const key = `native_${randomUUID()}`;
    let count = 0;
    async function send(text) {
      assert.equal((await invoke("chat:send", { sessionId, text: `@${providerId} ${text}` })).ok, true);
      const deadline = Date.now() + 185000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const state = await invoke("chat:state");
        const answers = state.session.messages.filter(message => message.authorType === "agent");
        if (answers.length > count && !state.session.turnState.current && !state.session.turnState.currentTurns?.length) {
          count = answers.length;
          const answer = answers.at(-1);
          assert.ok(!answer.error, answer.text);
          return answer.text;
        }
      }
      throw new Error("Native session smoke timed out");
    }
    await send(`Tool-free session test. Remember this key: ${key}. Do not use any tools, mention anyone, or repeat the key yet. Reply only STORED.`);
    const links = () => JSON.parse(fs.readFileSync(path.join(dir, "sessions", sessionId, "native-sessions.json"), "utf8"));
    const id = links()[providerId].cliSessionId;
    assert.ok(id);
    const question = "Do not use any tools or mention anyone. Reply only with the exact test key I gave you earlier in this session.";
    assert.ok((await send(question)).includes(key));
    assert.equal(links()[providerId].cliSessionId, id);
    feature.shutdown();
    open();
    await invoke("chat:state");
    assert.ok((await send(question)).includes(key));
    assert.equal(links()[providerId].cliSessionId, id);
    const runs = calls.filter(call => call.provider === providerId);
    assert.equal(runs.length, 3);
    assert.ok(runs.slice(1).every(call => !call.prompt.includes(key)), "The marker must come from native history, not replayed prompts");
    return { providerId, ok: true, sameNativeId: true, rememberedAfterRestart: true, replayedMarker: false, cliSessionId: id };
  } finally { feature.shutdown(); }
}

(async () => {
  for (const providerId of ["codex", "claude", "agy"]) {
    try { reports.push(await check(providerId)); }
    catch (error) { reports.push({ providerId, ok: false, error: error.message }); process.exitCode = 1; }
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(reports, null, 2));
    console.log(JSON.stringify(reports.at(-1)));
  }
  console.log(JSON.stringify({ root }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
