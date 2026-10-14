const test = require("node:test");
const assert = require("node:assert/strict");
const { clientFromPE, resolveAntigravityClient } = require("../src/antigravity-oauth-client");
const id = "123-test.apps.googleusercontent.com";
const secret = `GOCSPX-${"x".repeat(28)}`;

function fixture() {
  const b = Buffer.alloc(4096); b.write("MZ"); b.writeUInt32LE(128, 60); b.write("PE\0\0", 128);
  b.writeUInt16LE(1, 134); b.writeUInt16LE(240, 148); b.writeUInt16LE(0x20b, 152);
  b.writeBigUInt64LE(0x140000000n, 176);
  b.writeUInt32LE(4096, 404); b.writeUInt32LE(3584, 408); b.writeUInt32LE(512, 412);
  b.write(id, 1024); b.write(secret, 1536);
  return b;
}

test("reads paired installed client metadata, never an unrelated client", () => {
  const b = fixture();
  b.writeBigUInt64LE(0x140001200n, 2048); b.writeBigUInt64LE(BigInt(id.length), 2056);
  b.writeBigUInt64LE(0x140001400n, 2064); b.writeBigUInt64LE(35n, 2072);
  assert.deepEqual(clientFromPE(b, id), { clientId: id, clientSecret: secret });
  assert.equal(clientFromPE(b, "456-other.apps.googleusercontent.com"), null);
});

test("reads Windows Go runtime-initialized OAuth fields with exact pointer and length checks", () => {
  const b = fixture(); const at = 2200;
  const bytes = Buffer.from(`48c74008${id.length.toString(16)}000000488d0d0000000048890848c7401823000000488d0d0000000048894810`, "hex");
  bytes.copy(b, at); b.writeInt32LE(1024 - (at + 15), at + 11); b.writeInt32LE(1536 - (at + 33), at + 29);
  assert.deepEqual(clientFromPE(b, id), { clientId: id, clientSecret: secret });
  b[at + 36] = 0;
  assert.equal(clientFromPE(b, id), null);
  assert.equal(clientFromPE(b.subarray(0, 30), id), null);
});

test("configured OAuth metadata must match the token audience", async () => {
  const env = { ANTIGRAVITY_OAUTH_CLIENT_ID: id, ANTIGRAVITY_OAUTH_CLIENT_SECRET: secret };
  assert.deepEqual(await resolveAntigravityClient(id, { env, platform: "linux" }), { clientId: id, clientSecret: secret });
  assert.equal(await resolveAntigravityClient("other", { env, platform: "linux" }), null);
});
