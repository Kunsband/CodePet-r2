const GROUP_ALIASES = Object.freeze(["all", "everyone", "모두", "전원", "얘들아"]);

function agentMention(agent) {
  return agent?.mention || agent?.id || "";
}

function aliasKey(value) {
  return String(value).normalize("NFC").toLowerCase();
}

function identityPatch(patch, agentId, agents) {
  const next = {};
  if (Object.hasOwn(patch || {}, "name")) {
    if (typeof patch.name !== "string") throw new Error("표시 이름을 입력해 주세요.");
    const name = patch.name.normalize("NFC").trim();
    if (name.length > 40 || /[\p{Cc}\p{Cf}]/u.test(name)) {
      throw new Error("표시 이름은 줄바꿈 없이 40자 이내로 입력해 주세요.");
    }
    next.name = name;
  }
  if (Object.hasOwn(patch || {}, "mention")) {
    if (typeof patch.mention !== "string") throw new Error("호출명을 입력해 주세요.");
    const mention = patch.mention.normalize("NFC").trim().replace(/^@/, "");
    if (mention && (mention.length > 40 || !/^[\p{L}\p{N}_-]+$/u.test(mention))) {
      throw new Error("호출명은 문자·숫자·밑줄·하이픈으로 40자 이내로 입력해 주세요.");
    }
    const key = aliasKey(mention || agentId);
    if (GROUP_ALIASES.some((alias) => aliasKey(alias) === key)
      || agents.some((agent) => agent.id !== agentId
        && [agent.id, ...(agent.aliases || [])].some((alias) => aliasKey(alias) === key))) {
      throw new Error("이미 사용 중인 호출명입니다.");
    }
    next.mention = mention;
  }
  return next;
}

module.exports = { GROUP_ALIASES, agentMention, aliasKey, identityPatch };
