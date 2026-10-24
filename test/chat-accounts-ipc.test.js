const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const runner = require("../src/chat/chat-agent-runner");
const capabilities = require("../src/providers/provider-capabilities");
const { CodexChatRuntime } = require("../src/chat/codex-chat-runtime");

test("saved account participants keep their models, mentions, traces and CLI identities separate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codepet-account-ipc-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = { id: "codex", name: "Codex", aliases: ["codex"], status: "cli", commandPath: "same-cli", catalogStatus: "ready",
    modelOptions: [{ id: "base-model" }], permissions: { chat: { supported: true } } };
  t.mock.method(capabilities, "createCapabilityService", () => ({ defs: [base], getRecord: (id) => id === "codex" ? base : null, discover: async () => [base] }));
  const profiles = ["a", "b"].map((key) => ({ key, label: `Account ${key}` }));
  const record = (key) => ({ ...base, modelOptions: [{ id: `model-${key}`, efforts: ["high"] }], models: [`model-${key}`] });
  const accountService = { list: () => profiles, discover: async (key) => record(key), record,
    prepare: (key) => ({ env: { ...process.env, CODEX_HOME: path.join(root, `private-${key}`) } }) };
  const calls = [];
  const runtime = new CodexChatRuntime({ root: path.join(root, "runtime", "codex"), platform: "linux" });
  const privateHome = key => runtime.homeFor(path.join(root, `private-${key}`), key);
  t.mock.method(runner, "runAgentProcess", (input) => {
    assert.ok(input.env.CODEX_HOME.startsWith(path.join(root, "runtime", "codex")), "chat sessions must use a private home");
    calls.push(input);
    input.parseLine(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "fixture", aggregated_output: "account-trace", exit_code: 0 } }));
    return { promise: Promise.resolve({ ok: true, text: "finished" }), cancel() {} };
  });
  const modulePath = require.resolve("../src/chat/chat-ipc");
  delete require.cache[modulePath];
  const { createChatFeature } = require(modulePath);
  t.after(() => { delete require.cache[modulePath]; });
  const handlers = new Map();
  const options = { storeRoot: root, platform: "linux", codexAccounts: accountService, electron: {
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
  const rename = (agentId, patch) => invoke("chat:agent:configure", { sessionId, agentId, patch });
  assert.equal((await rename("codex", { name: "기본 담당", mention: "총괄" })).ok, true);
  assert.equal((await rename("codex-2", { name: "검토 담당", mention: "리뷰" })).ok, true);
  assert.equal((await rename("codex-3", { name: "바뀌면 안 됨", mention: "리뷰" })).ok, false);
  assert.equal((await rename("codex-3", { mention: "총괄" })).ok, false);
  assert.equal((await rename("codex-3", { mention: "모두" })).ok, false);
  assert.equal((await rename("codex-3", { mention: "CODEX-2" })).ok, false);
  await invoke("chat:agent:configure", { sessionId, agentId: "codex", patch: { enabled: false } });
  await invoke("chat:send", { sessionId, text: "@리뷰 확인해" });
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
  assert.equal(calls[0].env.CODEX_HOME, privateHome("a"));
  assert.equal(calls[0].provider, "codex");
  assert.ok(calls[0].outputFile);
  assert.ok(calls[0].argv.includes("model-a"));
  assert.equal(calls[0].argv[calls[0].argv.indexOf("--sandbox") + 1], "read-only");
  assert.match(calls[0].prompt, /참가자 "@리뷰"\(검토 담당\)/);
  await invoke("chat:send", { sessionId, text: "@모두 확인해" });
  const state = await completed(3);
  assert.deepEqual(calls.slice(1).map((call) => call.env.CODEX_HOME).sort(), [privateHome("a"), privateHome("b")].sort());
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
  assert.equal(reopened.session.agents.find((agent) => agent.id === "codex-2").effort, "high");
  assert.equal(reopened.session.agents.find((agent) => agent.id === "codex-2").mention, "리뷰");
  assert.equal(reopened.session.agents.find((agent) => agent.id === "codex-2").name, "검토 담당");
  assert.equal(reopened.session.agents.find((agent) => agent.id === "codex-3").name, "Codex B");
  assert.equal(reopened.session.agents.find((agent) => agent.id === "codex").name, "기본 담당");
  assert.equal(reopened.session.messages.find((message) => message.author === "codex-2").agentMeta.mention, "리뷰");
  await invoke("chat:send", { sessionId, text: "@codex-2 기존 호출도 확인해" });
  await completed(4);
  assert.equal(calls.at(-1).env.CODEX_HOME, privateHome("a"));
  assert.equal((await rename("codex-2", { name: "", mention: "" })).ok, true);
  const reset = await invoke("chat:state");
  assert.equal(reset.session.agents.find((agent) => agent.id === "codex-2").name, "Codex 2");
  assert.equal(reset.session.agents.find((agent) => agent.id === "codex-2").mention, "codex-2");
  assert.equal((await invoke("chat:agent:remove", { sessionId, agentId: "codex" })).ok, false);
  assert.equal((await invoke("chat:agent:remove", { sessionId, agentId: "codex-2" })).ok, true);
  assert.equal((await rename("codex", { mention: "codex-4" })).ok, true);
  const replacement = await invoke("chat:agent:add", { sessionId, profileKey: "a" });
  assert.ok(replacement.session.agents.some((agent) => agent.id === "codex-5"));
  const separate = await invoke("chat:sessions:create");
  assert.equal(separate.session.agents.find((agent) => agent.id === "codex").name, "Codex");
  assert.equal(separate.session.agents.find((agent) => agent.id === "codex").mention, "codex");
});
