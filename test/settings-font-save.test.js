const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { normalizeFontFamily, normalizeFontSize } = require("../src/appearance-settings");

test("settings save waits for font discovery only when selecting a different font", async () => {
  const source = fs.readFileSync(require.resolve("../src/main.js"), "utf8");
  const start = source.indexOf('  ipcMain.handle("settings:save"');
  const end = source.indexOf('  ipcMain.handle("settings:account"', start);
  let handler, reads = 0;
  const saved = { fontFamily: "Saved Font", fontSize: 14 };
  const context = {
    ipcMain: { handle(_name, callback) { handler = callback; } },
    readSettings: () => ({ ...saved }), writeSettings: patch => Object.assign(saved, patch),
    getInstalledFonts: async () => { reads++; return ["New Font"]; },
    getSettingsData: async () => saved,
    normalizeFontFamily, normalizeFontSize, ACTIVITY_BUBBLE_MODES: {},
    sendAppearanceToWindows() {}, refreshTrayMenu() {},
  };
  vm.runInNewContext(source.slice(start, end), context);
  await handler(null, { fontFamily: "Saved Font", fontSize: 16 });
  assert.equal(reads, 0);
  assert.equal(saved.fontFamily, "Saved Font");
  assert.equal(saved.fontSize, 16);
  await handler(null, { fontFamily: "New Font" });
  assert.equal(reads, 1);
  assert.equal(saved.fontFamily, "New Font");
  await handler(null, { fontFamily: "Not Installed" });
  assert.equal(reads, 2);
  assert.equal(saved.fontFamily, null);
  await handler(null, { fontFamily: "New Font" });
  await handler(null, { fontFamily: null });
  assert.equal(reads, 3);
  assert.equal(saved.fontFamily, null);
});
