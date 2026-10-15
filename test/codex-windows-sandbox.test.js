const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexWindowsSandboxState } = require("../src/chat/codex-windows-sandbox");
const files = [".sandbox-secrets/sandbox_users.json", ".sandbox/setup_marker.json"];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-sandbox-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), home = path.join(root, "profile");
  fs.mkdirSync(source); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "auth.json"), "separate-account");
  const seed = () => files.forEach(name => {
    fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    fs.writeFileSync(path.join(source, name), "machine-state-fixture");
  });
  const calls = [];
  const run = (shell, argv, options) => {
    calls.push({ shell, argv, options });
    for (const name of files) {
      fs.mkdirSync(path.dirname(path.join(home, name)), { recursive: true });
      fs.copyFileSync(path.join(source, name), path.join(home, name));
    }
  };
  return { source, home, seed, calls, run };
}
test("only machine state is synchronized, unchanged calls are cheap, and rotations invalidate the cache", t => {
  const f = fixture(t); f.seed();
  const state = new CodexWindowsSandboxState({ platform: "win32", run: f.run });
  state.prepare(f.home, f.source); state.prepare(f.home, f.source);
  assert.equal(f.calls.length, 1);
  fs.writeFileSync(path.join(f.source, files[0]), "rotated-machine-state-fixture");
  state.prepare(f.home, f.source);
  assert.equal(f.calls.length, 2);
  assert.equal(fs.readFileSync(path.join(f.home, files[0]), "utf8"), "rotated-machine-state-fixture");
  assert.equal(fs.readFileSync(path.join(f.home, "auth.json"), "utf8"), "separate-account");
  assert.ok(!f.calls[0].argv.join(" ").includes("machine-state-fixture"));
});
test("reparse points are rejected before copying protected sandbox state", t => {
  const f = fixture(t); f.seed();
  fs.symlinkSync(path.join(f.source, ".sandbox"), path.join(f.home, ".sandbox"), process.platform === "win32" ? "junction" : "dir");
  const state = new CodexWindowsSandboxState({ platform: "win32", run: f.run });
  assert.throws(() => state.prepare(f.home, f.source), /실제 폴더/);
  assert.equal(f.calls.length, 0);
});
test("fresh Windows homes initialize the canonical sandbox once before syncing participants", async t => {
  const f = fixture(t); let initializations = 0;
  const state = new CodexWindowsSandboxState({ platform: "win32", run: f.run, bootstrap: input => {
    initializations++;
    assert.equal(input.env.CODEX_HOME, f.source);
    assert.ok(input.argv.includes(":read-only"));
    assert.ok(!input.argv.some(arg => /bypass|unelevated/.test(arg)));
    return { promise: new Promise(resolve => setTimeout(() => { f.seed(); resolve({ ok: true, text: "CODEPET_SANDBOX_READY" }); }, 5)) };
  } });
  await Promise.all([state.ensure(f.home, f.source, { commandPath: "codex" }, "workspace"), state.ensure(f.home, f.source, { commandPath: "codex" }, "workspace")]);
  assert.equal(initializations, 1);
  assert.equal(f.calls.length, 1);
});
test("non-Windows hosts skip sandbox synchronization", async () => {
  const state = new CodexWindowsSandboxState({ platform: "linux", run: () => { throw new Error("must not run"); } });
  await state.ensure("missing", "missing", null, null);
});

test("a working native sandbox without legacy machine credentials needs no state copying", async t => {
  const f = fixture(t); let calls = 0;
  const state = new CodexWindowsSandboxState({ platform: "win32", run: () => { throw new Error("must not copy"); }, bootstrap: () => {
    calls++; return { promise: Promise.resolve({ ok: true, text: "CODEPET_SANDBOX_READY" }) };
  } });
  await state.ensure(f.home, f.source, { commandPath: "codex" }, "workspace");
  await state.ensure(f.home, f.source, { commandPath: "codex" }, "workspace");
  assert.equal(calls, 1);
});
