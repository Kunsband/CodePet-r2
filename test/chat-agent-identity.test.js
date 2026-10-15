const test = require("node:test");
const assert = require("node:assert/strict");
const { identityPatch, GROUP_ALIASES } = require("../src/chat/chat-agent-identity");
const { roomAgentFromCapability } = require("../src/chat/chat-agents");
const { parseMentions } = require("../src/chat/chat-mention");

const agents = [
  { id: "codex", aliases: ["민", "codex"] },
  { id: "claude", aliases: ["민수", "claude"], enabled: false },
  { id: "agy", aliases: ["agy", "antigravity"], available: false },
];

test("nickname validation normalizes input and rejects reserved or occupied handles atomically", () => {
  assert.deepEqual(identityPatch({ name: " 검토 담당 ", mention: " @지피티 " }, "codex", agents), { name: "검토 담당", mention: "지피티" });
  assert.deepEqual(identityPatch({ name: "", mention: "" }, "codex", agents), { name: "", mention: "" });
  assert.equal(identityPatch({ mention: "CODEX" }, "codex", agents).mention, "CODEX");
  for (const mention of [...GROUP_ALIASES, "민수", "CLAUDE", "Antigravity", "두 이름", "@@별명", "별명!", "가".repeat(41), 42]) {
    assert.throws(() => identityPatch({ name: "바뀌면 안 됨", mention }, "codex", agents));
  }
  for (const name of ["한\n줄", "숨김\u202e", "가".repeat(41), null]) {
    assert.throws(() => identityPatch({ name }, "codex", agents));
  }
});

test("custom identities retain provider aliases and independent execution settings", () => {
  const record = { id: "agy", name: "Antigravity", status: "cli", aliases: ["agy", "antigravity"] };
  const agent = roomAgentFromCapability(record, { name: "검토 담당", mention: "민수", enabled: false });
  assert.equal(agent.id, "agy");
  assert.equal(agent.providerId, "agy");
  assert.equal(agent.name, "검토 담당");
  assert.equal(agent.mention, "민수");
  assert.equal(agent.enabled, false);
  assert.deepEqual(parseMentions("@민수 @agy @antigravity", [agent]), ["agy"]);
  const reset = roomAgentFromCapability(record, { name: "", mention: "" });
  assert.equal(reset.name, "Antigravity");
  assert.equal(reset.mention, "agy");
});

test("Korean custom handles use the longest match and preserve particles, groups, and code exclusions", () => {
  assert.deepEqual(parseMentions("@민수 @민수야 @민이 @민수한테", agents), ["claude", "codex"]);
  const roster = [...agents, { id: "grok", aliases: ["모두미", "grok"] }];
  assert.deepEqual(parseMentions("@모두미야", roster, GROUP_ALIASES), ["grok"]);
  assert.deepEqual(parseMentions("@모두", roster, GROUP_ALIASES), roster.map((agent) => agent.id));
  assert.deepEqual(parseMentions("`@민수` ```\n@민\n``` mail@민수.test", agents), []);
  assert.deepEqual(parseMentions("@민수".normalize("NFD"), agents), ["claude"]);
});
