const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { writeJsonAtomic } = require("./chat-store");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A tiny cursor per participant, separate from renderer-visible metadata and
// the append-only transcript. Native histories remain owned by each CLI.
class NativeSessionLink {
  constructor(store, sessionId, agentId, scope) {
    this.store = store;
    this.sessionId = sessionId;
    this.agentId = agentId;
    this.file = path.join(store.sessionDir(sessionId), "native-sessions.json");
    this.scope = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
    this.token = randomUUID();
    const previous = this.read()[agentId];
    if (previous && (typeof previous !== "object" || typeof previous.scope !== "string" ||
        (previous.cliSessionId !== null && !UUID.test(previous.cliSessionId)))) {
      throw new Error("CLI 세션 연결 정보가 손상되었습니다.");
    }
    this.cliSessionId = previous?.scope === this.scope && UUID.test(previous.cliSessionId) ? previous.cliSessionId : null;
    this.lastMessageId = this.cliSessionId ? previous.lastMessageId || null : null;
    this.write(true);
  }

  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
      throw new Error("Invalid native session index");
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("CLI 세션 연결 정보를 읽지 못했습니다.");
    }
    return {};
  }

  write(begin = false) {
    const meta = this.store.readMeta(this.sessionId);
    if (!meta || this.store.readOnly || meta.readOnly) return false;
    const links = this.read();
    // A cancelled/deleted run cannot overwrite a newer run's session cursor.
    if (!begin && links[this.agentId]?.token !== this.token) return false;
    links[this.agentId] = { scope: this.scope, token: this.token,
      cliSessionId: this.cliSessionId, lastMessageId: this.lastMessageId };
    writeJsonAtomic(this.file, links);
    return true;
  }

  observe(id) {
    if (!UUID.test(id)) throw new Error("CLI 세션 ID가 올바르지 않습니다.");
    if (this.cliSessionId && this.cliSessionId !== id) {
      throw new Error("CLI가 기존 세션을 이어받지 못했습니다. 세션 기록을 확인해 주세요.");
    }
    this.cliSessionId = id;
    this.write();
  }

  delivered(messageId) {
    if (!this.cliSessionId || !messageId) return;
    this.lastMessageId = messageId;
    this.write();
  }
}

module.exports = { NativeSessionLink };
