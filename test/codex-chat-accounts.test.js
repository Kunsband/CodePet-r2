const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexChatAccounts, FILE_AUTH_ARGS } = require("../src/chat/codex-chat-accounts");
const { runAgentProcess } = require("../src/chat/chat-agent-runner");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-chat-accounts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "live");
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, "auth.json"), "live-auth-fixture");
  fs.writeFileSync(path.join(codexHome, "config.toml"), '# codepet-codex-proxy\nopenai_base_url = "http://127.0.0.1:8888/v1"\nmodel = "from-cli"\n[projects."test"]\ntrust_level = "untrusted"\n');
  fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "preserve shared instructions");
  fs.mkdirSync(path.join(codexHome, "skills"));
  const profiles = ["a", "b"].map((key) => {
    const homePath = path.join(root, key);
    fs.mkdirSync(homePath);
    fs.writeFileSync(path.join(homePath, "auth.json"), `${key}-auth-fixture`);
    return { key, homePath, hasAuth: true, label: `Account ${key}` };
  });
  const switcher = { codexHome, listProfiles: () => profiles, getProfile: (key) => profiles.find((entry) => entry.key === key) };
  return { root, profiles, switcher, codexHome };
}
const base = { id: "codex", status: "cli", commandPath: "fixture-cli", modelOptions: [{ id: "wrong-account-model" }] };

test("sandbox preparation uses the selected account but model discovery does not initialize Windows users", async (t) => {
  const { switcher, profiles, codexHome } = fixture(t);
  const service = new CodexChatAccounts({ switcher, probe: async () => [{ id: "from-cli" }] });
  const calls = [];
  service.windowsSandbox.ensure = async (...args) => calls.push(args);
  await service.discover("a", base);
  assert.equal(calls.length, 0);
  await service.prepareSandbox("a", base, "workspace");
  assert.deepEqual(calls, [[profiles[0].homePath, codexHome, base, "workspace"]]);
});

test("accounts use distinct CLI homes and preserve live auth, config, trust and AGENTS", async (t) => {
  const { switcher, profiles, codexHome } = fixture(t);
  const originalConfig = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  const calls = [];
  const service = new CodexChatAccounts({ switcher, probe: async (...args) => {
    calls.push(args[3]);
    return [{ id: `model-${path.basename(args[3].env.CODEX_HOME)}`, efforts: ["high"] }];
  } });
  const records = await Promise.all(profiles.map((profile) => service.discover(profile.key, base)));
  assert.deepEqual(records.map((record) => record.models), [["model-a"], ["model-b"]]);
  assert.deepEqual(calls.map((call) => call.env.CODEX_HOME), profiles.map((profile) => profile.homePath));
  assert.ok(calls.every((call) => JSON.stringify(call.argv) === JSON.stringify(FILE_AUTH_ARGS)));
  for (const profile of profiles) {
    const config = fs.readFileSync(path.join(profile.homePath, "config.toml"), "utf8");
    assert.doesNotMatch(config, /codepet-codex-proxy|127\.0\.0\.1/);
    assert.match(config, /model = "from-cli"/);
    assert.match(config, /trust_level = "untrusted"/);
    assert.equal(fs.readFileSync(path.join(profile.homePath, "AGENTS.md"), "utf8"), "preserve shared instructions");
    assert.equal(fs.realpathSync(path.join(profile.homePath, "skills")), fs.realpathSync(path.join(codexHome, "skills")));
    assert.equal(fs.readFileSync(path.join(profile.homePath, "auth.json"), "utf8"), `${profile.key}-auth-fixture`);
  }
  assert.equal(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"), "live-auth-fixture");
  assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), originalConfig);
  assert.doesNotMatch(JSON.stringify(service.list()), /homePath|auth-fixture/);
  await service.discover("a", base);
  assert.equal(calls.length, 2);
});

test("inherited settings refresh but profile-specific edits remain intact", (t) => {
  const { switcher, profiles, codexHome } = fixture(t);
  const service = new CodexChatAccounts({ switcher });
  service.prepare("a");
  fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "new shared rules");
  service.prepare("a");
  assert.equal(fs.readFileSync(path.join(profiles[0].homePath, "AGENTS.md"), "utf8"), "new shared rules");
  fs.writeFileSync(path.join(profiles[0].homePath, "AGENTS.md"), "profile rules");
  fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "another shared change");
  service.prepare("a");
  assert.equal(fs.readFileSync(path.join(profiles[0].homePath, "AGENTS.md"), "utf8"), "profile rules");
});

test("failed account discovery never falls back to the global model list; deleted profiles cannot run", async (t) => {
  const { switcher, profiles } = fixture(t);
  const service = new CodexChatAccounts({ switcher, probe: async () => null });
  const record = await service.discover("a", base);
  assert.equal(record.catalogStatus, "unavailable");
  assert.deepEqual(record.models, []);
  profiles.splice(0, 1);
  assert.throws(() => service.prepare("a"), /저장된 Codex 계정/);
  assert.equal(service.record("a", base).catalogStatus, "unavailable");
});

test("concurrent subprocesses receive their own CODEX_HOME without modifying parent environment", async (t) => {
  const { switcher } = fixture(t);
  const service = new CodexChatAccounts({ switcher });
  const previous = process.env.CODEX_HOME;
  const runs = ["a", "b"].map((key) => {
    const { env } = service.prepare(key);
    return runAgentProcess({ commandPath: process.execPath, argv: ["-e", "process.stdin.resume();process.stdin.on('end',()=>console.log(process.env.CODEX_HOME))"], prompt: "fixture", env });
  });
  const results = await Promise.all(runs.map((run) => run.promise));
  assert.ok(results.every((result) => result.ok));
  assert.equal(path.basename(results[0].text.trim()), "a");
  assert.equal(path.basename(results[1].text.trim()), "b");
  assert.equal(process.env.CODEX_HOME, previous);
});
