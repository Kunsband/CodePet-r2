const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const credentialStore = require("./credential-store");

// AGY CLI의 live 자격 증명 위치입니다. agy는 zalando/go-keyring을 쓰므로 OS마다 저장 형식이 다릅니다.
// - Windows: 자격 증명 관리자 "gemini:antigravity" (go-keyring의 service:user 이름)
// - macOS: Keychain service "gemini", account "antigravity", 값 앞에 "go-keyring-base64:" 접두사
// CLI의 파일 저장소는 ~/.gemini/antigravity-cli/antigravity-oauth-token입니다.
const KEYRING_SERVICE = "gemini";
const KEYRING_USER = "antigravity";
const WINDOWS_TARGET = `${KEYRING_SERVICE}:${KEYRING_USER}`;
const BASE64_PREFIX = "go-keyring-base64:";
const HEX_PREFIX = "go-keyring-encoded:";
// security CLI는 항목이 없을 때 44로 종료합니다.
const SECURITY_NOT_FOUND = 44;

function decodeKeyringValue(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.startsWith(BASE64_PREFIX)) {
    return Buffer.from(trimmed.slice(BASE64_PREFIX.length), "base64").toString("utf8");
  }
  if (trimmed.startsWith(HEX_PREFIX)) {
    return Buffer.from(trimmed.slice(HEX_PREFIX.length), "hex").toString("utf8");
  }
  return trimmed;
}

function encodeKeyringValue(value) {
  return `${BASE64_PREFIX}${Buffer.from(JSON.stringify(value), "utf8").toString("base64")}`;
}

function runSecurity(args, { stdin, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = stdin === undefined
      ? execFile("security", args, { timeout: timeoutMs }, (error, stdout) => {
        if (error) reject(Object.assign(new Error("Keychain 작업에 실패했습니다."), { code: error.code }));
        else resolve(stdout);
      })
      : spawn("security", args, { stdio: ["pipe", "ignore", "ignore"] });
    if (stdin === undefined) return;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Keychain 작업을 시작하지 못했습니다."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve("");
      else reject(Object.assign(new Error("Keychain 작업에 실패했습니다."), { code }));
    });
    // 비밀 값이 ps 출력에 보이지 않도록 `security -i`의 stdin으로만 전달합니다.
    child.stdin.end(stdin);
  });
}

function createMacKeychain({ run = runSecurity } = {}) {
  return {
    async read() {
      try {
        return decodeKeyringValue(await run(["find-generic-password", "-s", KEYRING_SERVICE, "-a", KEYRING_USER, "-w"]));
      } catch (error) {
        if (error.code === SECURITY_NOT_FOUND) return null;
        throw error;
      }
    },
    async write(value) {
      // 서비스·계정 이름과 base64 값에는 따옴표나 역슬래시가 없어 그대로 인용할 수 있습니다.
      await run(["-i"], {
        stdin: `add-generic-password -U -s "${KEYRING_SERVICE}" -a "${KEYRING_USER}" -w "${encodeKeyringValue(value)}"\n`,
      });
    },
    async clear() {
      try {
        await run(["delete-generic-password", "-s", KEYRING_SERVICE, "-a", KEYRING_USER]);
      } catch (error) {
        if (error.code !== SECURITY_NOT_FOUND) throw error;
      }
    },
  };
}

function createTokenFile(file) {
  return {
    async read() {
      try {
        return await fs.readFile(file, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async write(value) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(temp, file);
    },
    async clear() {
      await fs.rm(file, { force: true });
    },
  };
}

function parseCredential(raw) {
  if (!raw) return null;
  try {
    const credential = JSON.parse(raw);
    return credential?.token?.access_token || credential?.token?.refresh_token ? credential : null;
  } catch {
    return null;
  }
}

// Keychain을 우선하고, 없거나 접근할 수 없을 때만 CLI 파일을 사용합니다.
// 저장소마다 계정이 다를 수 있으므로 선택한 위치만 갱신합니다.
function createLayeredStore(locations) {
  async function load() {
    return Promise.all(locations.map(async (location) => {
      try {
        return { location, credential: parseCredential(await location.read()) };
      } catch {
        // Keychain 접근이 거부되거나 시간 초과돼도 다른 위치는 계속 확인합니다.
        return { location, credential: null };
      }
    }));
  }

  return {
    async read() {
      const found = (await load()).filter((entry) => entry.credential);
      if (!found.length) throw new Error("저장된 AGY 자격 증명이 없습니다.");
      return JSON.stringify(found[0].credential);
    },
    async write(value, { expectedRefreshToken } = {}) {
      const target = (await load()).find((entry) => entry.credential);
      if (expectedRefreshToken !== undefined && target?.credential?.token?.refresh_token !== expectedRefreshToken) {
        throw new Error("AGY 계정이 변경됐습니다. 다시 조회해 주세요.");
      }
      if (target) {
        await target.location.write(value);
        return;
      }
      // 처음 저장할 때는 agy 기본값인 Keychain을 먼저 쓰고, 실패하면 파일로 대체합니다.
      let lastError;
      for (const location of locations) {
        try {
          await location.write(value);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
    async clear() {
      await Promise.all(locations.map((location) => location.clear()));
    },
  };
}

function createAntigravityCredentialStore({
  platform = process.platform,
  home = os.homedir(),
  keychain,
  backend = credentialStore,
} = {}) {
  if (platform !== "darwin") {
    return {
      read: () => backend.readCredential(WINDOWS_TARGET),
      write: (value) => backend.writeCredential(WINDOWS_TARGET, value),
      clear: () => backend.deleteCredential(WINDOWS_TARGET),
    };
  }
  const file = createTokenFile(path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"));
  return createLayeredStore([keychain || createMacKeychain(), file]);
}

module.exports = {
  createAntigravityCredentialStore,
  createMacKeychain,
  decodeKeyringValue,
  encodeKeyringValue,
};
