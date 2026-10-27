const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { releaseHiddenWindow } = require("../src/idle-window-release");

test("hidden renderers are released after a grace period; showing and pending work prevent release", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = false, destroyed = false, pending = false;
  const win = Object.assign(new EventEmitter(), {
    isVisible: () => visible, isDestroyed: () => destroyed,
    destroy() { destroyed = true; this.emit("closed"); },
  });
  releaseHiddenWindow(win, { canRelease: () => !pending });
  t.mock.timers.tick(29000);
  assert.equal(destroyed, false);
  visible = true; win.emit("show");
  t.mock.timers.tick(60000);
  assert.equal(destroyed, false);
  visible = false; pending = true; win.emit("hide");
  t.mock.timers.tick(30000);
  assert.equal(destroyed, false);
  pending = false; win.emit("hide");
  t.mock.timers.tick(30000);
  assert.equal(destroyed, true);
});
