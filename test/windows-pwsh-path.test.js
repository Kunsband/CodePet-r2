const test = require("node:test");
const assert = require("node:assert/strict");
const { withRealPwshPath } = require("../src/chat/windows-pwsh-path");

const ALIAS_DIR = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps";
const REAL_DIR = "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.7.0_x64__8wekyb3d8bbwe";

function fakeFs(links) {
  return {
    readlinkSync(file) {
      if (Object.hasOwn(links, file)) {
        const value = links[file];
        if (value instanceof Error) throw value;
        return value;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
}
const regularFile = () => Object.assign(new Error("not a link"), { code: "EINVAL" });

test("inserts the Store pwsh install dir right before its execution alias", () => {
  const env = { Path: `C:\\Windows\\System32;${ALIAS_DIR};C:\\tools`, OTHER: "x" };
  const fsApi = fakeFs({ [`${ALIAS_DIR}\\pwsh.exe`]: `${REAL_DIR}\\pwsh.exe` });
  const next = withRealPwshPath(env, { platform: "win32", fsApi });
  assert.equal(next.Path, `C:\\Windows\\System32;${REAL_DIR};${ALIAS_DIR};C:\\tools`);
  assert.equal(next.OTHER, "x");
  assert.equal(env.Path, `C:\\Windows\\System32;${ALIAS_DIR};C:\\tools`, "input env must not be mutated");
});

test("leaves PATH alone when a regular pwsh.exe comes first", () => {
  const env = { PATH: `C:\\Program Files\\PowerShell\\7;${ALIAS_DIR}` };
  const fsApi = fakeFs({
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe": regularFile(),
    [`${ALIAS_DIR}\\pwsh.exe`]: `${REAL_DIR}\\pwsh.exe`,
  });
  assert.equal(withRealPwshPath(env, { platform: "win32", fsApi }), env);
});

test("leaves PATH alone when pwsh is missing, already resolved, or not on Windows", () => {
  const fsApi = fakeFs({ [`${ALIAS_DIR}\\pwsh.exe`]: `${REAL_DIR}\\pwsh.exe` });
  const missing = { Path: "C:\\Windows\\System32" };
  assert.equal(withRealPwshPath(missing, { platform: "win32", fsApi }), missing);
  const resolved = { Path: `${REAL_DIR};${ALIAS_DIR}` };
  assert.equal(withRealPwshPath(resolved, { platform: "win32", fsApi }), resolved);
  const linux = { PATH: `${ALIAS_DIR}` };
  assert.equal(withRealPwshPath(linux, { platform: "linux", fsApi }), linux);
});
