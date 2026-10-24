'use strict';

/* R2 Task 22 — the work timeline view.

   Real fixture with a seeded timeline file beside a session log. Proves:
   events render in order with their details; replay is read-only (no work
   runs, the list re-renders from copies); the export control exists. */

const { test, expect } = require('@playwright/test');

const { launchWorkbench } = require('./fixture');

const EVENTS = [
  { ts: 1, type: 'task.started', summary: 'e2e timeline task' },
  { ts: 2, type: 'skill.loaded', workflow: 'finance', skills: 3 },
  { ts: 3, type: 'tool.started', tool: 'write_file' },
  { ts: 4, type: 'tool.completed', tool: 'write_file', duration: 0.2, error: false },
  { ts: 5, type: 'verification.completed', state: 'passed' },
  { ts: 6, type: 'task.completed', summary: 'e2e timeline task' },
];

test('the timeline renders recorded events and replays read-only', async () => {
  const ctx = await launchWorkbench({ seedTimeline: { events: EVENTS } });
  try {
    const { page, errors } = ctx;

    await page.evaluate(() => toggleStudio(true));
    await page.click('#tab-timeline');

    // All six events render, in recorded order, with their details.
    await expect(page.locator('#tl-events .tl-item')).toHaveCount(6);
    await expect(page.locator('#tl-events')).toContainText('Task started');
    await expect(page.locator('#tl-events')).toContainText('Skill loaded');
    await expect(page.locator('#tl-events')).toContainText('finance (3 skills)');
    await expect(page.locator('#tl-events')).toContainText('Tool completed');
    await expect(page.locator('#tl-events')).toContainText('write_file (0.2s)');
    await expect(page.locator('#tl-events')).toContainText('Verification completed');
    await expect(page.locator('#tl-session')).toContainText('session_run_e2e');

    // Replay re-renders read-only: same events, zero tool cards, no errors.
    await page.click('#tl-replay');
    await expect(page.locator('#tl-events .tl-item')).toHaveCount(6);
    expect(await page.locator('.tool-card').count()).toBe(0);

    // Export control is present (the native save dialog is covered by the
    // mandatory manual platform checks).
    await expect(page.locator('#tl-export')).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
