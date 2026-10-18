function normalizeMovementPreferences(settings) {
  return {
    manualPaused: settings?.manualPaused === true,
  };
}

function movementPreferencesPatch(runtime) {
  return {
    manualPaused: runtime?.manualPaused === true,
  };
}

module.exports = { movementPreferencesPatch, normalizeMovementPreferences };
