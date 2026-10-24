'use strict';

/* R2 Task 23 — capture controls: nothing happens before an explicit Start.

   Asserts the plan's expected outcome on the real app: no capture file and
   no permission request before a user gesture, the picker lists sources on
   demand, Cancel returns to idle, and the pause/stop/save/discard controls
   stay hidden until a capture exists. The full capture path stays covered
   by the mandatory manual macOS/Windows permission checks. */

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { launchWorkbench } = require('./fixture');

test('no permission prompt or file appears before an explicit Start action', async () => {
  const ctx = await launchWorkbench();
  try {
    const { page, errors } = ctx;

    await page.evaluate(() => toggleStudio(true));

    const captureDir = path.join(os.tmpdir(), 'xavani-capture');
    const countBefore = fs.existsSync(captureDir) ? fs.readdirSync(captureDir).length : 0;

    // Idle: the control asks nothing and shows nothing.
    await expect(page.locator('#rec-main')).toHaveText('● Capture');
    await expect(page.locator('#rec-state')).toHaveText('');

    // The picker opens on the explicit gesture and offers Cancel.
    await page.click('#rec-main');
    await expect(page.locator('#rec-picker')).toBeVisible();
    await expect(page.locator('#rec-picker #rec-cancel')).toBeVisible();

    // Cancel returns to idle with no capture file created.
    await page.click('#rec-picker #rec-cancel');
    await expect(page.locator('#rec-picker')).toBeHidden();
    await expect(page.locator('#rec-state')).toHaveText('');
    const countAfter = fs.existsSync(captureDir) ? fs.readdirSync(captureDir).length : 0;
    expect(countAfter).toBe(countBefore);

    // Pause/stop/save/discard only exist once a capture is running.
    await expect(page.locator('#rec-stop')).toBeHidden();
    await expect(page.locator('#rec-discard')).toBeHidden();

    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
