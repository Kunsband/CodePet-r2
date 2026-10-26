const MENTION_PATTERN = /@([\p{L}\p{N}_-]+)/gu;

function maskNonCallingText(text) {
  let fenced = false;
  return String(text || "")
    .split(/(\r?\n)/)
    .map((line, index) => {
      if (index % 2) return line;
      // Match chat-markdown.js's line-based fence rules; retain source offsets.
      const delimiter = fenced ? /^```\s*$/.test(line) : /^```([A-Za-z0-9_+-]*)\s*$/.test(line);
      const masked = fenced || delimiter;
      if (delimiter) fenced = !fenced;
      return masked ? " ".repeat(line.length) : line;
    })
    .join("")
    .replace(/`[^`\r\n]*`/g, (match) => " ".repeat(match.length));
}

// "@codex야" 처럼 한국어 조사가 붙어도 별칭을 인식합니다.
// 별칭 뒤에 영문/숫자가 이어지면(@claudette) 다른 이름으로 보고 제외합니다.
function tokenMatchesAlias(token, alias) {
  const lowered = token.toLowerCase();
  if (!lowered.startsWith(alias.toLowerCase())) return false;
  const rest = token.slice(alias.length);
  return rest === "" || !/^[a-z0-9_-]/i.test(rest);
}

function parseMentions(text, agents, groupAliases = []) {
  const source = maskNonCallingText(text).normalize("NFC");
  const mentioned = [];
  const seen = new Set();
  // Exact names win over Korean particle matching; longer names win over prefixes.
  const aliases = [
    ...groupAliases.map((alias) => ({ alias, group: true })),
    ...agents.flatMap((agent) => (agent.aliases || []).map((alias) => ({ alias, agent }))),
  ].sort((left, right) => right.alias.length - left.alias.length);

  const add = (agent) => {
    if (!seen.has(agent.id)) {
      seen.add(agent.id);
      mentioned.push(agent.id);
    }
  };

  for (const match of source.matchAll(MENTION_PATTERN)) {
    const previous = match.index > 0 ? source[match.index - 1] : "";
    // 이메일/식별자 안의 @는 호출이 아닙니다. 독립된 @멘션만 허용합니다.
    if (previous && /[\p{L}\p{N}_@-]/u.test(previous)) continue;
    const token = match[1];
    const target = aliases.find(({ alias }) => token.toLowerCase() === alias.toLowerCase())
      || aliases.find(({ alias }) => tokenMatchesAlias(token, alias));
    if (target?.group) {
      for (const agent of agents) add(agent);
      continue;
    }
    if (target?.agent) add(target.agent);
  }
  return mentioned;
}

module.exports = { parseMentions, tokenMatchesAlias, maskNonCallingText };
