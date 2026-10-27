const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createHash } = require("node:crypto");
const { WINDOWS_UPDATE_SCRIPT } = require("../src/windows-update-helper");
const run = promisify(execFile);
const hash = value => createHash("sha256").update(value).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}
const exists = file => fs.access(file).then(() => true, () => false);

test("Windows helper replaces and restarts a native EXE, or restores it after failed startup", { skip: process.platform !== "win32", timeout: 90000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codepet-native-update-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const fixtures = {};
  for (const version of ["old", "new"]) {
    const output = path.join(dir, `${version}.exe`);
    const source = `using System; using System.IO;
      public class CodePetUpdateFixture {
        public static void Main() {
          string stage = Environment.GetEnvironmentVariable("CODEPET_UPDATE_STAGE");
          if (stage != null && Environment.GetEnvironmentVariable("CODEPET_TEST_FAIL_UPDATE") == "1") Environment.Exit(1);
          File.AppendAllText(Environment.GetEnvironmentVariable("CODEPET_TEST_MARKER"), "${version}|" + Environment.CurrentDirectory + "|" + Environment.GetEnvironmentVariable("PORTABLE_EXECUTABLE_FILE") + "|" + Environment.GetEnvironmentVariable("CODEPET_UPDATE_FAILED") + "\\n");
          if (stage != null) File.WriteAllText(Path.Combine(stage, "started"), "started");
        }
      }`;
    const command = 'Add-Type -TypeDefinition $env:CODEPET_TEST_SOURCE -OutputAssembly $env:CODEPET_TEST_OUTPUT -OutputType WindowsApplication';
    await run(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      windowsHide: true, env: { ...process.env, CODEPET_TEST_SOURCE: source, CODEPET_TEST_OUTPUT: output },
    });
    fixtures[version] = await fs.readFile(output);
  }
  for (const fail of [false, true]) {
    await t.test(fail ? "startup failure rolls back and restarts the original" : "success keeps the path and cleans the backup", async t => {
      const folder = path.join(dir, `한글 & [portable] ' ${fail}`);
      await fs.mkdir(folder);
      const target = path.join(folder, "CodePet user's [2].exe");
      const marker = path.join(folder, "launches.txt");
      await fs.writeFile(target, fixtures.old);
      const stage = await fs.mkdtemp(path.join(folder, ".codepet-update-"));
      await fs.writeFile(path.join(stage, "update.exe"), fixtures.new);
      // Model the portable wrapper retaining its EXE briefly after Electron exits.
      let locker;
      if (!fail) {
        const lockCommand = `$file = [IO.File]::Open($env:CODEPET_TEST_TARGET, 'Open', 'Read', 'Read');
          try { [IO.File]::WriteAllText($env:CODEPET_TEST_LOCKED, 'locked');
            while (-not [IO.File]::Exists($env:CODEPET_TEST_UNLOCK)) { Start-Sleep -Milliseconds 50 }
          } finally { $file.Dispose() }`;
        locker = spawn(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(lockCommand, "utf16le").toString("base64")], {
          windowsHide: true, stdio: "ignore", env: { ...process.env, CODEPET_TEST_TARGET: target,
            CODEPET_TEST_LOCKED: path.join(stage, "locked"), CODEPET_TEST_UNLOCK: path.join(stage, "unlock") },
        });
        t.after(() => locker.kill());
        await waitFor(() => exists(path.join(stage, "locked")), "Could not lock the old executable");
      }
      const parent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { windowsHide: true, stdio: "ignore" });
      t.after(() => parent.kill());
      const config = { target, stage, sha256: hash(fixtures.new), previousSha256: hash(fixtures.old), parentPid: parent.pid };
      const helper = spawn(powershell, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(WINDOWS_UPDATE_SCRIPT, "utf16le").toString("base64")], {
        windowsHide: true, cwd: folder, env: { ...process.env, CODEPET_UPDATE_CONFIG: JSON.stringify(config),
          PORTABLE_EXECUTABLE_FILE: "stale-launcher.exe", PORTABLE_EXECUTABLE_DIR: "stale-extraction",
          CODEPET_TEST_MARKER: marker, CODEPET_TEST_FAIL_UPDATE: fail ? "1" : "0" },
      });
      t.after(() => helper.kill());
      let stderr = "";
      helper.stderr.on("data", chunk => { stderr += chunk; });
      const exited = new Promise((resolve, reject) => { helper.once("exit", resolve); helper.once("error", reject); });
      await waitFor(async () => {
        if (helper.exitCode !== null) {
          const log = await fs.readFile(path.join(stage, "update.log"), "utf8").catch(() => "");
          throw new Error(`Helper exited (${helper.exitCode}): ${stderr} ${log}`);
        }
        return exists(path.join(stage, "ready"));
      }, "Helper not ready");
      await fs.writeFile(path.join(stage, "apply"), "apply");
      // A running parent must never be overwritten.
      await delay(300);
      assert.deepEqual(await fs.readFile(target), fixtures.old);
      parent.kill();
      if (locker) {
        await delay(500);
        assert.deepEqual(await fs.readFile(target), fixtures.old);
        assert.equal(helper.exitCode, null);
        await fs.writeFile(path.join(stage, "unlock"), "unlock");
      }
      const code = await exited;
      const log = await fs.readFile(path.join(stage, "update.log"), "utf8").catch(() => "");
      assert.equal(code, fail ? 1 : 0, `${stderr}\n${log}`);
      await waitFor(() => exists(marker), `The app was not relaunched: ${log}`);
      const launches = await fs.readFile(marker, "utf8");
      assert.equal(launches, `${fail ? "old" : "new"}|${folder}||${fail ? "1" : ""}\n`);
      assert.deepEqual(await fs.readFile(target), fail ? fixtures.old : fixtures.new);
      assert.equal(await exists(stage), fail);
      if (fail) assert.match(await fs.readFile(path.join(stage, "update.log"), "utf8"), /exited before startup/);
    });
  }
});
