'use strict';

/* R2 Task 13 — workbench shell state.
   Code Pack K's reducer is the single source of truth for the dock, the
   follow flag, and per-workspace pane sizes. The design constants below are
   the desktop specification's dimensions and tokens: they must not drift
   from src/renderer/workbench.css. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  initialWorkbench, reduceWorkbench, clampLayout,
  LAYOUT_DEFAULTS, LAYOUT_RANGES, WORKBENCH_TOKENS, WORKBENCH_REGIONS,
} = require('../../src/renderer/workbench-state');

const VIEWPORT_DESKTOP = { width: 1440, height: 900 };
const WB_STATE = path.join(__dirname, '../../src/renderer/workbench-state.js');
const WB_CSS = path.join(__dirname, '../../src/renderer/workbench.css');

function resized(state, pane, value, viewport) {
  return reduceWorkbench(state, { type: 'resize', pane, value, viewport });
}
function switched(state, workspaceId, viewport) {
  return reduceWorkbench(state, { type: 'workspace', workspaceId, viewport });
}

test('the default layout opens the dock with an editor and Agent pane', () => {
  const s = initialWorkbench('w1');
  assert.equal(s.workspaceId, 'w1');
  assert.equal(s.dockOpen, true);
  assert.equal(s.dockTab, 'preview');
  assert.equal(s.follow, true);
  assert.equal(s.lastFile, null);
  assert.equal(s.lastFileSeq, 0);
  assert.equal(s.dirty, false);
  assert.deepEqual(WORKBENCH_REGIONS, ['activity', 'explorer', 'editor', 'agent', 'bottom', 'status']);
});

test('initial pane sizes are the design constants', () => {
  const s = initialWorkbench('w1');
  assert.equal(s.explorerWidth, 240);
  assert.equal(s.agentWidth, 360);
  assert.equal(s.bottomHeight, 220);
  assert.deepEqual(LAYOUT_DEFAULTS, { explorerWidth: 240, agentWidth: 360, bottomHeight: 220 });
  assert.deepEqual(LAYOUT_RANGES, {
    explorerWidth: [180, 400],
    agentWidth: [300, 520],
    bottomHeight: [120, 480],
  });
  assert.deepEqual(WORKBENCH_TOKENS, {
    titleBarHeight: 40,
    activityRailWidth: 44,
    statusBarHeight: 24,
    fontSize: 13,
    lineHeight: 20,
    controlMinHeight: 28,
    iconTarget: 32,
    focusWidth: 2,
    panelRadius: 4,
    motionMs: 120,
    space: [4, 8, 12, 16, 24],
  });
});

test('pane sizes stay inside the design ranges', () => {
  const tiny = clampLayout({ explorerWidth: 10, agentWidth: 10, bottomHeight: 10 });
  assert.equal(tiny.explorerWidth, 180);
  assert.equal(tiny.agentWidth, 300);
  assert.equal(tiny.bottomHeight, 120);

  const huge = clampLayout({ explorerWidth: 9000, agentWidth: 9000, bottomHeight: 9000 }, VIEWPORT_DESKTOP);
  assert.equal(huge.explorerWidth, 400);
  assert.equal(huge.agentWidth, 520);
  assert.equal(huge.bottomHeight, 480);
});

test('a saved layout clamps to the current viewport', () => {
  const saved = { explorerWidth: 400, agentWidth: 520, bottomHeight: 480 };

  // Wide enough: the saved sizes survive untouched.
  assert.deepEqual(clampLayout(saved, VIEWPORT_DESKTOP), saved);

  // Too narrow: both side panes shrink to their range minimum before the
  // central editor gives up room.
  const narrow = clampLayout(saved, { width: 760, height: 900 });
  assert.equal(narrow.explorerWidth, 180);
  assert.equal(narrow.agentWidth, 300);

  // Too short: the bottom pane never leaves the editor less than 160 px.
  const short = clampLayout(saved, { width: 1440, height: 620 });
  assert.equal(short.bottomHeight, 620 - 40 - 24 - 160);
  assert.equal(clampLayout({ explorerWidth: 240, agentWidth: 360, bottomHeight: 220 }, { width: 980, height: 620 }).bottomHeight, 220);
});

test('resize stores the clamped size for the active workspace', () => {
  let s = resized(initialWorkbench('w1'), 'explorer', 500, VIEWPORT_DESKTOP);
  assert.equal(s.explorerWidth, 400);
  assert.equal(s.agentWidth, 360);
  assert.deepEqual(s.layouts.w1, { explorerWidth: 400, agentWidth: 360, bottomHeight: 220 });

  s = resized(s, 'agent', 300, VIEWPORT_DESKTOP);
  s = resized(s, 'bottom', 320, VIEWPORT_DESKTOP);
  assert.deepEqual(s.layouts.w1, { explorerWidth: 400, agentWidth: 300, bottomHeight: 320 });

  // An unknown pane or a non-numeric value never moves anything.
  assert.equal(resized(s, 'nope', 99), s);
  assert.equal(resized(s, 'explorer', 'wide'), s);
});

test('a workspace switch restores that workspace layout only', () => {
  let s = resized(initialWorkbench('w1'), 'explorer', 300, VIEWPORT_DESKTOP);
  s = reduceWorkbench(s, { type: 'file-changed', workspaceId: 'w1', seq: 1, path: 'a.py' });
  s = switched(s, 'w2', VIEWPORT_DESKTOP);

  // w2 has no saved layout: defaults, and no leftover w1 file pointer.
  assert.equal(s.workspaceId, 'w2');
  assert.equal(s.explorerWidth, 240);
  assert.equal(s.agentWidth, 360);
  assert.equal(s.lastFile, null);
  assert.equal(s.follow, true);

  s = resized(s, 'agent', 500, VIEWPORT_DESKTOP);
  s = switched(s, 'w1', VIEWPORT_DESKTOP);
  assert.equal(s.explorerWidth, 300);
  assert.equal(s.agentWidth, 360);
  assert.equal(s.lastFile, null);

  // Switching back to w2 restores w2's size, not w1's.
  s = switched(s, 'w2', VIEWPORT_DESKTOP);
  assert.equal(s.explorerWidth, 240);
  assert.equal(s.agentWidth, 500);
});

test('a restored layout is clamped to the viewport it returns into', () => {
  let s = resized(initialWorkbench('w1'), 'explorer', 400, VIEWPORT_DESKTOP);
  s = resized(s, 'agent', 520, VIEWPORT_DESKTOP);
  const restored = switched(s, 'w1', { width: 760, height: 620 });
  assert.equal(restored.explorerWidth, 180);
  assert.equal(restored.agentWidth, 300);
  assert.deepEqual(s.layouts.w1, { explorerWidth: 400, agentWidth: 520, bottomHeight: 220 });
});

test('restore-layout hydrates a stored layout and clamps it', () => {
  let s = reduceWorkbench(initialWorkbench('w1'), {
    type: 'restore-layout', layout: { explorerWidth: 390, agentWidth: 480, bottomHeight: 260 }, viewport: VIEWPORT_DESKTOP,
  });
  assert.equal(s.explorerWidth, 390);
  assert.equal(s.agentWidth, 480);
  assert.equal(s.bottomHeight, 260);
  const clamped = reduceWorkbench(initialWorkbench('w1'), {
    type: 'restore-layout', layout: { explorerWidth: 390, agentWidth: 9000 }, viewport: { width: 800, height: 620 },
  });
  assert.equal(clamped.agentWidth, 300);
  assert.equal(clamped.bottomHeight, 220);
});

test('a viewport change clamps the panes in place', () => {
  let s = resized(initialWorkbench('w1'), 'explorer', 400, VIEWPORT_DESKTOP);
  s = resized(s, 'agent', 520, VIEWPORT_DESKTOP);
  s = reduceWorkbench(s, { type: 'viewport', viewport: { width: 760, height: 620 } });
  assert.equal(s.explorerWidth, 180);
  assert.equal(s.agentWidth, 300);
  assert.equal(s.workspaceId, 'w1');
});

test('reset layout removes only layout preferences', () => {
  let s = resized(initialWorkbench('w1'), 'explorer', 300, VIEWPORT_DESKTOP);
  s = reduceWorkbench(s, { type: 'close-dock' });
  s = reduceWorkbench(s, { type: 'dirty', value: true });
  s = reduceWorkbench(s, { type: 'file-changed', workspaceId: 'w1', seq: 1, path: 'a.py' });
  s = reduceWorkbench(s, { type: 'reset-layout' });

  assert.deepEqual(
    { explorerWidth: s.explorerWidth, agentWidth: s.agentWidth, bottomHeight: s.bottomHeight },
    LAYOUT_DEFAULTS,
  );
  assert.equal(s.dockOpen, false);
  assert.equal(s.dockTab, 'preview');
  assert.equal(s.follow, false);
  assert.equal(s.dirty, true);
  assert.equal(s.lastFile, 'a.py');
  assert.equal(s.lastFileSeq, 1);
  assert.equal(s.workspaceId, 'w1');
  assert.equal(s.layouts.w1, undefined);

  // The reset sticks across a workspace round trip.
  assert.equal(switched(s, 'w2').explorerWidth, 240);
  assert.equal(switched(switched(s, 'w2'), 'w1').explorerWidth, 240);
});

test('Code Pack K dock and flip rules hold', () => {
  let s = reduceWorkbench(initialWorkbench('w1'), { type: 'close-dock' });
  s = reduceWorkbench(s, { type: 'file-changed', workspaceId: 'w1', seq: 1, path: 'a.py' });
  assert.equal(s.dockOpen, false);
  assert.equal(s.dockTab, 'preview');

  s = reduceWorkbench(initialWorkbench('w1'), { type: 'file-changed', workspaceId: 'w1', seq: 1, path: 'a.py' });
  assert.equal(s.dockTab, 'files');
  assert.equal(s.lastFile, 'a.py');
  s = reduceWorkbench(s, { type: 'flip' });
  assert.equal(s.dockTab, 'preview');
  s = reduceWorkbench(s, { type: 'flip' });
  assert.equal(s.dockTab, 'files');
  assert.equal(reduceWorkbench(initialWorkbench('w1'), { type: 'flip' }).dockTab, 'preview');

  // Another workspace's event, or a stale seq, never moves the pointer.
  assert.equal(reduceWorkbench(s, { type: 'file-changed', workspaceId: 'w2', seq: 9, path: 'b.py' }).lastFile, 'a.py');
  assert.equal(reduceWorkbench(s, { type: 'file-changed', workspaceId: 'w1', seq: 1, path: 'b.py' }).lastFile, 'a.py');

  // A dirty buffer pauses follow until the user resumes it explicitly.
  let d = reduceWorkbench(initialWorkbench('w1'), { type: 'dirty', value: true });
  assert.equal(d.follow, false);
  d = reduceWorkbench(d, { type: 'follow', value: true });
  assert.equal(d.follow, false);
  d = reduceWorkbench(reduceWorkbench(d, { type: 'dirty', value: false }), { type: 'follow', value: true });
  assert.equal(d.follow, true);
});

test('the dock tab group is reducible without the legacy view path', () => {
  let s = reduceWorkbench(initialWorkbench('w1'), { type: 'dock-tab', tab: 'files' });
  assert.equal(s.dockTab, 'files');
  s = reduceWorkbench(s, { type: 'dock-tab', tab: 'preview' });
  assert.equal(s.dockTab, 'preview');
  assert.equal(reduceWorkbench(s, { type: 'dock-tab', tab: 'nonsense' }).dockTab, 'preview');
  const closed = reduceWorkbench(initialWorkbench('w1'), { type: 'close-dock' });
  assert.equal(reduceWorkbench(closed, { type: 'dock-tab', tab: 'files' }).dockTab, 'preview');
});

test('reduceWorkbench never mutates its input', () => {
  let s = initialWorkbench('w1');
  s = resized(s, 'explorer', 300, VIEWPORT_DESKTOP);
  const before = JSON.stringify(s);
  const next = reduceWorkbench(s, { type: 'file-changed', workspaceId: 'w1', seq: 1, path: 'a.py' });
  assert.notEqual(next, s);
  assert.equal(JSON.stringify(s), before);
  assert.equal(next.layouts, s.layouts); // shared by reference, never mutated

  const other = switched(s, 'w2');
  assert.equal(JSON.stringify(s), before);
  assert.notEqual(other.layouts, s.layouts);
  assert.equal(other.layouts.w1.explorerWidth, 300);
});

test('the browser build attaches XavaniWorkbench to the global scope', () => {
  const src = fs.readFileSync(WB_STATE, 'utf8');
  const sandbox = {}; // no `module` — this is the <script> path index.html uses
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.equal(typeof sandbox.XavaniWorkbench.reduceWorkbench, 'function');
  assert.equal(sandbox.XavaniWorkbench.initialWorkbench('w1').explorerWidth, 240);
});

test('workbench.css carries the tokens, grid areas, and spec dimensions', () => {
  const css = fs.readFileSync(WB_CSS, 'utf8');
  for (const [name, value] of Object.entries({
    '--workbench-bg': '#0b1017',
    '--workbench-panel': '#111923',
    '--workbench-raised': '#182331',
    '--workbench-border': '#425368',
    '--workbench-text': '#e7edf5',
    '--workbench-muted': '#a9b6c6',
    '--workbench-accent': '#69adff',
    '--workbench-success': '#79d99e',
    '--workbench-warning': '#f0c36c',
    '--workbench-danger': '#ff9898',
  })) {
    assert.ok(css.includes(`${name}: ${value};`), `${name} must be ${value}`);
  }
  assert.match(css, /grid-template-areas:/);
  for (const area of WORKBENCH_REGIONS) {
    assert.match(css, new RegExp(`grid-area:\\s*${area}\\b`), `grid-area: ${area} is missing`);
    assert.match(css, new RegExp(`data-region="${area}"`), `region ${area} has no styling hook`);
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /role="separator"/);
});
