// Chat runs have their own lifecycle, independent of native CLI log watchers.
class ChatActivity {
  constructor(onChange = () => {}) {
    this.runs = new Map();
    this.state = null;
    this.onChange = onChange;
  }

  typing(sessionId, { agentId, busy }) {
    const key = `${sessionId}:${agentId}`;
    if (busy) {
      if (!this.runs.has(key)) this.runs.set(key, "review");
    } else this.runs.delete(key);
    this.publish();
  }

  event(sessionId, { agentId, kind, label }) {
    const key = `${sessionId}:${agentId}`;
    if (!this.runs.has(key)) return;
    if (["delta", "final"].includes(kind)) this.runs.set(key, "running");
    else if (kind === "error") this.runs.set(key, "failed");
    else if (kind === "status") this.runs.set(key, /생각|확인|검색|읽기/.test(label || "") ? "review" : "running");
    this.publish();
  }

  clear() { this.runs.clear(); this.publish(); }

  publish() {
    const values = [...this.runs.values()];
    const next = values.includes("running") ? "running" : values.includes("review") ? "review" : values[0] || null;
    if (next === this.state) return;
    this.state = next;
    this.onChange(next);
  }
}

module.exports = { ChatActivity };
