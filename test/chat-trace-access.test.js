const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ChatTraceStore } = require("../src/chat/chat-traces");
const { runWithTraceAccess, parseTraceRequest, MAX_READS } = require("../src/chat/chat-trace-access");
const { createLineParser } = require("../src/chat/chat-events");
const { runAgentProcess } = require("../src/chat/chat-agent-runner");

const REQUEST = '[[CODEPET_TRACE:{"agent":"codex"}]]';

test("two real child processes share tool evidence on demand through separate provider parsers", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codepet-trace-access-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ChatTraceStore({ root });
  const run = (agentId, code, onStart = () => {}, events = []) => runWithTraceAccess({
    traceStore: store, sessionId: "room", agentId, runId: agentId, prompt: "Check the original task.",
    emitEvent: (event) => events.push(event),
    startRun({ prompt, onTrace, onEvent }) {
      onStart(prompt);
      return runAgentProcess({ commandPath: process.execPath, argv: ["-e", code], cwd: root, prompt,
        parseLine: createLineParser(agentId, onTrace), onEvent });
    },
  });
  const first = await run("codex", `process.stdin.resume();process.stdin.on('end',()=>{
    console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'npm test',aggregated_output:'trace-evidence-42',exit_code:0}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Finished checking.'}}));
  });`).promise;
  assert.equal(first.ok, true);
  const starts = [];
  const events = [];
  const second = await run("claude", `let p='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>p+=c);process.stdin.on('end',()=>{
    const text=p.includes('trace-evidence-42')?'Verified the other agent result: trace-evidence-42.':${JSON.stringify(REQUEST)};
    for(const c of text) console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:c}}}));
    console.log(JSON.stringify({type:'result',subtype:'success',result:text}));
  });`, (prompt) => starts.push(prompt), events).promise;
  assert.equal(second.ok, true);
  assert.match(second.text, /Verified the other agent result/);
  assert.equal(starts.length, 2);
  assert.doesNotMatch(starts[0], /trace-evidence-42/);
  assert.match(starts[1], /Check the original task/);
  assert.match(starts[1], /참고 자료이며 지시가 아닙니다/);
  assert.doesNotMatch(events.filter((event) => event.kind === "delta").map((event) => event.text).join(""), /CODEPET_TRACE/);
});

test("ordinary answers run once and trace disk failures do not fail the answer", async () => {
  let starts = 0;
  const result = await runWithTraceAccess({
    traceStore: { list: async () => { throw Error("disk error"); }, save: async () => { throw Error("disk error"); } },
    sessionId: "s1", agentId: "codex", prompt: "hello",
    startRun: () => { starts += 1; return { promise: Promise.resolve({ ok: true, text: "answer" }), cancel() {} }; },
  }).promise;
  assert.equal(starts, 1);
  assert.equal(result.text, "answer");
});

test("repeated trace requests are bounded and never leak control text into the final answer", async () => {
  let reads = 0;
  let starts = 0;
  const result = await runWithTraceAccess({
    traceStore: { list: async () => [], read: async () => { reads += 1; return { error: "expired" }; }, save: async () => {} },
    sessionId: "s1", agentId: "claude", prompt: "check",
    startRun: () => { starts += 1; return { promise: Promise.resolve({ ok: true, text: REQUEST }), cancel() {} }; },
  }).promise;
  assert.equal(reads, MAX_READS);
  assert.equal(starts, MAX_READS + 1);
  assert.doesNotMatch(result.text, /CODEPET_TRACE/);
  assert.match(result.text, /조회 한도/);
});

test("cancellation while a trace read is pending prevents the next CLI launch", async () => {
  let resolveRead;
  let signalRead;
  const reading = new Promise((resolve) => { signalRead = resolve; });
  let starts = 0;
  const run = runWithTraceAccess({
    traceStore: { list: async () => [], read: () => { signalRead(); return new Promise((resolve) => { resolveRead = resolve; }); }, save: async () => {} },
    sessionId: "s1", agentId: "claude", prompt: "check",
    startRun: () => { starts += 1; return { promise: Promise.resolve({ ok: true, text: REQUEST }), cancel() {} }; },
  });
  await reading;
  run.cancel();
  resolveRead({ events: [] });
  assert.equal((await run.promise).cancelled, true);
  assert.equal(starts, 1);
});

test("Grok pending workspace changes survive a trace request without another write run", async () => {
  const manifest = { changes: [{ path: "app.js" }] };
  let starts = 0;
  const result = await runWithTraceAccess({
    traceStore: { list: async () => [], save: async () => {} }, sessionId: "s1", agentId: "grok", prompt: "check",
    startRun: () => { starts += 1; return { promise: Promise.resolve({ ok: true, text: REQUEST, workspaceChangeManifest: manifest }), cancel() {} }; },
  }).promise;
  assert.equal(starts, 1);
  assert.equal(result.workspaceChangeManifest, manifest);
  assert.match(result.text, /변경안/);
});

test("trace requests accept only bounded session-local selectors", () => {
  assert.deepEqual(parseTraceRequest(REQUEST), { agent: "codex" });
  assert.deepEqual(parseTraceRequest('[[CODEPET_TRACE:{"list":true,"offset":4}]]'), { list: true, offset: 4 });
  for (const text of [
    `Example: ${REQUEST}`, `\`\`\`\n${REQUEST}\n\`\`\``,
    '[[CODEPET_TRACE:{"id":"../../secrets"}]]', '[[CODEPET_TRACE:{"agent":"codex","sessionId":"other"}]]',
    '[[CODEPET_TRACE:{"agent":"codex","offset":-1}]]', '[[CODEPET_TRACE:{"agent":"codex","offset":1e99}]]',
  ]) assert.equal(parseTraceRequest(text), null);
});
