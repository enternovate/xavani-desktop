'use strict';

/* R2 Task 22 — work timeline view logic.

   Pure helpers: labels, ordering, row text, counts, and the read-only
   replay wrapper. Replay returns copies of the recorded events and can
   never dispatch anything. */

(function expose(root) {
  const LABELS = {
    'task.started': 'Task started',
    'skill.loaded': 'Skill loaded',
    'tool.started': 'Tool started',
    'tool.completed': 'Tool completed',
    'artifact.changed': 'Artifact changed',
    'verification.completed': 'Verification completed',
    'approval.requested': 'Approval requested',
    'approval.resolved': 'Approval resolved',
    'task.blocked': 'Task blocked',
    'task.completed': 'Task completed',
  };

  function sortedByTime(events) {
    return [...(events || [])].sort((a, b) => ((a && a.ts) || 0) - ((b && b.ts) || 0));
  }

  function eventTitle(event) {
    return LABELS[(event && event.type) || ''] || (event && event.type) || 'event';
  }

  function eventDetail(event) {
    const e = event || {};
    if (e.type === 'tool.started' || e.type === 'tool.completed' || e.type === 'artifact.changed') {
      let text = String(e.tool || 'tool');
      if (typeof e.duration === 'number') text += ` (${e.duration}s)`;
      if (e.error) text += ' — failed';
      return text;
    }
    if (e.type === 'skill.loaded') {
      const skills = typeof e.skills === 'number' ? ` (${e.skills} skills)` : '';
      return `${e.workflow || ''}${skills}`.trim();
    }
    if (e.type === 'verification.completed') return String(e.state || '');
    if (e.summary) return String(e.summary);
    if (e.state) return String(e.state);
    return '';
  }

  function summarize(events) {
    const counts = {};
    for (const event of events || []) {
      const key = (event && event.type) || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  function replayable(events) {
    // Read-only: copies for re-rendering; no execution path exists here.
    return sortedByTime(events).map((event) => ({ ...event }));
  }

  const api = { LABELS, sortedByTime, eventTitle, eventDetail, summarize, replayable };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XavaniTimeline = api;
})(globalThis);
