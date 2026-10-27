const fs = require("node:fs");
const path = require("node:path");

const fileKey = (file) => process.platform === "win32"
  ? path.resolve(file).toLowerCase() : path.resolve(file);

function rootIdentity(root) {
  try {
    const stat = fs.statSync(root);
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
  } catch { return null; }
}

// Keep polling/JSONL parsing on the existing cadence, but only stat changed files.
// Reconcile periodically because filesystem notifications can be lost. Unsupported
// or unavailable watches retain the original full-scan polling behavior.
class LogFileIndex {
  // Fork: Windows may not report appends to a file another process keeps open (Codex keeps its
  // rollout file open), so reconcile every 5s instead of 60s to avoid minute-long status delays.
  constructor({ scan, watch = fs.watch, now = Date.now, reconcileMs = 5000 }) {
    this.scan = scan;
    this.watch = watch;
    this.now = now;
    this.reconcileMs = reconcileMs;
    this.roots = new Map();
  }

  read(roots) {
    const wanted = new Map(roots.map((root) => [fileKey(root), root]));
    for (const [key, state] of this.roots) {
      if (wanted.has(key)) continue;
      state.watcher?.close();
      this.roots.delete(key);
    }
    const result = new Map();
    for (const [key, root] of wanted) {
      let state = this.roots.get(key);
      if (!state) {
        state = { files: new Map(), dirty: new Set(), rescan: true, scannedAt: -Infinity, retryAt: -Infinity };
        this.roots.set(key, state);
      }
      const now = this.now();
      if (state.watcher && (state.rescan || now - state.scannedAt >= this.reconcileMs)
        && rootIdentity(root) !== state.identity) {
        state.watcher.close();
        state.watcher = null;
        state.retryAt = -Infinity;
      }
      if (!state.watcher && now >= state.retryAt) {
        state.retryAt = now + this.reconcileMs;
        try {
          const watcher = this.watch(root, { recursive: true, persistent: false }, (event, filename) => {
            if (this.roots.get(key) !== state) return;
            if (!filename || event === "rename") { state.rescan = true; return; }
            const changed = fileKey(path.join(root, String(filename)));
            if (state.files.has(changed)) state.dirty.add(changed);
            else if (changed.endsWith(".jsonl")) state.rescan = true;
          });
          state.watcher = watcher;
          state.identity = rootIdentity(root);
          watcher.on("error", () => {
            if (state.watcher !== watcher) return;
            watcher.close();
            state.watcher = null;
            state.rescan = true;
          });
          state.rescan = true;
        } catch { state.watcher = null; }
      }
      if (!state.watcher || state.rescan || now - state.scannedAt >= this.reconcileMs) {
        state.rescan = false;
        state.dirty.clear();
        state.files = new Map(this.scan(root).map((file) => [fileKey(file.filePath), file]));
        state.scannedAt = now;
      } else {
        for (const changed of state.dirty) {
          const file = state.files.get(changed);
          if (!file) continue;
          try {
            const stat = fs.statSync(file.filePath);
            if (stat.isFile()) state.files.set(changed, { ...file, size: stat.size, mtimeMs: stat.mtimeMs });
            else state.files.delete(changed);
          } catch { state.files.delete(changed); }
        }
        state.dirty.clear();
      }
      for (const [name, file] of state.files) result.set(name, file);
    }
    return [...result.values()];
  }

  close() {
    for (const state of this.roots.values()) state.watcher?.close();
    this.roots.clear();
  }
}

module.exports = { LogFileIndex };
