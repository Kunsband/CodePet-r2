const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { LogFileIndex } = require("../src/log-file-index");
const { ExternalWatcher, recursiveJsonl } = require("../src/external-watcher");
const { CodexWatcher } = require("../src/codex-watcher");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-log-index-"));
  t.after(() => {
    assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function fakeWatch() {
  const handles = [];
  const watch = (root, options, notify) => {
    assert.deepEqual(options, { recursive: true, persistent: false });
    const handle = Object.assign(new EventEmitter(), { root, notify, closed: false,
      close() { this.closed = true; } });
    handles.push(handle);
    return handle;
  };
  return { handles, watch };
}

function scan(root) {
  return recursiveJsonl(root).map((filePath) => {
    const stat = fs.statSync(filePath);
    return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
  });
}

test("unchanged polls do no directory scans or stats; append and truncation refresh only the changed file", (t) => {
  const root = fixture(t), file = path.join(root, "session.jsonl");
  fs.writeFileSync(file, "old");
  const native = fakeWatch();
  let scans = 0;
  const index = new LogFileIndex({ ...native, scan: (root) => { scans++; return scan(root); } });
  t.after(() => index.close());
  index.read([root]);
  const stat = t.mock.method(fs, "statSync");
  for (let i = 0; i < 100; i++) assert.equal(index.read([root])[0].size, 3);
  assert.equal(scans, 1);
  assert.equal(stat.mock.callCount(), 0);
  fs.appendFileSync(file, " appended");
  native.handles[0].notify("change", "session.jsonl");
  native.handles[0].notify("change", "session.jsonl");
  assert.equal(index.read([root])[0].size, 12);
  assert.equal(stat.mock.callCount(), 1);
  fs.truncateSync(file, 0);
  native.handles[0].notify("change", "session.jsonl");
  assert.equal(index.read([root])[0].size, 0);
  assert.equal(scans, 1);
});

test("renames discover nested files, deletion drops entries, and reconciliation repairs lost notifications", (t) => {
  const root = fixture(t), native = fakeWatch();
  let now = 0;
  const index = new LogFileIndex({ ...native, scan, now: () => now, reconcileMs: 1000 });
  t.after(() => index.close());
  assert.equal(index.read([root]).length, 0);
  fs.mkdirSync(path.join(root, "nested"));
  const file = path.join(root, "nested", "new.jsonl");
  fs.writeFileSync(file, "hello");
  native.handles[0].notify("rename", "nested");
  assert.equal(index.read([root])[0].size, 5);
  fs.appendFileSync(file, " lost event");
  assert.equal(index.read([root])[0].size, 5);
  now = 1000;
  assert.equal(index.read([root])[0].size, 16);
  fs.unlinkSync(file);
  native.handles[0].notify("change", path.join("nested", "new.jsonl"));
  assert.equal(index.read([root]).length, 0);
  native.handles[0].notify("rename", null);
  assert.equal(index.read([root]).length, 0);
});

test("failed watches keep full polling, retry, and close when roots change or monitoring stops", (t) => {
  const root = fixture(t), native = fakeWatch();
  let now = 0, attempts = 0, scans = 0;
  const index = new LogFileIndex({ scan: (root) => { scans++; return scan(root); },
    now: () => now, reconcileMs: 1000, watch: (...args) => {
      if (++attempts === 1) throw new Error("watch unavailable");
      return native.watch(...args);
    } });
  t.after(() => index.close());
  index.read([root]); index.read([root]);
  assert.equal(scans, 2);
  now = 1000;
  index.read([root]); index.read([root]);
  assert.equal(scans, 3);
  native.handles[0].emit("error", new Error("root disappeared"));
  index.read([root]);
  assert.equal(scans, 4);
  assert.equal(native.handles[0].closed, true);
  now = 2000;
  index.read([root]);
  index.read([]);
  assert.equal(native.handles[1].closed, true);
  index.read([root]);
  index.close();
  assert.equal(native.handles[2].closed, true);
});

async function until(check) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("filesystem notification timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("external watcher recovers an append when native notifications are lost", (t) => {
  const root = fixture(t), file = path.join(root, "session.jsonl");
  fs.writeFileSync(file, "\n");
  t.mock.method(fs, "watch", () => Object.assign(new EventEmitter(), { close() {} }));
  const watcher = new ExternalWatcher({ provider: "test", roots: [root], findFiles: recursiveJsonl, parseRow: (row) => row });
  t.after(() => watcher.stop());
  const messages = [];
  watcher.on("user-message", (text) => messages.push(text));
  watcher.start();
  let now = Date.now();
  watcher.fileIndex.now = () => now;
  fs.appendFileSync(file, JSON.stringify({ type: "user", sessionId: "session", text: "missed event" }) + "\n");
  watcher.poll();
  assert.deepEqual(messages, []);
  now += watcher.fileIndex.reconcileMs;
  watcher.poll();
  assert.deepEqual(messages, ["missed event"]);
});

test("replacing a watched root reattaches to the new directory instead of retaining the moved watch", (t) => {
  const parent = fixture(t), root = path.join(parent, "logs"), native = fakeWatch();
  fs.mkdirSync(root);
  const index = new LogFileIndex({ ...native, scan });
  t.after(() => index.close());
  index.read([root]);
  fs.renameSync(root, path.join(parent, "moved"));
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "new.jsonl"), "new");
  native.handles[0].notify("rename", null);
  assert.equal(index.read([root])[0].size, 3);
  assert.equal(native.handles[0].closed, true);
  assert.equal(native.handles.length, 2);
});

