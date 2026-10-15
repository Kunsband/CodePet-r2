const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { gzip, gunzip } = require("node:zlib");
const { promisify } = require("node:util");
const { createInterface } = require("node:readline");
const { redactSensitiveText } = require("./chat-run-diagnostics");

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const PAGE_BYTES = 8 * 1024;
const RECORD_BYTES = 4 * 1024;
const RECORDS_PER_CHUNK = 128;
const RECENT_BYTES = 8 * 1024;
const UUID = /^[0-9a-f-]{36}$/;
const AGENTS = new Set(["codex", "claude", "agy", "grok"]);
function validTraceAgent(id) {
  return typeof id === "string" && (AGENTS.has(id) || /^(?:codex|claude|agy|grok)-[1-9]\d{0,8}$/.test(id));
}

function safeText(value) {
  return redactSensitiveText(String(value ?? "").replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"))
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\r\n]+)/gi, "$1[REDACTED]");
}

function safeValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return safeText(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (!value || typeof value !== "object") return undefined;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = value.map(item => safeValue(item, seen));
  else {
    result = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || /thinking|reasoning|signature|image|base64/i.test(key)) continue;
      result[safeText(key)] = /key|token|secret|password|credential|authorization/i.test(key)
        ? "[REDACTED]" : safeValue(item, seen);
    }
  }
  seen.delete(value);
  return result;
}

// Fragment oversized JSON records losslessly; pagination is not a retention limit.
function splitUtf8(text, bytes) {
  const buffer = Buffer.from(text);
  const parts = [];
  for (let start = 0; start < buffer.length;) {
    let end = Math.min(start + bytes, buffer.length);
    while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
    parts.push(buffer.subarray(start, end).toString("utf8"));
    start = end;
  }
  return parts;
}

class TraceCollector {
  constructor({ now = Date.now, append = null, entry = null } = {}) {
    this.now = now;
    this.append = append;
    this.entry = entry;
    this.sequence = 0;
    this.workEvents = 0;
    this.recent = [];
    this.recentBytes = 0;
  }

  add(event) {
    if (!event || !["tool-call", "tool-result", "file-change", "error", "trace-read"].includes(event.kind)) return;
    if (event.kind !== "trace-read") this.workEvents++;
    const clean = { ...safeValue(event), seq: this.sequence++, ts: this.now() };
    const json = JSON.stringify(clean);
    const records = Buffer.byteLength(json) <= RECORD_BYTES ? [json + "\n"]
      : splitUtf8(json, 1536).map((data, part, parts) => JSON.stringify({ kind: "event-fragment", eventSeq: clean.seq, part, parts: parts.length, data }) + "\n");
    for (const line of records) {
      this.recent.push(line);
      this.recentBytes += Buffer.byteLength(line);
      while (this.recentBytes > RECENT_BYTES) this.recentBytes -= Buffer.byteLength(this.recent.shift());
    }
    return this.append?.(records);
  }

  lines() { return [...this.recent]; }
}

function publicMeta(entry) {
  const { id, agentId, ts, status, count, truncated = false } = entry;
  return { id, agentId, ts, status, count, truncated };
}

class ChatTraceStore {
  constructor({ root, now = Date.now, hasSession = () => true }) {
    this.root = path.join(root, "traces");
    this.now = now;
    this.hasSession = hasSession;
    this.entries = [];
    this.ready = null;
    this.queue = Promise.resolve();
  }

  directory(entry) { return path.join(this.root, entry.id); }
  chunkFile(entry, chunk, compressed = false) { return path.join(this.directory(entry), `${chunk}.jsonl${compressed ? ".gz" : ""}`); }

  async checkDirectory(entry) {
    const stat = await fs.lstat(this.directory(entry));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Trace directory must not be a link");
  }

