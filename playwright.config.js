'use strict';

/* R2 Task 16 — Playwright configuration.
   Electron-only: no browser download, serial workers, one app per spec.
   The fixture in tests/e2e/fixture.js owns the app lifecycle. */

/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: './tests/e2e',
  timeout: 120000,
  expect: { timeout: 15000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
};
