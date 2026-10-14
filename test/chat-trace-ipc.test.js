const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const runner = require("../src/chat/chat-agent-runner");
const capabilities = require("../src/providers/provider-capabilities");

test("chat IPC persists traces before the next participant, preserves CLI permissions and deletes traces with the chat", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codepet-trace-ipc-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const records = ["codex", "claude"].map((id) => ({
    id, name: id, status: "cli", commandPath: `${id}-fixture`, models: ["fixture"],
    catalogStatus: "ready",
    modelOptions: [{ id: "fixture", isDefault: true }], efforts: ["medium"],
    permissions: { chat: { supported: true, enforcement: "tool-policy" } },
  }));
  t.mock.method(capabilities, "createCapabilityService", () => ({
    defs: records, getRecord: (id) => records.find((record) => record.id === id), discover: async () => records,
  }));
  const calls = [];
  t.mock.method(runner, "runAgentProcess", (input) => {
    calls.push(input);
    if (input.provider === "codex") {
      input.parseLine(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "fixture-check", aggregated_output: "ipc-proof-73", exit_code: 0 } }));
      return { promise: Promise.resolve({ ok: true, text: "점검을 마쳤어요." }), cancel() {} };
    }
    return { promise: Promise.resolve({ ok: true, text: input.prompt.includes("ipc-proof-73")
      ? "코덱스 실행 기록에서 ipc-proof-73을 확인했어요."
      : '[[CODEPET_TRACE:{"agent":"codex"}]]' }), cancel() {} };
  });
  const modulePath = require.resolve("../src/chat/chat-ipc");
  delete require.cache[modulePath];
  const { createChatFeature } = require(modulePath);
  t.after(() => { delete require.cache[modulePath]; });
  const handlers = new Map();
  const feature = createChatFeature({ storeRoot: root, electron: {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
    dialog: {}, BrowserWindow: class {}, shell: {},
  } });
  t.after(() => feature.shutdown());
  feature.registerIpcHandlers();
  const invoke = (name, data) => handlers.get(name)({}, data);
  const initial = await invoke("chat:state");
  assert.equal(initial.ok, true);
  const sessionId = initial.activeSessionId;
  assert.equal((await invoke("chat:agent:configure", { sessionId, agentId: "codex", patch: { model: "not-in-catalog" } })).ok, false);
  assert.equal((await invoke("chat:agent:configure", { sessionId, agentId: "codex", patch: { model: "fixture", effort: "high" } })).ok, false);
  assert.equal((await invoke("chat:agent:configure", { sessionId, agentId: "codex", patch: { model: "fixture", effort: "default" } })).ok, true);
  assert.equal((await invoke("chat:agent:configure", { sessionId, agentId: "codex", patch: { model: "default", effort: "default" } })).ok, true);
  assert.equal((await invoke("chat:send", { sessionId, text: "@codex @claude 작업 결과를 확인해줘." })).ok, true);
  let state;
  for (let i = 0; i < 200; i += 1) {
    state = await invoke("chat:state");
    if (state.session.messages.filter((message) => message.authorType === "agent").length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(state.session.messages.at(-1).text, /ipc-proof-73/);
  assert.equal(calls.length, 3);
  assert.doesNotMatch(calls[1].prompt, /ipc-proof-73/);
  assert.match(calls[2].prompt, /ipc-proof-73/);
  for (const call of calls.filter((item) => item.provider === "claude")) {
    assert.equal(call.argv[call.argv.indexOf("--tools") + 1], "");
    assert.ok(call.argv.includes("--strict-mcp-config"));
  }
  assert.equal(calls[0].argv[calls[0].argv.indexOf("--sandbox") + 1], "read-only");
  assert.ok(calls.every((call) => !call.argv.includes("--model") && !call.argv.includes("--effort")));
  assert.equal((await fs.readdir(path.join(root, "traces"))).length, 1);
  assert.equal((await invoke("chat:sessions:delete", { sessionId })).ok, true);
  assert.deepEqual(await fs.readdir(path.join(root, "traces")), []);
});
