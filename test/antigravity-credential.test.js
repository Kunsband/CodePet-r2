const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createAntigravityCredentialStore,
  createMacKeychain,
  decodeKeyringValue,
  encodeKeyringValue,
} = require("../src/antigravity-credential");

function credential(refresh, expiry = "2099-01-01T00:00:00Z") {
  return { auth_method: "oauth", id_token: "id", token: { access_token: `access-${refresh}`, refresh_token: refresh, expiry } };
}

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-agy-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function tokenFile(home) {
  return path.join(home, ".gemini", "jetski-standalone-oauth-token");
}

function memoryKeychain(value = null) {
  const keychain = {
    value,
    read: async () => keychain.value,
    write: async (next) => { keychain.value = JSON.stringify(next); },
    clear: async () => { keychain.value = null; },
  };
  return keychain;
}

test("go-keyring 접두사로 저장된 macOS Keychain 값을 복원한다", () => {
  const value = credential("alpha");
  assert.deepEqual(JSON.parse(decodeKeyringValue(encodeKeyringValue(value))), value);
  const hex = `go-keyring-encoded:${Buffer.from(JSON.stringify(value)).toString("hex")}`;
  assert.deepEqual(JSON.parse(decodeKeyringValue(`${hex}\n`)), value);
  assert.equal(decodeKeyringValue('{"plain":true}'), '{"plain":true}');
});

test("macOS Keychain은 agy의 service/account로 읽고 쓰며 없는 항목은 null로 본다", async () => {
  const calls = [];
  const keychain = createMacKeychain({
    run: async (args, options = {}) => {
      calls.push({ args, stdin: options.stdin });
      if (args[0] === "find-generic-password") throw Object.assign(new Error("missing"), { code: 44 });
      return "";
    },
  });
  assert.equal(await keychain.read(), null);
  assert.deepEqual(calls[0].args, ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"]);
  await keychain.write(credential("alpha"));
  assert.deepEqual(calls[1].args, ["-i"]);
  assert.match(calls[1].stdin, /^add-generic-password -U -s "gemini" -a "antigravity" -w "go-keyring-base64:[A-Za-z0-9+/=]+"\n$/);
  // 비밀 값은 명령 인수로 넘기지 않습니다.
  assert.ok(!calls[1].args.join(" ").includes("alpha"));
});

test("Keychain이 비어 있으면 agy의 대체 토큰 파일을 읽는다", async (t) => {
  const home = tempHome(t);
  fs.mkdirSync(path.dirname(tokenFile(home)), { recursive: true });
  fs.writeFileSync(tokenFile(home), JSON.stringify(credential("file")));
  const store = createAntigravityCredentialStore({ platform: "darwin", home, keychain: memoryKeychain() });
  assert.equal(JSON.parse(await store.read()).token.refresh_token, "file");
});

test("Keychain 접근이 실패해도 토큰 파일로 계속 조회한다", async (t) => {
  const home = tempHome(t);
  fs.mkdirSync(path.dirname(tokenFile(home)), { recursive: true });
  fs.writeFileSync(tokenFile(home), JSON.stringify(credential("file")));
  const keychain = { ...memoryKeychain(), read: async () => { throw new Error("denied"); } };
  const store = createAntigravityCredentialStore({ platform: "darwin", home, keychain });
  assert.equal(JSON.parse(await store.read()).token.refresh_token, "file");
});

test("두 위치에 모두 있으면 더 늦게 만료되는 자격 증명을 쓰고, 갱신은 양쪽에 반영한다", async (t) => {
  const home = tempHome(t);
  fs.mkdirSync(path.dirname(tokenFile(home)), { recursive: true });
  fs.writeFileSync(tokenFile(home), JSON.stringify(credential("file", "2099-01-01T00:00:00Z")));
  const keychain = memoryKeychain(JSON.stringify(credential("keychain", "2020-01-01T00:00:00Z")));
  const store = createAntigravityCredentialStore({ platform: "darwin", home, keychain });
  assert.equal(JSON.parse(await store.read()).token.refresh_token, "file");

  await store.write(credential("next"));
  assert.equal(JSON.parse(keychain.value).token.refresh_token, "next");
  assert.equal(JSON.parse(fs.readFileSync(tokenFile(home), "utf8")).token.refresh_token, "next");
  assert.equal(fs.statSync(tokenFile(home)).mode & 0o777, 0o600);
});

test("처음 저장할 때는 Keychain에 쓰고, Keychain이 실패하면 파일에 쓴다", async (t) => {
  const home = tempHome(t);
  const keychain = memoryKeychain();
  await createAntigravityCredentialStore({ platform: "darwin", home, keychain }).write(credential("alpha"));
  assert.equal(JSON.parse(keychain.value).token.refresh_token, "alpha");
  assert.equal(fs.existsSync(tokenFile(home)), false);

  const broken = { ...memoryKeychain(), write: async () => { throw new Error("locked"); } };
  await createAntigravityCredentialStore({ platform: "darwin", home, keychain: broken }).write(credential("beta"));
  assert.equal(JSON.parse(fs.readFileSync(tokenFile(home), "utf8")).token.refresh_token, "beta");
});

test("로그아웃 준비는 Keychain과 토큰 파일을 모두 비우고, 없으면 오류로 알린다", async (t) => {
  const home = tempHome(t);
  fs.mkdirSync(path.dirname(tokenFile(home)), { recursive: true });
  fs.writeFileSync(tokenFile(home), JSON.stringify(credential("file")));
  const keychain = memoryKeychain(JSON.stringify(credential("keychain")));
  const store = createAntigravityCredentialStore({ platform: "darwin", home, keychain });
  await store.clear();
  assert.equal(keychain.value, null);
  assert.equal(fs.existsSync(tokenFile(home)), false);
  await assert.rejects(store.read(), /자격 증명이 없습니다/);
});

test("Windows는 기존 자격 증명 관리자 대상 이름을 그대로 사용한다", async () => {
  const calls = [];
  const backend = {
    readCredential: async (target) => { calls.push(["read", target]); return "{}"; },
    writeCredential: async (target) => { calls.push(["write", target]); },
    deleteCredential: async (target) => { calls.push(["clear", target]); },
  };
  const store = createAntigravityCredentialStore({ platform: "win32", backend });
  await store.read();
  await store.write({});
  await store.clear();
  assert.deepEqual(calls, [["read", "gemini:antigravity"], ["write", "gemini:antigravity"], ["clear", "gemini:antigravity"]]);
});
