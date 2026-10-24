'use strict';

/* R2 Task 16 — the smoke spec: the real application opens, receives an
   authenticated ready event, and completes a read-only run.

   The run: the fixture boots the true Electron app on a temporary home and
   workspace; the chat turn is served by backend/test_runtime.py (the faux
   provider at the provider boundary); a read-only reply must render with
   zero tool cards and zero renderer errors. A missing engine or secret
   never reaches readiness and fails the waits in the fixture. */

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const { launchWorkbench, FAUX_REPLY, BACKUPS } = require('./fixture');

test('the real app boots, authenticates, and completes a read-only run', async () => {
  const ctx = await launchWorkbench();
  try {
    const { page, errors } = ctx;

    // Authenticated readiness: open studio through the same function the
    // native /studio command runs, then read the granted workspace tree —
    // rendered only if the authenticated injector works end to end.
    try {
      await page.evaluate(() => toggleStudio(true));
      await expect(page.locator('#file-tree .tree-row').first()).toBeVisible({ timeout: 20000 });
      expect(await page.inputValue('#ws-root')).toContain('xavani-e2e-ws-');
    } catch (err) {
      const state = await page.evaluate(() => JSON.stringify({
        appClass: document.querySelector('#app').className,
        treeText: (document.querySelector('#file-tree') || {}).textContent || '',
        wsRoot: (document.querySelector('#ws-root') || {}).value || '',
      })).catch(() => 'evaluate failed');
      throw new Error(`studio/tree step failed state=${state}: ${err && err.message}`);
    }

    // Back to chat for the read-only run.
    await page.evaluate(() => toggleStudio(false));

    // A chat turn through the faux provider at the provider boundary.
    await page.fill('#input', 'hello from the e2e smoke');
    await page.press('#input', 'Enter');
    await expect(page.locator('.msg-assistant').last()).toContainText('FAUX-OK', { timeout: 30000 });

    // Read-only: nothing ran, nothing was written.
    expect(await page.locator('.tool-card').count()).toBe(0);

    // Owner-approval screenshot (read-only state).
    try {
      fs.mkdirSync(BACKUPS, { recursive: true });
      await page.screenshot({ path: path.join(BACKUPS, 'desktop-task16-smoke-v1.png') });
    } catch { /* screenshot is evidence, not a gate */ }

    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
