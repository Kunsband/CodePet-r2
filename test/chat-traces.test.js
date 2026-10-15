const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { ChatTraceStore, PAGE_BYTES, RECORDS_PER_CHUNK, RECENT_BYTES } = require("../src/chat/chat-traces");
const { createLineParser } = require("../src/chat/chat-events");

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codepet-traces-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: new ChatTraceStore({ root, ...options }) };
}
async function begin(store, sessionId = "s1", agentId = "codex") {
  return store.begin({ sessionId, agentId, runId: randomUUID() });
}
async function save(store, sessionId = "s1", agentId = "codex", events = [{ kind: "tool-result", output: "verified-result" }]) {
  const collector = await begin(store, sessionId, agentId);
  for (const event of events) collector.add(event);
  return store.save({ collector, status: "completed" });
}
async function readAll(store, id, sessionId = "s1") {
  const events = [];
  let offset = 0;
  do {
    const page = await store.read(sessionId, { id, offset });
    assert.ok(page.events.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item) + "\n"), 0) <= PAGE_BYTES);
    events.push(...page.events);
    offset = page.nextOffset;
  } while (offset !== null);
  return events;
}

test("compressed traces survive restart and cannot cross chat boundaries", async t => {
  const { root, store } = await fixture(t);
  const first = await save(store);
  const second = await save(store);
  assert.notEqual(first, second);
  assert.ok((await fs.readdir(path.join(root, "traces", first))).includes("0.jsonl.gz"));
  const reopened = new ChatTraceStore({ root });
  assert.equal((await reopened.list("s1")).length, 2);
  assert.equal((await reopened.read("s1", { id: first })).events[0].output, "verified-result");
  assert.match((await reopened.read("s2", { id: first })).error, /No trace/);
  assert.match((await reopened.read("s1", { id: "../../secret" })).error, /No trace/);
});

test("10000 events keep the entire beginning, middle and end while recent memory stays bounded", async t => {
  const { store } = await fixture(t);
  const collector = await begin(store);
  for (let i = 0; i < 10000; i++) {
    const write = collector.add({ kind: "tool-result", output: `${i}:한글😀${"x".repeat(800)}` });
    if (i % 64 === 63) await write;
  }
  const id = await store.save({ collector, status: "completed" });
  assert.ok(collector.recentBytes <= RECENT_BYTES);
  const events = await readAll(store, id);
  assert.equal(events.length, 10000);
  for (const i of [0, 5000, 9999]) assert.equal(events[i].output, `${i}:한글😀${"x".repeat(800)}`);
  assert.equal((await store.read("s1", { id })).truncated, false);
  let reads = 0;
  const original = store.readChunk.bind(store);
  store.readChunk = (...args) => { reads++; return original(...args); };
  assert.match((await store.read("s1", { id, offset: 9999 })).events[0].output, /^9999:/);
  assert.equal(reads, 1, "late pages seek directly to their compressed chunk");
});

test("long commands, deep inputs, arrays and outputs round-trip losslessly across pages", async t => {
  const { store } = await fixture(t);
  const input = { nested: { one: { two: { values: Array.from({ length: 100 }, (_, i) => i) } } } };
  const command = 'pwsh -Command "' + '한글😀\\n'.repeat(2000) + '"';
  const output = Array.from({ length: 10000 }, (_, i) => `line ${i}`).join("\n");
  const id = await save(store, "s1", "claude", [{ kind: "tool-call", tool: "Bash", command, input }, { kind: "tool-result", output }]);
  const records = await readAll(store, id);
  const restored = [];
  for (const record of records) {
    assert.equal(record.kind, "event-fragment");
    restored[record.eventSeq] = (restored[record.eventSeq] || "") + record.data;
  }
  assert.equal(JSON.parse(restored[0]).command, command);
  assert.deepEqual(JSON.parse(restored[0]).input, input);
  assert.equal(JSON.parse(restored[1]).output, output);
});

test("run counts, storage quotas and elapsed time do not prune traces", async t => {
  let now = 1000;
  const { root, store } = await fixture(t, { now: () => now++, maxRuns: 1, sessionRuns: 1, totalBytes: 1, sessionBytes: 1, retentionMs: 1 });
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(await save(store));
  now += 365 * 24 * 60 * 60 * 1000;
  const reopened = new ChatTraceStore({ root, now: () => now });
  for (const id of ids) assert.equal((await reopened.read("s1", { id })).events[0].output, "verified-result");
  assert.equal((await fs.readdir(path.join(root, "traces"))).length, 20);
});

test("live commands and results are readable before completion with stable resume offsets", async t => {
  const { store } = await fixture(t);
  const collector = await begin(store);
  await collector.add({ kind: "tool-call", command: "npm test" });
  const page = await store.read("s1", { agent: "codex" });
  assert.equal(page.status, "running");
  assert.equal(page.events[0].command, "npm test");
  await collector.add({ kind: "tool-result", output: "passed", exitCode: 0 });
  const next = await store.read("s1", { id: page.id, offset: page.resumeOffset });
  assert.equal(next.events[0].output, "passed");
  assert.equal(next.status, "running");
  const id = await store.save({ collector, status: "completed" });
  assert.equal(id, page.id);
  assert.equal((await store.read("s1", { id })).status, "completed");
});

