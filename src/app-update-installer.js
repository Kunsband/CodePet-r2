const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { WINDOWS_UPDATE_SCRIPT } = require("./windows-update-helper");

const MAX_DOWNLOAD = 1024 * 1024 * 1024;
const RELEASE_PREFIX = "https://github.com/nokryong/CodePet/releases/download/";
const DOWNLOAD_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchReleaseFile(url, fetchImpl, signal) {
  if (!url?.startsWith(RELEASE_PREFIX)) throw new Error("Untrusted release URL");
  for (let redirects = 0; redirects < 6; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !DOWNLOAD_HOSTS.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) {
      throw new Error("Untrusted download redirect");
    }
    const response = await fetchImpl(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Missing redirect location");
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !response.body) throw new Error("Release download failed");
    return response;
  }
  throw new Error("Too many download redirects");
}

function checksumFor(manifest, name) {
  const matches = manifest.split(/\r?\n/).map(line => line.match(/^([a-fA-F0-9]{64}) [ *](.+)$/))
    .filter(match => match?.[2] === name);
  if (matches.length !== 1) throw new Error("Missing or ambiguous release checksum");
  return matches[0][1].toLowerCase();
}

async function fileHash(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function portableTarget({ platform, isPackaged, env }) {
  const target = env.PORTABLE_EXECUTABLE_FILE;
  return platform === "win32" && isPackaged && target && path.isAbsolute(target) && /\.exe$/i.test(target) ? target : null;
}

class AppUpdateInstaller extends EventEmitter {
  constructor({ app, platform = process.platform, env = process.env, fetchImpl = globalThis.fetch, spawnImpl = spawn }) {
    super();
    this.app = app;
    this.env = env;
    this.target = portableTarget({ platform, isPackaged: app.isPackaged, env });
    this.supported = Boolean(this.target);
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.state = { phase: "idle" };
    this.pending = null;
  }

  report(phase, percent) {
    this.state = { phase, ...(Number.isFinite(percent) ? { percent } : {}) };
    this.emit("progress", this.state);
  }

  install(release) {
    if (this.pending) return this.pending;
    this.pending = this.performInstall(release).catch(error => {
      this.report("error");
      this.pending = null;
      throw error;
    });
    return this.pending;
  }

  async performInstall(release) {
    if (!this.supported || !release.asset || !release.checksumUrl) throw new Error("No verified portable update available");
    const { asset } = release;
    if (!/^CodePet-[0-9]+\.[0-9]+\.[0-9]+(?:-(?:x64|arm64|ia32))?\.exe$/.test(asset.name)
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_DOWNLOAD) {
      throw new Error("Invalid update asset");
    }
    const targetStat = await fsp.lstat(this.target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error("Invalid portable executable");
    // A sibling staging directory both checks write access and keeps replacement on one volume.
    const stage = await fsp.mkdtemp(path.join(path.dirname(this.target), ".codepet-update-"));
    let helper;
    try {
      this.report("downloading", 0);
      const signal = AbortSignal.timeout(5 * 60_000);
      const manifestResponse = await fetchReleaseFile(release.checksumUrl, this.fetch, signal);
      const manifestChunks = [];
      let manifestSize = 0;
      for await (const chunk of manifestResponse.body) {
        manifestSize += chunk.length;
        if (manifestSize > 1024 * 1024) throw new Error("Checksum manifest is too large");
        manifestChunks.push(Buffer.from(chunk));
      }
      const sha256 = checksumFor(Buffer.concat(manifestChunks).toString("utf8"), asset.name);
      const response = await fetchReleaseFile(asset.url, this.fetch, signal);
      const payload = path.join(stage, "update.exe");
      const file = await fsp.open(payload, "wx");
      let received = 0, lastPercent = -1;
      try {
        for await (const chunk of response.body) {
          received += chunk.length;
          if (received > asset.size) throw new Error("Download exceeds release size");
          await file.writeFile(chunk);
          const percent = Math.floor(received / asset.size * 100);
          if (percent !== lastPercent) { this.report("downloading", percent); lastPercent = percent; }
        }
        await file.sync();
      } finally { await file.close(); }
      this.report("verifying");
      if (received !== asset.size || await fileHash(payload) !== sha256) throw new Error("Download integrity check failed");
      const previousSha256 = await fileHash(this.target);
      helper = await this.startHelper({ target: this.target, stage, sha256, previousSha256, parentPid: process.pid });
      await fsp.writeFile(path.join(stage, "apply"), "apply", { flag: "wx" });
      this.report("restarting");
      helper.unref();
      // Let the IPC response/progress reach the settings window before normal shutdown.
      setTimeout(() => this.app.quit(), 300);
    } catch (error) {
      if (helper) helper.kill();
      await fsp.rm(stage, { recursive: true, force: true });
      throw error;
    }
  }

  async startHelper(config) {
    const powershell = path.join(this.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = this.spawn(powershell, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand",
      Buffer.from(WINDOWS_UPDATE_SCRIPT, "utf16le").toString("base64")], {
      detached: true, windowsHide: true, stdio: "ignore", cwd: path.dirname(this.target),
      env: { ...this.env, CODEPET_UPDATE_CONFIG: JSON.stringify(config) },
    });
    let failure;
    child.once("error", error => { failure = error; });
    child.once("exit", () => { failure ||= new Error("Update helper exited before it was ready"); });
    try {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (failure) throw failure;
        try { await fsp.access(path.join(config.stage, "ready")); return child; } catch {}
        await pause(100);
      }
      throw new Error("Update helper did not become ready");
    } catch (error) { child.kill(); throw error; }
  }
}

function acknowledgeUpdateStartup(env = process.env) {
  const stage = env.CODEPET_UPDATE_STAGE;
  delete env.CODEPET_UPDATE_STAGE;
  if (!stage || !env.PORTABLE_EXECUTABLE_FILE) return;
  try {
    if (!path.isAbsolute(stage) || !/^\.codepet-update-[a-zA-Z0-9]+$/.test(path.basename(stage))
      || fs.realpathSync.native(path.dirname(stage)) !== fs.realpathSync.native(path.dirname(env.PORTABLE_EXECUTABLE_FILE))
      || fs.lstatSync(stage).isSymbolicLink()) return;
    fs.writeFileSync(path.join(stage, "started"), "started", { flag: "wx" });
  } catch { /* The updater retains its backup if startup cannot be acknowledged. */ }
}

module.exports = { AppUpdateInstaller, acknowledgeUpdateStartup, checksumFor, fetchReleaseFile, portableTarget };
