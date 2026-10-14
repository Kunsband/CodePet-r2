const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { redactSensitiveText } = require("./chat-run-diagnostics");

const RUN_BYTES = 64 * 1024;
const SESSION_BYTES = 1024 * 1024;
const TOTAL_BYTES = 16 * 1024 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_BYTES = 8 * 1024;
const TRACE_FILE = /^[0-9a-f-]{36}\.jsonl$/;
const AGENTS = new Set(["codex", "claude", "agy", "grok"]);

function clipUtf8(text, bytes) {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  return `${buffer.subarray(0, Math.max(0, bytes - 16)).toString("utf8").replace(/\uFFFD$/, "")}…[truncated]`;
}

function safeText(value, bytes = 2048) {
  let text = String(value ?? "");
  // Bound scanning work even when a CLI supplies megabytes of tool output.
  text = text.slice(0, 12000);
  text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*/g, "[REDACTED PRIVATE KEY]");
  text = redactSensitiveText(text).replace(
    /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\r\n]+)/gi,
    "$1[REDACTED]"
  );
  return clipUtf8(text, bytes);
}

function safeValue(value, depth = 0, budget = { bytes: 3000, nodes: 80 }) {
  if (--budget.nodes < 0) return "[omitted]";
  if (typeof value === "string") {
    if (budget.bytes < 32) return "[omitted]";
    const text = safeText(value, Math.min(2048, budget.bytes));
    budget.bytes -= Buffer.byteLength(text);
    return text;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (!value || depth >= 3) return "[omitted]";
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => safeValue(item, depth + 1, budget));
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 16)) {
    if (item === undefined || /thinking|reasoning|signature|image|base64/i.test(key)) continue;
    result[safeText(key, 80)] = /key|token|secret|password|credential|authorization/i.test(key)
      ? "[REDACTED]" : safeValue(item, depth + 1, budget);
  }
  return result;
}

class TraceCollector {
  constructor({ now = Date.now, maxBytes = RUN_BYTES - 2048 } = {}) {
    this.now = now;
    this.halfBytes = Math.floor(maxBytes / 2);
    this.head = [];
    this.tail = [];
    this.headBytes = 0;
    this.tailBytes = 0;
    this.sequence = 0;
    this.workEvents = 0;
    this.tailStarted = false;
    this.truncated = false;
  }

  add(event) {
    if (!event || !["tool-call", "tool-result", "file-change", "error", "trace-read"].includes(event.kind)) return;
    if (event.kind !== "trace-read") this.workEvents += 1;
    const clean = safeValue(event);
    let line = JSON.stringify({ ...clean, seq: this.sequence++, ts: this.now() });
    if (Buffer.byteLength(line) > 4096) {
      line = JSON.stringify({ kind: event.kind, seq: this.sequence - 1, ts: this.now(), detail: safeText(line, 3000), truncated: true });
    }
    line += "\n";
    const size = Buffer.byteLength(line);
    if (!this.tailStarted && this.headBytes + size <= this.halfBytes && this.head.length < 128) {
      this.head.push(line);
      this.headBytes += size;
      return;
    }
    this.tailStarted = true;
    this.tail.push(line);
    this.tailBytes += size;
    while (this.tailBytes > this.halfBytes || this.tail.length > 128) {
      this.tailBytes -= Buffer.byteLength(this.tail.shift());
      this.truncated = true;
    }
  }

  lines() { return [...this.head, ...this.tail]; }
}

class ChatTraceStore {
  constructor({ root, now = Date.now, hasSession = () => true, totalBytes = TOTAL_BYTES, sessionBytes = SESSION_BYTES, maxRuns = 256, sessionRuns = 16, retentionMs = RETENTION_MS }) {
    this.root = path.join(root, "traces");
    this.now = now;
    this.hasSession = hasSession;
    this.totalBytes = totalBytes;
    this.sessionBytes = sessionBytes;
    this.maxRuns = maxRuns;
    this.sessionRuns = sessionRuns;
    this.retentionMs = retentionMs;
    this.entries = [];
    this.ready = null;
    this.queue = Promise.resolve();
  }

