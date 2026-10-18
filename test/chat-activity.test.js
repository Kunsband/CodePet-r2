const test = require("node:test");
const assert = require("node:assert/strict");
const { ChatActivity } = require("../src/chat/chat-activity");
const { isActivityOnlyReason, hasBlockingMovementReasons } = require("../src/movement-policy");

test("chat pet activity aggregates participants and rooms without returning idle early", () => {
  const states = [];
  const activity = new ChatActivity((state) => states.push(state));
  activity.typing("a", { agentId: "codex", busy: true });
  activity.typing("b", { agentId: "codex", busy: true });
  activity.event("a", { agentId: "codex", kind: "status", label: "실행: npm test" });
  for (let i = 0; i < 100; i++) activity.event("a", { agentId: "codex", kind: "delta", text: "text" });
  assert.deepEqual(states, ["review", "running"]);
  activity.typing("a", { agentId: "codex", busy: false });
  assert.equal(activity.state, "review");
  activity.typing("b", { agentId: "codex", busy: false });
  assert.equal(activity.state, null);
  activity.event("a", { agentId: "codex", kind: "delta", text: "late" });
  assert.equal(activity.state, null);
});

test("clearing chat activity resets the pet and does not block movement", () => {
  const states = [];
  const activity = new ChatActivity((state) => states.push(state));
  activity.typing("a", { agentId: "claude", busy: true });
  activity.clear();
  assert.deepEqual(states, ["review", null]);
  assert.equal(isActivityOnlyReason("chat"), true);
  assert.equal(hasBlockingMovementReasons(new Set(["chat", "codex"])), false);
  assert.equal(hasBlockingMovementReasons(new Set(["chat", "drag"])), true);
});
