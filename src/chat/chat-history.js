const fs = require("node:fs");

const HISTORY_PAGE_SIZE = 50;
const HISTORY_PAGE_BYTES = 1024 * 1024;
const READ_BLOCK_BYTES = 64 * 1024;

// JSONL 파일 끝에서 필요한 구간만 읽습니다. 바이트 커서는 새 메시지가
// 추가되어도 변하지 않으며 UTF-8은 한 줄을 조립한 후 디코딩합니다.
function* reverseLines(fd, before) {
  let position = before;
  let parts = [];
  while (position > 0) {
    const start = Math.max(0, position - READ_BLOCK_BYTES);
    const block = Buffer.allocUnsafe(position - start);
    const read = fs.readSync(fd, block, 0, block.length, start);
    let end = read;
    for (let i = read - 1; i >= 0; i -= 1) {
      if (block[i] !== 10) continue;
      parts.push(block.subarray(i + 1, end));
      yield { raw: Buffer.concat(parts.reverse()), before: start + i + 1 };
      parts = [];
      end = i;
    }
    if (end > 0) parts.push(block.subarray(0, end));
    position = start;
  }
  if (parts.length) yield { raw: Buffer.concat(parts.reverse()), before: 0 };
}

function readMessagePage(file, {
  before = null,
  limit = HISTORY_PAGE_SIZE,
  maxBytes = HISTORY_PAGE_BYTES,
  filter = () => true,
} = {}) {
  if (before !== null && (!Number.isSafeInteger(before) || before < 0)) {
    throw new Error("대화 기록 위치가 올바르지 않습니다.");
  }
  const count = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : HISTORY_PAGE_SIZE;
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    if (error.code === "ENOENT") return { messages: [], before: null, hasMore: false };
    throw error;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (before !== null && before > size) throw new Error("대화 기록 위치가 변경되었습니다. 채팅방을 다시 열어 주세요.");
    const messages = [];
    let cursor = null;
    let bytes = 0;
    let hasMore = false;
    for (const line of reverseLines(fd, before ?? size)) {
      let event;
      try { event = JSON.parse(line.raw.toString("utf8")); } catch { continue; }
      const message = event?.kind === "message" ? event.message : null;
      if (!message || typeof message !== "object" || Array.isArray(message) || !filter(message)) continue;
      if (messages.length >= count || (messages.length > 0 && bytes + line.raw.length > maxBytes)) {
        hasMore = true;
        break;
      }
      messages.push(message);
      bytes += line.raw.length;
      cursor = line.before;
    }
    return { messages: messages.reverse(), before: cursor, hasMore };
  } finally {
    fs.closeSync(fd);
  }
}

// Read only messages not yet delivered to this native session. The end ID fixes
// the broadcast snapshot even if another participant finishes while preparing.
function readMessageRange(file, { afterId, throughId, agentId }) {
  if (!afterId || !throughId) return null;
  if (afterId === throughId) return [];
  const fd = fs.openSync(file, "r");
  try {
    let within = false;
    const messages = [];
    for (const line of reverseLines(fd, fs.fstatSync(fd).size)) {
      let event;
      try { event = JSON.parse(line.raw.toString("utf8")); } catch { continue; }
      const message = event?.kind === "message" ? event.message : null;
      if (!message) continue;
      if (message.id === throughId) within = true;
      if (!within) continue;
      if (message.id === afterId) return messages.reverse();
      // This participant's own answers already live in the native session.
      if (message.authorType !== "system" && !message.error &&
          !(message.authorType === "agent" && message.author === agentId)) messages.push(message);
    }
    return null; // An anchor was removed: never silently skip missing context.
  } finally { fs.closeSync(fd); }
}

module.exports = { readMessagePage, readMessageRange, HISTORY_PAGE_SIZE };
