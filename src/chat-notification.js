// 채팅 실행기는 watcher rollout과 독립적이므로, 말풍선 표현도 작은 순수 함수로 분리합니다.
// action은 외부 codex:// 링크가 아니라 CodePet의 저장된 대화방을 여는 내부 IPC 경로입니다.
const CHAT_NOTIFICATION_ACTION = "chat-session:open";

const KIND_LABELS = Object.freeze({
  working: { title: "작업 시작", statusText: "CodePet이 작업을 시작했습니다.", busy: true },
  progress: { title: "작업 중", statusText: "CodePet이 작업을 진행하고 있습니다.", busy: true },
  waiting: { title: "입력 대기", statusText: "CodePet이 사용자 확인을 기다리고 있습니다.", busy: true },
  completed: { title: "작업 완료", statusText: "CodePet 작업이 완료되었습니다.", busy: false },
  failed: { title: "작업 실패", statusText: "CodePet 작업 중 문제가 발생했습니다.", busy: false },
  cancelled: { title: "작업 취소", statusText: "CodePet 작업이 취소되었습니다.", busy: false },
});

// 한 대화방에는 여러 agent run이 동시에 존재할 수 있으므로 방 id만으로는 부족합니다.
// IPC에서 전달한 영속 agent id와 함께 상태 키를 만들어, 한 agent의 정리가 다른 agent를 지우지 않게 합니다.
function chatNotificationActivityKey(sessionId, agentId) {
  const room = typeof sessionId === "string" ? sessionId.trim() : "";
  const agent = typeof agentId === "string" ? agentId.trim() : "";
  if (!room || !agent) return null;
  return `chat:${encodeURIComponent(room)}:${encodeURIComponent(agent)}`;
}

function buildChatNotificationBubble(notification) {
  const sessionId = typeof notification?.sessionId === "string" ? notification.sessionId.trim() : "";
  const detail = KIND_LABELS[notification?.kind];
  if (!sessionId || !detail) return null;

  const agentName = typeof notification.agentName === "string" && notification.agentName.trim()
    ? notification.agentName.trim()
    : "CodePet";
  const text = typeof notification.text === "string" && notification.text.trim()
    ? notification.text.trim()
    : detail.statusText;

  return {
    kind: "activity",
    title: `${agentName} · ${detail.title}`,
    busy: detail.busy,
    text,
    statusText: detail.statusText,
    primaryAction: {
      id: CHAT_NOTIFICATION_ACTION,
      payload: { sessionId },
    },
    clickHint: "클릭해서 CodePet 대화 열기",
    terminal: !detail.busy,
  };
}

module.exports = {
  CHAT_NOTIFICATION_ACTION,
  buildChatNotificationBubble,
  chatNotificationActivityKey,
};
