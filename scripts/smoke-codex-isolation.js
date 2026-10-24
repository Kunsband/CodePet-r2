// Opt-in smoke for Codex's on-disk rollout isolation.  It uses the installed
// app-server only, fresh per-run homes beneath artifacts, and an intentionally dead
// loopback Responses endpoint: no account data or remote model is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { CodexChatRuntime, findRollout, migrateRollout } = require("../src/chat/codex-chat-runtime");

const marker = `codepet-isolation-${randomUUID()}`;
const root = path.resolve("artifacts", "codex-isolation-smoke", `${Date.now()}-${process.pid}`);
const fixture = path.join(root, "fixture");
const sourceHome = path.join(root, "source-home");
const runtimeRoot = path.join(root, "runtime");
const report = { root, marker, assertions: [], processes: [] };
const codex = process.platform === "win32"
  ? spawnSync("powershell.exe", ["-NoProfile", "-Command", "(Get-Command codex).Source"], { encoding: "utf8", windowsHide: true }).stdout.trim()
  : spawnSync("sh", ["-lc", "command -v codex"], { encoding: "utf8" }).stdout.trim();

function isolatedEnvironment(home) {
  const env = { ...process.env };
  // A diagnostic provider must not inherit a user's token or alternate API origin.
  for (const key of Object.keys(env)) if (/^(?:CODEX|OPENAI)_/i.test(key)) delete env[key];
  return { ...env, CODEX_HOME: home };
}

function note(name, detail = true) { report.assertions.push({ name, detail }); }
function save() { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2)); }
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

