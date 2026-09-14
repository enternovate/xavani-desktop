'use strict';

/* R2 Task 14 — flip behavior and stability.
   Every Flip rule from the desktop specification plus the plan's eight
   required cases is asserted here: the reducer behavior directly, and the
   shell wiring (control markup, keyboard command, fade contract) with
   static checks. The DOM/viewport cases run under the Task 16 harness. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  initialWorkbench, reduceWorkbench, canFlip,
} = require('../../src/renderer/workbench-state');

const WB_CSS = path.join(__dirname, '../../src/renderer/workbench.css');
const WB_HTML = path.join(__dirname, '../../src/renderer/index.html');
const WB_APP = path.join(__dirname, '../../src/renderer/app.js');
const VIEWPORT = { width: 1440, height: 900 };

const changed = (s, seq, p, ws = 'w1') => reduceWorkbench(s, { type: 'file-changed', workspaceId: ws, seq, path: p, viewport: VIEWPORT });
const flip = (s) => reduceWorkbench(s, { type: 'flip' });

// ── 1. Preview → last changed file → the same preview ──

test('flip goes preview -> last changed file -> the same preview', () => {
  let s = initialWorkbench('w1');
  s = reduceWorkbench(s, { type: 'follow', value: false });
  assert.equal(s.dockTab, 'preview');
  s = changed(s, 1, 'src/a.py');
  assert.equal(s.dockTab, 'preview'); // follow is off, so no auto-switch

  s = flip(s);
  assert.equal(s.dockTab, 'files');
  assert.equal(s.lastFile, 'src/a.py');
  s = flip(s);
  assert.equal(s.dockTab, 'preview');
  s = flip(s);
  assert.equal(s.dockTab, 'files');
  assert.equal(s.lastFile, 'src/a.py'); // the pointer survives every round trip
});

// ── 2. No changed file ──

test('flip with no changed file is a no-op and canFlip is false', () => {
  const s = initialWorkbench('w1');
  assert.equal(canFlip(s), false);
  assert.equal(flip(s), s);
  assert.equal(flip(flip(s)).dockTab, 'preview');
});

// ── 3. A closed pane stays closed after a tool event ──

test('a closed pane stays closed after a tool event', () => {
  let s = reduceWorkbench(initialWorkbench('w1'), { type: 'close-dock' });
  s = changed(s, 1, 'src/a.py');
  assert.equal(s.dockOpen, false);
  assert.equal(s.dockTab, 'preview');
  assert.equal(canFlip(s), false); // a closed dock cannot be flipped into
  assert.equal(flip(s), s); // flip never reopens it
});

// ── 4. A dirty editor disables automatic following ──

test('a dirty editor disables automatic following but keeps the pointer fresh', () => {
  let s = reduceWorkbench(initialWorkbench('w1'), { type: 'dirty', value: true });
  assert.equal(s.follow, false);
  s = changed(s, 1, 'src/a.py');
  assert.equal(s.dockTab, 'preview'); // no auto-switch while the buffer is dirty
  assert.equal(s.lastFile, 'src/a.py'); // the flip target still updates
  assert.equal(canFlip(s), true);
});

// ── 5. Follow resumes only after a user action ──

test('follow resumes only after an explicit user action', () => {
  let s = reduceWorkbench(initialWorkbench('w1'), { type: 'dirty', value: true });
  s = reduceWorkbench(s, { type: 'dirty', value: false });
  assert.equal(s.follow, false); // clearing dirty does not resume by itself
  s = reduceWorkbench(s, { type: 'follow', value: true });
  assert.equal(s.follow, true);

  // The follow action can never override a dirty buffer.
  let d = reduceWorkbench(initialWorkbench('w1'), { type: 'dirty', value: true });
  d = reduceWorkbench(d, { type: 'follow', value: true });
  assert.equal(d.follow, false);
});

// ── 6. An older file event does not replace the latest file ──

test('an older file event does not replace the latest file', () => {
  let s = changed(initialWorkbench('w1'), 3, 'src/three.py');
  s = changed(s, 2, 'src/two.py');
  assert.equal(s.lastFile, 'src/three.py');
  s = changed(s, 3, 'src/three-again.py');
  assert.equal(s.lastFile, 'src/three.py'); // an equal seq is stale too
  s = changed(s, 99, 'src/other-workspace.py', 'w2');
  assert.equal(s.lastFile, 'src/three.py'); // another workspace never moves it
});

// ── 7. A workspace switch clears the previous workspace's file pointer ──

test('a workspace switch clears the previous file pointer', () => {
  let s = changed(initialWorkbench('w1'), 1, 'src/a.py');
  s = reduceWorkbench(s, { type: 'workspace', workspaceId: 'w2', viewport: VIEWPORT });
  assert.equal(s.lastFile, null);
  assert.equal(canFlip(s), false);
  s = reduceWorkbench(s, { type: 'workspace', workspaceId: 'w1', viewport: VIEWPORT });
  assert.equal(s.lastFile, null); // pointers never survive a switch, either way
});

// ── Contract: flip is disabled during a workspace transition ──

test('flip is disabled during a workspace transition', () => {
  let s = changed(initialWorkbench('w1'), 1, 'src/a.py');
  s = reduceWorkbench(s, { type: 'transition', value: true });
  assert.equal(canFlip(s), false);
  assert.equal(flip(s), s);
  s = reduceWorkbench(s, { type: 'transition', value: false });
  assert.equal(canFlip(s), true);
  assert.equal(flip(s).dockTab, 'preview');
});

// ── 8. Reduced motion removes the transition ──

test('the flip fade is a 120 ms opacity animation that reduced motion removes', () => {
  const css = fs.readFileSync(WB_CSS, 'utf8');
  assert.match(css, /\.wb-flip-fade\s*{[^}]*animation:[^;]*var\(--workbench-motion\)/);
  assert.match(css, /@keyframes wb-flip-fade\s*{[^}]*from\s*{\s*opacity:\s*0;\s*}[^}]*to\s*{\s*opacity:\s*1;\s*}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /animation-duration:\s*0s\s*!important/);
});

// ── Wiring: the visible control and the keyboard command ──

test('index.html ships the visible flip control', () => {
  const html = fs.readFileSync(WB_HTML, 'utf8');
  assert.match(html, /id="dock-flip"/);
  assert.match(html, /Preview \/ Files/);
  assert.match(html, /⌘⌥F|Cmd\+Alt\+F/);
});

test('app.js wires the flip keyboard command through the reducer', () => {
  const js = fs.readFileSync(WB_APP, 'utf8');
  assert.match(js, /e\.altKey\s*&&\s*\(e\.metaKey\s*\|\|\s*e\.ctrlKey\)\s*&&\s*e\.code\s*===\s*'KeyF'/);
  assert.match(js, /\{\s*type:\s*'flip'\s*\}/);
  // The visible control itself must be wired, not just present.
  assert.match(js, /flipBtn\.addEventListener\('click',\s*\(\)\s*=>\s*dockFlip\(\)\)/);
});
