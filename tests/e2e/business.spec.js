'use strict';

/* R2 Task 21 — the business workspace view.

   Real fixture: the view must render exactly what the backend can serve.
   Seeded: one business state file (sources/checks/outstanding) and one
   real operator-queue approval (Task 19 record) in the isolated home. */

const { test, expect } = require('@playwright/test');

const { launchWorkbench } = require('./fixture');

const STATE = {
  sources: [
    { name: 'statement.csv', access: 'Granted' },
    { name: 'bank-feed', access: 'Unavailable' },
  ],
  drafts: [{ name: 'analysis/report.md', path: 'analysis/report.md' }],
  checks: [{ name: 'reconciliation', status: 'failed', difference: 'ZAR 0.01' }],
  outstanding: [{ summary: 'file the VAT return', state: 'open' }],
};

const APPROVAL = {
  id: 'biz-1',
  request: {
    profile: 'default',
    workspace_id: 'ws',
    operation: 'send_email',
    target: 'customer@example.com',
    payload: { recipient: 'customer@example.com', body_sha256: '9f2c1d' },
  },
};

test('the business view renders capable controls and keeps denials', async () => {
  const ctx = await launchWorkbench({ seedBusiness: { state: STATE, approval: APPROVAL } });
  try {
    const { page, errors } = ctx;

    await page.evaluate(() => toggleStudio(true));
    await page.click('#tab-business');

    // The selector is the backend's exact workflow list.
    await expect(page.locator('#biz-workflow option')).toHaveCount(12);

    // A missing connector shows Unavailable; a readable source shows Granted.
    await expect(page.locator('#biz-sources')).toContainText('bank-feed — Unavailable');
    await expect(page.locator('#biz-sources')).toContainText('statement.csv — Granted');

    // A missing financial period blocks report execution.
    await page.selectOption('#biz-workflow', 'B01');
    await expect(page.locator('#biz-run')).toBeDisabled();
    await expect(page.locator('#biz-missing')).toContainText('missing period');
    await page.fill('#biz-period', '2026-Q2');
    await page.fill('#biz-currency', 'ZAR');
    await expect(page.locator('#biz-run')).toBeEnabled();

    // A failed reconciliation shows the exact difference.
    await expect(page.locator('#biz-checks')).toContainText('difference: ZAR 0.01');

    // A draft email shows its exact recipient before approval.
    await expect(page.locator('#biz-approvals')).toContainText('send_email → customer@example.com');
    await expect(page.locator('#biz-approvals')).toContainText('recipient: customer@example.com');

    // Deny through the real queue; navigate away and back; still denied.
    await page.locator('#biz-approvals button.biz-decision', { hasText: 'Deny' }).click();
    await expect(page.locator('#biz-approvals')).toContainText('denied');
    await page.click('#tab-preview');
    await page.click('#tab-business');
    await expect(page.locator('#biz-approvals')).toContainText('denied');
    await expect(page.locator('.biz-item.denied')).toHaveCount(1);

    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
