const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Fork-only: keep Live's default working folder out of the CodePet program folder.
test("fork: Live starts in a dedicated empty folder, not the CodePet program folder", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  assert.match(main, /const liveWorkspace = path\.join\(os\.homedir\(\), "\.codepet", "live", "workspace"\);/);
  assert.match(main, /defaultWorkspace: liveWorkspace,/);
  // Upstream has used the app folder and, since 1.1.9, the whole home folder; keep neither.
  assert.doesNotMatch(main, /defaultWorkspace: (app\.isPackaged|os\.homedir\(\))/);
});

test("fork: log watchers reconcile every 5 seconds by default", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/log-file-index.js"), "utf8");
  assert.match(source, /reconcileMs = 5000 \}\)/);
});
