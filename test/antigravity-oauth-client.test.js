const test = require("node:test");
const assert = require("node:assert/strict");
const { clientFromMachO, clientFromPE, resolveAntigravityClient } = require("../src/antigravity-oauth-client");
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

// arm64 Mach-O with one __TEXT segment: strings at 0x200/0x300/0x340, code in __text from 0x800.
function machO() {
  const b = Buffer.alloc(4096);
  b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(0x0100000c, 4); b.writeUInt32LE(1, 16);
  b.writeUInt32LE(0x19, 32); b.writeUInt32LE(152, 36); b.write("__TEXT", 40);
  b.writeBigUInt64LE(0x100000000n, 56); b.writeBigUInt64LE(4096n, 64);
  b.writeBigUInt64LE(0n, 72); b.writeBigUInt64LE(4096n, 80); b.writeUInt32LE(1, 96);
  b.write("__text", 104); b.write("__TEXT", 120);
  b.writeBigUInt64LE(0x100000800n, 136); b.writeBigUInt64LE(0x400n, 144); b.writeUInt32LE(0x800, 152);
  b.write(id, 0x200); b.write(secret, 0x300); b.write(`GOCSPX-${"y".repeat(28)}`, 0x340);
  return b;
}

function loadString(b, at, register, target, length) {
  b.writeUInt32LE((0x90000000 | register) >>> 0, at);
  b.writeUInt32LE((0x91000000 | (target << 10) | (register << 5) | register) >>> 0, at + 4);
  b.writeUInt32LE((0xd2800000 | (length << 5) | (register + 1)) >>> 0, at + 8);
}

test("reads arm64 macOS Go runtime-initialized OAuth fields from ADRP/ADD/MOVZ sequences", () => {
  const b = machO();
  loadString(b, 0x800, 1, 0x200, id.length); loadString(b, 0x80c, 3, 0x300, 35);
  assert.deepEqual(clientFromMachO(b, id), { clientId: id, clientSecret: secret });
  assert.equal(clientFromMachO(b, "456-other.apps.googleusercontent.com"), null);
  // A wrong length next to the ID is not the OAuth config.
  const wrong = machO();
  loadString(wrong, 0x800, 1, 0x200, id.length + 1); loadString(wrong, 0x820, 3, 0x300, 35);
  assert.equal(clientFromMachO(wrong, id), null);
  assert.equal(clientFromMachO(b.subarray(0, 30), id), null);
});

test("refuses macOS client metadata when ID references pair with different secrets", () => {
  const b = machO();
  loadString(b, 0x800, 1, 0x200, id.length); loadString(b, 0x80c, 3, 0x300, 35);
  loadString(b, 0x900, 1, 0x200, id.length); loadString(b, 0x90c, 3, 0x340, 35);
  assert.equal(clientFromMachO(b, id), null);
});

test("reads the matching slice of a universal macOS binary", () => {
  const slice = machO();
  loadString(slice, 0x800, 1, 0x200, id.length); loadString(slice, 0x80c, 3, 0x300, 35);
  const fat = Buffer.alloc(4096 + slice.length);
  fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(1, 4);
  fat.writeUInt32BE(0x0100000c, 8); fat.writeUInt32BE(4096, 16); fat.writeUInt32BE(slice.length, 20);
  slice.copy(fat, 4096);
  assert.deepEqual(clientFromMachO(fat, id, "arm64"), { clientId: id, clientSecret: secret });
});
