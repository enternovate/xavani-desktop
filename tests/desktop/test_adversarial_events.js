'use strict';

/* R1 Task 28a — adversarial corpus for the desktop run-event surface.
 *
 * Methodology: every case here is an executable attack against the shipped
 * defenses (commit b5e3c15 plus d672851's identity-keyed consumption), and
 * every case ASSERTS THE DEFENSE HOLDS. A failing case is a finding, left
 * exactly as-is and reported with its severity — never softened to go green.
 * Surface: high (a mis-rendered run is a lie about what the agent did).
 *
 * Two targets per case, both pure and offline — no network, no model, no
 * Electron binary:
 *   1. src/renderer/run-state.js   — the reducer that folds every parsed event.
 *   2. src/renderer/app.js         — the consumption contract around it. The
 *      card-selection expression is lifted VERBATIM out of app.js and executed,
 *      so this pins the production predicate, not a re-implementation.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { initialRunState, applyRunEvent, endRunStream } = require('../../src/renderer/run-state');

const RUN = 'run_abc123';
const OTHER_RUN = 'run_zzz999';

function started(seq, id, over = {}) {
  return { event: 'tool.started', run_id: RUN, seq, tool_call_id: id, tool: 'read_file', ...over };
}
function completed(seq, id, over = {}) {
  return { event: 'tool.completed', run_id: RUN, seq, tool_call_id: id, tool: 'read_file', ...over };
}

/* ------------------------------------------------------------------ *
 * app.js as the source of truth
 * ------------------------------------------------------------------ */

const APP_JS = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');

/* The real card-selection expression from app.js's `tool.completed` branch,
 * executed under a `new Function` so the assertion covers production code. */
function loadCardSelector() {
  const start = APP_JS.indexOf('const id = typeof evt.tool_call_id');
  assert.ok(start > -1, 'app.js tool.completed card selection was not found');
  const end = APP_JS.indexOf('if (card) {', start);
  assert.ok(end > start, 'app.js tool.completed branch terminator was not found');
  const body = APP_JS.slice(start, end);
  assert.match(body, /toolCards\.get\(id\)/, 'app.js no longer selects by identity');
  return new Function('evt', 'toolCards', 'toolsBox', `${body}; return card;`);
}

/* ------------------------------------------------------------------ *
 * duplicated seq
 * ------------------------------------------------------------------ */

test('test_attack_events_duplicated_seq_is_ignored_in_both_directions', () => {
  let s = initialRunState(RUN);
  s = applyRunEvent(s, started(1, 'call_a'));
  s = applyRunEvent(s, completed(2, 'call_a'));

  // A duplicate of a seq already applied: same seq, hostile body.
  const before = JSON.stringify(s);
  const replayed = applyRunEvent(s, completed(2, 'call_a', { error: true }));
  assert.equal(JSON.stringify(replayed), before);
  assert.equal(replayed.tools.call_a.status, 'completed');
  assert.equal(replayed.seq, 2);

  // A duplicate that would create a NEW card: still ignored.
  const injected = applyRunEvent(s, started(2, 'call_injected'));
  assert.equal(injected.tools.call_injected, undefined);
  assert.equal(JSON.stringify(injected), before);

  // A duplicate terminal event is a no-op (state object identity preserved).
  let t = applyRunEvent(initialRunState(RUN),
    { event: 'run.completed', run_id: RUN, seq: 4, verification_state: 'verified' });
  assert.equal(applyRunEvent(t, { event: 'run.failed', run_id: RUN, seq: 4 }), t);
  assert.equal(t.status, 'completed');
  assert.equal(t.verification, 'verified');
});

/* ------------------------------------------------------------------ *
 * gapped seq
 * ------------------------------------------------------------------ */

test('test_attack_events_gapped_seq_is_monotonic_and_reorders_are_dropped', () => {
  let s = initialRunState(RUN);
  s = applyRunEvent(s, started(1, 'call_a'));
  // A gap: the stream skipped 2..4. It must be accepted, not treated as a
  // tamper — and it must raise the watermark so a late replay cannot land.
  s = applyRunEvent(s, started(5, 'call_b'));
  assert.equal(s.seq, 5);
  assert.equal(s.tools.call_b.status, 'active');

  const before = JSON.stringify(s);
  for (const late of [2, 3, 4, 5]) {
    const next = applyRunEvent(s, completed(late, 'call_b', { error: true }));
    assert.equal(JSON.stringify(next), before, `late seq ${late} changed state`);
  }
  assert.equal(s.tools.call_b.status, 'active');

  // The watermark advances again on the next real event.
  s = applyRunEvent(s, completed(6, 'call_b'));
  assert.equal(s.seq, 6);
  assert.equal(s.tools.call_b.status, 'completed');
});

