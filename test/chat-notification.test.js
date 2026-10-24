const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CHAT_NOTIFICATION_ACTION,
  buildChatNotificationBubble,
  chatNotificationActivityKey,
} = require("../src/chat-notification");
const { ActivityBubbleState } = require("../src/activity-bubble-state");

test("CodePet 채팅 알림은 저장된 방을 여는 내부 action을 사용한다", () => {
  const bubble = buildChatNotificationBubble({
    sessionId: "room-1",
    agentId: "codex",
    agentName: "Codex",
    kind: "completed",
    text: "완료했습니다.",
  });

  assert.equal(bubble.title, "Codex · 작업 완료");
  assert.equal(bubble.busy, false);
  assert.equal(bubble.terminal, true);
  assert.equal(bubble.primaryAction.id, CHAT_NOTIFICATION_ACTION);
  assert.deepEqual(bubble.primaryAction.payload, { sessionId: "room-1" });
  assert.equal(JSON.stringify(bubble).includes("codex://"), false);
});

test("작업 중, 진행, 대기 알림은 활성 작업 말풍선으로 쓸 수 있다", () => {
  for (const kind of ["working", "progress", "waiting"]) {
    const bubble = buildChatNotificationBubble({ sessionId: "room-1", kind });
    assert.equal(bubble.busy, true);
    assert.equal(bubble.terminal, false);
  }
});

test("모르는 종류 또는 session 없는 알림은 무시한다", () => {
  assert.equal(buildChatNotificationBubble({ sessionId: "room-1", kind: "unknown" }), null);
  assert.equal(buildChatNotificationBubble({ kind: "completed" }), null);
});

test("같은 방의 한 참가자가 완료·취소되어도 다른 참가자의 활성 작업은 남는다", () => {
  const activity = new ActivityBubbleState();
  const terra = chatNotificationActivityKey("room-1", "codex_terra");
  const luna = chatNotificationActivityKey("room-1", "codex_luna");
  assert.notEqual(terra, luna);

  activity.upsert(terra, { kind: "activity", title: "Terra · 작업 중" });
  activity.upsert(luna, { kind: "activity", title: "Luna · 작업 중" });

  // typing 종료와 completion은 같은 참가자 키를 두 번 제거해도 안전해야 합니다.
  activity.remove(terra);
  activity.remove(terra);

  assert.equal(activity.size, 1);
  assert.deepEqual(activity.getVisibleThreadIds(), [luna]);
  assert.equal(activity.toBubbleData().title, "Luna · 작업 중");
});
