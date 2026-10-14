const test = require("node:test");
const assert = require("node:assert/strict");
const { parseClaudeModels, parseAgyModels, parseGrokCatalog, normalizeCatalog } = require("../src/providers/provider-model-catalog");
const { roomAgentFromCapability } = require("../src/chat/chat-agents");
const { buildAgentInvocation } = require("../src/chat/chat-argv");

test("Claude는 initialize 응답의 모델별 추론만 보존하고 계정 정보는 버린다", () => {
  const catalog = parseClaudeModels([
    { value: "model-a", displayName: "Model A", supportsEffort: true, supportedEffortLevels: ["low", "max"], secret: "private" },
    { value: "model-b", supportsEffort: false, supportedEffortLevels: ["high"] },
    { value: "model-c" },
    { value: 'bad & command' },
  ]);
  assert.deepEqual(catalog, [
    { id: "model-a", label: "Model A", efforts: ["low", "max"] },
    { id: "model-b", label: "model-b", efforts: [] },
    { id: "model-c", label: "model-c", efforts: [] },
  ]);
  assert.doesNotMatch(JSON.stringify(catalog), /private/);
});

test("AGY 목록의 단독 ID와 표시명 열을 읽되 추론 플래그를 추측하지 않는다", () => {
  const catalog = parseAgyModels("Available models:\n\u001b[32mfuture-flash-high\u001b[0m  Future Flash (High)\nfuture-flash-low\nother-model\nfuture-flash-high\n");
  assert.deepEqual(catalog.map((row) => row.id), ["future-flash-high", "future-flash-low", "other-model"]);
  assert.ok(catalog.every((row) => row.efforts.length === 0));
  assert.deepEqual(parseAgyModels("Error: authentication required\n"), []);
});

test("Grok의 모델 목록과 전역 도움말로 모델별 추론 지원을 추측하지 않는다", () => {
  const output = "You are logged in.\nAvailable models:\n * future-model (default)\n * other-model\n";
  assert.deepEqual(parseGrokCatalog(output)[0].efforts, []);
  const catalog = parseGrokCatalog(output, "  --effort <LEVEL>\n    [possible values: minimal, high, ultra]\n  --model <MODEL>\n");
  assert.deepEqual(catalog[0].efforts, []);
  assert.equal(catalog[0].isDefault, true);
  assert.deepEqual(parseGrokCatalog(output, "  --effort <LEVEL> Choose reasoning effort\n")[0].efforts, []);
});

test("조회 실패와 삭제된 모델, 다른 모델의 추론을 실행 직전에 차단한다", () => {
  const provider = { id: "agy", name: "AGY", status: "cli", catalogStatus: "ready",
    modelOptions: [{ id: "future-high", efforts: [] }, { id: "configurable", efforts: ["low"] }],
    permissions: { chat: { supported: true } } };
  const build = (model, effort, record = provider) => buildAgentInvocation({ provider: record, model, effort, chatCwd: process.cwd() });
  for (const [model, effort] of [["deleted-model", "default"], ["future-high", "high"], ["configurable", "high"], ["default", "low"]]) {
    assert.equal(build(model, effort).ok, false);
    assert.equal(roomAgentFromCapability(provider, { model, effort }).available, false);
  }
  assert.equal(build("default", "default", { ...provider, catalogStatus: "unavailable" }).ok, false);
  const good = build("future-high", "default");
  assert.equal(good.ok, true);
  assert.ok(!good.argv.includes("--effort"));
  const defaults = build("default", "default");
  assert.ok(!defaults.argv.includes("--model"));
  assert.ok(!defaults.argv.includes("--effort"));
  assert.deepEqual(normalizeCatalog([{ id: "default" }, { id: "unsafe & flag" }]), []);
});
