const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const runner = require("../src/chat/chat-agent-runner");
const capabilities = require("../src/providers/provider-capabilities");

test("saved account participants keep their models, mentions, traces and CLI identities separate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codepet-account-ipc-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = { id: "codex", name: "Codex", aliases: ["codex"], status: "cli", commandPath: "same-cli", catalogStatus: "ready",
    modelOptions: [{ id: "base-model" }], permissions: { chat: { supported: true } } };
  t.mock.method(capabilities, "createCapabilityService", () => ({ defs: [base], getRecord: (id) => id === "codex" ? base : null, discover: async () => [base] }));
  const profiles = ["a", "b"].map((key) => ({ key, label: `Account ${key}` }));
  const sandboxReady = new Set();
  const record = (key) => ({ ...base, modelOptions: [{ id: `model-${key}`, efforts: ["high"] }], models: [`model-${key}`] });
  const accountService = { list: () => profiles, discover: async (key) => record(key), record,
    prepareSandbox: async key => { await new Promise(resolve => setTimeout(resolve, 5)); sandboxReady.add(`private-${key}`); },
    prepare: (key) => ({ env: { ...process.env, CODEX_HOME: path.join(root, `private-${key}`) } }) };
  const calls = [];
  t.mock.method(runner, "runAgentProcess", (input) => {
    assert.ok(sandboxReady.delete(path.basename(input.env.CODEX_HOME)), "sandbox preparation must finish before each participant runs");
    calls.push(input);
    input.parseLine(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "fixture", aggregated_output: "account-trace", exit_code: 0 } }));
    return { promise: Promise.resolve({ ok: true, text: "finished" }), cancel() {} };
  });
  const modulePath = require.resolve("../src/chat/chat-ipc");
  delete require.cache[modulePath];
  const { createChatFeature } = require(modulePath);
  t.after(() => { delete require.cache[modulePath]; });
  const handlers = new Map();
  const options = { storeRoot: root, codexAccounts: accountService, electron: {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} }, dialog: {}, BrowserWindow: class {}, shell: {},
  } };
  let feature = createChatFeature(options);
  t.after(() => feature.shutdown());
  feature.registerIpcHandlers();
  const invoke = (name, data) => handlers.get(name)({}, data);
  const first = await invoke("chat:state");
  const sessionId = first.activeSessionId;
  assert.equal((await invoke("chat:agent:add", { sessionId, profileKey: "../outside" })).ok, false);
  const added = await invoke("chat:agent:add", { sessionId, profileKey: "a", name: "Codex A" });
  assert.equal(added.ok, true);
  assert.equal(added.session.agents.find((agent) => agent.id === "codex-2").providerId, "codex");
  assert.deepEqual(added.session.providers.find((provider) => provider.id === "codex-2").models, ["model-a"]);
  assert.equal((await invoke("chat:agent:add", { sessionId, profileKey: "a" })).ok, false);
  assert.equal((await invoke("chat:agent:add", { sessionId, profileKey: "b", name: "Codex B" })).ok, true);
  assert.equal((await invoke("chat:agent:configure", { sessionId, agentId: "codex-2", patch: { model: "model-b" } })).ok, false);
  assert.equal((await invoke("chat:agent:configure", { sessionId, agentId: "codex-2", patch: { model: "model-a", effort: "high" } })).ok, true);
  await invoke("chat:agent:configure", { sessionId, agentId: "codex", patch: { enabled: false } });
  await invoke("chat:send", { sessionId, text: "@codex-2 확인해" });
  async function completed(count) {
    for (let i = 0; i < 100; i += 1) {
      const state = await invoke("chat:state");
      if (state.session.messages.filter((message) => message.authorType === "agent").length === count && !state.session.turnState.current) return state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("responses did not finish");
  }
  await completed(1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.CODEX_HOME, path.join(root, "private-a"));
  assert.equal(calls[0].provider, "codex");
  assert.ok(calls[0].outputFile);
  assert.ok(calls[0].argv.includes("model-a"));
  assert.equal(calls[0].argv[calls[0].argv.indexOf("--sandbox") + 1], "read-only");
  await invoke("chat:send", { sessionId, text: "@모두 확인해" });
  const state = await completed(3);
  assert.deepEqual(calls.slice(1).map((call) => path.basename(call.env.CODEX_HOME)).sort(), ["private-a", "private-b"]);
  assert.ok(calls.every((call) => call.commandPath === "same-cli"));
  assert.doesNotMatch(JSON.stringify(state), /private-a|private-b|auth\.json/);
  const { ChatTraceStore } = require("../src/chat/chat-traces");
  const traces = await new ChatTraceStore({ root }).list(sessionId);
  assert.deepEqual([...new Set(traces.map((trace) => trace.agentId))].sort(), ["codex-2", "codex-3"]);
  feature.shutdown();
  feature = createChatFeature(options);
  feature.registerIpcHandlers();
  const reopened = await invoke("chat:state");
  assert.equal(reopened.session.agents.find((agent) => agent.id === "codex-2").model, "model-a");
  assert.equal((await invoke("chat:agent:remove", { sessionId, agentId: "codex" })).ok, false);
  assert.equal((await invoke("chat:agent:remove", { sessionId, agentId: "codex-2" })).ok, true);
  const replacement = await invoke("chat:agent:add", { sessionId, profileKey: "a" });
  assert.ok(replacement.session.agents.some((agent) => agent.id === "codex-4"));
});
