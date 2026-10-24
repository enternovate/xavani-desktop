'use strict';

// Update checks are opt-in (Task 24b). This module owns the scheduling rule so
// it can be tested without Electron: nothing is scheduled, and no network call
// happens, until the user turns auto-check on.

const FIRST_DELAY_MS = 8000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

function createAutoUpdateSchedule({
  check,
  firstDelayMs = FIRST_DELAY_MS,
  intervalMs = INTERVAL_MS,
  timers = {},
} = {}) {
  const setTimeoutFn = timers.setTimeout || setTimeout;
  const clearTimeoutFn = timers.clearTimeout || clearTimeout;
  const setIntervalFn = timers.setInterval || setInterval;
  const clearIntervalFn = timers.clearInterval || clearInterval;

  let firstHandle = null;
  let intervalHandle = null;
  let enabled = false;

  function stop() {
    if (firstHandle !== null) { clearTimeoutFn(firstHandle); firstHandle = null; }
    if (intervalHandle !== null) { clearIntervalFn(intervalHandle); intervalHandle = null; }
  }

  function fire() {
    if (enabled) check().catch(() => {});
  }

  function setEnabled(next) {
    enabled = next === true;
    stop();
    if (!enabled) return false;
    firstHandle = setTimeoutFn(fire, firstDelayMs);
    intervalHandle = setIntervalFn(fire, intervalMs);
    return true;
  }

  return { setEnabled, isEnabled: () => enabled };
}

module.exports = { FIRST_DELAY_MS, INTERVAL_MS, createAutoUpdateSchedule };
