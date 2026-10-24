'use strict';

// Task 24b: update checks are opt-in. The scheduling rule lives in
// src/update-policy.js so it can be exercised with fake timers, without
// Electron and without the network.

const test = require('node:test');
const assert = require('node:assert');

const {
  createAutoUpdateSchedule,
  FIRST_DELAY_MS,
  INTERVAL_MS,
} = require('../../src/update-policy');

function fakeTimers() {
  const timeouts = new Map();
  const intervals = new Map();
  let seq = 0;
  return {
    timeouts,
    intervals,
    timers: {
      setTimeout: (fn, ms) => { timeouts.set(++seq, { fn, ms }); return seq; },
      clearTimeout: (id) => { timeouts.delete(id); },
      setInterval: (fn, ms) => { intervals.set(++seq, { fn, ms }); return seq; },
      clearInterval: (id) => { intervals.delete(id); },
    },
    fireTimeouts: () => { for (const { fn } of [...timeouts.values()]) fn(); },
    fireIntervals: () => { for (const { fn } of [...intervals.values()]) fn(); },
  };
}

function harness() {
  const ft = fakeTimers();
  const calls = [];
  const check = () => { calls.push(Date.now()); return Promise.resolve(null); };
  const schedule = createAutoUpdateSchedule({ check, timers: ft.timers });
  return { ft, calls, schedule };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('no check and no timer exist before the user opts in', () => {
  const { ft, calls, schedule } = harness();
  assert.equal(schedule.isEnabled(), false);
  assert.equal(ft.timeouts.size, 0);
  assert.equal(ft.intervals.size, 0);
  ft.fireTimeouts();
  ft.fireIntervals();
  assert.equal(calls.length, 0);
});

test('opting in schedules one delayed check plus the repeat interval', () => {
  const { ft, calls, schedule } = harness();
  assert.equal(schedule.setEnabled(true), true);
  assert.equal(ft.timeouts.size, 1);
  assert.equal(ft.intervals.size, 1);
  assert.equal([...ft.timeouts.values()][0].ms, FIRST_DELAY_MS);
  assert.equal([...ft.intervals.values()][0].ms, INTERVAL_MS);
  ft.fireTimeouts();
  assert.equal(calls.length, 1);
  ft.fireIntervals();
  assert.equal(calls.length, 2);
});

test('opting out clears both timers and stops further checks', () => {
  const { ft, calls, schedule } = harness();
  schedule.setEnabled(true);
  assert.equal(schedule.setEnabled(false), false);
  assert.equal(schedule.isEnabled(), false);
  assert.equal(ft.timeouts.size, 0);
  assert.equal(ft.intervals.size, 0);
  ft.fireTimeouts();
  ft.fireIntervals();
  assert.equal(calls.length, 0);
});

test('opt-in is idempotent: a second enable does not stack intervals', () => {
  const { ft, schedule } = harness();
  schedule.setEnabled(true);
  schedule.setEnabled(true);
  assert.equal(ft.intervals.size, 1);
  assert.equal(ft.timeouts.size, 1);
});

test('a failing check is swallowed', async () => {
  const ft = fakeTimers();
  const schedule = createAutoUpdateSchedule({
    check: () => Promise.reject(new Error('offline')),
    timers: ft.timers,
  });
  schedule.setEnabled(true);
  assert.doesNotThrow(() => ft.fireTimeouts());
  await tick();
});

test('a non-boolean enable value does not turn checks on', () => {
  const { ft, calls, schedule } = harness();
  assert.equal(schedule.setEnabled('yes'), false);
  assert.equal(ft.intervals.size, 0);
  assert.equal(calls.length, 0);
});

test('defaults: first check after 8s, repeat every 6h', () => {
  assert.equal(FIRST_DELAY_MS, 8000);
  assert.equal(INTERVAL_MS, 6 * 60 * 60 * 1000);
});

// main.js must wire the policy and gate it on the trusted sender, and must not
// schedule anything at startup.
const fs = require('node:fs');
const path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');

test('main.js wires the opt-in policy and no longer schedules at startup', () => {
  assert.ok(main.includes('createAutoUpdateSchedule({ check: checkForUpdates })'));
  assert.ok(main.includes("ipcMain.handle('set-auto-update'"));
  assert.ok(main.includes("if (!trustedSender(event, mainWindow)) return null;\n      return autoUpdate.setEnabled(enabled);"));
  assert.equal(main.includes('setInterval('), false, 'main.js must not schedule an interval itself');
  assert.equal(main.includes('setTimeout(() => checkForUpdates'), false, 'no startup update check');
});