  async init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(this.root)).isSymbolicLink()) throw new Error("Trace directory must not be a link");
      for (const file of await fs.readdir(this.root, { withFileTypes: true })) {
        if (!file.isFile() || !TRACE_FILE.test(file.name)) continue;
        const target = path.join(this.root, file.name);
        let handle;
        let valid = false;
        try {
          handle = await fs.open(target, "r");
          const stat = await handle.stat();
          if (stat.size > RUN_BYTES) continue;
          const buffer = Buffer.alloc(2048);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const meta = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]);
          if (meta.v !== 1 || `${meta.id}.jsonl` !== file.name || !AGENTS.has(meta.agentId)
            || typeof meta.sessionId !== "string" || meta.sessionId.length > 100 || !Number.isFinite(meta.ts)
            || !["completed", "failed", "cancelled"].includes(meta.status)
            || !Number.isInteger(meta.count) || meta.count < 0 || meta.count > 256) continue;
          this.entries.push({ ...meta, bytes: stat.size });
          valid = true;
        } catch { /* Incomplete crash leftovers are not exposed to agents. */ }
        finally {
          await handle?.close();
          if (!valid) await fs.unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
        }
      }
      await this.prune();
    })();
    return this.ready;
  }

  serial(work) {
    const next = this.queue.then(async () => { await this.init(); return work(); });
    this.queue = next.catch(() => {});
    return next;
  }

  async remove(entry) {
    await fs.unlink(path.join(this.root, `${entry.id}.jsonl`)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    this.entries = this.entries.filter((item) => item.id !== entry.id);
  }

  async prune(incoming = null) {
    let total = incoming?.bytes || 0;
    let count = incoming ? 1 : 0;
    const sessions = new Map();
    if (incoming) sessions.set(incoming.sessionId, { bytes: incoming.bytes, count: 1 });
    this.entries.sort((a, b) => b.ts - a.ts);
    for (const entry of [...this.entries]) {
      const session = sessions.get(entry.sessionId) || { bytes: 0, count: 0 };
      if (this.now() - entry.ts > this.retentionMs || !this.hasSession(entry.sessionId)
        || total + entry.bytes > this.totalBytes || count >= this.maxRuns
        || session.bytes + entry.bytes > this.sessionBytes || session.count >= this.sessionRuns) {
        await this.remove(entry);
      } else {
        total += entry.bytes;
        count += 1;
        session.bytes += entry.bytes;
        session.count += 1;
        sessions.set(entry.sessionId, session);
      }
    }
  }

  save({ sessionId, agentId, runId, status, collector }) {
    return this.serial(async () => {
      if (!this.hasSession(sessionId) || !AGENTS.has(agentId) || !collector.workEvents) return null;
      const lines = collector.lines();
      const meta = { v: 1, id: randomUUID(), sessionId, agentId, runId: safeText(runId, 200), ts: this.now(), status, count: lines.length, truncated: collector.truncated };
      const data = `${JSON.stringify(meta)}\n${lines.join("")}`;
      const bytes = Buffer.byteLength(data);
      if (bytes > RUN_BYTES || bytes > this.totalBytes || bytes > this.sessionBytes) return null;
      await this.prune({ sessionId, bytes });
      const file = path.join(this.root, `${meta.id}.jsonl`);
      try { await fs.writeFile(file, data, { flag: "wx", mode: 0o600 }); }
      catch (error) { await fs.unlink(file).catch(() => {}); throw error; }
      this.entries.unshift({ ...meta, bytes });
      return meta.id;
    });
  }

  list(sessionId, offset = 0) {
    return this.serial(async () => {
      await this.prune();
      return this.entries.filter((entry) => entry.sessionId === sessionId).slice(offset, offset + 4)
        .map(({ id, agentId, ts, status, count, truncated }) => ({ id, agentId, ts, status, count, truncated }));
    });
  }

  read(sessionId, request) {
    return this.serial(async () => {
      await this.prune();
      const offset = Number.isInteger(request.offset) && request.offset >= 0 ? request.offset : 0;
      const entries = this.entries.filter((entry) => entry.sessionId === sessionId);
      if (request.list === true) {
        return { traces: entries.slice(offset, offset + 4).map(({ id, agentId, ts, status, count, truncated }) => ({ id, agentId, ts, status, count, truncated })), nextOffset: offset + 4 < entries.length ? offset + 4 : null };
      }
      const entry = entries.find((item) => request.id ? item.id === request.id : item.agentId === request.agent);
      if (!entry) return { error: "No saved trace in this chat (missing or expired)." };
      const file = path.join(this.root, `${entry.id}.jsonl`);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RUN_BYTES) return { error: "Trace unavailable." };
      const lines = (await fs.readFile(file, "utf8")).trimEnd().split("\n").slice(1);
      let bytes = 0;
      const events = [];
      let cursor = offset;
      for (const line of lines.slice(offset)) {
        if (Buffer.byteLength(line) > PAGE_BYTES) { cursor += 1; continue; }
        if (bytes + Buffer.byteLength(line) > PAGE_BYTES) break;
        cursor += 1;
        bytes += Buffer.byteLength(line);
        try { events.push(JSON.parse(line)); } catch { /* Skip a torn record and keep moving. */ }
      }
      return { id: entry.id, agent: entry.agentId, status: entry.status, truncated: entry.truncated, events, nextOffset: cursor < lines.length ? cursor : null };
    });
  }

  discard(sessionId) {
    return this.serial(async () => {
      for (const entry of [...this.entries]) if (entry.sessionId === sessionId) await this.remove(entry);
    });
  }
}

module.exports = { ChatTraceStore, TraceCollector, safeText, safeValue, RUN_BYTES, SESSION_BYTES, TOTAL_BYTES, RETENTION_MS, PAGE_BYTES };