test("crash recovery retains the final partial chunk and marks it interrupted", async t => {
  const { root, store } = await fixture(t);
  const collector = await begin(store);
  for (let i = 0; i < RECORDS_PER_CHUNK + 3; i++) collector.add({ kind: "tool-call", command: `echo ${i}` });
  await store.queue;
  await collector.entry.flushing;
  await store.queue;
  const reopened = new ChatTraceStore({ root });
  const events = await readAll(reopened, collector.entry.id);
  assert.equal(events.length, RECORDS_PER_CHUNK + 3);
  assert.equal((await reopened.read("s1", { id: collector.entry.id })).status, "interrupted");
});

test("deleting a chat removes live and saved traces and late callbacks cannot recreate them", async t => {
  let exists = true;
  const { root, store } = await fixture(t, { hasSession: () => exists });
  await save(store);
  const collector = await begin(store);
  await collector.add({ kind: "tool-call", command: "npm test" });
  exists = false;
  await store.discard("s1");
  await collector.add({ kind: "tool-result", output: "late output" });
  assert.equal(await store.save({ collector, status: "cancelled" }), null);
  assert.deepEqual(await fs.readdir(path.join(root, "traces")), []);
});

test("ordinary conversation does not leave empty trace files", async t => {
  const { root, store } = await fixture(t);
  const collector = await begin(store);
  for (const kind of ["delta", "final", "status"]) collector.add({ kind, text: "text" });
  assert.equal(await store.save({ collector, status: "completed" }), null);
  assert.deepEqual(await fs.readdir(path.join(root, "traces")), []);
});

test("credentials, reasoning and images are excluded even beyond the former truncation boundary", async t => {
  const { store } = await fixture(t);
  const collector = await begin(store, "s1", "claude");
  const parse = createLineParser("claude", event => collector.add(event));
  parse(JSON.stringify({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "private-reasoning" },
    { type: "tool_use", name: "Bash", input: { command: "API_TOKEN=hidden-env npm test", password: "hidden-password" } },
  ] } }));
  parse(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: [
    { type: "image", source: { data: "private-image" } },
    { type: "text", text: "x".repeat(20000) + '\nAuthorization: Bearer private-bearer\n{"access_token":"private-token"}\nall tests passed' },
  ] }] } }));
  await parse.flushTraces();
  const id = await store.save({ collector, status: "completed" });
  const raw = JSON.stringify(await readAll(store, id));
  assert.doesNotMatch(raw, /private-reasoning|private-image|hidden-env|hidden-password|private-bearer|private-token/);
  assert.match(raw, /all tests passed/);
  assert.match(raw, /REDACTED/);
});

test("all provider parsers preserve complete tool inputs and outputs without changing UI events", () => {
  const fixtures = [
    ["codex", { type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test" } }, "npm test"],
    ["codex", { type: "item.completed", item: { type: "command_execution", command: "npm test", aggregated_output: "passed", exit_code: 0 } }, "passed"],
    ["codex", { type: "item.completed", item: { type: "file_change", changes: Array.from({ length: 20 }, (_, i) => ({ path: `${i}.js`, kind: "update" })) } }, "19.js"],
    ["agy", { event: "step_update", step_update: { state: "RUNNING", tool_name: "run_command", tool_info: { input: { command: "echo agy" } } } }, "echo agy"],
    ["grok", { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo grok" } }] } }, "echo grok"],
    ["claude", { type: "user", message: { content: [{ type: "tool_result", content: Array.from({ length: 20 }, (_, i) => ({ type: "text", text: "x".repeat(14000) + `end-${i}` })) }] } }, "end-19"],
  ];
  for (const [provider, event, expected] of fixtures) {
    const recorded = [];
    const line = JSON.stringify(event);
    assert.deepEqual(createLineParser(provider, item => recorded.push(item))(line), createLineParser(provider)(line));
    assert.ok(JSON.stringify(recorded).includes(expected));
  }
});

test("old traces remain readable after years and corrupt files are preserved", async t => {
  const { root, store } = await fixture(t);
  await store.init();
  const id = randomUUID();
  const meta = { v: 1, id, sessionId: "s1", agentId: "codex", ts: 1000, status: "completed", count: 2, truncated: true };
  await fs.writeFile(path.join(root, "traces", id + ".jsonl"), JSON.stringify(meta) + '\n{"kind":"tool-call","command":"old command"}\n{"kind":"tool-result","output":"old result"}\n');
  const broken = randomUUID() + ".jsonl";
  await fs.writeFile(path.join(root, "traces", broken), "{broken");
  const reopened = new ChatTraceStore({ root });
  const page = await reopened.read("s1", { id, offset: 1 });
  assert.equal(page.events[0].output, "old result");
  assert.equal(page.truncated, true);
  assert.equal(await fs.readFile(path.join(root, "traces", broken), "utf8"), "{broken");
});
