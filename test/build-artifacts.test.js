const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildReleaseArtifacts, removeBuildDirectory } = require("../scripts/build-artifacts");

function fixture(t) {
  const cache = path.resolve(__dirname, "..", ".cache");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "build-artifacts-"));
  const outputDir = path.join(root, "artifacts");
  fs.mkdirSync(outputDir);
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(cache));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { projectDir: root, outputDir };
}

function write(root, name, contents = name) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

for (const [platform, packages, unpacked] of [
  ["Windows", ["CodePet-1.0.11.exe"], "win-unpacked"],
  ["macOS", ["CodePet-1.0.11-mac-universal.dmg"], "mac-universal/CodePet.app"],
  ["Linux", ["CodePet-1.0.11-x86_64.AppImage", "CodePet-1.0.11-x86_64.AppImage.zsync"], "linux-unpacked"],
]) {
  test(`${platform}: keep only distributable build outputs and preserve existing user files`, async (t) => {
    const options = fixture(t);
    write(options.outputDir, "CodePet-1.0.1.exe", "previous release");
    write(options.outputDir, "manual-notes/report.txt", "keep");
    const targets = new Map();
    const published = await buildReleaseArtifacts({ ...options, targets, build: async (input) => {
      assert.equal(input.targets, targets);
      assert.equal(input.publish, "never");
      const stage = input.config.directories.output;
      assert.notEqual(stage, options.outputDir);
      for (const file of packages) write(stage, file, `package:${file}`);
      write(stage, `${unpacked}/resources/app.asar`);
      write(stage, "builder-debug.yml");
      write(stage, "builder-effective-config.yaml");
      write(stage, "code-pet-1.0.11-x64.nsis.7z");
      write(stage, "nested/CodePet-unexpected.exe");
    } });
    assert.deepEqual(published.map((file) => path.basename(file)).sort(), [...packages].sort());
    assert.deepEqual(fs.readdirSync(options.outputDir).sort(), ["CodePet-1.0.1.exe", "manual-notes", ...packages].sort());
    for (const file of packages) assert.equal(fs.readFileSync(path.join(options.outputDir, file), "utf8"), `package:${file}`);
    assert.equal(fs.readFileSync(path.join(options.outputDir, "manual-notes/report.txt"), "utf8"), "keep");
  });
}

test("a failed build discards partial output and retains the existing release", async (t) => {
  const options = fixture(t);
  write(options.outputDir, "CodePet-1.0.11.exe", "existing");
  await assert.rejects(buildReleaseArtifacts({ ...options, build: async ({ config }) => {
    write(config.directories.output, "CodePet-1.0.11.exe", "incomplete");
    write(config.directories.output, "win-unpacked/resources/app.asar");
    throw new Error("packager failed");
  } }), /packager failed/);
  assert.deepEqual(fs.readdirSync(options.outputDir), ["CodePet-1.0.11.exe"]);
  assert.equal(fs.readFileSync(path.join(options.outputDir, "CodePet-1.0.11.exe"), "utf8"), "existing");
});

test("missing distributable files fail without leaving intermediate files", async (t) => {
  const options = fixture(t);
  await assert.rejects(buildReleaseArtifacts({ ...options, build: async ({ config }) => {
    write(config.directories.output, "builder-debug.yml");
  } }), /did not produce a release package/);
  assert.deepEqual(fs.readdirSync(options.outputDir), []);
});

test("CI can retain the Linux smoke-test package and remove it immediately after testing", async (t) => {
  const options = fixture(t);
  await buildReleaseArtifacts({ ...options, keepLinuxUnpacked: true, build: async ({ config }) => {
    write(config.directories.output, "CodePet-1.0.11-x86_64.AppImage");
    write(config.directories.output, "linux-unpacked/code-pet", "smoke fixture");
  } });
  const unpacked = path.join(options.outputDir, "linux-unpacked");
  assert.equal(fs.readFileSync(path.join(unpacked, "code-pet"), "utf8"), "smoke fixture");
  removeBuildDirectory(options.outputDir, unpacked);
  assert.deepEqual(fs.readdirSync(options.outputDir), ["CodePet-1.0.11-x86_64.AppImage"]);
});

test("the smoke-test directory cannot overwrite a pre-existing unpacked app", async (t) => {
  const options = fixture(t);
  write(options.outputDir, "linux-unpacked/keep.txt", "keep");
  await assert.rejects(buildReleaseArtifacts({ ...options, keepLinuxUnpacked: true, build: async ({ config }) => {
    write(config.directories.output, "CodePet-1.0.11-x86_64.AppImage");
    write(config.directories.output, "linux-unpacked/code-pet");
  } }), /Cannot reserve/);
  assert.deepEqual(fs.readdirSync(options.outputDir), ["linux-unpacked"]);
  assert.equal(fs.readFileSync(path.join(options.outputDir, "linux-unpacked/keep.txt"), "utf8"), "keep");
});

test("cleanup refuses the output root, outside directories, and junctions to outside data", (t) => {
  const options = fixture(t);
  const outside = path.join(options.projectDir, "outside");
  write(outside, "keep.txt", "keep");
  assert.throws(() => removeBuildDirectory(options.outputDir, options.outputDir), /outside/);
  assert.throws(() => removeBuildDirectory(options.outputDir, outside), /outside/);
  const link = path.join(options.outputDir, "linux-unpacked");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => removeBuildDirectory(options.outputDir, link), /outside|linked/);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
  fs.unlinkSync(link);
});
