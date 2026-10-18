const test = require("node:test");
const assert = require("node:assert/strict");

const {
  movementPreferencesPatch,
  normalizeMovementPreferences,
} = require("../src/movement-preferences");

test("이동 일시정지만 저장하고 이전 마우스 따라가기 설정은 무시한다", () => {
  assert.deepEqual(normalizeMovementPreferences({ followMouse: true, manualPaused: true }), {
    manualPaused: true,
  });
  assert.deepEqual(normalizeMovementPreferences({ followMouse: "true", manualPaused: 1 }), {
    manualPaused: false,
  });
  assert.deepEqual(movementPreferencesPatch({ followMouse: true, manualPaused: false }), {
    manualPaused: false,
  });
});
