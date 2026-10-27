const test = require("node:test");
const assert = require("node:assert/strict");
const { AppUpdateChecker, registerUpdateIpc, isNewerStableVersion, downloadTarget, RELEASE_REPOSITORY, RELEASE_API } = require("../src/app-updates");
const root = `https://github.com/${RELEASE_REPOSITORY}/releases`;
function release(version = "1.0.13") {
  return { tag_name: `v${version}`, draft: false, prerelease: false,
    assets: [".exe", "-mac-universal.dmg", "-x86_64.AppImage", "-x86_64.AppImage.zsync"].map(suffix => {
      const name = `CodePet-${version}${suffix}`;
      return { name, browser_download_url: `${root}/download/v${version}/${name}` };
    }) };
}
const response = value => ({ ok: true, json: async () => value });

test("numeric release comparison detects newer stable versions without downgrade/prerelease offers", () => {
  for (const [latest, current, expected] of [
    ["v1.0.13", "1.0.12", true], ["v1.0.10", "1.0.9", true], ["v2.0.0", "1.99.99", true],
    ["v1.0.12", "1.0.12", false], ["v1.0.11", "1.0.12", false],
    ["v1.1.0-beta", "1.0.12", false], ["v1.0.13", "1.0.13-rc.1", true],
    ["garbage", "1.0.12", false], ["v1.0.13", "unknown", false],
  ]) assert.equal(isNewerStableVersion(latest, current), expected, `${current} -> ${latest}`);
});

test("downloads match the native platform; unsupported architecture uses the release page", () => {
  const value = release();
  assert.match(downloadTarget(value, "win32", "x64"), /CodePet-1\.0\.13\.exe$/);
  assert.match(downloadTarget(value, "darwin", "arm64"), /mac-universal\.dmg$/);
  assert.match(downloadTarget(value, "darwin", "x64"), /mac-universal\.dmg$/);
  assert.match(downloadTarget(value, "linux", "x64"), /x86_64\.AppImage$/);
  assert.equal(downloadTarget(value, "linux", "arm64"), `${root}/tag/v1.0.13`);
  value.assets[0].browser_download_url = "https://example.test/not-codepet.exe";
  assert.equal(downloadTarget(value, "win32", "x64"), `${root}/tag/v1.0.13`);
});

test("checks coalesce, cache successful results and query only the configured public repository", async () => {
  let count = 0, now = 0;
  const checker = new AppUpdateChecker({ currentVersion: "1.0.12", now: () => now, fetchImpl: async (url, options) => {
    count++;
    assert.equal(url, RELEASE_API);
    assert.equal(options.headers.Authorization, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return response(release());
  } });
  const results = await Promise.all([checker.check(), checker.check(), checker.check()]);
  assert.ok(results.every(result => result.status === "available"));
  assert.equal(count, 1);
  now = 14 * 60_000; await checker.check(); assert.equal(count, 1);
  now = 16 * 60_000; await checker.check(); assert.equal(count, 2);
});

test("this fork checks its own releases, so an upstream merge cannot silently restore the upstream channel", () => {
  assert.equal(RELEASE_REPOSITORY, "Kunsband/CodePet-r2");
  assert.equal(RELEASE_API, "https://api.github.com/repos/Kunsband/CodePet-r2/releases/latest");
});

test("offline, rate limits, missing/malformed releases, drafts and previews stay unavailable", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("offline"); },
    async () => ({ ok: false, status: 403 }), async () => ({ ok: false, status: 404 }),
    async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }),
    async () => response({}), async () => response({ ...release(), draft: true }),
    async () => response({ ...release(), prerelease: true }), async () => response(release("1.1.0-beta")),
  ]) {
    const result = await new AppUpdateChecker({ currentVersion: "1.0.12", fetchImpl }).check();
    assert.equal(result.status, "unavailable"); assert.equal(result.downloadUrl, undefined);
  }
});

test("a failed check can recover after its short retry interval", async () => {
  let now = 0, count = 0;
  const checker = new AppUpdateChecker({ currentVersion: "1.0.12", now: () => now, fetchImpl: async () => {
    if (++count === 1) throw new Error("offline"); return response(release());
  } });
  assert.equal((await checker.check()).status, "unavailable");
  await checker.check(); assert.equal(count, 1);
  now = 60_001;
  assert.equal((await checker.check()).status, "available");
});

test("same/older releases do not provide a download action", async () => {
  for (const version of ["1.0.12", "1.0.11"]) {
    const result = await new AppUpdateChecker({ currentVersion: "1.0.12", fetchImpl: async () => response(release(version)) }).check();
    assert.equal(result.status, "up-to-date"); assert.equal(result.downloadUrl, undefined);
  }
});

test("download IPC opens the verified release asset, ignoring renderer-supplied URLs", async () => {
  const handlers = new Map(), opened = [];
  const checker = new AppUpdateChecker({ currentVersion: "1.0.12", platform: "win32", arch: "x64", fetchImpl: async () => response(release()) });
  registerUpdateIpc({ checker, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, shell: { openExternal: async url => opened.push(url) } });
  assert.equal((await handlers.get("settings:check-update")()).downloadUrl, undefined);
  const result = await handlers.get("settings:download-update")({}, { url: "file:///untrusted" });
  assert.equal(result.ok, true);
  assert.deepEqual(opened, [`${root}/download/v1.0.13/CodePet-1.0.13.exe`]);
});

test("download IPC reports unavailable updates and browser errors without throwing", async () => {
  for (const currentVersion of ["1.0.12", "1.0.13"]) {
    const handlers = new Map(); let calls = 0;
    registerUpdateIpc({ checker: new AppUpdateChecker({ currentVersion, fetchImpl: async () => response(release()) }),
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, shell: { openExternal: async () => { calls++; throw new Error("no browser"); } } });
    assert.equal((await handlers.get("settings:download-update")()).ok, false);
    assert.equal(calls, currentVersion === "1.0.12" ? 1 : 0);
  }
});

test("portable update IPC uses trusted metadata, exposes progress and never opens a browser", async () => {
  const handlers = new Map(), installed = [];
  const checker = new AppUpdateChecker({ currentVersion: "1.0.12", platform: "win32", arch: "x64", fetchImpl: async () => response(release()) });
  const updater = { supported: true, state: { phase: "downloading", percent: 42 }, install: async value => installed.push(value) };
  registerUpdateIpc({ checker, updater, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, shell: { openExternal: () => { throw new Error("must not open browser"); } } });
  const state = await handlers.get("settings:check-update")();
  assert.equal(state.automatic, true);
  assert.deepEqual(state.update, updater.state);
  assert.equal(state.asset, undefined); assert.equal(state.checksumUrl, undefined); assert.equal(state.downloadUrl, undefined);
  assert.deepEqual(await handlers.get("settings:download-update")({}, { asset: { url: "file:///untrusted" } }), { ok: true, restarting: true });
  assert.equal(installed[0].asset.url, `${root}/download/v1.0.13/CodePet-1.0.13.exe`);
  updater.install = async () => { throw new Error("integrity failure"); };
  const error = await handlers.get("settings:download-update")();
  assert.equal(error.ok, false); assert.match(error.error, /기존 버전은 유지/);
});
