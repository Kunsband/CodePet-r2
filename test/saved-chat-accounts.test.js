const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { ProviderProfileStore } = require("../src/provider-profile-store");
const { SavedChatAccounts } = require("../src/chat/saved-chat-accounts");
const { claudeKeychainService } = require("../src/claude-live-credentials");
const { runAgentProcess } = require("../src/chat/chat-agent-runner");
const { GrokDockerRuntime } = require("../src/grok-docker-runtime");

for (const providerId of ["claude", "grok"]) {
  test(`${providerId}: isolated credentials, refresh persistence, CLI catalogs and child environments`, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-accounts-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const store = new ProviderProfileStore(providerId, home);
    const secret = (id) => providerId === "claude"
      ? { claudeAiOauth: { accessToken: `fixture-access-${id}`, refreshToken: `fixture-refresh-${id}` } }
      : { issuer: { refresh_token: `fixture-refresh-${id}`, user_id: id } };
    const profiles = ["a", "b"].map((id) => store.save({ secret: secret(id), email: `${id}@example.test`, active: id === "a" }));
    const live = path.join(home, `.${providerId}`);
    fs.mkdirSync(live);
    const config = providerId === "claude" ? "settings.json" : "config.toml";
    fs.writeFileSync(path.join(live, config), providerId === "claude" ? '{"permissions":{"deny":["Bash"]},"model":"custom"}' : 'model = "custom"');
    fs.mkdirSync(path.join(live, "skills"));
    const calls = [];
    const credentials = new Map();
    const credentialStore = (dir) => ({ read: () => credentials.get(dir), write: (value) => credentials.set(dir, value) });
    const base = { id: providerId, name: providerId, status: "cli", commandPath: "one-cli" };
    const service = new SavedChatAccounts({ providerId, switcher: { home, store }, credentialStore,
      probe: async (...args) => { calls.push(args[3].env); return [{ id: `model-${path.basename(args[3].env.CLAUDE_CONFIG_DIR || args[3].env.GROK_HOME)}` }]; } });
    const records = await Promise.all(profiles.map((profile) => service.discover(profile.key, base)));
    assert.ok(records.every((record) => record.catalogStatus === "ready"));
    assert.notEqual(records[0].models[0], records[1].models[0]);
    const accounts = profiles.map((profile) => service.prepare(profile.key));
    assert.notEqual(accounts[0].dir, accounts[1].dir);
    assert.deepEqual(credentials.get(accounts[0].dir), secret("a"));
    assert.deepEqual(credentials.get(accounts[1].dir), secret("b"));
    assert.equal(fs.realpathSync(path.join(accounts[0].dir, "skills")), fs.realpathSync(path.join(live, "skills")));
    assert.match(fs.readFileSync(path.join(accounts[0].dir, config), "utf8"), /custom/);
    if (providerId === "claude") assert.deepEqual(JSON.parse(fs.readFileSync(path.join(accounts[0].dir, config))).permissions.deny, ["Bash"]);
    assert.doesNotMatch(JSON.stringify(service.list()), /secret|fixture-access|fixture-refresh/);
    const envName = providerId === "claude" ? "CLAUDE_CONFIG_DIR" : "GROK_HOME";
    const results = await Promise.all(accounts.map(({ env }) => runAgentProcess({ commandPath: process.execPath,
      argv: ["-e", `process.stdin.resume();process.stdin.on('end',()=>console.log(process.env.${envName}))`], prompt: "fixture", env }).promise));
    assert.deepEqual(results.map((result) => result.text.trim()), accounts.map((account) => account.dir));
    const rotated = secret("rotated");
    credentials.set(accounts[0].dir, rotated);
    await accounts[0].finish();
    assert.deepEqual(store.get(profiles[0].key).secret, rotated);
    assert.equal(store.getActiveKey(), profiles[0].key);
    service.prepare(profiles[0].key);
    assert.deepEqual(credentials.get(accounts[0].dir), rotated);
    await service.discover(profiles[0].key, base);
    assert.equal(calls.length, 3, "rotation invalidates the account's catalog");
    const edited = providerId === "claude" ? '{"model":"account-only"}' : 'model = "account-only"';
    fs.writeFileSync(path.join(accounts[0].dir, config), edited);
    service.prepare(profiles[0].key);
    assert.equal(fs.readFileSync(path.join(accounts[0].dir, config), "utf8"), edited);
    assert.throws(() => service.prepare("../../outside"), /저장된/);
    store.delete(profiles[1].key);
    assert.equal(fs.existsSync(accounts[1].dir), false);
    assert.equal(service.record(profiles[1].key, base).catalogStatus, "unavailable");
    assert.throws(() => service.prepare(profiles[1].key), /저장된/);
  });
}

test("profile refresh uses compare-and-set and never resurrects a removed login", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-account-cas-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new ProviderProfileStore("claude", home);
  const original = { claudeAiOauth: { refreshToken: "fixture-first" } };
  const profile = store.save({ secret: original, email: "a@example.test" });
  store.save({ secret: { claudeAiOauth: { refreshToken: "fixture-relogin" } }, email: "a@example.test" });
  assert.equal(store.updateSecret(profile.key, original, original), false);
  store.delete(profile.key);
  assert.equal(store.updateSecret(profile.key, original, original), false);
});

test("Claude Keychain namespace is per config directory and preserves the default service", () => {
  assert.equal(claudeKeychainService(), "Claude Code-credentials");
  assert.match(claudeKeychainService("/accounts/a"), /^Claude Code-credentials-[a-f0-9]{8}$/);
  assert.notEqual(claudeKeychainService("/accounts/a"), claudeKeychainService("/accounts/b"));
});

test("Grok account runtimes separate auth volumes and keep the original workspace boundary", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-grok-account-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new ProviderProfileStore("grok", home);
  const profiles = ["a", "b"].map((id) => store.save({ secret: { issuer: { refresh_token: `fixture-${id}`, user_id: id } }, email: `${id}@example.test` }));
  const base = new GrokDockerRuntime({ home, dockerPath: "docker" });
  const service = new SavedChatAccounts({ providerId: "grok", switcher: { home, store }, dockerRuntime: base });
  const runtimes = profiles.map((profile) => service.runtime(profile.key));
  assert.notEqual(runtimes[0].authVolume, runtimes[1].authVolume);
  assert.notEqual(runtimes[0].authPath, runtimes[1].authPath);
  assert.equal(runtimes[0].home, home);
  assert.equal(runtimes[0].changeStore, base.changeStore);
  assert.ok(runtimes.every((runtime) => runtime.readHostAuth()));
  assert.equal(base.readHostAuth(), null);
});
