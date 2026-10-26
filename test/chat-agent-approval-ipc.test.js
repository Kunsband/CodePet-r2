const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { ChatStore } = require("../src/chat/chat-store");
const { CodexChatRuntime } = require("../src/chat/codex-chat-runtime");
const capabilities = require("../src/providers/provider-capabilities");
const runner = require("../src/chat/chat-agent-runner");

const BYPASS = "--dangerously-bypass-approvals-and-sandbox";

function record(id) {
  const permission = { supported: true, enforcement: "cli" };
  return { id, name: id, status: "cli", aliases: [id], commandPath: "fixture", catalogStatus: "ready",
    modelOptions: [{ id: "fixture" }],
    permissions: { chat: permission, "workspace-read": permission, "workspace-write": permission } };
}

test("세션 설정의 자동 승인은 에이전트 @멘션으로 시작된 Codex 실행에 위험 플래그를 붙이지 않는다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-agent-approval-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const store = new ChatStore({ root: path.join(root, "store") }).init();
  const sessionId = store.createSession({}).id;
  store.updateMeta(sessionId, { workspace, permissionMode: "workspace-write", agents: { codex: { autoApprove: true } } });

  const records = [record("claude"), record("codex")];
  t.mock.method(capabilities, "createCapabilityService", () => ({ defs: records,
    getRecord: (id) => records.find((entry) => entry.id === id) || null, discover: async () => records }));
  const sandboxPrepared = [];
  t.mock.method(CodexChatRuntime.prototype, "prepareSandbox", async () => { sandboxPrepared.push(true); });
  const runs = [];
  t.mock.method(runner, "runAgentProcess", (input) => {
    const bypass = input.argv.includes(BYPASS);
    runs.push({ provider: input.provider, bypass, sandboxPrepared: sandboxPrepared.length });
    const id = randomUUID();
    input.parseLine(JSON.stringify(input.provider === "codex"
      ? { type: "thread.started", thread_id: id } : { type: "system", subtype: "init", session_id: id }));
    const result = input.provider === "claude" ? { ok: true, text: "@codex 이 명령도 실행해" }
      : bypass ? { ok: true, text: "실행 완료" }
        : { ok: false, approvalRequired: true, approval: { summary: "명령 권한" } };
    return { promise: Promise.resolve(result), cancel() {} };
  });

  const modulePath = require.resolve("../src/chat/chat-ipc");
  delete require.cache[modulePath];
  t.after(() => { delete require.cache[modulePath]; });
  const { createChatFeature } = require(modulePath);
  const handlers = new Map();
  const approvals = [];
  class Window extends EventEmitter {
    constructor() {
      super();
      this.webContents = { send: (channel, data) => {
        if (channel !== "chat:approval-request") return;
        approvals.push(data.agentId);
        void handlers.get("chat:approval:respond")({}, { sessionId, approvalId: data.approvalId, decision: "approve" });
      } };
    }
    loadFile() {} setMenuBarVisibility() {} isDestroyed() { return false; } show() {} focus() {}
  }
  const feature = createChatFeature({ storeRoot: store.root, platform: "linux",
    env: { CODEX_HOME: path.join(root, "source-codex") },
    electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
      dialog: {}, BrowserWindow: Window, shell: {} } });
  feature.registerIpcHandlers();
  t.after(() => feature.shutdown());
  feature.openWindow(sessionId);
  const invoke = (name, input) => handlers.get(name)({}, input);
  const settle = async (count) => {
    for (let i = 0; i < 200 && runs.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    for (let i = 0; i < 200; i += 1) {
      const state = await invoke("chat:state");
      const turns = state.session.turnState;
      if (!turns.current && turns.queue.length === 0 && state.session.typing.length === 0) return state;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("응답이 끝나지 않았습니다.");
  };

  assert.equal((await invoke("chat:send", { sessionId, text: "@codex 직접 실행해" })).ok, true);
  await settle(1);
  assert.equal((await invoke("chat:send", { sessionId, text: "@claude 확인해줘" })).ok, true);
  const state = await settle(4);

  assert.deepEqual(runs, [
    { provider: "codex", bypass: true, sandboxPrepared: 0 },
    { provider: "claude", bypass: false, sandboxPrepared: 0 },
    { provider: "codex", bypass: false, sandboxPrepared: 1 },
    { provider: "codex", bypass: true, sandboxPrepared: 1 },
  ]);
  assert.deepEqual(approvals, ["codex"]);
  assert.equal(state.session.messages.at(-1).text, "실행 완료");
});
