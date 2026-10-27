const test = require("node:test");
const assert = require("node:assert/strict");
const { createPetMotionHarness } = require("../scripts/lib/pet-motion-harness");
const { ClaudeWatcher, parseClaudeRow } = require("../src/claude-watcher");

test("movement ticks run only while walking and stop during idle, manual pause, drag, and hiding", () => {
  const { context: c } = createPetMotionHarness({ manualPaused: false });
  c.startMovementLoop();
  assert.equal(c.movementTimer, null);
  c.beginWalkingPhase();
  assert.ok(c.movementTimer);
  c.beginIdlePhase();
  assert.equal(c.movementTimer, null);
  c.beginWalkingPhase(); c.toggleManualPause();
  assert.equal(c.movementTimer, null);
  c.toggleManualPause(); c.beginWalkingPhase();
  c.pauseAutoMovement("drag");
  assert.equal(c.movementTimer, null);
  c.resumeAutoMovement("drag"); c.beginWalkingPhase();
  assert.ok(c.movementTimer);
  c.stopMovementLoop();
  assert.equal(c.movementTimer, null);
});

for (const paused of [true, false]) {
  test(`Claude command reaches the working motion with movement paused=${paused}`, () => {
    const watcher = new ClaudeWatcher({ roots: [] });
    const h = createPetMotionHarness({ manualPaused: paused, claudeWatcher: watcher });
    h.context.registerExternalWatcher(watcher, "Claude");
    watcher.accept(parseClaudeRow({ sessionId: "motion", type: "assistant", message: {
      content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }],
    } }), Date.now());
    assert.equal(h.bubbles.at(-1).title, "Claude 명령 실행 중");
    assert.equal(h.context.runtime.currentState, "running");
    if (paused) {
      h.context.updateMovementTick();
      h.context.beginWalkingPhase();
      assert.equal(h.context.runtime.x, 100);
      assert.equal(h.context.runtime.y, 100);
      assert.equal(h.context.runtime.movementPhase, "idle");
    }
  });
}

test("pausing movement preserves working animation and reactions return to the current work", () => {
  const h = createPetMotionHarness({ manualPaused: false });
  const c = h.context;
  c.pauseAutoMovement("codex", "running");
  c.toggleManualPause();
  assert.equal(c.runtime.currentState, "running");
  c.playReaction("waving");
  c.pauseAutoMovement("codex", "review");
  assert.equal(c.runtime.currentState, "waving");
  h.finishReaction();
  assert.equal(c.runtime.currentState, "review");
  c.resumeAutoMovement("codex");
  assert.equal(c.runtime.currentState, "idle");
  assert.equal(c.runtime.manualPaused, true);
});

test("paused chat activity survives drag release, pet recreation and completion of another source", () => {
  const h = createPetMotionHarness();
  const c = h.context;
  c.pauseAutoMovement("chat", "running");
  c.pauseAutoMovement("drag", "idle");
  c.resumeAutoMovement("drag");
  assert.equal(c.runtime.currentState, "running");
  c.pauseAutoMovement("codex", "review");
  c.resumeAutoMovement("codex");
  assert.equal(c.runtime.currentState, "running");
  c.runtime.currentState = "idle";
  c.startMovementLoop({ resetPosition: false });
  assert.equal(c.runtime.currentState, "running");
  c.resumeAutoMovement("chat");
  assert.equal(c.runtime.currentState, "idle");
});

test("paused approval waiting remains distinct from command execution", () => {
  const { context: c } = createPetMotionHarness();
  c.pauseAutoMovement("codex", "waiting");
  assert.equal(c.runtime.currentState, "waiting");
  c.pauseAutoMovement("codex", "running");
  assert.equal(c.runtime.currentState, "running");
});