/* ------------------------------------------------------------------ *
 * foreign run_id
 * ------------------------------------------------------------------ */

test('test_attack_events_foreign_run_id_injection_is_ignored', () => {
  let s = applyRunEvent(initialRunState(RUN), started(1, 'call_a'));
  const before = JSON.stringify(s);

  const hostile = [
    { event: 'tool.started', run_id: OTHER_RUN, seq: 2, tool_call_id: 'call_x' },
    { event: 'tool.completed', run_id: OTHER_RUN, seq: 3, tool_call_id: 'call_a', error: true },
    { event: 'run.completed', run_id: OTHER_RUN, seq: 4, verification_state: 'verified' },
    { event: 'run.completed', run_id: OTHER_RUN, seq: 5 },
    { event: 'tool.started', run_id: '', seq: 6, tool_call_id: 'call_y' },
  ];
  for (const evt of hostile) {
    s = applyRunEvent(s, evt);
  }
  assert.equal(JSON.stringify(s), before);
  assert.equal(s.status, 'running');
  assert.equal(s.tools.call_a.status, 'active');

  // Documented residual, asserted so a change of behavior is noticed: an event
  // with NO run_id at all is treated as ours (the reducer cannot prove
  // otherwise from the stream it is handed). It therefore CAN apply.
  const anonymous = applyRunEvent(s, { event: 'tool.started', seq: 7, tool_call_id: 'call_anon' });
  assert.equal(anonymous.tools.call_anon.status, 'active');
});

/* ------------------------------------------------------------------ *
 * tool id collision
 * ------------------------------------------------------------------ */

test('test_attack_events_tool_id_collision_never_lands_on_the_wrong_card', () => {
  let s = initialRunState(RUN);
  s = applyRunEvent(s, started(1, 'call_a'));
  s = applyRunEvent(s, started(2, 'call_b'));

  // One completion for call_b: call_a must stay active (the reverse-order case
  // the identity keying exists for).
  s = applyRunEvent(s, completed(3, 'call_b', { error: true }));
  assert.equal(s.tools.call_b.status, 'failed');
  assert.equal(s.tools.call_a.status, 'active');

  // An UNKNOWN id completes: it must not close call_a.
  s = applyRunEvent(s, completed(4, 'call_unknown'));
  assert.equal(s.tools.call_a.status, 'active');
  assert.equal(s.tools.call_unknown.status, 'completed');

  // A completion for call_a still works afterwards.
  s = applyRunEvent(s, completed(5, 'call_a'));
  assert.equal(s.tools.call_a.status, 'completed');

  // Two starts on the SAME id: the second is not a new card, and the id keeps
  // its identity (deterministic last-start-wins on status only).
  let c = applyRunEvent(initialRunState(RUN), started(1, 'call_dup', { tool: 'read_file' }));
  c = applyRunEvent(c, started(2, 'call_dup', { tool: 'write_file' }));
  assert.equal(c.tools.call_dup.status, 'active');
  assert.equal(c.tools.call_dup.tool, 'write_file');
  assert.deepEqual(Object.keys(c.tools), ['call_dup']);
});

test('test_attack_events_app_js_unknown_id_does_not_touch_the_last_card', () => {
  const selectCard = loadCardSelector();
  const cardA = { name: 'cardA' };
  const cardB = { name: 'cardB' };
  const cards = new Map([['call_a', cardA], ['call_b', cardB]]);
  // The last card in the tools box is call_b (the most recent start).
  const toolsBox = { lastElementChild: cardB, children: [cardA, cardB] };

  // Known id: the exact card.
  assert.equal(selectCard({ tool_call_id: 'call_b' }, cards, toolsBox), cardB);
  assert.equal(selectCard({ tool_call_id: 'call_a' }, cards, toolsBox), cardA);

  // Unknown id: null. It must NOT fall through to the last card, and a
  // hostile `_card` on the event must not be honoured while an id is present.
  assert.equal(selectCard({ tool_call_id: 'call_unknown' }, cards, toolsBox), null);
  assert.equal(selectCard({ tool_call_id: 'call_unknown', _card: cardB }, cards, toolsBox), null);
  assert.equal(selectCard({ tool_call_id: '' }, cards, toolsBox), cardB); // no id: documented fallback
  assert.equal(selectCard({ tool_call_id: 42 }, cards, toolsBox), cardB); // non-string id: fallback

  // A non-string id in the reducer is ignored outright (no card is created
  // from it), so the two layers agree on what an identity is.
  let s = applyRunEvent(initialRunState(RUN), started(1, 'call_a'));
  s = applyRunEvent(s, completed(2, 42));
  assert.equal(s.tools.call_a.status, 'active');
  assert.deepEqual(Object.keys(s.tools), ['call_a']);
});

