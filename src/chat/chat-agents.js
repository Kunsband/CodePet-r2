// 채팅방 에이전트 구성 유틸.
// CLI 탐지/검증은 src/providers/provider-capabilities.js 한 곳에서만 수행하고,
// 이 모듈은 탐지 결과(capability record)와 세션별 설정을 방 참가자로 합칩니다.

const { GROUP_ALIASES } = require("./chat-agent-identity");
const { selectionError } = require("../providers/provider-model-catalog");

function concreteModelOptions(record) {
  return (record.modelOptions || []).filter((option) => option.id && option.id !== "default");
}

function resolvedModel(record, configured) {
  return configured || "default";
}

function resolvedEffort(record, model, configured) {
  return configured || "default";
}

// capability record + 세션 설정 → 채팅방 참가자.
// commandPath/needsShell 같은 실행 정보는 여기서 제거되어 방/renderer로 가지 않습니다.
function roomAgentFromCapability(record, config = {}, permissionMode = "chat") {
  const model = resolvedModel(record, config.model);
  const effort = resolvedEffort(record, model, config.effort);
  const invalidSelection = selectionError(record, model, effort);
  const permission = record.permissions?.[permissionMode];
  const modeSupported = permission?.supported !== false;
  return {
    id: record.id,
    providerId: record.providerId || record.id,
    accountLabel: record.accountLabel || "",
    name: config.name || record.name,
    mention: config.mention || record.id,
    color: record.color,
    aliases: [...new Set([config.mention || record.id, record.id, ...(record.aliases || [])])],
    available: record.status === "cli" && modeSupported && !invalidSelection,
    enabled: config.enabled !== false,
    reason: modeSupported
      ? record.reason || invalidSelection
      : permissionMode === "chat"
        ? "채팅 실행 통합이 아직 준비되지 않았습니다."
        : permission?.reason || `${record.name}는 이 권한 모드를 지원하지 않습니다.`,
    version: record.version || "",
    model,
    effort,
    autoApprove: (record.providerId || record.id) === "grok" && permissionMode === "workspace-write"
      ? false
      : Boolean(config.autoApprove),
  };
}

function roomAgentsFromCapabilities(records, sessionAgents = {}, permissionMode = "chat") {
  return (records || []).map((record) =>
    roomAgentFromCapability(record, sessionAgents[record.id] || {}, permissionMode)
  );
}

module.exports = {
  GROUP_ALIASES,
  concreteModelOptions,
  resolvedModel,
  resolvedEffort,
  roomAgentFromCapability,
  roomAgentsFromCapabilities,
};
