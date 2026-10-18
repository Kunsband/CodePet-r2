const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { ActivityBubbleState } = require("../../src/activity-bubble-state");
const movement = require("../../src/movement-policy");

// Run the real main-process handlers with isolated timers, windows and watchers.
function createPetMotionHarness({ manualPaused = true, send = () => {}, claudeWatcher,
  mainPath = require.resolve("../../src/main.js") } = {}) {
  const source = fs.readFileSync(mainPath, "utf8");
  const sent = [];
  const bubbles = [];
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    ...movement,
    runtime: {
      width: 192, height: 208, x: 100, y: 100, direction: 1,
      velocityX: 1, velocityY: 0, spriteRows: 11, idleState: "waiting",
      currentState: "idle", movementPhase: "idle", manualPaused,
      pauseReasons: new Set(), pauseStates: new Map(),
    },
    petWindow: { isDestroyed: () => false, webContents: { send(channel, state) {
      sent.push(state);
      send(channel, state);
    } } },
    IPC_CHANNELS: { SET_STATE: "pet:set-state" },
    V2_SPRITE_ROWS: 11, DEFAULT_SPRITE_ROWS: 9,
    phaseTimer: null, reactionTimer: null, movementTimer: null, bubbleHideTimer: null,
    MOVEMENT_CONFIG: { minIdleMs: 2100, maxIdleMs: 3300, minWalkMs: 3200, maxWalkMs: 6500, idleAfterReactionMs: 650, tickMs: 16 },
    STATE_TIMING: { idle: { frames: 6, fps: 3 }, waving: { frames: 4, fps: 4 }, jumping: { frames: 5, fps: 5 }, failed: { frames: 8, fps: 4 } },
    BUBBLE_CONFIG: { doneAutoHideMs: 5000 },
    activeActivityBubbles: new ActivityBubbleState(),
    codexWatcher: { working: false }, antigravityWatcher: { working: false },
    claudeWatcher: claudeWatcher || { working: false }, grokWatcher: { working: false },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval: () => ++timerId, clearInterval() {},
    persistMovementPreferences() {}, refreshTrayMenu() {},
    detectPetSpriteRows: () => 11,
    moveWindowTo() {}, placeInitialWindow() {},
    truncateForBubble: (text) => text,
    showWatcherActivityBubble(data) { bubbles.push(data); return true; },
    showActiveActivityBubble() { bubbles.push(context.activeActivityBubbles.toBubbleData()); return true; },
    restoreActiveActivityBubble() {},
  });
  const names = [
    "randomBetween", "chooseRandomIdleState", "getActivePauseState", "getActivityPetState",
    "hasBlockingPauseReasons", "sendPetState", "ensurePetState", "resendCurrentPetState",
    "ensureRoamingMotionState", "syncMovementAnimation", "schedulePhase", "pauseAutoMovement",
    "resumeAutoMovement", "beginWalkingPhase", "beginIdlePhase", "updateMovementTick",
    "stopMovementLoop", "startMovementLoop", "getStateDurationMs", "playReaction",
    "toggleManualPause", "isAnyProviderWorking", "showCodexActivityBubble", "didTaskFail",
    "registerExternalWatcher",
  ];
  vm.runInContext(names.map(name => {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    return source.slice(start, source.indexOf("\n}", start) + 2);
  }).join("\n"), context);
  return {
    context, sent, bubbles,
    finishReaction() {
      const id = context.reactionTimer;
      const callback = timers.get(id);
      assert.ok(callback, "reaction timer exists");
      timers.delete(id);
      callback();
    },
  };
}

module.exports = { createPetMotionHarness };
