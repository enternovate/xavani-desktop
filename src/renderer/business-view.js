'use strict';

/* R2 Task 21 — business workspace view logic.

   Pure helpers for the Business dock tab: workflow requirement gating,
   section normalisation, and row formatting. The backend
   /desktop/api/business/state response is the single source of workflow
   capability — no control may claim a capability its backend lacks. */

(function expose(root) {
  function workflowById(stateData, id) {
    const list = (stateData && stateData.workflows) || [];
    return list.find((w) => w.id === id) || null;
  }

  function missingRequirements(workflow, values) {
    const needs = (workflow && workflow.needs) || [];
    const v = values || {};
    const missing = [];
    if (needs.includes('period') && !String(v.period || '').trim()) missing.push('period');
    if (needs.includes('currency') && !String(v.currency || '').trim()) missing.push('currency');
    return missing;
  }

  function runState(workflow, values) {
    const missing = missingRequirements(workflow, values);
    return {
      enabled: Boolean(workflow) && missing.length === 0,
      missing,
      note: missing.length ? `Blocked: missing ${missing.join(' and ')}.` : '',
    };
  }

  function normalizeState(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    return {
      workflows: Array.isArray(d.workflows) ? d.workflows : [],
      sources: Array.isArray(d.sources) ? d.sources : [],
      drafts: Array.isArray(d.drafts) ? d.drafts : [],
      checks: Array.isArray(d.checks) ? d.checks : [],
      approvals: Array.isArray(d.approvals) ? d.approvals : [],
      outstanding: Array.isArray(d.outstanding) ? d.outstanding : [],
    };
  }

  function sourceText(source) {
    const access = source && source.access ? source.access : 'Unavailable';
    return `${(source && source.name) || 'unknown'} — ${access}`;
  }

  function checkText(check) {
    const name = (check && check.name) || 'check';
    if (check && check.status === 'failed') {
      return (check.difference
        ? `${name}: failed — difference: ${check.difference}`
        : `${name}: failed`);
    }
    return `${name}: ${(check && check.status) || 'unknown'}`;
  }

  function approvalText(approval) {
    const a = approval || {};
    let line = `${a.operation || 'action'} → ${a.target || 'unknown target'}`;
    if (a.recipient) line += ` (recipient: ${a.recipient})`;
    line += ` — ${a.state || 'unknown'}`;
    return line;
  }

  const api = {
    workflowById,
    missingRequirements,
    runState,
    normalizeState,
    sourceText,
    checkText,
    approvalText,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XavaniBusiness = api;
})(globalThis);
