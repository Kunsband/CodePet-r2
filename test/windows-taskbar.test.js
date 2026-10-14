const test = require("node:test");
const assert = require("node:assert/strict");
const { taskbarRows, createTaskbar } = require("../src/windows-taskbar");
test("taskbar protocol contains no credentials or account identity and preserves unknown values", () => {
  const rows = taskbarRows({ providers: [
    { label: "Codex", account: "private@example.com", token: "secret", connected: true, gauges: [{ usedPercent: null }] },
    { label: "Claude", connected: true, stale: true, gauges: [{ usedPercent: 22 }, { usedPercent: 87.6 }] },
    { label: "AGY", connected: false, gauges: [{ usedPercent: 99 }] },
  ] });
  assert.deepEqual(rows, [{ label: "Codex", remainingPercent: null, stale: false }, { label: "Claude", remainingPercent: 12, stale: true }]);
});
test("taskbar displays the smallest remaining quota, including zero and full balances", () => {
  const rows = taskbarRows({ providers: [0, 23, 100, -10, 120].map((usedPercent) => ({ label: "Codex", connected: true, gauges: [{ usedPercent }] })) });
  assert.deepEqual(rows.map((row) => row.remainingPercent), [100, 77, 0, 100]);
  assert.equal(taskbarRows({ providers: [{ label: "AGY", connected: true, gauges: [{ usedPercent: 120 }] }] })[0].remainingPercent, 0);
});
test("non-Windows platforms never launch a floating bar", () => {
  const bar = createTaskbar({ platform: "linux", onClick() { throw new Error("unexpected"); } });
  bar.update({ providers: [] }); bar.setVisible(true); assert.equal(bar.getBounds(), null); bar.dispose();
});

test("native renderer submits an opaque quota surface to a hidden layered child", { skip: process.platform !== "win32", timeout: 30000 }, () => {
  const { execFileSync } = require("node:child_process");
  const path = require("node:path");
  const output = execFileSync(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-File", path.join(__dirname, "../scripts/test-taskbar-renderer.ps1")],
    { windowsHide: true, encoding: "utf8", timeout: 25000 });
  assert.match(output, /PASS: hidden layered child, native surface submitted/);
});
