const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function claudeDesktopCandidates({ platform = process.platform, env = process.env, home = os.homedir(), fsApi = fs } = {}) {
  if (platform !== "win32") return [];
  const join = path.win32.join;
  const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
  const roaming = env.APPDATA || join(home, "AppData", "Roaming");
  const directories = (root) => {
    try {
      return fsApi.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
    } catch { return []; }
  };
  const roots = [join(roaming, "Claude", "claude-code")];
  const packages = join(local, "Packages");
  for (const name of directories(packages).filter((name) => /^Claude_[A-Za-z0-9]+$/.test(name))) {
    roots.push(join(packages, name, "LocalCache", "Roaming", "Claude", "claude-code"));
  }
  const candidates = [];
  for (const root of roots) {
    for (const version of directories(root).filter((name) => /^\d+\.\d+\.\d+$/.test(name))) {
      for (const hash of directories(join(root, version))) {
        const file = join(root, version, hash, "claude.exe");
        try {
          if (fsApi.statSync(file).isFile()) candidates.push({ file, version });
        } catch { /* An app update may remove a version while scanning. */ }
      }
    }
  }
  return candidates.sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }))
    .map(({ file }) => file);
}

module.exports = { claudeDesktopCandidates };
