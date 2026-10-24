'use strict';

/* Code Pack P — capture state tests (R2 Task 23). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { transitionRecording, captureLimit } = require('../../src/recording');

test('capture requires an explicit permission state', () => {
  assert.throws(() => transitionRecording('idle', 'granted'));
  assert.equal(transitionRecording('idle', 'request'), 'requesting');
  assert.equal(transitionRecording('requesting', 'denied'), 'idle');
});

test('pause and stop have explicit transitions', () => {
  assert.equal(transitionRecording('recording', 'pause'), 'paused');
  assert.equal(transitionRecording('paused', 'stop'), 'stopped');
  assert.throws(() => transitionRecording('stopped', 'resume'));
});

test('both capture limits stop capture', () => {
  assert.equal(captureLimit({ elapsedMs: 1800000, bytes: 0 }), true);
  assert.equal(captureLimit({ elapsedMs: 0, bytes: 262144000 }), true);
  assert.equal(captureLimit({ elapsedMs: 1000, bytes: 1024 }), false);
});

test('save and discard are explicit; failures recover through discard', () => {
  assert.equal(transitionRecording('stopped', 'save'), 'saved');
  assert.equal(transitionRecording('saved', 'reset'), 'idle');
  assert.equal(transitionRecording('stopped', 'discard'), 'idle');
  assert.equal(transitionRecording('recording', 'error'), 'failed');
  assert.equal(transitionRecording('failed', 'discard'), 'idle');
  // An invalid capture measurement is refused outright.
  assert.throws(() => captureLimit({ elapsedMs: -1, bytes: 0 }));
  assert.throws(() => captureLimit({ elapsedMs: Number.NaN, bytes: 0 }));
});

test('the limit monitor fires once, stops, and never fires under limit', () => {
  const { createCaptureLimitMonitor } = require('../../src/recording');

  let tick = null;
  let fired = 0;
  let cleared = 0;
  createCaptureLimitMonitor({
    getMeasurement: () => ({ elapsedMs: 1800000, bytes: 0 }),
    onLimit: () => { fired += 1; },
    setIntervalFn: (fn) => { tick = fn; return 'timer-1'; },
    clearIntervalFn: () => { cleared += 1; },
  });
  tick();
  assert.equal(fired, 1);
  assert.equal(cleared, 1); // the monitor stops itself at the limit

  let tick2 = null;
  let fired2 = 0;
  createCaptureLimitMonitor({
    getMeasurement: () => ({ elapsedMs: 1000, bytes: 1024 }),
    onLimit: () => { fired2 += 1; },
    setIntervalFn: (fn) => { tick2 = fn; return 'timer-2'; },
    clearIntervalFn: () => {},
  });
  tick2();
  assert.equal(fired2, 0);
});
