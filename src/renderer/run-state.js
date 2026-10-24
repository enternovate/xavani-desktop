'use strict';

/* Run-event reducer for the desktop run view (R1 Task 10b).
 *
 * Two jobs, both about honesty under a hostile/failing stream:
 *  1. Identity: tool cards are keyed by tool_call_id, so completions that
 *     arrive out of order still land on the right card, and replayed or
 *     out-of-order events (seq) never double-apply.
 *  2. Interruption: when the SSE reader ends without a terminal run event,
 *     the run is *unknown*, not successful — endRunStream() says so.
 *
 * Pure and dependency-free so it is unit-testable under `node --test`.
 * Loaded as a plain <script> in the renderer (root.XavaniRunState) and via
 * require() in tests. */

(function (root) {
  const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

  const TOOL_EVENTS = new Set(['tool.started', 'tool.completed']);

  const TERMINAL_EVENTS = {
    'run.completed': 'completed',
    'run.failed': 'failed',
    'run.cancelled': 'cancelled',
    'run.interrupted': 'interrupted',
  };

  /** Fresh state for a run that has not reported anything yet. */
  function initialRunState(runId) {
    return {
      runId,
      seq: 0,
      status: 'running',
      verification: 'unverified',
      tools: {},
    };
  }

  /* Sequence number of an event. The desktop run stream stamps `seq`; older
     streams only carry the Responses-API `sequence_number`. Returns null when
     neither is a finite number — such an event cannot be de-duplicated, so it
     is accepted rather than silently dropped. */
  function eventSeq(event) {
    if (typeof event.seq === 'number' && Number.isFinite(event.seq)) return event.seq;
    if (typeof event.sequence_number === 'number' && Number.isFinite(event.sequence_number)) {
      return event.sequence_number;
    }
    return null;
  }

  function verificationOf(event) {
    const v = event.verification_state;
    return typeof v === 'string' && v !== '' ? v : 'unverified';
  }

  /**
   * Fold one parsed run event into the state.
   *
   * Ignored (state returned unchanged): events belonging to a different
   * run_id, duplicate/out-of-order events (seq <= state.seq), tool events
   * without a nonempty string tool_call_id, and malformed input.
   * Otherwise a NEW state object is returned; the input is never mutated.
   */
  function applyRunEvent(state, event) {
    if (!state || typeof state !== 'object') return state;
    if (!event || typeof event !== 'object') return state;

    // A run_id that is present and different is never ours.
    if (event.run_id != null && state.runId != null && event.run_id !== state.runId) {
      return state;
    }

    const seq = eventSeq(event);
    if (seq != null && seq <= state.seq) return state; // replayed or stale

    const isTool = TOOL_EVENTS.has(event.event);
    if (isTool && (typeof event.tool_call_id !== 'string' || event.tool_call_id === '')) {
      return state; // no identity to key the card on — refuse to guess
    }

    const next = Object.assign({}, state, { tools: Object.assign({}, state.tools) });
    if (seq != null) next.seq = seq;

    if (isTool) {
      const id = event.tool_call_id;
      const prev = state.tools[id] || {};
      next.tools[id] = {
        id,
        tool: event.tool != null ? event.tool : (prev.tool != null ? prev.tool : null),
        path: event.path != null ? event.path : (prev.path != null ? prev.path : null),
        status: event.event === 'tool.started' ? 'active' : (event.error ? 'failed' : 'completed'),
      };
      return next;
    }

    const terminal = TERMINAL_EVENTS[event.event];
    if (terminal) {
      next.status = terminal;
      next.verification = verificationOf(event);
    }
    return next;
  }

  /**
   * The stream ended. If the run already reported a terminal status, this is
   * a no-op; otherwise the outcome is unknown — mark it interrupted so the
   * view never renders a dropped stream as success.
   */
  function endRunStream(state) {
    if (!state || typeof state !== 'object') return state;
    if (TERMINAL_STATUSES.has(state.status)) return state;
    return Object.assign({}, state, { status: 'interrupted' });
  }

  const api = { initialRunState, applyRunEvent, endRunStream };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XavaniRunState = api;
})(globalThis);