test("native external watcher skips history and detects append, new nested logs, deletion, and restart", async (t) => {
  const root = fixture(t), file = path.join(root, "existing.jsonl");
  const row = (text) => JSON.stringify({ type: "user", sessionId: "session", text }) + "\n";
  fs.writeFileSync(file, row("history"));
  const watcher = new ExternalWatcher({ provider: "test", roots: [root], findFiles: recursiveJsonl, parseRow: (row) => row });
  t.after(() => watcher.stop());
  const messages = [];
  watcher.on("user-message", (text) => messages.push(text));
  watcher.start();
  // Native notifications can be lost; exercise the existing recovery path
  // within this test's deadline without changing the production interval.
  watcher.fileIndex.reconcileMs = 1000;
  watcher.poll();
  assert.deepEqual(messages, []);
  fs.appendFileSync(file, row("append"));
  await until(() => { watcher.poll(); return messages.includes("append"); });
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "nested", "new.jsonl"), row("new"));
  await until(() => { watcher.poll(); return messages.includes("new"); });
  fs.unlinkSync(file);
  await until(() => { watcher.poll(); return !watcher.offsets.has(file); });
  watcher.stop(); watcher.start(); watcher.poll();
  assert.deepEqual(messages, ["append", "new"]);
});

test("Codex detects resumed old threads outside the ten tailed files and newly created sessions", async (t) => {
  const root = fixture(t);
  const day = path.join(root, "sessions", "2020", "01", "01");
  fs.mkdirSync(day, { recursive: true });
  const paths = [];
  for (let i = 0; i < 12; i++) {
    const file = path.join(day, `rollout-2020-01-01-00000000-0000-4000-8000-${String(i).padStart(12, "0")}.jsonl`);
    fs.writeFileSync(file, "\n");
    fs.utimesSync(file, 1000 + i, 1000 + i);
    paths.push(file);
  }
  const watcher = new CodexWatcher({ getCodexHomes: () => [root] });
  t.after(() => watcher.stop());
  watcher.start();
  watcher.fileIndex.reconcileMs = 1000;
  assert.equal(watcher.tails.has(paths[0]), false);
  const event = JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n";
  fs.appendFileSync(paths[0], event);
  await until(() => { watcher.poll(); return watcher.workingFiles.has(paths[0]); });
  const newDay = path.join(root, "sessions", "2026", "10", "27");
  fs.mkdirSync(newDay, { recursive: true });
  const fresh = path.join(newDay, "rollout-2026-10-27-11111111-2222-4333-8444-555555555555.jsonl");
  fs.writeFileSync(fresh, event);
  await until(() => { watcher.poll(); return watcher.workingFiles.has(fresh); });
});
