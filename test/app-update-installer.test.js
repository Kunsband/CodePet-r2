const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { AppUpdateInstaller, acknowledgeUpdateStartup, checksumFor, fetchReleaseFile, portableTarget } = require("../src/app-update-installer");

const root = "https://github.com/nokryong/CodePet/releases/download/v2.0.0/";
const bytes = Buffer.from("MZ verified portable update fixture");
const hash = value => createHash("sha256").update(value).digest("hex");
const release = { asset: { name: "CodePet-2.0.0.exe", url: `${root}CodePet-2.0.0.exe`, size: bytes.length }, checksumUrl: `${root}SHA256SUMS` };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, options = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "codepet-update-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "CodePet.exe");
  await fsp.writeFile(target, "original version");
  let quits = 0, spawns = 0, helperConfig;
  const updater = new AppUpdateInstaller({
    app: { isPackaged: true, quit: () => { quits++; } }, platform: "win32", env: { PORTABLE_EXECUTABLE_FILE: target },
    fetchImpl: async url => new Response(url.endsWith("SHA256SUMS") ? `${hash(bytes)}  ${release.asset.name}\n` : bytes),
    spawnImpl: (command, args, opts) => {
      spawns++;
      assert.equal(opts.windowsHide, true);
      assert.equal(opts.detached, false);
      assert.equal(opts.cwd, dir);
      assert.ok(!args.includes("-ExecutionPolicy"));
      helperConfig = JSON.parse(opts.env.CODEPET_UPDATE_CONFIG);
      assert.equal(helperConfig.sha256, hash(bytes));
      assert.equal(helperConfig.previousSha256, hash("original version"));
      fs.writeFileSync(path.join(helperConfig.stage, "ready"), "ready");
      const child = new EventEmitter();
      child.unref = () => {}; child.kill = () => {};
      return child;
    }, ...options,
  });
  return { dir, target, updater, quits: () => quits, spawns: () => spawns, config: () => helperConfig };
}

test("portable support never targets an unpacked Electron executable or another OS", () => {
  const env = { PORTABLE_EXECUTABLE_FILE: path.resolve("CodePet.exe") };
  assert.equal(portableTarget({ platform: "win32", isPackaged: true, env }), env.PORTABLE_EXECUTABLE_FILE);
  for (const options of [
    { platform: "linux", isPackaged: true, env }, { platform: "darwin", isPackaged: true, env },
    { platform: "win32", isPackaged: false, env }, { platform: "win32", isPackaged: true, env: {} },
    { platform: "win32", isPackaged: true, env: { PORTABLE_EXECUTABLE_FILE: "relative.exe" } },
  ]) assert.equal(portableTarget(options), null);
});

test("checksum lookup requires one exact filename, accepts binary SHA256SUMS entries", () => {
  assert.equal(checksumFor(`${hash(bytes)} *${release.asset.name}\r\n`, release.asset.name), hash(bytes));
  for (const manifest of ["bad", `${hash(bytes)}  other.exe`, `${hash(bytes)}  ${release.asset.name}\n${hash(bytes)}  ${release.asset.name}`]) {
    assert.throws(() => checksumFor(manifest, release.asset.name));
  }
});

test("download redirects only follow GitHub HTTPS asset hosts and stop redirect loops", async () => {
  const seen = [];
  const result = await fetchReleaseFile(release.asset.url, async (url, options) => {
    seen.push(url); assert.equal(options.redirect, "manual");
    return seen.length === 1 ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/asset?signature=test" } }) : new Response(bytes);
  });
  assert.equal(await result.text(), bytes.toString()); assert.equal(seen.length, 2);
  for (const location of ["http://github.com/asset", "https://example.com/asset", "https://github.com.evil.test/asset", "file:///tmp/update.exe"]) {
    let calls = 0;
    await assert.rejects(fetchReleaseFile(release.asset.url, async () => { calls++; return new Response(null, { status: 302, headers: { location } }); }));
    assert.equal(calls, 1);
  }
  await assert.rejects(fetchReleaseFile("https://example.com/file", () => { throw new Error("must not fetch"); }), /Untrusted/);
  await assert.rejects(fetchReleaseFile(release.asset.url, async () => new Response(null, { status: 302, headers: { location: release.asset.url } })), /Too many/);
});

