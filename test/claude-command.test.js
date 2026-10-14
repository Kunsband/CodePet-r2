const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { claudeDesktopCandidates } = require("../src/claude-command");

test("Claude finds Store and standalone Desktop CLI caches, sorting versions numerically", () => {
  const env = { LOCALAPPDATA: "C:\\users\\u\\Local", APPDATA: "C:\\users\\u\\Roaming" };
  const join = path.win32.join;
  const packages = join(env.LOCALAPPDATA, "Packages");
  const desktop = join(env.APPDATA, "Claude", "claude-code");
  const store = join(packages, "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude", "claude-code");
  const tree = new Map([
    [packages, ["Claude_pzs8sxrjxfjjc", "Unrelated_app"]],
    [desktop, ["2.1.9"]], [store, ["2.1.99", "2.1.295", "invalid"]],
    [join(desktop, "2.1.9"), ["old"]],
    [join(store, "2.1.99"), ["middle"]], [join(store, "2.1.295"), ["new", "incomplete"]],
  ]);
  const expected = [join(store, "2.1.295", "new", "claude.exe"), join(store, "2.1.99", "middle", "claude.exe"), join(desktop, "2.1.9", "old", "claude.exe")];
  const fsApi = {
    readdirSync: (dir) => (tree.get(dir) || []).map((name) => ({ name, isDirectory: () => true, isSymbolicLink: () => false })),
    statSync: (file) => ({ isFile: () => expected.includes(file) }),
  };
  assert.deepEqual(claudeDesktopCandidates({ platform: "win32", env, fsApi }), expected);
  assert.deepEqual(claudeDesktopCandidates({ platform: "linux", env, fsApi }), []);
});
