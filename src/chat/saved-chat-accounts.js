const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { atomicWrite, atomicWriteText } = require("../provider-profile-store");
const { createClaudeLiveStore } = require("../claude-live-credentials");
const { ClaudeAccountSwitcher } = require("../claude-account-switcher");
const { grokCredential } = require("../grok-account-switcher");
const { probeClaudeModelCatalog, parseGrokCatalog, normalizeCatalog, CATALOG_ERROR } = require("../providers/provider-model-catalog");
const { GrokDockerRuntime } = require("../grok-docker-runtime");

const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function readText(file) { try { return fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
const AUTH_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR", "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID"];
const GROK_AUTH_ENV = ["XAI_API_KEY", "GROK_API_KEY", "GROK_BASE_URL"];

// Copy only small configuration files. Large skills/plugin trees are shared;
// histories, caches and credentials are never inherited from the live account.
function inheritSettings(source, target, providerId) {
  const manifestPath = path.join(target, ".codepet-inheritance.json");
  const hashes = readJson(manifestPath) || {};
  const files = providerId === "claude"
    ? ["settings.json", "settings.local.json", "managed-settings.json", "CLAUDE.md"]
    : ["config.toml", "managed_config.toml", "requirements.toml", "AGENTS.md"];
  for (const name of files) {
    const file = path.join(target, name);
    const current = readText(file);
    if (current !== null && hashes[name] !== hash(current)) continue;
    let next = readText(path.join(source, name));
    if (providerId === "claude" && name.startsWith("settings") && next !== null) {
      const settings = JSON.parse(next);
      delete settings.apiKeyHelper;
      if (settings.env) for (const key of [...AUTH_ENV, "CLAUDE_CONFIG_DIR"]) delete settings.env[key];
      next = JSON.stringify(settings, null, 2);
    }
    if (next === null) {
      if (current !== null) fs.unlinkSync(file);
      delete hashes[name];
    } else {
      if (next !== current) atomicWriteText(file, next);
      hashes[name] = hash(next);
    }
  }
  for (const name of ["skills", "commands", "rules", "plugins"]) {
    const from = path.join(source, name), to = path.join(target, name);
    if (!fs.existsSync(from)) continue;
    try { fs.lstatSync(to); } catch (e) {
      if (e.code !== "ENOENT") throw e;
      fs.symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
    }
  }
  if (JSON.stringify(readJson(manifestPath)) !== JSON.stringify(hashes)) atomicWrite(manifestPath, hashes);
}

function probeGrokModels(commandPath, needsShell, timeout, options) {
  return new Promise((resolve) => {
    execFile(needsShell ? `"${commandPath}"` : commandPath, ["models"], { env: options.env, cwd: options.cwd, shell: needsShell,
      timeout, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve(error ? [] : parseGrokCatalog(`${stdout}\n${stderr}`));
    });
  });
}

class SavedChatAccounts {
  constructor({ providerId, switcher, probe, credentialStore, dockerRuntime, now = Date.now }) {
    this.providerId = providerId;
    this.label = providerId === "claude" ? "Claude" : "Grok";
    this.switcher = switcher;
    this.probe = probe || (providerId === "claude" ? probeClaudeModelCatalog : probeGrokModels);
    this.credentialStore = credentialStore || ((dir) => providerId === "claude"
      ? createClaudeLiveStore({ configDir: dir })
      : { read: () => readJson(path.join(dir, "auth.json")), write: (value) => atomicWrite(path.join(dir, "auth.json"), value) });
    this.dockerRuntime = dockerRuntime;
    this.now = now;
    this.cache = new Map();
    this.pending = new Map();
    this.credentials = new Map();
    this.runtimes = new Map();
  }

  valid(secret) {
    return this.providerId === "claude" ? ClaudeAccountSwitcher.isProfileUsable(secret) : Boolean(grokCredential(secret)?.refresh_token);
  }

  list() {
    return this.switcher.store.list().map(({ key, label, email, plan }) => ({ key, label: label || email || key, email, plan }));
  }

  prepare(key) {
    const profile = this.switcher.store.get(key);
    if (!profile) throw new Error(`저장된 ${this.label} 계정이 없습니다. 설정에서 다시 로그인해 주세요.`);
    const dir = path.join(this.switcher.store.root, "chat", profile.key);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let credentials = this.credentials.get(key);
    if (!credentials) { credentials = this.credentialStore(dir); this.credentials.set(key, credentials); }
    const seedFile = path.join(dir, ".codepet-auth-seed.json");
    const sourceHash = hash(profile.secret);
    const seed = readJson(seedFile);
    // Preserve CLI token rotation across processes and application restarts.
    if (seed?.sourceHash !== sourceHash || !this.valid(credentials.read())) {
      if (!this.valid(profile.secret)) throw new Error(`${this.label} 로그인 정보가 만료됐습니다. 설정에서 다시 로그인해 주세요.`);
      credentials.write(profile.secret);
      atomicWrite(seedFile, { sourceHash });
      const runtime = this.runtimes.get(key);
      if (runtime) runtime.authConfirmedAt = 0;
    }
    inheritSettings(path.join(this.switcher.home, `.${this.providerId}`), dir, this.providerId);
    const env = { ...process.env, [this.providerId === "claude" ? "CLAUDE_CONFIG_DIR" : "GROK_HOME"]: dir };
    for (const name of this.providerId === "claude" ? AUTH_ENV : GROK_AUTH_ENV) delete env[name];
    const finish = async (runtime) => {
      if (hash(this.switcher.store.get(key)?.secret) !== sourceHash) return;
      let next = credentials.read(true);
      if (runtime) {
        const volume = await runtime.readVolumeAuth();
        if (volume) { next = JSON.parse(volume.raw); credentials.write(next); }
      }
      if (!this.valid(next) || JSON.stringify(next) === JSON.stringify(profile.secret)) return;
      if (this.switcher.store.updateSecret(key, next, profile.secret)) atomicWrite(seedFile, { sourceHash: hash(next) });
    };
    return { env, dir, finish };
  }

  runtime(key) {
    if (this.providerId !== "grok" || !this.dockerRuntime) return null;
    const { dir } = this.prepare(key);
    if (!this.runtimes.has(key)) {
      const base = this.dockerRuntime;
      this.runtimes.set(key, new GrokDockerRuntime({ platform: base.platform, env: base.env, home: base.home,
        image: base.image, dockerPath: base.dockerPath, assetsDir: base.assetsDir, changeStore: base.changeStore,
        authPath: path.join(dir, "auth.json"), authVolume: `${base.authVolume}-${key}` }));
    }
    return this.runtimes.get(key);
  }

  async discover(key, base, { force = false } = {}) {
    const fingerprint = hash(this.switcher.store.get(key)?.secret);
    const cached = this.cache.get(key);
    if (!force && cached && cached.fingerprint === fingerprint && cached.commandPath === base?.commandPath && this.now() - cached.at < 60000) return cached.record;
    if (this.pending.has(key)) return this.pending.get(key);
    const pending = (async () => {
      let models = [], reason = "";
      try {
        if (!base?.commandPath || base.status !== "cli") throw new Error(`${this.label} CLI를 먼저 설치해 주세요.`);
        const account = this.prepare(key);
        try { models = normalizeCatalog(await this.probe(base.commandPath, base.needsShell, 15000, { env: account.env })); }
        finally { await account.finish(); }
        if (!models.length) reason = CATALOG_ERROR;
      } catch (error) { reason = error.message || CATALOG_ERROR; }
      const record = { ...base, providerId: this.providerId, reason, modelOptions: models, models: models.map((row) => row.id),
        efforts: [], catalogStatus: models.length ? "ready" : "unavailable", catalogReason: reason };
      this.cache.set(key, { at: this.now(), fingerprint: hash(this.switcher.store.get(key)?.secret), commandPath: base?.commandPath, record });
      return record;
    })();
    this.pending.set(key, pending);
    try { return await pending; } finally { this.pending.delete(key); }
  }

  record(key, base) {
    if (this.switcher.store.get(key)) return this.cache.get(key)?.record || { ...base, models: [], modelOptions: [], catalogStatus: "unavailable", reason: "이 계정의 모델 목록을 다시 확인해 주세요." };
    return { ...base, models: [], modelOptions: [], catalogStatus: "unavailable", reason: "저장된 계정이 삭제되었습니다. 참가자를 다시 추가해 주세요." };
  }
}

module.exports = { SavedChatAccounts, inheritSettings, probeGrokModels };
