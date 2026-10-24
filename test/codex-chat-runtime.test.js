const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { CodexChatRuntime, migrateRollout, findRollout } = require("../src/chat/codex-chat-runtime");
const { NativeSessionLink } = require("../src/chat/chat-native-sessions");
const { ChatStore } = require("../src/chat/chat-store");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-codex-runtime-"));
  t.after(() => {
    assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceHome = path.join(root, "desktop");
  fs.mkdirSync(sourceHome);
  const runtime = new CodexChatRuntime({ root: path.join(root, "private"), platform: "linux" });
  const prepare = (identity = "account-a") => runtime.prepare({ sourceHome, identity, env: { OTHER: "preserved", CODEX_HOME: sourceHome } });
  const write = (name, text) => fs.writeFileSync(path.join(sourceHome, name), text);
  return { root, sourceHome, runtime, prepare, write };
}

test("default and saved accounts have persistent isolated homes and override shared SQLite/log settings", t => {
  const f = fixture(t);
  f.write("config.toml", 'sqlite_home="shared"\nlog_dir="shared-log"\nmodel="gpt-6-astra"');
  f.write("AGENTS.md", "shared rules");
  f.write("auth.json", '{"tokens":{"access_token":"fixture"}}');
  const a = f.prepare(), b = f.prepare("account-b");
  assert.notEqual(a.home, f.sourceHome);
  assert.notEqual(a.home, b.home);
  assert.equal(f.prepare().home, a.home);
  assert.equal(new CodexChatRuntime({ root: f.runtime.root }).homeFor(f.sourceHome, "account-a"), a.home);
  assert.equal(a.env.OTHER, "preserved");
  assert.equal(a.env.CODEX_HOME, a.home);
  assert.ok(a.argv.includes(`sqlite_home=${JSON.stringify(a.home)}`));
  assert.ok(a.argv.includes(`log_dir=${JSON.stringify(path.join(a.home, "log"))}`));
  assert.ok(a.argv.includes("cli_auth_credentials_store=file"));
  assert.equal(fs.readFileSync(path.join(a.home, "AGENTS.md"), "utf8"), "shared rules");
  fs.mkdirSync(path.join(a.home, "sessions"));
  fs.writeFileSync(path.join(a.home, "sessions", "marker"), "history");
  f.prepare();
  assert.equal(fs.readFileSync(path.join(a.home, "sessions", "marker"), "utf8"), "history");
  assert.equal(fs.existsSync(path.join(f.sourceHome, "sessions")), false);
  f.write("AGENTS.md", "updated rules"); f.prepare();
  assert.equal(fs.readFileSync(path.join(a.home, "AGENTS.md"), "utf8"), "updated rules");
});

test("credential refresh survives restart, syncs back, and never overwrites a changed source login", t => {
  const f = fixture(t), initial = '{"token":"initial"}', rotated = '{"token":"rotated"}', switched = '{"token":"other-account"}';
  f.write("auth.json", initial);
  const a = f.prepare();
  fs.writeFileSync(path.join(a.home, "auth.json"), rotated);
  const restarted = f.prepare();
  assert.equal(fs.readFileSync(path.join(restarted.home, "auth.json"), "utf8"), rotated);
  restarted.finish();
  assert.equal(fs.readFileSync(path.join(f.sourceHome, "auth.json"), "utf8"), rotated);
  const b = f.prepare();
  fs.writeFileSync(path.join(b.home, "auth.json"), '{"token":"newer"}');
  f.write("auth.json", switched); b.finish();
  assert.equal(fs.readFileSync(path.join(f.sourceHome, "auth.json"), "utf8"), switched);
  f.prepare();
  assert.equal(fs.readFileSync(path.join(b.home, "auth.json"), "utf8"), switched);
  fs.unlinkSync(path.join(f.sourceHome, "auth.json")); f.prepare();
  assert.equal(fs.existsSync(path.join(b.home, "auth.json")), false);
});

function rollout(home, id, extra = "") {
  const dir = path.join(home, "sessions", "2026", "10", "18");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-18T10-00-00-${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { id } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "earlier context" } })}\n${extra}`);
  return file;
}

test("migration copies only the linked history, keeps cursor/ID, and leaves the source untouched", t => {
  const f = fixture(t), id = randomUUID(), unrelated = randomUUID();
  const file = rollout(f.sourceHome, id, '{"partial":'); rollout(f.sourceHome, unrelated);
  const before = fs.readFileSync(file);
  const store = new ChatStore({ root: path.join(f.root, "chat") }).init(), room = store.createSession({}).id;
  const legacyScope = { providerId: "codex", home: f.sourceHome, cwd: "workspace", model: "default" };
  const old = new NativeSessionLink(store, room, "codex", legacyScope); old.observe(id); old.delivered("message-12");
  const runtime = f.prepare(), scope = { ...legacyScope, home: runtime.home };
  const link = new NativeSessionLink(store, room, "codex", scope, { legacyScope, migrate: runtime.migrate });
  assert.equal(link.cliSessionId, id); assert.equal(link.lastMessageId, "message-12");
  const copy = findRollout(runtime.home, id);
  assert.ok(copy); assert.match(fs.readFileSync(copy, "utf8"), /earlier context/);
  assert.doesNotMatch(fs.readFileSync(copy, "utf8"), /partial/);
  assert.equal(findRollout(runtime.home, unrelated), null);
  assert.deepEqual(fs.readFileSync(file), before);
  fs.appendFileSync(copy, '{"new":"private turn"}\n');
  migrateRollout(f.sourceHome, runtime.home, id);
  assert.match(fs.readFileSync(copy, "utf8"), /private turn/);
  assert.equal(new NativeSessionLink(store, room, "codex", scope).lastMessageId, "message-12");
});

test("missing legacy history leaves the saved cursor intact instead of silently starting over", t => {
  const f = fixture(t), store = new ChatStore({ root: path.join(f.root, "chat") }).init(), room = store.createSession({}).id;
  const legacyScope = { home: f.sourceHome }, old = new NativeSessionLink(store, room, "codex", legacyScope);
  old.observe(randomUUID()); old.delivered("anchor");
  const before = fs.readFileSync(old.file, "utf8"), runtime = f.prepare();
  assert.throws(() => new NativeSessionLink(store, room, "codex", { home: runtime.home }, { legacyScope, migrate: runtime.migrate }), /기존 Codex 대화 기록/);
  assert.equal(fs.readFileSync(old.file, "utf8"), before);
});

test("sandbox preparation targets the private home while retaining the machine source", async t => {
  const f = fixture(t), calls = [];
  f.runtime.sandbox.ensure = async (...args) => calls.push(args);
  await f.runtime.prepareSandbox({ sourceHome: f.sourceHome, identity: "account-a", sandboxSource: "machine-home", record: { commandPath: "fixture" }, cwd: "workspace" });
  assert.deepEqual(calls[0], [f.runtime.homeFor(f.sourceHome, "account-a"), "machine-home", { commandPath: "fixture" }, "workspace"]);
});
