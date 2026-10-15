const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { runAgentProcess } = require("./chat-agent-runner");

const STATE_FILES = [".sandbox-secrets/sandbox_users.json", ".sandbox/setup_marker.json"];
// Copy only Codex's DPAPI-encrypted Windows machine login state. OAuth logins
// remain independent. Native sandbox paths must be real directories, not links.
const SYNC_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = $env:CODEPET_SANDBOX_SOURCE
$target = $env:CODEPET_SANDBOX_TARGET
$sections = [System.Security.AccessControl.AccessControlSections]::Access
function Copy-AccessRules($from, $to) {
  $sourceAcl = Get-Acl -LiteralPath $from
  $targetAcl = Get-Acl -LiteralPath $to
  $targetAcl.SetSecurityDescriptorSddlForm($sourceAcl.GetSecurityDescriptorSddlForm($sections), $sections)
  Set-Acl -LiteralPath $to -AclObject $targetAcl
}
foreach ($name in @('.sandbox-secrets', '.sandbox')) {
  $sourceDir = Join-Path $source $name
  $targetDir = Join-Path $target $name
  if (!(Test-Path -LiteralPath $targetDir)) {
    $null = [IO.Directory]::CreateDirectory($targetDir)
    Copy-AccessRules $sourceDir $targetDir
  }
}
foreach ($name in @('.sandbox-secrets\sandbox_users.json', '.sandbox\setup_marker.json')) {
  $from = Join-Path $source $name
  $to = Join-Path $target $name
  if ((Test-Path -LiteralPath $to) -and !(Test-Path -LiteralPath ($to + '.codepet-backup'))) {
    Copy-Item -LiteralPath $to -Destination ($to + '.codepet-backup')
    Copy-AccessRules $to ($to + '.codepet-backup')
  }
  $temporary = $to + '.codepet-next-' + [Guid]::NewGuid().ToString('N')
  try {
    Copy-Item -LiteralPath $from -Destination $temporary -Force
    Copy-AccessRules $from $temporary
    Move-Item -LiteralPath $temporary -Destination $to -Force
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
  }
}
`;

class CodexWindowsSandboxState {
  constructor({ platform = process.platform, run = execFileSync, bootstrap = runAgentProcess } = {}) {
    this.platform = platform;
    this.run = run;
    this.bootstrap = bootstrap;
    this.starting = null;
    this.nativeReady = new Map();
    this.cache = new Map();
  }

  async ensure(home, source, record, cwd) {
    if (this.platform !== "win32") return;
    if (!STATE_FILES.every(name => fs.existsSync(path.join(source, name)))) {
      const configStamp = (root) => { try { return fs.statSync(path.join(root, "config.toml")).mtimeMs; } catch { return 0; } };
      const readyKey = `${source}|${record.commandPath}|${record.version || ""}|${cwd}|${configStamp(source)}|${configStamp(home)}`;
      if (Date.now() - (this.nativeReady.get(readyKey) || 0) < 60000) return;
      if (!this.starting) {
        const run = this.bootstrap({ commandPath: record.commandPath, needsShell: record.needsShell,
          argv: ["sandbox", "--include-managed-config", "--permission-profile", ":read-only", "--", "cmd.exe", "/d", "/c", "echo", "CODEPET_SANDBOX_READY"],
          cwd, env: { ...process.env, CODEX_HOME: source }, prompt: "", provider: "codex", timeoutMs: 120000 });
        this.starting = run.promise.then(result => {
          if (!result.ok || result.text?.trim() !== "CODEPET_SANDBOX_READY") throw new Error("기본 Codex의 Windows 샌드박스를 초기화하지 못했습니다.");
        }).finally(() => { this.starting = null; });
      }
      await this.starting;
      // MXC and the restricted-token sandbox have no dedicated Windows users.
      if (!STATE_FILES.every(name => fs.existsSync(path.join(source, name)))) {
        this.nativeReady.set(readyKey, Date.now());
        return;
      }
    }
    this.prepare(home, source);
  }

  prepare(home, source) {
    if (this.platform !== "win32") return;
    const targetRoot = fs.realpathSync(home);
    const sourceRoot = fs.realpathSync(source);
    if (targetRoot.toLowerCase() === sourceRoot.toLowerCase()) throw new Error("별도 Codex 계정 경로가 필요합니다.");
    for (const root of [sourceRoot, targetRoot]) {
      for (const name of [".sandbox", ".sandbox-secrets", ...STATE_FILES]) {
        const file = path.join(root, name);
        if (!file.startsWith(root + path.sep)) throw new Error("잘못된 샌드박스 경로입니다.");
        let stat;
        try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (stat?.isSymbolicLink()) throw new Error("Codex 샌드박스 경로는 실제 폴더여야 합니다.");
      }
    }
    const stamp = (root) => STATE_FILES.map((name) => {
      try { const stat = fs.statSync(path.join(root, name)); return `${stat.mtimeMs}:${stat.size}`; }
      catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
    }).join("|");
    const sourceStamp = stamp(sourceRoot);
    if (sourceStamp.includes("missing")) {
      throw new Error("기본 Codex의 Windows 샌드박스를 먼저 초기화해 주세요.");
    }
    const cacheKey = `${sourceRoot}|${sourceStamp}|${stamp(targetRoot)}`;
    if (this.cache.get(targetRoot) === cacheKey) return;
    const shell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    try {
      this.run(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SYNC_SCRIPT, "utf16le").toString("base64")], {
        windowsHide: true, timeout: 15000, stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, PSModulePath: path.join(path.dirname(shell), "Modules"),
          CODEPET_SANDBOX_SOURCE: sourceRoot, CODEPET_SANDBOX_TARGET: targetRoot },
      });
    } catch (cause) {
      throw new Error("Codex의 Windows 샌드박스 상태를 동기화하지 못했습니다. 실행 중인 Codex 작업을 마친 뒤 다시 시도해 주세요.", { cause });
    }
    if (sourceStamp !== stamp(sourceRoot)) throw new Error("Windows 샌드박스 초기화가 진행 중입니다. 잠시 후 다시 시도해 주세요.");
    this.cache.set(targetRoot, `${sourceRoot}|${sourceStamp}|${stamp(targetRoot)}`);
  }
}

module.exports = { CodexWindowsSandboxState };
