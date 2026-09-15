'use strict';

/* R1 Task 10b — run-state consumption by identity.
   The desktop run view must key tool cards by tool_call_id and must never
   treat a dropped SSE stream as a successful run. These tests pin the pure
   reducer that app.js feeds every parsed run event through. */

const test = require('node:test');
const assert = require('node:assert');

const { initialRunState, applyRunEvent, endRunStream } = require('../../src/renderer/run-state');

const RUN = 'run_abc123';
const OTHER_RUN = 'run_zzz999';

function started(seq, id, over = {}) {
  return { event: 'tool.started', run_id: RUN, seq, tool_call_id: id, tool: 'read_file', ...over };
}
function completed(seq, id, over = {}) {
  return { event: 'tool.completed', run_id: RUN, seq, tool_call_id: id, tool: 'read_file', ...over };
}

test('initialRunState starts running, unverified, with no tools', () => {
  const s = initialRunState(RUN);
  assert.equal(s.runId, RUN);
  assert.equal(s.seq, 0);
  assert.equal(s.status, 'running');
  assert.equal(s.verification, 'unverified');
  assert.deepEqual(s.tools, {});
});

test('opposite completion order keeps per-id identity', () => {
  let s = initialRunState(RUN);
  s = applyRunEvent(s, started(1, 'call_a'));
  s = applyRunEvent(s, started(2, 'call_b'));
  assert.equal(s.tools.call_a.status, 'active');
  assert.equal(s.tools.call_b.status, 'active');

  // B finishes first: A must stay active, B must not bleed onto A.
  s = applyRunEvent(s, completed(3, 'call_b'));
  assert.equal(s.tools.call_b.status, 'completed');
  assert.equal(s.tools.call_a.status, 'active');

  s = applyRunEvent(s, completed(4, 'call_a'));
  assert.equal(s.tools.call_a.status, 'completed');
  assert.equal(s.tools.call_b.status, 'completed');
});

test('tool.completed with error marks that id failed', () => {
  let s = initialRunState(RUN);
  s = applyRunEvent(s, started(1, 'call_a'));
  s = applyRunEvent(s, started(2, 'call_b'));
  s = applyRunEvent(s, completed(3, 'call_b', { error: true }));
  assert.equal(s.tools.call_b.status, 'failed');
  assert.equal(s.tools.call_a.status, 'active');
});

test('tool events without a tool_call_id are ignored', () => {
  let s = initialRunState(RUN);
  s = applyRunEvent(s, { event: 'tool.started', run_id: RUN, seq: 1, tool: 'read_file' });
  s = applyRunEvent(s, started(2, ''));
  assert.deepEqual(s.tools, {});
  assert.equal(s.seq, 0);
});

test('duplicate seq is a no-op', () => {
  let s = initialRunState(RUN);
  s = applyRunEvent(s, started(1, 'call_a'));
  const afterFirst = s;
  s = applyRunEvent(s, started(1, 'call_b'));
  assert.equal(s.seq, afterFirst.seq);
  assert.equal(s.tools.call_b, undefined);
  assert.equal(s.tools.call_a.status, 'active');

  // A replayed out-of-order (lower seq) event is also a no-op.
  s = applyRunEvent(s, completed(1, 'call_a', { error: true }));
  assert.equal(s.tools.call_a.status, 'active');
});

test('unknown run_id is a no-op', () => {
  let s = initialRunState(RUN);
  s = applyRunEvent(s, started(1, 'call_a'));
  const before = JSON.stringify(s);
  s = applyRunEvent(s, { event: 'tool.started', run_id: OTHER_RUN, seq: 2, tool_call_id: 'call_x' });
  s = applyRunEvent(s, { event: 'run.completed', run_id: OTHER_RUN, seq: 3, verification_state: 'verified' });
  assert.equal(JSON.stringify(s), before);
  assert.equal(s.status, 'running');
});

test('run.completed sets status and carries verification_state', () => {
  let s = initialRunState(RUN);
  s = applyRunEvent(s, started(1, 'call_a'));
  s = applyRunEvent(s, completed(2, 'call_a'));
  s = applyRunEvent(s, { event: 'run.completed', run_id: RUN, seq: 3, verification_state: 'verified' });
  assert.equal(s.status, 'completed');
  assert.equal(s.verification, 'verified');
  assert.equal(s.seq, 3);
});

test('a terminal event without verification_state defaults to unverified', () => {
  let s = initialRunState(RUN);
  s = applyRunEvent(s, { event: 'run.completed', run_id: RUN, seq: 1 });
  assert.equal(s.status, 'completed');
  assert.equal(s.verification, 'unverified');
});

test('run.failed / run.cancelled / run.interrupted set their status', () => {
  const cases = [
    ['run.failed', 'failed'],
    ['run.cancelled', 'cancelled'],
    ['run.interrupted', 'interrupted'],
  ];
  for (const [event, status] of cases) {
    let s = initialRunState(RUN);
    s = applyRunEvent(s, { event, run_id: RUN, seq: 1, verification_state: 'unverified' });
    assert.equal(s.status, status, event);
  }
});

test('endRunStream after EOF without a terminal event returns interrupted', () => {
  let s = initialRunState(RUN);
  s = applyRunEvent(s, started(1, 'call_a'));
  s = applyRunEvent(s, { event: 'message.delta', run_id: RUN, seq: 2, delta: 'partial' });
  s = endRunStream(s);
  assert.equal(s.status, 'interrupted');
  // The tool that never completed must not be reported as done.
  assert.equal(s.tools.call_a.status, 'active');
});

test('endRunStream leaves an already-terminal run alone', () => {
  let s = applyRunEvent(initialRunState(RUN), { event: 'run.completed', run_id: RUN, seq: 1, verification_state: 'verified' });
  s = endRunStream(s);
  assert.equal(s.status, 'completed');
  assert.equal(s.verification, 'verified');
});

test('applyRunEvent returns a new state without mutating the input', () => {
  const s = initialRunState(RUN);
  const before = JSON.stringify(s);
  const next = applyRunEvent(s, started(1, 'call_a'));
  assert.notEqual(next, s);
  assert.equal(JSON.stringify(s), before);
  assert.equal(next.tools.call_a.status, 'active');
});

test('the browser build attaches XavaniRunState to the global scope', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/run-state.js'), 'utf8');
  const sandbox = {}; // no `module` — this is the <script> path app.js relies on
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.equal(typeof sandbox.XavaniRunState.initialRunState, 'function');
  assert.equal(sandbox.XavaniRunState.initialRunState(RUN).status, 'running');
});
