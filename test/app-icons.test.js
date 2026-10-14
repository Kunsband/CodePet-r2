const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..", "build");
function pngSize(buffer) {
  assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}
test("app icons include PNG assets and all Windows tray/executable sizes", () => {
  assert.deepEqual(pngSize(fs.readFileSync(path.join(root, "icon.png"))), [512, 512]);
  assert.deepEqual(pngSize(fs.readFileSync(path.join(root, "icon-mac.png"))), [1024, 1024]);
  const ico = fs.readFileSync(path.join(root, "icon.ico"));
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 7);
  for (const [i, size] of [16, 24, 32, 48, 64, 128, 256].entries()) {
    const index = 6 + i * 16, length = ico.readUInt32LE(index + 8), offset = ico.readUInt32LE(index + 12);
    assert.ok(offset + length <= ico.length);
    assert.deepEqual(pngSize(ico.subarray(offset, offset + length)), [size, size]);
  }
});