test("download verifies bytes on disk, prepares the helper once, then requests normal app shutdown", async t => {
  const f = await fixture(t), states = [];
  f.updater.on("progress", state => states.push(state));
  const first = f.updater.install(release);
  assert.equal(f.updater.install(release), first);
  await first;
  assert.equal(f.spawns(), 1); assert.equal(f.quits(), 0);
  assert.equal(await fsp.readFile(f.target, "utf8"), "original version");
  assert.deepEqual(await fsp.readFile(path.join(f.config().stage, "update.exe")), bytes);
  assert.equal(await fsp.readFile(path.join(f.config().stage, "apply"), "utf8"), "apply");
  assert.deepEqual(states.map(s => s.phase), ["downloading", "downloading", "verifying", "restarting"]);
  assert.equal(states[1].percent, 100);
  await delay(350); assert.equal(f.quits(), 1);
});

test("checksum mismatch, interrupted/oversized downloads and helper failures preserve the original and allow retry", async t => {
  for (const mode of ["hash", "short", "oversized", "offline", "helper"]) {
    await t.test(mode, async t => {
      const f = await fixture(t);
      const originalFetch = f.updater.fetch, originalSpawn = f.updater.spawn;
      if (mode === "helper") {
        f.updater.spawn = () => {
          const child = new EventEmitter(); child.kill = () => {};
          setImmediate(() => child.emit("error", new Error("Cannot launch helper")));
          return child;
        };
      } else {
        f.updater.fetch = async url => {
          if (mode === "offline") throw new Error("offline");
          if (url.endsWith("SHA256SUMS")) return new Response(`${mode === "hash" ? "0".repeat(64) : hash(bytes)}  ${release.asset.name}\n`);
          return new Response(mode === "short" ? bytes.subarray(0, 4) : mode === "oversized" ? Buffer.concat([bytes, bytes]) : bytes);
        };
      }
      await assert.rejects(f.updater.install(release));
      assert.equal(f.quits(), 0); assert.equal(f.updater.state.phase, "error");
      assert.equal(await fsp.readFile(f.target, "utf8"), "original version");
      assert.deepEqual(await fsp.readdir(f.dir), ["CodePet.exe"]);
      f.updater.fetch = originalFetch; f.updater.spawn = originalSpawn;
      await f.updater.install(release);
      await delay(350); assert.equal(f.quits(), 1);
    });
  }
});

test("missing checksums and invalid assets never spawn or quit", async t => {
  const f = await fixture(t);
  for (const value of [
    { ...release, checksumUrl: undefined }, { ...release, asset: null },
    { ...release, asset: { ...release.asset, size: 0 } },
    { ...release, asset: { ...release.asset, size: 2 ** 32 } },
    { ...release, asset: { ...release.asset, name: "../../malicious.exe" } },
  ]) await assert.rejects(f.updater.install(value));
  assert.equal(f.spawns(), 0); assert.equal(f.quits(), 0);
});

test("startup acknowledgement is restricted to the portable executable's own staging directory", async t => {
  const f = await fixture(t);
  const stage = await fsp.mkdtemp(path.join(f.dir, ".codepet-update-"));
  const env = { PORTABLE_EXECUTABLE_FILE: f.target, CODEPET_UPDATE_STAGE: stage };
  acknowledgeUpdateStartup(env);
  assert.equal(env.CODEPET_UPDATE_STAGE, undefined);
  assert.equal(await fsp.readFile(path.join(stage, "started"), "utf8"), "started");
  acknowledgeUpdateStartup({ PORTABLE_EXECUTABLE_FILE: f.target, CODEPET_UPDATE_STAGE: f.dir });
  assert.equal(fs.existsSync(path.join(f.dir, "started")), false);
  if (process.platform === "win32") {
    const alternateStage = await fsp.mkdtemp(path.join(f.dir, ".codepet-update-"));
    acknowledgeUpdateStartup({ PORTABLE_EXECUTABLE_FILE: f.target.toUpperCase(), CODEPET_UPDATE_STAGE: alternateStage });
    assert.equal(fs.existsSync(path.join(alternateStage, "started")), true);
  }
});