/* ------------------------------------------------------------------ *
 * replayed terminal event
 * ------------------------------------------------------------------ */

test('test_attack_events_replayed_terminal_event_cannot_flip_a_finished_run', () => {
  let s = applyRunEvent(initialRunState(RUN),
    { event: 'run.completed', run_id: RUN, seq: 3, verification_state: 'verified' });
  assert.equal(s.status, 'completed');

  // Every terminal event replayed at or below the watermark is a no-op —
  // including one that would downgrade verified -> unverified.
  for (const evt of [
    { event: 'run.completed', run_id: RUN, seq: 3, verification_state: 'verified' },
    { event: 'run.completed', run_id: RUN, seq: 3 },
    { event: 'run.interrupted', run_id: RUN, seq: 1 },
    { event: 'run.failed', run_id: RUN, seq: 3, verification_state: 'unverified' },
    { event: 'run.cancelled', run_id: RUN, seq: 2 },
  ]) {
    const next = applyRunEvent(s, evt);
    assert.equal(next, s, JSON.stringify(evt));
  }
  assert.equal(endRunStream(s), s); // EOF after a terminal event changes nothing

  // A terminal event at a HIGHER seq is applied: the reducer has no second
  // source of truth for "the run already ended". Documented residual.
  const later = applyRunEvent(s, { event: 'run.failed', run_id: RUN, seq: 9 });
  assert.equal(later.status, 'failed');
});

test('test_attack_events_endRunStream_never_reports_success_for_a_dropped_stream', () => {
  // A stream cut after partial output: unknown, not success.
  let s = applyRunEvent(initialRunState(RUN), started(1, 'call_a'));
  s = applyRunEvent(s, { event: 'message.delta', run_id: RUN, seq: 2, delta: 'partial' });
  s = endRunStream(s);
  assert.equal(s.status, 'interrupted');
  assert.notEqual(s.status, 'completed');
  assert.equal(s.tools.call_a.status, 'active'); // the unfinished tool stays unfinished

  // Cut before ANY event.
  assert.equal(endRunStream(initialRunState(RUN)).status, 'interrupted');
  // Cut after only tool events, no terminal: still unknown.
  let t = applyRunEvent(initialRunState(RUN), completed(1, 'call_a'));
  assert.equal(endRunStream(t).status, 'interrupted');
  // A hostile non-object state must not throw.
  assert.equal(endRunStream(null), null);
  assert.equal(endRunStream(undefined), undefined);
});

/* ------------------------------------------------------------------ *
 * malformed seq types
 * ------------------------------------------------------------------ */

