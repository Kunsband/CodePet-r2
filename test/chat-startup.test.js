const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const capabilities = require("../src/providers/provider-capabilities");
const runner = require("../src/chat/chat-agent-runner");

test("chat opens and switches during CLI discovery, then updates providers without replacing the transcript", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-startup-"));
  t.after(() => { assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const record = { id: "codex", name: "Codex", status: "cli", aliases: ["codex"], commandPath: "fixture", catalogStatus: "ready", modelOptions: [{ id: "fixture" }], models: ["fixture"], permissions: { chat: { supported: true, enforcement: "sandbox" } } };
  let resolveDiscovery, ready = false;
  const discovery = new Promise(resolve => { resolveDiscovery = () => { ready = true; resolve([record]); }; });
  let discoveryCalls = 0;
  t.mock.method(capabilities, "createCapabilityService", () => ({ defs: [record], getRecord: () => ready ? record : null, discover: () => { discoveryCalls++; return discovery; } }));
  const messages = [], pet = [];
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = { send: (channel, payload) => messages.push({ channel, payload }) }; }
    loadFile() {} setMenuBarVisibility() {} isDestroyed() { return false; }
  }
  const nativeId = "11111111-2222-4333-8444-555555555555";
  let finish;
  t.mock.method(runner, "runAgentProcess", (input) => {
    assert.ok(!input.argv.includes("--ephemeral"));
    const line = JSON.stringify({ type: "thread.started", thread_id: nativeId });
    input.parseLine(line); input.parseLine(line);
    input.onEvent({ kind: "status", label: "실행: fixture" });
    return { promise: new Promise(resolve => { finish = resolve; }), cancel() { finish({ cancelled: true }); } };
  });
  const modulePath = require.resolve("../src/chat/chat-ipc");
  delete require.cache[modulePath];
  t.after(() => { delete require.cache[modulePath]; });
  const { createChatFeature } = require(modulePath);
  const handlers = new Map();
  const feature = createChatFeature({ storeRoot: root, onActivity: state => pet.push(state), electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} }, dialog: {}, BrowserWindow: Window, shell: {} } });
  t.after(() => feature.shutdown());
  feature.registerIpcHandlers(); feature.openWindow();
  const invoke = (name, input) => handlers.get(name)({}, input);
  const beforeDiscovery = promise => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("UI waited for CLI discovery")), 1000); timer.unref(); })]);
  const initial = await beforeDiscovery(invoke("chat:state", { backgroundProviders: true }));
  assert.equal(initial.providersLoading, true);
  assert.equal(initial.session.agents.length, 0);
  const created = await beforeDiscovery(invoke("chat:sessions:create"));
  assert.notEqual(created.activeSessionId, initial.activeSessionId);
  const selected = await beforeDiscovery(invoke("chat:sessions:select", { sessionId: initial.activeSessionId }));
  assert.equal(selected.activeSessionId, initial.activeSessionId);
  await new Promise(setImmediate);
  assert.equal(discoveryCalls, 1);
  resolveDiscovery();
  await new Promise(setImmediate);
  const update = messages.find(({ channel }) => channel === "chat:providers-changed");
  assert.equal(update.payload.sessionId, initial.activeSessionId);
  assert.equal(update.payload.providers[0].id, "codex");
  assert.equal(Object.hasOwn(update.payload, "messages"), false);
  assert.ok(messages.some(({ channel, payload }) => channel === "chat:agents" && payload.agents[0]?.available));
  await invoke("chat:send", { sessionId: initial.activeSessionId, text: "@codex test" });
  for (let i = 0; i < 100 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(finish);
  assert.deepEqual(pet, ["review", "running"]);
  const rows = fs.readFileSync(path.join(root, "sessions", initial.activeSessionId, "transcript.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const saved = rows.filter(row => row.kind === "cli-session");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].cliSessionId, nativeId);
  assert.equal(saved[0].agentId, "codex");
  assert.equal(saved[0].profileKey, null);
  await invoke("chat:stop", { sessionId: initial.activeSessionId });
  assert.equal(pet.at(-1), null);
});
