const test = require("node:test");
const assert = require("node:assert/strict");
const { roomAgentFromCapability } = require("../src/chat/chat-agents");

function record(id, modelOptions, efforts = ["default", "low", "medium", "high"]) {
  return {
    id,
    name: id,
    status: "cli",
    catalogStatus: "ready",
    aliases: [id],
    modelOptions,
    efforts,
  };
}

test("Claude 기본 설정에 모델이나 추론을 임의 지정하지 않는다", () => {
  const agent = roomAgentFromCapability(record("claude", [
    { id: "default", efforts: ["default", "low", "medium", "high"] },
    { id: "fable", efforts: ["default", "low", "medium", "high"] },
    { id: "claude-fable-5", efforts: ["default", "low", "medium", "high"] },
  ]), { model: "default", effort: "default" });
  assert.equal(agent.model, "default");
  assert.equal(agent.effort, "default");
});

test("Codex 카탈로그의 기본 표시로 사용자 CLI 설정을 덮어쓰지 않는다", () => {
  const agent = roomAgentFromCapability(record("codex", [
    { id: "default", efforts: ["low", "medium", "high"] },
    { id: "gpt-5.6-sol", isDefault: true, efforts: ["low", "medium", "high"] },
    { id: "gpt-5.6-terra", efforts: ["medium"] },
  ]), {});
  assert.equal(agent.model, "default");
  assert.equal(agent.effort, "default");
});

test("AGY 모델명을 보고 추론 플래그를 만들어내지 않는다", () => {
  const agent = roomAgentFromCapability(record("agy", [
    { id: "default", efforts: ["default", "low", "medium", "high"] },
    { id: "gemini-3.6-flash-high", efforts: ["default", "low", "medium", "high"] },
  ]), { model: "gemini-3.6-flash-high" });
  assert.equal(agent.model, "gemini-3.6-flash-high");
  assert.equal(agent.effort, "default");
});

test("실행 어댑터가 아직 없는 provider는 채팅에서 사용 가능으로 노출하지 않는다", () => {
  const pending = record("grok", [
    { id: "default", efforts: ["default", "medium", "high"] },
    { id: "grok-4.5", efforts: ["default", "medium", "high"] },
  ]);
  pending.permissions = { chat: { supported: false, enforcement: "sandbox" } };
  const agent = roomAgentFromCapability(pending, {});
  assert.equal(agent.available, false);
  assert.match(agent.reason, /통합/);
});

test("grok is unavailable outside chat permission mode", () => {
  const grok = record("grok", [{ id: "grok-4.5", efforts: ["medium"] }]);
  grok.permissions = { chat: { supported: true, enforcement: "tool-policy" }, "workspace-read": { supported: false, enforcement: "unavailable" } };
  assert.equal(roomAgentFromCapability(grok, {}, "chat").available, true);
  assert.equal(roomAgentFromCapability(grok, {}, "workspace-read").available, false);
});

test("Grok 승인형 쓰기는 저장된 자동 승인 설정을 무시한다", () => {
  const grok = record("grok", [{ id: "grok-4.5", efforts: ["medium"] }]);
  grok.permissions = {
    chat: { supported: true, enforcement: "tool-policy" },
    "workspace-write": { supported: true, enforcement: "container-copy-approval" },
  };
  const agent = roomAgentFromCapability(grok, { autoApprove: true }, "workspace-write");
  assert.equal(agent.available, true);
  assert.equal(agent.autoApprove, false);
});
