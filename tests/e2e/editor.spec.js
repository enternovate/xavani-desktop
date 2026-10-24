'use strict';

/* R2 Task 15 — editor component and Problems pane end-to-end cases.
   SKELETON ONLY.

   TODO(Task 16): the real desktop harness (playwright.config.js,
   tests/e2e/fixture.js with the Electron fixture, the `test:e2e` npm
   script) does not exist yet. Do not add the npm wiring here — Task 16
   owns package.json. Until the harness lands this file is inert: it
   registers nothing, so a stray glob cannot fail on a missing dependency.

   The adapter rules are covered by tests/desktop/test_editor_adapter.js
   against a mock monaco. These cases cover the DOM, the worker, the LSP
   route, and the real application behavior the unit tests cannot see. */

let playwright = null;
try {
  // eslint-disable-next-line global-require
  playwright = require('@playwright/test');
} catch {
  // Task 16 installs @playwright/test.
}

if (playwright) {
  const { test, expect } = playwright;
  // TODO(Task 16): const { launchWorkbench } = require('./fixture');

  test('a UTF-8 file opens in Monaco through the workspace API', async () => {
    // TODO(Task 16): open a UTF-8 file from the explorer, assert the Monaco
    // model text matches the workspace API payload, and assert no second
    // read path hit the filesystem directly.
  });

  test('two tabs keep independent buffers', async () => {
    // TODO(Task 16): edit two files, switch tabs, assert each buffer keeps
    // its own text and view state.
  });

  test('save uses the expected revision and surfaces a conflict', async () => {
    // TODO(Task 16): save normally; then move the file behind the buffer and
    // assert the 409 path keeps the dirty buffer and reports the conflict.
  });

  test('the diff view is side-by-side and read-only', async () => {
    // TODO(Task 16): open a diff, assert two panes, assert attempting an edit
    // changes nothing on disk and nothing in the model pair base.
  });

  test('a diagnostic lands on the exact file and line in the Problems pane', async () => {
    // TODO(Task 16): feed a diagnostic at a known position, assert the
    // Problems entry shows file:line and that keyboard navigation focuses
    // that editor position.
  });

  test('LSP actions are disabled when no server exists', async () => {
    // TODO(Task 16): with the LSP status route reporting unavailable, assert
    // the LSP affordances are disabled and no diagnostics request is made.
  });

  test('closing a tab disposes its model (no leak)', async () => {
    // TODO(Task 16): close a tab, assert monaco.editor.getModels() no longer
    // contains it.
  });

  test('a reopened tab shows fresh disk content, never the old buffer', async () => {
    // TODO(Task 16): close a tab whose buffer held a marker string, change
    // the file on disk, reopen, and assert the old string is gone.
  });

  test('the editor boots under the current CSP without unsafe-eval', async () => {
    // TODO(Task 16): assert the page met the CSP (no violations) and the
    // worker connected; the fixture already fails on uncaught renderer
    // errors.
  });
}

module.exports = {};
