'use strict';

/* Code Pack P — capture state (R2 Task 23).

   The state machine does not grant operating-system permissions. The
   main-process capture adapter owns those permissions and the temporary
   file. Every stop path stops all media tracks and closes the file handle. */

function transitionRecording(state, event) {
  const transitions = {
    idle: { request: 'requesting' },
    requesting: { granted: 'recording', denied: 'idle', cancel: 'idle' },
    recording: { pause: 'paused', stop: 'stopped', limit: 'stopped', error: 'failed' },
    paused: { resume: 'recording', stop: 'stopped', limit: 'stopped', error: 'failed' },
    stopped: { save: 'saved', discard: 'idle' },
    saved: { reset: 'idle' },
    failed: { discard: 'idle' },
  };
  const next = transitions[state] && transitions[state][event];
  if (!next) throw new Error(`Invalid capture transition: ${state} -> ${event}`);
  return next;
}

function captureLimit({ elapsedMs, bytes }) {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(bytes) || elapsedMs < 0 || bytes < 0) {
    throw new Error('Invalid capture measurement.');
  }
  return elapsedMs >= 30 * 60 * 1000 || bytes >= 250 * 1024 * 1024;
}

function createCaptureLimitMonitor({
  getMeasurement,
  onLimit,
  intervalMs = 1000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  // Injectable timers keep this testable; main.js never schedules directly.
  const timer = setIntervalFn(() => {
    let over = false;
    try {
      over = captureLimit(getMeasurement());
    } catch {
      over = true; // an invalid measurement must never run unbounded
    }
    if (over) {
      clearIntervalFn(timer);
      onLimit();
    }
  }, intervalMs);
  return {
    stop() {
      clearIntervalFn(timer);
    },
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { transitionRecording, captureLimit, createCaptureLimitMonitor };
else globalThis.XavaniRecording = { transitionRecording, captureLimit, createCaptureLimitMonitor };
