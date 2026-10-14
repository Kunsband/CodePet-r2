const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ChatTraceStore, TraceCollector, RUN_BYTES, RETENTION_MS, PAGE_BYTES } = require("../src/chat/chat-traces");
const { createLineParser } = require("../src/chat/chat-events");

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codepet-traces-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: new ChatTraceStore({ root, ...options }) };
}

function capture(events) {
  const collector = new TraceCollector();
  for (const event of events) collector.add(event);
  return collector;
}

async function save(store, sessionId = "s1", agentId = "codex", collector = capture([{ kind: "tool-result", output: "verified-result" }])) {
  return store.save({ sessionId, agentId, runId: "r1", status: "completed", collector });
}

test("traces survive restart, retain unique run identities and cannot cross chat boundaries", async (t) => {
  const { root, store } = await fixture(t);
  const first = await save(store);
  const second = await save(store);
  assert.notEqual(first, second);
  const reopened = new ChatTraceStore({ root });
  assert.equal((await reopened.list("s1")).length, 2);
  assert.equal((await reopened.read("s1", { id: first })).events[0].output, "verified-result");
  assert.match((await reopened.read("s2", { id: first })).error, /No saved trace/);
  assert.match((await reopened.read("s1", { id: "../../secret" })).error, /No saved trace/);
});

test("10000 large tool events keep the beginning and end within the run and page caps", async (t) => {
  const { root, store } = await fixture(t);
  const collector = new TraceCollector();
  for (let i = 0; i < 10000; i += 1) collector.add({ kind: "tool-result", output: `${i}:한글😀${"x".repeat(9000)}` });
  assert.ok(collector.headBytes + collector.tailBytes < RUN_BYTES);
  assert.equal(collector.truncated, true);
  const id = await save(store, "s1", "claude", collector);
  assert.ok((await fs.stat(path.join(root, "traces", `${id}.jsonl`))).size <= RUN_BYTES);
  const events = [];
  let offset = 0;
  do {
    const page = await store.read("s1", { id, offset });
    assert.ok(page.events.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item) + "\n"), 0) <= PAGE_BYTES);
    assert.doesNotMatch(JSON.stringify(page), /\uFFFD/);
    events.push(...page.events);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.match(events[0].output, /^0:/);
  assert.match(events.at(-1).output, /^9999:/);
});

test("retention caps disk bytes and run counts per chat and globally, and expires old traces", async (t) => {
  let time = 1000;
  const { root, store } = await fixture(t, { now: () => time++, maxRuns: 3, sessionRuns: 2, totalBytes: 20000, sessionBytes: 12000 });
  const collector = capture(Array.from({ length: 3 }, () => ({ kind: "tool-result", output: "x".repeat(3000) })));
  for (const session of ["s1", "s1", "s1", "s2", "s3", "s3"]) await save(store, session, "codex", collector);
  const files = await fs.readdir(path.join(root, "traces"));
  const sizes = await Promise.all(files.map((name) => fs.stat(path.join(root, "traces", name)).then((stat) => stat.size)));
  assert.ok(files.length <= 3);
  assert.ok(sizes.reduce((a, b) => a + b, 0) <= 20000);
  assert.ok((await store.list("s3")).length <= 2);
  time += RETENTION_MS + 1;
  assert.deepEqual(await store.list("s3"), []);
  assert.deepEqual(await fs.readdir(path.join(root, "traces")), []);
});

test("discarding a chat removes its traces and late completion cannot recreate them", async (t) => {
  let exists = true;
  const { root, store } = await fixture(t, { hasSession: () => exists });
  await save(store);
  exists = false;
  await store.discard("s1");
  assert.equal(await save(store), null);
  assert.deepEqual(await fs.readdir(path.join(root, "traces")), []);
});

test("plain conversations and token deltas do not create trace files", async (t) => {
  const { root, store } = await fixture(t);
  const collector = capture([{ kind: "delta", text: "a" }, { kind: "final", text: "answer" }, { kind: "status", label: "thinking" }, { kind: "trace-read", request: { agent: "claude" } }]);
  assert.equal(await save(store, "s1", "codex", collector), null);
  assert.deepEqual(await fs.readdir(path.join(root, "traces")), []);
});

test("credentials, reasoning and images never enter saved trace fixtures", async (t) => {
  const { root, store } = await fixture(t);
  const collector = new TraceCollector();
  const parse = createLineParser("claude", (event) => collector.add(event));
  parse(JSON.stringify({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "private-reasoning" },
    { type: "tool_use", name: "Bash", id: "tool-1", input: { command: "API_TOKEN=hidden-env-key npm test", password: "hidden-password" } },
  ] } }));
  parse(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: [
    { type: "image", source: { data: "private-image" } },
    { type: "text", text: 'Authorization: Bearer private-bearer\n{"access_token":"private-token"}\nsk-ant-hidden-api-key\nall tests passed' },
  ] }] } }));
  const id = await save(store, "s1", "claude", collector);
  const raw = await fs.readFile(path.join(root, "traces", `${id}.jsonl`), "utf8");
  assert.doesNotMatch(raw, /private-reasoning|private-image|hidden-env-key|hidden-password|private-bearer|private-token|hidden-api-key/);
  assert.match(raw, /all tests passed/);
  assert.match(raw, /REDACTED/);
});

test("provider parsers capture observable tool inputs and outputs without changing UI events", () => {
  const fixtures = [
    ["codex", { type: "item.completed", item: { type: "command_execution", command: "npm test", aggregated_output: "passed", exit_code: 0 } }, "passed"],
    ["codex", { type: "item.completed", item: { type: "file_change", changes: [{ path: "app.js", kind: "update" }] } }, "app.js"],
    ["codex", { msg: { type: "exec_command_end", stdout: "legacy-output", exit_code: 0 } }, "legacy-output"],
    ["agy", { event: "step_update", step_update: { state: "DONE", tool_name: "read_file", tool_info: { input: { path: "a.txt" }, output: "agy-output" } } }, "agy-output"],
    ["grok", { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { path: "grok.txt" } }] } }, "grok.txt"],
    ["grok", { type: "user", message: { content: [{ type: "tool_result", content: "grok-output" }] } }, "grok-output"],
  ];
  for (const [provider, event, expected] of fixtures) {
    const recorded = [];
    const line = JSON.stringify(event);
    assert.deepEqual(createLineParser(provider, (item) => recorded.push(item))(line), createLineParser(provider)(line));
    assert.match(JSON.stringify(recorded), new RegExp(expected));
  }
  const recorded = [];
  createLineParser("codex", (event) => recorded.push(event))(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "secret-thought" } }));
  assert.deepEqual(recorded, []);
});

test("restart clears corrupt owned trace files without touching unrelated files", async (t) => {
  const { root, store } = await fixture(t);
  await store.init();
  const broken = "11111111-1111-1111-1111-111111111111.jsonl";
  await fs.writeFile(path.join(root, "traces", broken), "{broken");
  await fs.writeFile(path.join(root, "traces", "unrelated.txt"), "keep");
  await new ChatTraceStore({ root }).init();
  assert.deepEqual(await fs.readdir(path.join(root, "traces")), ["unrelated.txt"]);
});