test('test_attack_events_malformed_seq_types_degrade_deterministically', () => {
  const cases = [
    // value, watermarks, appliedCardExpected
    ['5', 0, true],
    [NaN, 0, true],
    [null, 0, true],
    [undefined, 0, true],
    [Infinity, 0, true],
    [-Infinity, 0, true],   // non-finite: no dedup possible, so accepted
    [true, 0, true],
    [[7], 0, true],
    [{}, 0, true],
    ['', 0, true],
    [-1, 0, false],
    [0, 0, false],
  ];
  for (const [seq, expectedWatermark, applies] of cases) {
    let s = initialRunState(RUN);
    s = applyRunEvent(s, { event: 'tool.started', run_id: RUN, seq, tool_call_id: 'call_x', tool: 't' });
    // A seq that is not a finite number cannot de-duplicate, so the event is
    // accepted and the watermark is left alone (never corrupted to NaN/string).
    assert.equal(s.seq, expectedWatermark, `seq ${String(seq)} corrupted the watermark`);
    assert.ok(Number.isInteger(s.seq), `seq ${String(seq)} left a non-integer watermark`);
    if (applies) {
      assert.equal(s.tools.call_x.status, 'active', `seq ${String(seq)} was dropped`);
    } else {
      assert.equal(s.tools.call_x, undefined, `seq ${String(seq)} was wrongly applied`);
    }
  }

  // A malformed seq on a terminal event degrades the same way: applied, and the
  // watermark is not overwritten with junk.
  let s = applyRunEvent(initialRunState(RUN),
    { event: 'run.completed', run_id: RUN, seq: 'not-a-number', verification_state: 'verified' });
  assert.equal(s.status, 'completed');
  assert.equal(s.seq, 0);
  assert.equal(s.verification, 'verified');

  // sequence_number is the legacy alias: a finite one is honoured, and a NaN
  // alias does not shadow a usable seq.
  let a = applyRunEvent(initialRunState(RUN),
    { event: 'tool.started', run_id: RUN, sequence_number: 3, tool_call_id: 'call_a' });
  assert.equal(a.seq, 3);
  let b = applyRunEvent(initialRunState(RUN),
    { event: 'tool.started', run_id: RUN, sequence_number: NaN, seq: 2, tool_call_id: 'call_b' });
  assert.equal(b.seq, 2);
});

test('test_attack_events_tool_events_without_identity_are_refused', () => {
  const before = JSON.stringify(initialRunState(RUN));
  for (const evt of [
    { event: 'tool.started', run_id: RUN, seq: 1, tool: 'read_file' },
    { event: 'tool.completed', run_id: RUN, seq: 2, tool: 'read_file' },
    { event: 'tool.started', run_id: RUN, seq: 3, tool_call_id: '' },
    { event: 'tool.completed', run_id: RUN, seq: 4, tool_call_id: '' },
    { event: 'tool.started', run_id: RUN, seq: 5, tool_call_id: {} },
    { event: 'tool.completed', run_id: RUN, seq: 6, tool_call_id: ['x'] },
    { event: 'tool.completed', run_id: RUN, seq: 7, tool_call_id: 0 },
  ]) {
    const next = applyRunEvent(initialRunState(RUN), evt);
    assert.equal(JSON.stringify(next), before, JSON.stringify(evt));
  }
  // Non-object input never throws and never fabricates state.
  assert.equal(applyRunEvent(initialRunState(RUN), null).status, 'running');
  assert.equal(applyRunEvent(initialRunState(RUN), 'tool.completed').status, 'running');
  assert.equal(applyRunEvent(initialRunState(RUN), 42).status, 'running');
  assert.equal(applyRunEvent(undefined, started(1, 'call_a')), undefined);
});

/* ------------------------------------------------------------------ *
 * app.js consumption contract
 * ------------------------------------------------------------------ */

test('test_attack_events_app_js_contract_folds_every_event_and_flags_a_cut_stream', () => {
  // Every parsed event goes through the reducer before the render switch.
  assert.match(APP_JS, /runState = window\.XavaniRunState\.applyRunEvent\(runState, evt\);/);
  const foldAt = APP_JS.indexOf('applyRunEvent(runState, evt);');
  const switchAt = APP_JS.indexOf('switch (evt.event)', foldAt);
  assert.ok(switchAt > foldAt, 'the reducer must run before the render switch');

  // Tool starts are registered by identity, not by order.
  assert.match(APP_JS, /toolCards\.set\(evt\.tool_call_id, card\);/);
  assert.match(APP_JS, /const card = id\s*\n?\s*\? \(toolCards\.get\(id\) \|\| null\)/);

  // The stream tail marks an unresolved run, and the warning is gated on it.
  assert.match(APP_JS, /runState = window\.XavaniRunState\.endRunStream\(runState\);/);
  assert.match(APP_JS, /if \(runState\.status !== 'interrupted'\) return;/);
  const endAt = APP_JS.indexOf('endRunStream(runState);');
  const noteAt = APP_JS.indexOf('noteStreamInterrupted();', endAt);
  assert.ok(noteAt > endAt, 'the interruption note must follow endRunStream');

  // The reducer's own contract, exercised end to end: a cut stream after a
  // pending tool call must never read as success.
  let s = applyRunEvent(initialRunState(RUN), started(1, 'call_a'));
  s = endRunStream(s);
  assert.equal(s.status, 'interrupted');
  assert.notEqual(s.status, 'completed');
});