  async readFile(file, zipped = false) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Trace file must not be a link");
    const data = await fs.readFile(file);
    return (zipped ? await decompress(data) : data).toString("utf8");
  }

  async writeMeta(entry) {
    await this.checkDirectory(entry);
    const { v, id, sessionId, agentId, runId, ts, status, count, truncated = false } = entry;
    const file = path.join(this.directory(entry), "meta.json");
    const temporary = file + `.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ v, id, sessionId, agentId, runId, ts, status, count, truncated }), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }

  validMeta(meta, id) {
    return meta?.id === id && validTraceAgent(meta.agentId) && typeof meta.sessionId === "string"
      && Number.isFinite(meta.ts) && Number.isSafeInteger(meta.count) && meta.count >= 0
      && ["running", "completed", "failed", "cancelled", "interrupted"].includes(meta.status);
  }

  async init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(this.root)).isSymbolicLink()) throw new Error("Trace directory must not be a link");
      for (const file of await fs.readdir(this.root, { withFileTypes: true })) {
        try {
          if (file.isDirectory() && UUID.test(file.name)) {
            const meta = JSON.parse(await this.readFile(path.join(this.root, file.name, "meta.json")));
            if (meta.v !== 2 || !this.validMeta(meta, file.name)) continue;
            if (meta.status === "running") {
              const chunks = (await fs.readdir(this.directory(meta))).filter(name => /^\d+\.jsonl(?:\.gz)?$/.test(name));
              const last = chunks.reduce((maximum, name) => Math.max(maximum, Number(name.split(".")[0])), -1);
              meta.count = last < 0 ? 0 : last * RECORDS_PER_CHUNK + (await this.readChunk(meta, last)).length;
              meta.status = "interrupted";
              await this.writeMeta(meta);
            }
            this.entries.push(meta);
          } else if (file.isFile() && /^[0-9a-f-]{36}\.jsonl$/.test(file.name)) {
            // Existing v1 traces remain readable, without their former expiry policy.
            const stream = createReadStream(path.join(this.root, file.name));
            const lines = createInterface({ input: stream, crlfDelay: Infinity });
            try {
              for await (const line of lines) {
                const meta = JSON.parse(line);
                if (meta.v === 1 && this.validMeta(meta, file.name.slice(0, -6))) this.entries.push({ ...meta, legacy: true });
                break;
              }
            } finally { lines.close(); stream.destroy(); }
          }
        } catch { /* Keep unreadable records on disk; never prune user history. */ }
      }
    })();
    return this.ready;
  }

  serial(work) {
    const next = this.queue.then(async () => { await this.init(); return work(); });
    this.queue = next.catch(() => {});
    return next;
  }

  async begin({ sessionId, agentId, runId }) {
    await this.init();
    if (!this.hasSession(sessionId) || !validTraceAgent(agentId)) throw new Error("Trace session unavailable");
    const entry = { v: 2, id: randomUUID(), sessionId, agentId, runId: safeText(runId), ts: this.now(), status: "running", count: 0, truncated: false };
    this.entries.unshift(entry);
    return new TraceCollector({ now: this.now, entry, append: records => this.append(entry, records) });
  }

  append(entry, records) {
    if (entry.discarded) return;
    (entry.pending ||= []).push(...records);
    if (!entry.flushing) {
      // Coalesce the events in a stdout chunk into one filesystem batch.
      entry.flushing = Promise.resolve().then(() => {
        const batch = entry.pending;
        entry.pending = [];
        entry.flushing = null;
        return this.serial(async () => {
          if (entry.discarded || !this.hasSession(entry.sessionId)) return;
          if (!entry.created) {
            await fs.mkdir(this.directory(entry), { mode: 0o700 });
            entry.created = true;
            await this.writeMeta(entry);
          }
          for (let start = 0; start < batch.length;) {
            await this.checkDirectory(entry);
            const chunk = Math.floor(entry.count / RECORDS_PER_CHUNK);
            const take = Math.min(RECORDS_PER_CHUNK - entry.count % RECORDS_PER_CHUNK, batch.length - start);
            const file = this.chunkFile(entry, chunk);
            const existing = await fs.lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; });
            if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Trace file must not be a link");
            await fs.appendFile(file, batch.slice(start, start + take).join(""), { mode: 0o600 });
            entry.count += take;
            start += take;
            if (entry.count % RECORDS_PER_CHUNK === 0) await this.seal(entry, chunk);
          }
          await this.writeMeta(entry);
        });
      });
      entry.flushing.catch(error => { entry.writeError = error; });
    }
    return entry.flushing;
  }

  async seal(entry, chunk) {
    await this.checkDirectory(entry);
    const file = this.chunkFile(entry, chunk);
    const data = await this.readFile(file);
    const temporary = file + `.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, await compress(data, { level: 1 }), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, file + ".gz");
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    await fs.unlink(file);
  }

  async save({ collector, status }) {
    const entry = collector.entry;
    if (!entry) return null;
    await entry.flushing;
    return this.serial(async () => {
      if (entry.discarded || !this.hasSession(entry.sessionId)) return null;
      if (entry.writeError) throw entry.writeError;
      if (!collector.workEvents) {
        this.entries = this.entries.filter(item => item !== entry);
        if (entry.created) await fs.rm(this.directory(entry), { recursive: true, force: true });
        return null;
      }
      if (entry.count % RECORDS_PER_CHUNK) await this.seal(entry, Math.floor(entry.count / RECORDS_PER_CHUNK));
      entry.status = status;
      await this.writeMeta(entry);
      return entry.id;
    });
  }

  sessionEntries(sessionId) {
    return this.hasSession(sessionId) ? this.entries.filter(entry => entry.sessionId === sessionId && !entry.discarded).sort((a, b) => b.ts - a.ts) : [];
  }

  async flushPending(sessionId) {
    await Promise.all(this.entries.filter(entry => entry.sessionId === sessionId).map(entry => entry.flushing));
  }

  async list(sessionId, offset = 0) {
    await this.flushPending(sessionId);
    return this.serial(() => this.sessionEntries(sessionId).slice(offset, offset + 4).map(publicMeta));
  }

  async readChunk(entry, chunk) {
    await this.checkDirectory(entry);
    let text;
    try { text = await this.readFile(this.chunkFile(entry, chunk, true), true); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      text = await this.readFile(this.chunkFile(entry, chunk));
    }
    const records = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { records.push(JSON.parse(line)); } catch { /* A crash can leave the last write incomplete. */ }
    }
    return records;
  }

  async legacyPage(entry, offset) {
    const file = path.join(this.root, `${entry.id}.jsonl`);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Trace unavailable");
    const stream = createReadStream(file);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const events = [];
    let index = -1, bytes = 0;
    try {
      for await (const line of lines) {
        if (index++ < offset) continue;
        if (events.length && bytes + Buffer.byteLength(line) > PAGE_BYTES) break;
        events.push(JSON.parse(line));
        bytes += Buffer.byteLength(line);
      }
    } finally { lines.close(); stream.destroy(); }
    return events;
  }

  async read(sessionId, request) {
    await this.flushPending(sessionId);
    return this.serial(async () => {
      let offset = Number.isSafeInteger(request.offset) && request.offset >= 0 ? request.offset : 0;
      const entries = this.sessionEntries(sessionId);
      if (request.list === true) return { traces: entries.slice(offset, offset + 4).map(publicMeta), nextOffset: offset + 4 < entries.length ? offset + 4 : null };
      const entry = entries.find(item => request.id ? item.id === request.id : item.agentId === request.agent);
      if (!entry) return { error: "No trace in this chat." };
      if (request.tail === true) offset = Math.max(0, entry.count - 2);
      const events = [];
      let cursor = offset, bytes = 0;
      if (entry.legacy) events.push(...await this.legacyPage(entry, offset));
      else {
        while (cursor < entry.count) {
          const chunk = await this.readChunk(entry, Math.floor(cursor / RECORDS_PER_CHUNK));
          let full = false;
          const available = chunk.slice(cursor % RECORDS_PER_CHUNK);
          if (!available.length) break;
          for (const event of available) {
            const size = Buffer.byteLength(JSON.stringify(event) + "\n");
            if (events.length && bytes + size > PAGE_BYTES) { full = true; break; }
            events.push(event); bytes += size; cursor++;
          }
          if (full) break;
        }
      }
      if (entry.legacy) cursor += events.length;
      return { id: entry.id, agent: entry.agentId, status: entry.status, truncated: entry.truncated || false, offset, events, nextOffset: cursor < entry.count ? cursor : null, resumeOffset: cursor };
    });
  }

  discard(sessionId) {
    return this.serial(async () => {
      for (const entry of this.entries.filter(item => item.sessionId === sessionId)) {
        entry.discarded = true;
        if (entry.legacy) await fs.unlink(path.join(this.root, `${entry.id}.jsonl`)).catch(error => { if (error.code !== "ENOENT") throw error; });
        else await fs.rm(this.directory(entry), { recursive: true, force: true });
      }
      this.entries = this.entries.filter(entry => entry.sessionId !== sessionId);
    });
  }
}

module.exports = { ChatTraceStore, TraceCollector, validTraceAgent, safeText, safeValue, PAGE_BYTES, RECORDS_PER_CHUNK, RECENT_BYTES };
