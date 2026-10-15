const fs = require("node:fs");
const path = require("node:path");

// Microsoft Store판 PowerShell은 PATH에 앱 실행 별칭(reparse point)으로만 노출됩니다.
// Claude CLI(Bun 빌드)는 이 별칭을 실행 파일로 확인하지 못해 PowerShell 권한 검사용
// 파서(약 29K자 -EncodedCommand)를 cmd.exe로 감싸 띄우고, cmd의 8191자 한도에 걸려
// "명령줄이 너무 깁니다"로 실패합니다. 별칭이 가리키는 실제 설치 폴더를 별칭 폴더
// 바로 앞에 끼워 넣어 CLI가 실제 pwsh.exe를 찾도록 합니다.
function pathKey(env) {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") || "Path";
}

function realPwshDirForAlias(env, fsApi = fs) {
  const entries = String(env[pathKey(env)] || "").split(path.win32.delimiter).filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const candidate = path.win32.join(entries[index], "pwsh.exe");
    let target = null;
    try {
      target = fsApi.readlinkSync(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      // 일반 실행 파일(EINVAL 등)이 먼저 잡히면 CLI도 그것을 쓰므로 보정이 필요 없습니다.
      return null;
    }
    if (!path.win32.isAbsolute(target) || path.win32.basename(target).toLowerCase() !== "pwsh.exe") return null;
    return { index, dir: path.win32.dirname(target) };
  }
  return null;
}

function withRealPwshPath(env = process.env, { platform = process.platform, fsApi = fs } = {}) {
  if (platform !== "win32") return env;
  const source = { ...env };
  const found = realPwshDirForAlias(source, fsApi);
  if (!found) return env;
  const key = pathKey(source);
  const entries = String(source[key] || "").split(path.win32.delimiter).filter(Boolean);
  if (entries.some((entry) => entry.toLowerCase() === found.dir.toLowerCase())) return env;
  entries.splice(found.index, 0, found.dir);
  source[key] = entries.join(path.win32.delimiter);
  return source;
}

module.exports = { withRealPwshPath, realPwshDirForAlias };
