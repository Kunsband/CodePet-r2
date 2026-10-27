// Public distribution used by README and the AppImage update channel. The
// development repository is private and cannot serve unauthenticated clients.
const RELEASE_REPOSITORY = "nokryong/CodePet";
const RELEASE_ROOT = `https://github.com/${RELEASE_REPOSITORY}/releases`;
const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;

function parseVersion(value) {
  const match = String(value || "").match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? { parts, prerelease: match[4] || null, version: parts.join(".") } : null;
}

function isNewerStableVersion(latest, current) {
  const next = parseVersion(latest), installed = parseVersion(current);
  if (!next || !installed || next.prerelease) return false;
  for (let index = 0; index < 3; index++) {
    if (next.parts[index] !== installed.parts[index]) return next.parts[index] > installed.parts[index];
  }
  return Boolean(installed.prerelease);
}

function releaseAsset(release, name) {
  const expected = `${RELEASE_ROOT}/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}`;
  const asset = Array.isArray(release.assets) && release.assets.find(item => item.name === name && item.browser_download_url === expected);
  return asset ? { name, url: expected, size: asset.size } : null;
}

function nativeAsset(release, platform, arch) {
  const version = parseVersion(release.tag_name)?.version;
  const names = platform === "win32"
    ? [`CodePet-${version}-${arch}.exe`, ...(arch === "x64" ? [`CodePet-${version}.exe`] : [])]
    : platform === "darwin" ? [`CodePet-${version}-mac-universal.dmg`, `CodePet-${version}-mac-${arch}.dmg`]
      : platform === "linux" ? [`CodePet-${version}-${arch === "x64" ? "x86_64" : arch}.AppImage`] : [];
  for (const name of names) {
    const asset = releaseAsset(release, name);
    if (asset) return asset;
  }
  return null;
}

function downloadTarget(release, platform, arch) {
  return nativeAsset(release, platform, arch)?.url || `${RELEASE_ROOT}/tag/${encodeURIComponent(release.tag_name)}`;
}

class AppUpdateChecker {
  constructor({ currentVersion, platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch, now = Date.now }) {
    this.currentVersion = currentVersion;
    this.platform = platform;
    this.arch = arch;
    this.fetch = fetchImpl;
    this.now = now;
    this.cached = null;
    this.expiresAt = 0;
    this.pending = null;
  }

  async check() {
    if (this.cached && this.now() < this.expiresAt) return this.cached;
    if (this.pending) return this.pending;
    this.pending = this.fetchLatest().finally(() => { this.pending = null; });
    return this.pending;
  }

  async fetchLatest() {
    let result;
    try {
      const response = await this.fetch(RELEASE_API, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `CodePet/${this.currentVersion}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`Release lookup failed (${response.status})`);
      const release = await response.json();
      const version = parseVersion(release?.tag_name);
      if (!version || release.draft || release.prerelease || version.prerelease) throw new Error("No stable release found");
      const available = isNewerStableVersion(release.tag_name, this.currentVersion);
      result = { currentVersion: this.currentVersion, latestVersion: version.version,
        status: available ? "available" : "up-to-date",
        ...(available ? { downloadUrl: downloadTarget(release, this.platform, this.arch),
          asset: nativeAsset(release, this.platform, this.arch), checksumUrl: releaseAsset(release, "SHA256SUMS")?.url } : {}) };
    } catch {
      result = { currentVersion: this.currentVersion, status: "unavailable" };
    }
    this.cached = result;
    this.expiresAt = this.now() + (result.status === "unavailable" ? 60_000 : 15 * 60_000);
    return result;
  }
}

function registerUpdateIpc({ ipcMain, shell, checker, updater }) {
  ipcMain.handle("settings:check-update", async () => {
    const { currentVersion, latestVersion, status } = await checker.check();
    return { currentVersion, latestVersion, status, automatic: Boolean(updater?.supported), update: updater?.state };
  });
  ipcMain.handle("settings:download-update", async () => {
    const result = await checker.check();
    if (result.status !== "available") return { ok: false, error: "지금 다운로드할 새 버전을 확인하지 못했습니다." };
    try {
      if (updater?.supported) {
        await updater.install(result);
        return { ok: true, restarting: true };
      }
      await shell.openExternal(result.downloadUrl);
      return { ok: true };
    } catch {
      return { ok: false, error: updater?.supported
        ? "업데이트를 적용하지 못했습니다. 기존 버전은 유지됩니다. 저장 공간과 폴더 쓰기 권한, 네트워크를 확인하고 다시 시도해 주세요."
        : "다운로드 링크를 열지 못했습니다. 잠시 후 다시 시도해 주세요." };
    }
  });
}

module.exports = { AppUpdateChecker, registerUpdateIpc, isNewerStableVersion, downloadTarget, RELEASE_REPOSITORY, RELEASE_API };
