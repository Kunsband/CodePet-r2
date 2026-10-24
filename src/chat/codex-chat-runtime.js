const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { atomicWriteText } = require("../provider-profile-store");
const { CodexWindowsSandboxState } = require("./codex-windows-sandbox");

const hash = value => createHash("sha256").update(value || "").digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function optional(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

// Authentication/configuration come from the selected account. Session files,
// SQLite state, writer leases and logs belong exclusively to CodePet.
class CodexChatRuntime {
  constructor({ root, platform = process.platform }) {
    this.root = path.resolve(root);
    this.sandbox = new CodexWindowsSandboxState({ platform });
  }

  homeFor(source, identity = null) {
    const normalized = path.resolve(source);
    return path.join(this.root, hash(JSON.stringify([process.platform === "win32" ? normalized.toLowerCase() : normalized, identity])));
  }

  settings(source, identity) {
    const home = this.homeFor(source, identity);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const manifestFile = path.join(home, ".codepet-settings.json");
    const oldNames = JSON.parse(optional(manifestFile) || "[]");
    const names = new Set(["config.toml", "managed_config.toml", "requirements.toml", "AGENTS.md", "AGENTS.override.md", "hooks.json",
      ...entries(source).filter(entry => entry.isFile() && entry.name.endsWith(".config.toml")).map(entry => entry.name)]);
    for (const name of new Set([...names, ...oldNames])) {
      if (path.basename(name) !== name) throw new Error("잘못된 Codex 설정 파일 경로입니다.");
      const next = names.has(name) ? optional(path.join(source, name)) : null;
      const target = path.join(home, name);
      if (next === null) fs.rmSync(target, { force: true });
      else if (optional(target) !== next) atomicWriteText(target, next);
    }
    atomicWriteText(manifestFile, JSON.stringify([...names]));
    for (const name of ["skills", "rules", "agents", "plugins"]) {
      const from = path.join(source, name), to = path.join(home, name);
      if (!fs.existsSync(from)) continue;
      try { fs.lstatSync(to); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        fs.symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
      }
    }
    return home;
  }

  async prepareSandbox({ sourceHome, identity, sandboxSource = sourceHome, record, cwd }) {
    const home = this.settings(sourceHome, identity);
    await this.sandbox.ensure(home, sandboxSource, record, cwd);
  }

  prepare({ sourceHome, identity, env }) {
    const home = this.settings(sourceHome, identity);
    const sourceFile = path.join(sourceHome, "auth.json"), targetFile = path.join(home, "auth.json");
    const seedFile = path.join(home, ".codepet-auth-seed.json");
    const source = optional(sourceFile);
    const sourceHash = hash(source);
    const seed = JSON.parse(optional(seedFile) || "null");
    // Retain refreshed credentials if the source has not changed, including
    // after a crash. A changed/deleted source login must replace/remove them.
    if (seed?.sourceHash !== sourceHash || (source !== null && optional(targetFile) === null)) {
      if (source === null) fs.rmSync(targetFile, { force: true });
      else atomicWriteText(targetFile, source);
      atomicWriteText(seedFile, JSON.stringify({ sourceHash }));
    }
    const argv = ["-c", `sqlite_home=${JSON.stringify(home)}`, "-c", `log_dir=${JSON.stringify(path.join(home, "log"))}`];
    if (source !== null) argv.push("-c", "cli_auth_credentials_store=file");
    return {
      home, env: { ...env, CODEX_HOME: home }, argv,
      migrate: id => migrateRollout(sourceHome, home, id),
      finish() {
        const next = optional(targetFile);
        if (source === null || next === null || next === source || optional(sourceFile) !== source) return;
        // Never overwrite a concurrent account switch or a separate refresh.
        JSON.parse(next);
        atomicWriteText(sourceFile, next);
        atomicWriteText(seedFile, JSON.stringify({ sourceHash: hash(next) }));
      },
    };
  }
}

function findRollout(home, id) {
  function visit(dir, depth) {
    for (const entry of entries(dir)) {
      if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${id}.jsonl`)) return path.join(dir, entry.name);
      if (entry.isDirectory() && depth > 0 && /^\d{2,4}$/.test(entry.name)) {
        const found = visit(path.join(dir, entry.name), depth - 1);
        if (found) return found;
      }
    }
    return null;
  }
  return visit(path.join(home, "sessions"), 3) || visit(path.join(home, "archived_sessions"), 3);
}

function migrateRollout(sourceHome, home, id) {
  if (!UUID.test(id)) throw new Error("CLI 세션 ID가 올바르지 않습니다.");
  if (findRollout(home, id)) return;
  const source = findRollout(sourceHome, id);
  if (!source) throw new Error("기존 Codex 대화 기록을 찾지 못해 전용 저장소로 옮기지 못했습니다. 원본 기록을 확인해 주세요.");
  // Snapshot complete records only; the original may still be open in Desktop.
  const raw = fs.readFileSync(source);
  const end = raw.lastIndexOf(10);
  const snapshot = raw.subarray(0, end + 1);
  const first = JSON.parse(snapshot.subarray(0, snapshot.indexOf(10)).toString("utf8"));
  if (first.type !== "session_meta" || first.payload?.id !== id) throw new Error("기존 Codex 세션 기록의 ID가 일치하지 않습니다.");
  const date = path.basename(source).match(/^rollout-(\d{4})-(\d{2})-(\d{2})/);
  if (!date) throw new Error("기존 Codex 대화 기록의 날짜 경로가 올바르지 않습니다.");
  const target = path.join(home, "sessions", ...date.slice(1), path.basename(source));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, snapshot, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}

module.exports = { CodexChatRuntime, migrateRollout, findRollout };
