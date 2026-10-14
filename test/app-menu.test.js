const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Exercise the actual main-process handlers without starting Electron or a UI.
const source = fs.readFileSync(require.resolve("../src/main.js"), "utf8");
function declaration(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
function setup({ petVisible, taskbarVisible }) {
  const calls = { popup: 0, toggle: 0, petMenus: [] };
  const context = {
    Menu: { buildFromTemplate: (items) => ({ items, popup: (options) => calls.petMenus.push({ items, options }) }) },
    petWindow: { isDestroyed: () => false, isVisible: () => petVisible },
    tray: { getBounds: () => ({ x: 10, y: 20, width: 24, height: 24 }), setToolTip() {}, setContextMenu: (menu) => { calls.trayMenu = menu; } },
    usageWindows: { togglePopup: () => calls.popup++, toggleBar: () => calls.toggle++ },
    readSettings: () => ({ taskbarUsageVisible: taskbarVisible }),
    runtime: { manualPaused: false, followMouse: false },
    isCodexProxyModeEnabled: () => false, isAutoLaunchEnabled: () => false,
  };
  for (const name of ["openSettingsWindow", "openChatWindow", "showPetWindowFromTray", "hidePetWindowToTray", "setCodexProxyMode", "toggleManualPause", "toggleFollowMouse", "toggleAutoLaunch", "quitApp"]) context[name] = () => {};
  for (const name of ["buildProviderAccountSubmenu", "buildPetSelectionSubmenu", "buildManualMotionSubmenu"]) context[name] = () => [];
  vm.createContext(context);
  vm.runInContext(["buildAppMenu", "refreshTrayMenu", "showContextMenu"].map(declaration).join("\n"), context);
  return { context, calls };
}

for (const petVisible of [true, false]) {
  for (const taskbarVisible of [true, false, undefined]) {
    test(`pet and tray menus share working quota controls (pet=${petVisible}, taskbar=${taskbarVisible})`, () => {
      const { context, calls } = setup({ petVisible, taskbarVisible });
      context.refreshTrayMenu();
      context.showContextMenu();
      assert.equal(calls.petMenus.length, 1);
      assert.equal(calls.petMenus[0].options.window, context.petWindow);
      const petItems = calls.petMenus[0].items;
      assert.deepEqual(petItems.map((item) => item.label || item.type), calls.trayMenu.items.map((item) => item.label || item.type));
      for (const items of [petItems, calls.trayMenu.items]) {
        items.find((item) => item.label === "남은 한도 보기…").click();
        const toggle = items.find((item) => item.label === "작업표시줄에 표시");
        assert.equal(toggle.checked, taskbarVisible !== false);
        toggle.click();
        assert.ok(items.some((item) => item.label === "모션 실행"));
        assert.ok(items.some((item) => item.label === "로그인 시 자동 실행"));
      }
      assert.equal(calls.popup, 2);
      assert.equal(calls.toggle, 2);
    });
  }
}
