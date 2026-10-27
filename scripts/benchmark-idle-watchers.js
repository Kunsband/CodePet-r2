// Metadata-only benchmark with isolated fixtures; never touches account logs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const source = process.env.CODEPET_BENCHMARK_SOURCE || path.join(__dirname, "..", "src");
const { CodexWatcher } = require(path.join(source, "codex-watcher"));
const { ExternalWatcher, recursiveJsonl } = require(path.join(source, "external-watcher"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-idle-benchmark-"));
const watchers = [];
try {
  const day = path.join(root, "sessions", "2026", "01", "01");
  const external = path.join(root, "external");
  fs.mkdirSync(day, { recursive: true });
  for (let i = 0; i < 200; i++) {
    const rollout = path.join(day, `rollout-2026-01-01-${i}.jsonl`);
    fs.writeFileSync(rollout, "\n");
    fs.utimesSync(rollout, 1000, 1000);
    const project = path.join(external, String(i));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "transcript.jsonl"), "\n");
  }
  watchers.push(new CodexWatcher({ getCodexHomes: () => [root] }));
  watchers.push(new ExternalWatcher({ provider: "fixture", roots: [external], findFiles: recursiveJsonl, parseRow: () => null }));
  for (const watcher of watchers) {
    watcher.start();
    const original = { readdirSync: fs.readdirSync, statSync: fs.statSync };
    const counts = { readdirSync: 0, statSync: 0 };
    for (const name of Object.keys(original)) fs[name] = (...args) => {
      counts[name]++;
      return original[name](...args);
    };
    const timings = [];
    try {
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        watcher.poll();
        timings.push(performance.now() - start);
      }
    } finally { Object.assign(fs, original); }
    timings.sort((a, b) => a - b);
    console.log(JSON.stringify({ watcher: watcher.constructor.name, polls: timings.length,
      files: 200, medianMs: +timings[10].toFixed(3), ...counts }));
    watcher.stop();
  }
} finally {
  for (const watcher of watchers) watcher.stop();
  assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
