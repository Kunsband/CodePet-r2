const test = require("node:test");
const assert = require("node:assert/strict");
const { withAntigravityCredential } = require("../src/antigravity-auth");

function fixture() {
  let current = {
    auth_method: "oauth",
    id_token: `header.${Buffer.from(JSON.stringify({ aud: "test.apps.googleusercontent.com" })).toString("base64url")}.signature`,
    token: { access_token: "old", refresh_token: "refresh", expiry: "2026-01-01T00:00:00Z" },
  };
  const calls = { refresh: 0, writes: 0 };
  const store = {
    read: async () => structuredClone(current),
    write: async (next) => { calls.writes++; current = structuredClone(next); },
  };
  const options = {
    store,
    resolveClient: async (clientId) => ({ clientId, clientSecret: "test-public-client" }),
    fetchImpl: async (url, request) => {
      calls.refresh++;
      assert.equal(url, "https://oauth2.googleapis.com/token");
      assert.equal(request.body.get("client_id"), "test.apps.googleusercontent.com");
      assert.equal(request.body.get("refresh_token"), "refresh");
      assert.equal(request.body.get("client_secret"), "test-public-client");
      return { ok: true, json: async () => ({ access_token: "fresh", expires_in: 3600 }) };
    },
  };
  return { store, calls, options, credential: structuredClone(current) };
}

test("AGY refresh persists renewed credentials, preserves metadata, and coalesces concurrent reads", async () => {
  const f = fixture();
  const tokens = await Promise.all([f.credential, structuredClone(f.credential)].map((c) =>
    withAntigravityCredential(c, async (token) => token, f.options)));
  assert.deepEqual(tokens, ["fresh", "fresh"]);
  assert.equal(f.calls.refresh, 1);
  assert.equal(f.calls.writes, 1);
  const saved = await f.store.read();
  assert.equal(saved.auth_method, "oauth");
  assert.equal(saved.token.refresh_token, "refresh");
  assert.ok(Date.parse(saved.token.expiry) > Date.now());
});

test("AGY refreshes once on 401 even when the stored expiration is in the future", async () => {
  const f = fixture();
  f.credential.token.expiry = "2099-01-01T00:00:00Z";
  const tokens = [];
  await withAntigravityCredential(f.credential, async (token) => {
    tokens.push(token);
    if (token === "old") throw Object.assign(new Error("unauthorized"), { status: 401 });
  }, f.options);
  assert.deepEqual(tokens, ["old", "fresh"]);
  assert.equal(f.calls.refresh, 1);
});

test("AGY does not overwrite an account selected during token refresh", async () => {
  const f = fixture();
  const fetchImpl = f.options.fetchImpl;
  f.options.fetchImpl = async (...args) => {
    await f.store.write({ token: { access_token: "other", refresh_token: "other-account" } });
    return fetchImpl(...args);
  };
  await assert.rejects(withAntigravityCredential(f.credential, async () => {}, f.options), /계정이 변경/);
  assert.equal((await f.store.read()).token.refresh_token, "other-account");
  assert.equal(f.calls.writes, 1);
});

test("AGY keeps existing credentials when refresh fails and does not retry non-auth errors", async () => {
  const f = fixture();
  f.options.fetchImpl = async () => ({ ok: false, status: 400 });
  await assert.rejects(withAntigravityCredential(f.credential, async () => {}, f.options), /HTTP 400/);
  assert.equal(f.calls.writes, 0);
  assert.equal(f.credential.token.access_token, "old");
  f.credential.token.expiry = "2099-01-01T00:00:00Z";
  await assert.rejects(withAntigravityCredential(f.credential, async () => {
    throw Object.assign(new Error("rate limited"), { status: 429 });
  }, f.options), /rate limited/);
  assert.equal(f.calls.writes, 0);
});
