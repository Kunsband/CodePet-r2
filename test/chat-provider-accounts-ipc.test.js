const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const runner = require("../src/chat/chat-agent-runner");
const capabilities = require("../src/providers/provider-capabilities");

for (const providerId of ["claude", "grok"]) test(`${providerId} accounts retain separate models, mentions, traces and subprocess identities`, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codepet-account-ipc-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = { id: providerId, name: providerId, aliases: [providerId], status: "cli", commandPath: "same-cli", catalogStatus: "ready",
    modelOptions: [{ id: "base-model" }], permissions: { chat: { supported: true } } };
  t.mock.method(capabilities, "createCapabilityService", () => ({ defs: [base], getRecord: (id) => id === providerId ? base : null, discover: async () => [base] }));
  const profiles = ["a", "b"].map((key) => ({ key, label: `Account ${key}` }));
  const record = (key) => ({ ...base, modelOptions: [{ id: `model-${key}`, efforts: ["high"] }], models: [`model-${key}`] });
  const accountService = { list: () => profiles, discover: async (key) => record(key), record,
    prepare: (key) => ({ env: { ...process.env, [providerId === "claude" ? "CLAUDE_CONFIG_DIR" : "GROK_HOME"]: path.join(root, `private-${key}`) } }) };
  const calls = [];
  t.mock.method(runner, "runAgentProcess", (input) => {
    calls.push(input);
    input.parseLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "fixture-id", name: "Read", input: { file_path: "fixture.txt" } }] } }));
    return { promise: Promise.resolve({ ok: true, text: "finished" }), cancel() {} };
  });
  const modulePath = require.resolve("../src/chat/chat-ipc");
  delete require.cache[modulePath];
  const { createChatFeature } = require(modulePath);
  t.after(() => { delete require.cache[modulePath]; });
  const handlers = new Map();
  const options = { storeRoot: root, [`${providerId}Accounts`]: accountService, electron: {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} }, dialog: {}, BrowserWindow: class {}, shell: {},
  } };
  let feature = createChatFeature(options);
  t.after(() => feature.shutdown());
  feature.registerIpcHandlers();
  const invoke = (name, data) => handlers.get(name)({}, data);
  const first = await invoke("chat:state");
  const sessionId = first.activeSessionId;
  assert.equal((await invoke("chat:agent:add", { sessionId, providerId, profileKey: "../outside" })).ok, false);
  const added = await invoke("chat:agent:add", { sessionId, providerId, profileKey: "a", name: "Codex A" });
  assert.equal(added.ok, true);
  assert.equal(added.session.agents.find((agent) => agent.id === `${providerId}-2`).providerId, providerId);
  assert.deepEqual(added.session.providers.find((provider) => provider.id === `${providerId}-2`).models, ["model-a"]);
  assert.equal((await invoke("chat:agent:add", { sessionId, providerId, profileKey: "a" })).ok, false);
  assert.equal((await invoke("chat:agent:add", { sessionId, providerId, profileKey: "b", name: "Codex B" })).ok, true);
  assert.equal((await invoke("chat:agent:configure", { sessionId, agentId: `${providerId}-2`, patch: { model: "model-b" } })).ok, false);
  assert.equal((await invoke("chat:agent:configure", { sessionId, agentId: `${providerId}-2`, patch: { model: "model-a", effort: "high" } })).ok, true);
  await invoke("chat:agent:configure", { sessionId, agentId: providerId, patch: { enabled: false } });
  await invoke("chat:send", { sessionId, text: `@${providerId}-2 확인해` });
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
  assert.equal(calls[0].env[providerId === "claude" ? "CLAUDE_CONFIG_DIR" : "GROK_HOME"], path.join(root, "private-a"));
  assert.equal(calls[0].provider, providerId);
  assert.equal(calls[0].outputFile, null);
  assert.ok(calls[0].argv.includes("model-a"));
  assert.ok(!calls[0].argv.includes("--dangerously-skip-permissions"));
  assert.ok(!calls[0].argv.includes("cli_auth_credentials_store=file"));
  await invoke("chat:send", { sessionId, text: "@모두 확인해" });
  const state = await completed(3);
  assert.deepEqual(calls.slice(1).map((call) => path.basename(call.env[providerId === "claude" ? "CLAUDE_CONFIG_DIR" : "GROK_HOME"])).sort(), ["private-a", "private-b"]);
  assert.ok(calls.every((call) => call.commandPath === "same-cli"));
  assert.doesNotMatch(JSON.stringify(state), /private-a|private-b|auth\.json/);
  const { ChatTraceStore } = require("../src/chat/chat-traces");
  const traces = await new ChatTraceStore({ root }).list(sessionId);
  assert.deepEqual([...new Set(traces.map((trace) => trace.agentId))].sort(), [`${providerId}-2`, `${providerId}-3`]);
  feature.shutdown();
  feature = createChatFeature(options);
  feature.registerIpcHandlers();
  const reopened = await invoke("chat:state");
  assert.equal(reopened.session.agents.find((agent) => agent.id === `${providerId}-2`).model, "model-a");
  assert.equal((await invoke("chat:agent:remove", { sessionId, agentId: providerId })).ok, false);
  assert.equal((await invoke("chat:agent:remove", { sessionId, agentId: `${providerId}-2` })).ok, true);
  const replacement = await invoke("chat:agent:add", { sessionId, providerId, profileKey: "a" });
  assert.ok(replacement.session.agents.some((agent) => agent.id === `${providerId}-4`));
});

test("account picker lists only detected services and successfully discovered accounts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codepet-account-picker-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const defs = ["codex", "claude", "grok", "agy"].map((id) => ({ id, status: id === "grok" ? "absent" : "cli", commandPath: id === "grok" ? null : "fixture" }));
  t.mock.method(capabilities, "createCapabilityService", () => ({ defs, getRecord: (id) => defs.find((p) => p.id === id), discover: async () => defs }));
  const services = {};
  let active = 0, maxActive = 0;
  for (const provider of defs) services[`${provider.id}Accounts`] = {
    list: () => ["ready", "expired", "broken"].map((key) => ({ key, label: key, email: `${key}@example.test`, plan: "test-plan" })),
    discover: async (key) => {
      assert.ok(["codex", "claude"].includes(provider.id));
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      if (key === "broken") throw new Error("fixture failure");
      return { catalogStatus: key === "ready" ? "ready" : "unavailable" };
    },
  };
  const modulePath = require.resolve("../src/chat/chat-ipc");
  delete require.cache[modulePath];
  t.after(() => { delete require.cache[modulePath]; });
  const handlers = new Map();
  const feature = require(modulePath).createChatFeature({ storeRoot: root, ...services, electron: {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} }, dialog: {}, BrowserWindow: class {}, shell: {},
  } });
  t.after(() => feature.shutdown());
  feature.registerIpcHandlers();
  const result = await handlers.get("chat:accounts:list")({}, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.accounts.map((account) => [account.providerId, account.key, account.email, account.plan]), [
    ["codex", "ready", "ready@example.test", "test-plan"], ["claude", "ready", "ready@example.test", "test-plan"],
  ]);
  assert.ok(maxActive <= 2);
});