class AppServer {
  constructor(name, { home, argv }) {
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.lines = [];
    this.stderr = "";
    this.child = spawn(codex, ["app-server", "--stdio", ...argv,
      "-c", 'model_provider="diagnostic"',
      "-c", 'model_providers.diagnostic={name="Local diagnostic",base_url="http://127.0.0.1:1/v1",wire_api="responses"}',
      "-c", 'model="gpt-6-astra"'], {
      cwd: fixture, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: isolatedEnvironment(home),
    });
    report.processes.push({ name, pid: this.child.pid });
    let buffer = "";
    this.child.stdout.on("data", chunk => {
      buffer += String(chunk);
      const rows = buffer.split(/\r?\n/); buffer = rows.pop() || "";
      for (const row of rows) this.receive(row);
    });
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + String(chunk)).slice(-16384); });
    this.child.on("exit", (code, signal) => this.rejectAll(new Error(`${name} exited (${code ?? signal}): ${this.stderr}`)));
  }
  receive(row) {
    let message; try { message = JSON.parse(row); } catch { return; }
    this.lines.push(message);
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(timer);
      message.error ? reject(Object.assign(new Error(message.error.message || "app-server error"), { rpc: message.error })) : resolve(message.result);
    }
  }
  request(method, params, timeout = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name} ${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ method, params })}\n`); }
  rejectAll(error) { for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); } this.pending.clear(); }
  async initialize() {
    await this.request("initialize", { clientInfo: { name: "codepet-diagnostic", version: "0.0.1" }, capabilities: { experimentalApi: true } });
    this.notify("initialized");
  }
  async close() {
    if (this.child.exitCode !== null || this.child.killed) return;
    this.child.kill();
    await Promise.race([new Promise(resolve => this.child.once("exit", resolve)), wait(3000)]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}

async function eventually(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { return await check(); } catch (error) { last = error; await wait(100); } }
  throw new Error(`${label}: ${last?.message || "timed out"}`);
}

async function main() {
  assert.ok(codex, "Installed Codex CLI was not found with Get-Command codex");
  assert.equal(spawnSync(codex, ["--version"], { encoding: "utf8", windowsHide: true }).status, 0, "Installed Codex CLI is not executable");
  fs.mkdirSync(fixture, { recursive: true });
  fs.mkdirSync(sourceHome, { recursive: true, mode: 0o700 });
  const runtime = new CodexChatRuntime({ root: runtimeRoot });
  const prepared = runtime.prepare({ sourceHome, identity: "diagnostic", env: {} });
  assert.equal(prepared.home, runtime.homeFor(sourceHome, "diagnostic"));
  assert.ok(prepared.argv.some(value => value.startsWith("sqlite_home=")) && prepared.argv.some(value => value.startsWith("log_dir=")));
  note("runtime.prepare supplies private sqlite_home and log_dir");

  const original = new AppServer("original", { home: sourceHome, argv: ["-c", `sqlite_home=${JSON.stringify(sourceHome)}`, "-c", `log_dir=${JSON.stringify(path.join(sourceHome, "log"))}`] });
  try {
    await original.initialize();
    const thread = await original.request("thread/start", { cwd: fixture, approvalPolicy: "never", sandbox: "read-only", ephemeral: false });
    const threadId = thread.thread?.id || thread.id;
    assert.match(threadId, /^[0-9a-f-]{36}$/i, "thread/start did not return a UUID");
    await original.request("turn/start", { threadId, input: [{ type: "text", text: `fixture ${marker}` }] });
    await eventually(() => {
      const rollout = findRollout(sourceHome, threadId);
      assert.ok(rollout, "turn/start did not materialize a rollout");
      assert.ok(fs.readFileSync(rollout, "utf8").includes(marker), "turn input is not persisted yet");
      return rollout;
    }, "source rollout materialization");
    const sourceRollout = findRollout(sourceHome, threadId);
    assert.ok(fs.readFileSync(sourceRollout, "utf8").includes(marker));
    note("turn/start materializes source rollout with exact marker", sourceRollout);

    const secondSource = new AppServer("same-home-resume", { home: sourceHome, argv: ["-c", `sqlite_home=${JSON.stringify(sourceHome)}`, "-c", `log_dir=${JSON.stringify(path.join(sourceHome, "log"))}`] });
    try {
      await secondSource.initialize();
      await assert.rejects(secondSource.request("thread/resume", { threadId, cwd: fixture, approvalPolicy: "never", sandbox: "read-only" }), /active|writer|lock|already|busy/i);
      note("same source home rejects simultaneous writer resume");
    } finally { await secondSource.close(); }

    prepared.migrate(threadId);
    const privateRollout = findRollout(prepared.home, threadId);
    assert.ok(privateRollout && fs.readFileSync(privateRollout, "utf8").includes(marker));
    const sourceMatches = fs.readdirSync(path.dirname(sourceRollout)).filter(name => name.endsWith(`-${threadId}.jsonl`));
    assert.equal(sourceMatches.length, 1, "migration added source histories");
    note("migrateRollout snapshots only the matching rollout and leaves source singular");

    const privateOne = new AppServer("private-resume", { home: prepared.home, argv: prepared.argv });
    try {
      await privateOne.initialize();
      const resumed = await privateOne.request("thread/resume", { threadId, cwd: fixture, approvalPolicy: "never", sandbox: "read-only" });
      assert.equal(resumed.thread?.id || resumed.id, threadId);
      const read = await privateOne.request("thread/read", { threadId, includeTurns: true });
      assert.ok(JSON.stringify(read).includes(marker), "private resume did not retain exact marker history");
      note("isolated home resumes while original writer remains live and reads marker history");
    } finally { await privateOne.close(); }

    const privateTwo = new AppServer("private-reopen", { home: prepared.home, argv: prepared.argv });
    try {
      await privateTwo.initialize();
      const resumed = await privateTwo.request("thread/resume", { threadId, cwd: fixture, approvalPolicy: "never", sandbox: "read-only" });
      assert.equal(resumed.thread?.id || resumed.id, threadId);
      const read = await privateTwo.request("thread/read", { threadId, includeTurns: true });
      assert.ok(JSON.stringify(read).includes(marker), "private reopen did not retain marker history");
      note("private close/reopen retains identical thread ID and marker history");
    } finally { await privateTwo.close(); }
    report.ok = true; report.threadId = threadId; report.sourceRollout = sourceRollout; report.privateRollout = privateRollout;
  } finally { await original.close(); }
}

main().catch(error => { report.ok = false; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }).finally(() => { save(); console.log(JSON.stringify({ ok: report.ok, root, report: path.join(root, "report.json") })); });
