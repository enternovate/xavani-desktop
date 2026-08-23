'use strict';

/* global marked, DOMPurify */

const $ = (sel) => document.querySelector(sel);

const state = {
  apiPort: null,
  desktopPort: null,
  sessionId: null,
  running: false,
  currentController: null,
  currentRunId: null,
  messages: [],
  status: null,
  activeView: 'chat',
  activeSessionItem: null,
  cliCommands: [],
  showCli: false,
  lastSessions: [],
  providers: [],
  prefs: { effort: 'medium', fast_mode: false, fast_supported: false },
};

const api = (p, opts) => fetch(`http://127.0.0.1:${state.apiPort}${p}`, opts);
const dapi = (p, opts) => fetch(`http://127.0.0.1:${state.desktopPort}${p}`, opts);

function toast(msg, ms = 4000) {
  let el = document.querySelector('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ---------------- notification stack ---------------- */

function notify(message, { kind = 'info', onClick = null, ms = 6000 } = {}) {
  const stack = document.querySelector('#notif-stack');
  if (!stack) return;
  const note = document.createElement('div');
  note.className = `notif notif-${kind}`;
  note.textContent = message;
  if (onClick) {
    note.style.cursor = 'pointer';
    note.addEventListener('click', () => { onClick(); dismiss(); });
  }
  stack.appendChild(note);
  requestAnimationFrame(() => note.classList.add('show'));
  function dismiss() {
    note.classList.remove('show');
    setTimeout(() => note.remove(), 300);
  }
  setTimeout(dismiss, ms);
}

/* ---------------- ambient activity pill ---------------- */

const ACTIVITY_POLL_MS = 20000;

async function pollActivity() {
  try {
    const res = await dapi('/desktop/api/activity');
    const d = await res.json();
    renderActivity(d.activities || []);
  } catch {
    renderActivity([]);
  }
}

function renderActivity(activities) {
  const pill = document.querySelector('#activity-pill');
  if (!pill) return;
  if (!activities.length) {
    pill.classList.add('hidden');
    pill.textContent = '';
    return;
  }
  const first = activities[0];
  const extra = activities.length > 1 ? ` +${activities.length - 1} more` : '';
  pill.innerHTML = `<span class="activity-dot"></span>${escapeHtml(first.label)}${escapeHtml(extra)}`;
  pill.classList.remove('hidden');
}

function startActivityPolling() {
  pollActivity();
  setInterval(pollActivity, ACTIVITY_POLL_MS);
}

/* ---------------- outstanding-work reminders ---------------- */

const OUTSTANDING_POLL_MS = 30 * 60 * 1000;

async function checkOutstanding() {
  try {
    const res = await dapi('/desktop/api/outstanding');
    const d = await res.json();
    const items = d.items || [];
    if (!items.length) return;
    notify(
      `You have ${items.length} outstanding item(s) from earlier sessions.`,
      {
        kind: 'info',
        ms: 12000,
        onClick: () => {
          if (!$('#app').classList.contains('dock-open')) $('#dock-toggle').click();
          document.querySelector('#tab-todo').click();
        },
      },
    );
  } catch {}
}

function startOutstandingReminders() {
  checkOutstanding();
  setInterval(checkOutstanding, OUTSTANDING_POLL_MS);
}

/* ---------------- boot ---------------- */

window.__errs = window.__errs || [];
window.addEventListener('error', (e) => { window.__errs.push(String(e.message || e)); });
window.addEventListener('unhandledrejection', (e) => { window.__errs.push(`unhandled: ${e.reason}`); });

let booted = false;

window.xavaniDesktop.onBackendReady(({ apiPort, desktopPort }) => {
  if (booted) return;
  booted = true;
  state.apiPort = apiPort;
  state.desktopPort = desktopPort;
  $('#boot').classList.add('hidden');
  $('#app').classList.remove('hidden');
  init();
});

window.xavaniDesktop.onBackendExit((info) => {
  const sub = $('#boot-sub');
  $('#app').classList.add('hidden');
  const boot = $('#boot');
  boot.classList.remove('hidden');
  sub.textContent = info && info.error ? String(info.error) : 'Engine stopped unexpectedly.';
  sub.classList.add('error');
  $('#boot-restart').classList.remove('hidden');
});

$('#boot-restart').addEventListener('click', () => {
  $('#boot-sub').textContent = 'Restarting engine…';
  $('#boot-sub').classList.remove('error');
  $('#boot-restart').classList.add('hidden');
  window.xavaniDesktop.restartBackend();
});

/* ---------------- init ---------------- */

async function init() {
  const rt = await window.xavaniDesktop.runtime();
  if (rt.platform === 'darwin') document.body.classList.add('mac');
  $('#brand-ver').textContent = rt.backend ? `v${rt.backend.engine_version}` : '';

  renderMessages();

  await refreshStatus();
  await refreshSessions();
  dapi('/desktop/api/cli/commands').then((r) => r.json()).then((d) => {
    state.cliCommands = d.commands || [];
    buildChips();
  }).catch(() => {});
  dapi('/desktop/api/commands').then((r) => r.json()).then((d) => {
    const known = new Set(state.cliCommands.map((c) => c.name));
    const registry = (d.commands || [])
      .filter((c) => !known.has(c.name))
      .map((c) => ({ name: c.name, desc: c.desc || c.args_hint || '', args: [`/${c.name}`] }));
    state.cliCommands = [...state.cliCommands, ...registry];
    buildChips();
  }).catch(() => {});
  setupSlash();
  setupModelMenus();
  loadPrefs();
  setupDock();
  setupStudio();
  wireComposerClean();
  startActivityPolling();
  startOutstandingReminders();

  window.xavaniDesktop.checkForUpdates().then((info) => {
    if (info && info.updateAvailable && !localStorage.getItem('xz-update-notified')) {
      localStorage.setItem('xz-update-notified', info.latest);
      notify(`Update available: Xavani ${info.latest}`, {
        kind: 'update',
        onClick: () => info.url && window.xavaniDesktop.openExternal(info.url),
        ms: 10000,
      });
    }
  }).catch(() => {});

  $('#send').addEventListener('click', onSend);
  $('#stop').addEventListener('click', onStop);
  $('#mic').addEventListener('click', toggleRecord);
  $('#new-chat').addEventListener('click', newChat);
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
  });
  $('#input').addEventListener('input', autosize);

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  document.querySelectorAll('#approval [data-choice]').forEach((btn) => {
    btn.addEventListener('click', () => resolveApproval(btn.dataset.choice));
  });

  $('#messages').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a && a.href.startsWith('http')) {
      e.preventDefault();
      window.xavaniDesktop.openExternal(a.href);
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
  });

  $('#toggle-cli').addEventListener('click', () => {
    state.showCli = !state.showCli;
    $('#toggle-cli').classList.toggle('on', state.showCli);
    renderSessions(state.lastSessions || []);
  });

  $('#input').focus();
  checkFirstRun();

  window.xavaniDesktop.onUpdateInfo((info) => renderUpdateBadge(info));
}

function renderUpdateBadge(info) {
  const badge = $('#update-badge');
  if (!badge || !info) return;
  badge.classList.toggle('hidden', !info.updateAvailable);
  if (info.updateAvailable) {
    badge.textContent = `↑ v${String(info.latest).replace(/^v/, '')}`;
    badge.onclick = () => info.url && window.xavaniDesktop.openExternal(info.url);
  }
}

async function refreshStatus() {
  try {
    const res = await dapi('/desktop/api/status');
    state.status = await res.json();
    $('#chip-model').textContent = state.status.model || 'no model';
    $('#chip-provider').textContent = state.status.provider || '—';
    $('#foot-model').textContent = `${state.status.model || 'no model configured'}`;
    $('#health-dot').className = 'dot ok';
  } catch {
    $('#health-dot').className = 'dot bad';
  }
}

async function refreshSessions() {
  try {
    const res = await dapi('/desktop/api/sessions?limit=40');
    const data = await res.json();
    state.lastSessions = data.sessions || [];
    renderSessions(state.lastSessions);
  } catch { /* sidebar stays empty */ }
}

function renderSessions(sessions) {
  const box = $('#sessions');
  box.innerHTML = '';
  const visible = (sessions || []).filter((s) => state.showCli || !(s.source === 'cli' || String(s.source || '').startsWith('cli')));
  if (!visible.length) {
    box.innerHTML = `<div class="session-item" style="cursor:default">${state.showCli ? 'No sessions yet' : 'No desktop sessions yet'}</div>`;
    return;
  }
  for (const s of visible) {
    const el = document.createElement('button');
    el.className = 'session-item';
    const label = s.title || s.preview || 'Untitled session';
    el.title = label;
    el.innerHTML = `<span class="s-title">${escapeHtml(String(label).slice(0, 80))}</span><span class="when">${fmtWhen(s.last_active)}</span>`;
    el.addEventListener('click', () => openSession(s.id, el));
    box.appendChild(el);
  }
}

function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toTimeString().slice(0, 5);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function openSession(id, el) {
  if (state.running) return;
  state.sessionId = id;
  state.activeSessionItem = el;
  document.querySelectorAll('.session-item').forEach((x) => x.classList.remove('active'));
  if (el) el.classList.add('active');
  try {
    const res = await dapi(`/desktop/api/sessions/${encodeURIComponent(id)}/messages`);
    const data = await res.json();
    state.messages = data.messages || [];
  } catch { state.messages = []; }
  switchView('chat');
  renderMessages();
  scrollBottom(true);
}

function newChat() {
  if (state.running) return;
  state.sessionId = null;
  state.messages = [];
  state.activeSessionItem = null;
  document.querySelectorAll('.session-item').forEach((x) => x.classList.remove('active'));
  renderMessages();
  $('#input').focus();
}

/* ---------------- chat rendering ---------------- */

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function md(text) {
  const raw = marked.parse(text || '', { breaks: true, gfm: true });
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
}

function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  if (!state.messages.length) {
    box.innerHTML = `
      <div class="msg-wrap"><div class="empty" style="padding-top:120px">
        <div style="font-size:15px;font-weight:590;color:var(--text-primary);margin-bottom:6px">Xavani is ready</div>
        <div>Full agent engine — every tool, skill and integration from the CLI.</div>
      </div></div>`;
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap';
  for (const m of state.messages) {
    wrap.appendChild(m.role === 'user' ? userBubble(m.content) : assistantBlock(m.content, false));
  }
  box.appendChild(wrap);
}

function userBubble(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  div.appendChild(b);
  return div;
}

function assistantBlock(content, streaming) {
  const div = document.createElement('div');
  div.className = 'msg msg-assistant';
  div.innerHTML = '<div class="who">Xavani</div>';
  const b = document.createElement('div');
  b.className = 'bubble';
  if (streaming) b.classList.add('cursor-blink');
  b.innerHTML = content ? md(content) : '';
  div.appendChild(b);
  div._bubble = b;
  return div;
}

let stickBottom = true;
$('#messages').addEventListener('scroll', () => {
  const el = $('#messages');
  stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
});

function scrollBottom(force) {
  if (!force && !stickBottom) return;
  const el = $('#messages');
  el.scrollTop = el.scrollHeight;
}

/* ---------------- run loop ---------------- */

function setRunning(on) {
  state.running = on;
  $('#send').classList.toggle('hidden', on);
  $('#stop').classList.toggle('hidden', !on);
  $('#run-state').textContent = on ? 'Working…' : '';
  if (!on) { $('#input').focus(); }
}

function autosize() {
  const el = $('#input');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
}

async function onSend() {
  if (state.running) return;
  const input = $('#input');
  const text = input.value.trim();
  if (!text || !state.apiPort) return;
  input.value = '';
  autosize();
  stickBottom = true;

  if (!state.messages.length) $('#messages').innerHTML = '';
  const wrap = $('#messages').querySelector('.msg-wrap') || (() => {
    const w = document.createElement('div');
    w.className = 'msg-wrap';
    $('#messages').appendChild(w);
    return w;
  })();

  wrap.appendChild(userBubble(text));
  state.messages.push({ role: 'user', content: text });

  const block = assistantBlock('', true);
  wrap.appendChild(block);
  scrollBottom(true);

  setRunning(true);
  state.currentController = new AbortController();

  try {
    const res = await api('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, session_id: state.sessionId || undefined }),
      signal: state.currentController.signal,
    });
    if (!res.ok) throw new Error(`runs API ${res.status}`);
    const { run_id } = await res.json();
    state.currentRunId = run_id;
    await consumeEvents(run_id, block);
  } catch (err) {
    finishBlock(block, `⚠️ ${escapeHtml(String(err.message || err))}`);
  } finally {
    setRunning(false);
    state.currentRunId = null;
    state.currentController = null;
    dockRunEnded();
    refreshStatus();
    refreshSessions();
  }
}

async function consumeEvents(runId, block) {
  const res = await api(`/v1/runs/${runId}/events`, { signal: state.currentController.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let acc = '';
  let renderQueued = false;
  let toolsBox = null;
  let reasoningBox = null;

  const toolsContainer = () => {
    if (!toolsBox) {
      toolsBox = document.createElement('div');
      toolsBox.className = 'tools';
      activityContainer(block).appendChild(toolsBox);
    }
    return toolsBox;
  };

  const paint = () => {
    renderQueued = false;
    block._bubble.innerHTML = md(acc);
    scrollBottom();
  };
  const schedulePaint = () => {
    if (!renderQueued) { renderQueued = true; setTimeout(paint, 60); }
  };

  const addToolCard = (evt) => {
    const card = document.createElement('div');
    card.className = 'tool-card running';
    card.innerHTML = `
      <span class="t-icon"><span class="spinner"></span></span>
      <span class="t-name">${escapeHtml(evt.tool || 'tool')}</span>
      <span class="t-preview">${escapeHtml((evt.preview || '').slice(0, 140))}</span>
      <span class="t-status">running</span>`;
    toolsContainer().appendChild(card);
    scrollBottom();
    return card;
  };

  const addReasoning = (text) => {
    if (!reasoningBox) {
      reasoningBox = document.createElement('details');
      reasoningBox.className = 'reasoning';
      reasoningBox.innerHTML = '<summary>Thinking</summary><div class="reasoning-body"></div>';
      activityContainer(block).appendChild(reasoningBox);
    }
    const body = reasoningBox.querySelector('.reasoning-body');
    body.textContent += text;
  };

  while (true) {
    let chunk;
    try { chunk = await reader.read(); } catch { break; }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const rawEvent = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      let evt;
      try { evt = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }

      switch (evt.event) {
        case 'message.delta':
          acc += evt.delta || '';
          schedulePaint();
          break;
        case 'tool.started':
          evt._card = addToolCard(evt);
          agentTouchedFile(evt);
          break;
        case 'tool.completed': {
          const card = evt._card || toolsBox && toolsBox.lastElementChild;
          if (card) {
            card.classList.remove('running');
            card.classList.add(evt.error ? 'error' : 'done');
            const icon = card.querySelector('.t-icon');
            icon.innerHTML = evt.error ? '✕' : '✓';
            icon.style.color = evt.error ? 'var(--red)' : 'var(--green)';
            card.querySelector('.t-status').textContent = evt.duration != null ? `${evt.duration}s` : (evt.error ? 'error' : 'done');
          }
          agentTouchedFile(evt);
          break;
        }
        case 'reasoning.available':
          addReasoning(evt.text || '');
          scrollBottom();
          break;
        case 'approval.request':
          showApproval(evt);
          break;
        default:
          break;
      }
    }
  }

  const finalBlock = await api(`/v1/runs/${runId}`).then((r) => r.json()).catch(() => null);
  if (finalBlock && finalBlock.output && !acc.trim()) acc = finalBlock.output;
  if (state.sessionId == null && finalBlock && finalBlock.session_id) state.sessionId = finalBlock.session_id;
  if (finalBlock && finalBlock.usage) {
    $('#usage-chip').textContent = `${finalBlock.usage.total_tokens.toLocaleString()} tokens`;
  }
  dockRunEnded();
  finishBlock(block, null);
  block._bubble.innerHTML = md(acc || (finalBlock && finalBlock.output) || '*(no output)*');
  state.messages.push({ role: 'assistant', content: acc || (finalBlock && finalBlock.output) || '' });
  if (block._activity) {
    const nTools = block._activity.querySelectorAll('.tool-card').length;
    const hasReasoning = !!block._activity.querySelector('.reasoning');
    if (!nTools && !hasReasoning) {
      block._activity.remove();
    } else {
      const bits = [];
      if (nTools) bits.push(`${nTools} tool call${nTools > 1 ? 's' : ''}`);
      if (hasReasoning) bits.push('thinking');
      block._activity.querySelector('summary').textContent = bits.join(' · ');
    }
  }
  scrollBottom(true);
}

function finishBlock(block, errText) {
  block._bubble.classList.remove('cursor-blink');
  if (errText) block._bubble.innerHTML = `<span style="color:var(--red)">${errText}</span>`;
}

async function onStop() {
  if (!state.running || !state.currentRunId) return;
  try { await api(`/v1/runs/${state.currentRunId}/stop`, { method: 'POST' }); } catch {}
}

let pendingApprovalRunId = null;
function showApproval(evt) {
  pendingApprovalRunId = evt.run_id;
  $('#approval-cmd').textContent = evt.command || evt.preview || evt.summary || JSON.stringify(evt, null, 2).slice(0, 600);
  $('#approval').classList.remove('hidden');
  scrollBottom(true);
}

async function resolveApproval(choice) {
  $('#approval').classList.add('hidden');
  if (!pendingApprovalRunId) return;
  try {
    await api(`/v1/runs/${pendingApprovalRunId}/approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice }),
    });
  } catch {}
  pendingApprovalRunId = null;
}

/* ---------------- views ---------------- */

function switchView(name) {
  state.activeView = name;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $('#topbar-title').textContent = name === 'chat' ? 'Chat' : name[0].toUpperCase() + name.slice(1);
  if (name === 'tools') loadTools();
  if (name === 'skills') loadSkills();
  if (name === 'cron') loadCron();
  if (name === 'status') loadStatus();
  if (name === 'ops') loadOps();
  if (name === 'settings') loadSettings();
  if (name === 'constellation') loadConstellation();
  if (name === 'console') ensureConsole();
  if (name === 'import') loadMigration();
}

function cardEl(name, desc, meta, action) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <div class="c-body">
      <div class="c-name ${meta && meta.mono ? 'mono' : ''}">${escapeHtml(name)}</div>
      ${desc ? `<div class="c-desc">${escapeHtml(desc)}</div>` : ''}
      ${meta && meta.text ? `<div class="c-meta">${escapeHtml(meta.text)}</div>` : ''}
    </div>`;
  if (action) el.appendChild(action);
  return el;
}

async function loadTools() {
  const box = $('#tools-list');
  box.innerHTML = '<div class="empty">Loading toolsets…</div>';
  try {
    const res = await dapi('/desktop/api/tools');
    const { toolsets } = await res.json();
    box.innerHTML = '<div class="panel-title">Tools</div><div class="panel-desc">Toggle toolsets for new sessions. Changes apply on the next conversation.</div>';
    if (!toolsets.length) { box.innerHTML += '<div class="empty">No toolsets found</div>'; return; }
    for (const t of toolsets) {
      const tg = document.createElement('div');
      tg.className = `toggle${t.enabled ? ' on' : ''}`;
      tg.title = t.enabled ? 'Disable' : 'Enable';
      tg.addEventListener('click', async () => {
        tg.classList.toggle('on');
        await dapi('/desktop/api/tools/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: t.name, enabled: tg.classList.contains('on') }),
        });
      });
      box.appendChild(cardEl(t.name, t.description, null, tg));
    }
  } catch (err) {
    box.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(String(err))}</div>`;
  }
}

async function loadSkills() {
  const box = $('#skills-list');
  box.innerHTML = '<div class="empty">Loading skills…</div>';
  try {
    const res = await dapi('/desktop/api/skills');
    const { skills } = await res.json();
    box.innerHTML = `<div class="panel-title">Skills</div><div class="panel-desc">${skills.length} installed in ${escapeHtml(state.status ? state.status.xavani_home : '~/.xavani')}/skills</div>`;
    if (!skills.length) { box.innerHTML += '<div class="empty">No skills installed</div>'; return; }
    for (const s of skills) box.appendChild(cardEl(s.name, s.description, { mono: true }));
  } catch (err) {
    box.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(String(err))}</div>`;
  }
}

async function loadCron() {
  const box = $('#cron-list');
  box.innerHTML = '<div class="empty">Loading cron jobs…</div>';
  try {
    const res = await api('/api/jobs');
    const data = await res.json();
    const jobs = Array.isArray(data) ? data : (data.jobs || []);
    box.innerHTML = '<div class="panel-title">Cron jobs</div><div class="panel-desc">Scheduled agent jobs. Same store as the CLI and gateway.</div>';
    if (!jobs.length) { box.innerHTML += '<div class="empty">No cron jobs</div>'; return; }
    for (const j of jobs) {
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;flex-shrink:0';
      const mkBtn = (label, fn, cls = 'ghost') => {
        const b = document.createElement('button');
        b.className = `btn ${cls} sm`;
        b.textContent = label;
        b.addEventListener('click', fn);
        return b;
      };
      const refresh = () => loadCron();
      const act = (path) => async () => {
        await api(`/api/jobs/${j.id}/${path}`, { method: 'POST' }).catch(() => {});
        refresh();
      };
      if (j.enabled === false || j.paused) actions.appendChild(mkBtn('Resume', act('resume')));
      else actions.appendChild(mkBtn('Pause', act('pause')));
      actions.appendChild(mkBtn('Run', act('run')));
      actions.appendChild(mkBtn('Delete', async () => {
        await api(`/api/jobs/${j.id}`, { method: 'DELETE' }).catch(() => {});
        refresh();
      }, 'danger'));
      const schedule = j.schedule || j.cron || j.interval || '';
      box.appendChild(cardEl(
        j.name || j.prompt || j.id,
        typeof j.prompt === 'string' ? j.prompt.slice(0, 160) : '',
        { text: `${schedule}`, mono: true },
        actions,
      ));
    }
  } catch (err) {
    box.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(String(err))}</div>`;
  }
}

async function loadStatus() {
  const box = $('#status-panel');
  box.innerHTML = '<div class="empty">Loading…</div>';
  await refreshStatus();
  const s = state.status || {};
  box.innerHTML = '<div class="panel-title">Status</div><div class="panel-desc">Engine, configuration and storage.</div>';
  const grid = document.createElement('div');
  grid.className = 'status-grid';
  const rows = [
    ['Engine version', s.engine_version || '—'],
    ['Model', s.model || 'not configured'],
    ['Provider', s.provider || '—'],
    ['Profile', s.profile || 'default'],
    ['Python', s.python || '—'],
    ['Xavani home', s.xavani_home || '—'],
    ['API port', String(s.api_port || state.apiPort)],
    ['Uptime', `${Math.round(s.uptime_s || 0)}s`],
  ];
  for (const [k, v] of rows) {
    const el = document.createElement('div');
    el.className = 'kv';
    el.innerHTML = `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(String(v))}</div>`;
    grid.appendChild(el);
  }
  box.appendChild(grid);

  if (s.xavani_home) {
    const cfgBtn = document.createElement('button');
    cfgBtn.className = 'btn ghost sm';
    cfgBtn.textContent = 'Reveal config.yaml';
    cfgBtn.style.marginTop = '12px';
    cfgBtn.addEventListener('click', () => window.xavaniDesktop.revealPath(`${s.xavani_home}/config.yaml`));
    box.appendChild(cfgBtn);
  }
  if (!s.config_ok) {
    const warn = document.createElement('div');
    warn.className = 'empty';
    warn.style.color = 'var(--amber)';
    warn.textContent = 'No model configured yet — run `xavani setup` in a terminal, or set config.yaml.';
    box.appendChild(warn);
  }
}

/* ---------------- settings view ---------------- */

function settingsCard(title, desc, group) {
  const card = document.createElement('div');
  card.className = 'card set-card';
  if (group) card.dataset.group = group;
  card.innerHTML = `<div class="c-body"><div class="c-name">${escapeHtml(title)}</div>
    ${desc ? `<div class="c-desc">${escapeHtml(desc)}</div>` : ''}</div>`;
  return card;
}

const SETTINGS_GROUPS = ['all', 'general', 'models', 'tools'];

function renderSettingsGroups(active) {
  const strip = $('#settings-groups');
  if (!strip) return;
  strip.innerHTML = '';
  const labels = { all: 'All', general: 'General', models: 'Models', tools: 'Tools' };
  for (const g of SETTINGS_GROUPS) {
    const b = document.createElement('button');
    b.className = `chip chip-btn set-group${g === active ? ' on' : ''}`;
    b.textContent = labels[g];
    b.addEventListener('click', () => applySettingsGroup(g));
    strip.appendChild(b);
  }
}

function applySettingsGroup(group) {
  const panel = $('#settings-panel');
  SETTINGS_GROUPS.filter((g) => g !== 'all').forEach((g) => {
    panel.classList.toggle(`show-${g}`, group === 'all' || group === g);
  });
  panel.classList.toggle('grouped', group !== 'all');
  renderSettingsGroups(group);
}

async function loadSettings() {
  const box = $('#settings-panel');
  box.innerHTML = '<div class="panel-title">Settings</div><div class="panel-desc">Everything is stored locally in ~/.xavani.</div>';
  const strip = document.createElement('div');
  strip.id = 'settings-groups';
  box.appendChild(strip);
  const gen = document.createElement('div');
  const mod = document.createElement('div');
  const tol = document.createElement('div');
  [gen, mod, tol].forEach((c) => { c.className = 'set-cluster'; box.appendChild(c); });
  applySettingsGroup('all');

  // --- Appearance ---
  const skin = await dapi('/desktop/api/skins').then((r) => r.json()).catch(() => null);
  if (skin) {
    const c = settingsCard('Appearance', 'Engine skin used by the console and CLI surfaces.', 'general');
    const row = document.createElement('div');
    row.className = 'set-row';
    row.innerHTML = `<select id="set-skin">${(skin.skins || []).map((s) => `<option value="${s.name}"${s.name === skin.active ? ' selected' : ''}>${s.name}</option>`).join('')}</select>
      <button class="btn ghost sm" id="set-skin-apply">Apply</button>`;
    c.appendChild(row);
    box.appendChild(c);
    c.querySelector('#set-skin-apply').addEventListener('click', async () => {
      const name = c.querySelector('#set-skin').value;
      const res = await dapi('/desktop/api/skins/activate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const d = await res.json();
      toast(d.ok ? `Skin set to ${name} (new console sessions)` : (d.error || 'failed'));
    });
  }

  // --- Model & provider ---
  const s = state.status || {};
  const mc = settingsCard('Model & provider', 'Current model for new chats.', 'models');
  mc.appendChild(cardEl(s.model || 'not configured', s.provider ? `provider: ${s.provider}` : 'open the picker to choose one', null, (() => {
    const b = document.createElement('button');
    b.className = 'btn ghost sm';
    b.textContent = 'Change…';
    b.addEventListener('click', () => { switchView('chat'); openModelModal(null); });
    return b;
  })()));
  mod.appendChild(mc);

  // --- Effort & fast mode ---
  await loadPrefs();
  const pc = settingsCard('Reasoning effort & fast mode', 'Applies to new runs. Same controls as the topbar chips.', 'models');
  const prow = document.createElement('div');
  prow.className = 'set-row';
  prow.innerHTML = `<select id="set-effort">${['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((e) =>
    `<option value="${e}"${e === (state.prefs.effort || 'medium') ? ' selected' : ''}>${e}</option>`).join('')}</select>
    <label class="wiz-check"><input type="checkbox" id="set-fast" ${state.prefs.fast_mode ? 'checked' : ''}> Fast mode</label>
    <button class="btn primary sm" id="set-prefs-save">Save</button>`;
  pc.appendChild(prow);
  mod.appendChild(pc);
  pc.querySelector('#set-prefs-save').addEventListener('click', () => {
    setPrefs({ effort: pc.querySelector('#set-effort').value, fast_mode: pc.querySelector('#set-fast').checked });
  });

  // --- Tools & toolsets ---
  const tc = settingsCard('Tools & toolsets', 'What the agent may do in a session.', 'tools');
  try {
    const { toolsets } = await dapi('/desktop/api/tools').then((r) => r.json());
    for (const t of (toolsets || [])) {
      const row = document.createElement('div');
      row.className = 'set-row';
      row.innerHTML = `<label class="wiz-check"><input type="checkbox" data-ts="${t.name}" ${t.enabled ? 'checked' : ''}> ${escapeHtml(t.name)}</label>
        <span class="dim">${escapeHtml((t.description || '').slice(0, 80))}</span>`;
      row.querySelector('input').addEventListener('change', async (ev) => {
        await dapi('/desktop/api/tools/toggle', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: t.name, enabled: ev.target.checked }),
        }).catch(() => {});
        toast(`${t.name} ${ev.target.checked ? 'enabled' : 'disabled'} (new sessions)`);
      });
      tc.appendChild(row);
    }
  } catch {
    tc.insertAdjacentHTML('beforeend', '<span class="dim">Could not load toolsets.</span>');
  }
  tol.appendChild(tc);

  // --- MCP servers ---
  let mcpServers = {};
  try {
    const st = await dapi('/desktop/api/settings').then((r) => r.json());
    mcpServers = st.mcp_servers || {};
  } catch {}
  const mcc = settingsCard('MCP servers', 'Stdio/HTTP tools the engine connects to at startup.', 'tools');
  for (const [name, cfgv] of Object.entries(mcpServers)) {
    const row = document.createElement('div');
    row.className = 'set-row';
    const cmd = typeof cfgv === 'object' && cfgv ? `${cfgv.command || ''} ${(cfgv.args || []).join(' ')}` : String(cfgv);
    row.innerHTML = `<span class="mono">${escapeHtml(name)}</span> <span class="dim mono">${escapeHtml(cmd.trim())}</span>
      <button class="btn danger sm set-mcp-del" data-name="${escapeHtml(name)}">Remove</button>`;
    mcc.appendChild(row);
  }
  const addRow = document.createElement('div');
  addRow.className = 'set-row';
  addRow.innerHTML = `<input id="mcp-name" placeholder="name" style="width:120px">
    <input id="mcp-cmd" placeholder="/path/to/server --args" class="mono">
    <button class="btn ghost sm" id="mcp-add">Add</button>`;
  mcc.appendChild(addRow);
  tol.appendChild(mcc);

  const saveMcp = async (servers) => {
    const res = await dapi('/desktop/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcp_servers: servers }),
    });
    const d = await res.json();
    toast(d.ok ? 'MCP servers saved — reload the app or /reload-mcp to apply' : (d.error || 'save failed'));
    if (d.ok) setTimeout(() => loadSettings(), 600);
  };
  mcc.querySelectorAll('.set-mcp-del').forEach((b) => {
    b.addEventListener('click', () => {
      const next = { ...mcpServers };
      delete next[b.dataset.name];
      saveMcp(next);
    });
  });
  mcc.querySelector('#mcp-add').addEventListener('click', () => {
    const name = mcc.querySelector('#mcp-name').value.trim();
    const cmdLine = mcc.querySelector('#mcp-cmd').value.trim();
    if (!name || !cmdLine) { toast('name and command required'); return; }
    const parts = cmdLine.split(/\s+/);
    saveMcp({ ...mcpServers, [name]: { command: parts[0], args: parts.slice(1), env: {} } });
  });

  // --- Profiles ---
  const prof = await dapi('/desktop/api/profiles').then((r) => r.json()).catch(() => null);
  if (prof) {
    const pcc = settingsCard('Profiles', 'Isolated Xavani homes. Switch with `/profile` in the console — the app restarts into that profile.', 'tools');
    for (const p of (prof.profiles || [])) {
      const row = document.createElement('div');
      row.className = 'set-row';
      row.innerHTML = `<span>${escapeHtml(p.name)}</span>${p.name === prof.active ? '<span class="wiz-ok">active</span>' : ''}`;
      pcc.appendChild(row);
    }
    tol.appendChild(pcc);
  }

  // --- Display zoom ---
  const dc = settingsCard('Display', 'Interface zoom level.', 'general');
  const zrow = document.createElement('div');
  zrow.className = 'set-row';
  const zoom = Number(localStorage.getItem('xz-zoom') || '1');
  zrow.innerHTML = `<select id="set-zoom">${[0.85, 0.9, 1, 1.1, 1.25].map((z) =>
    `<option value="${z}"${z === zoom ? ' selected' : ''}>${Math.round(z * 100)}%</option>`).join('')}</select>`;
  dc.appendChild(zrow);
  gen.appendChild(dc);
  dc.querySelector('#set-zoom').addEventListener('change', async (ev) => {
    const z = Number(ev.target.value);
    localStorage.setItem('xz-zoom', String(z));
    if (window.xavaniDesktop.setZoom) window.xavaniDesktop.setZoom(z);
  });

  // --- Updates ---
  const uc = settingsCard('Updates', 'Check GitHub releases for new desktop builds.', 'general');
  const urow = document.createElement('div');
  urow.className = 'set-row';
  urow.innerHTML = `<button class="btn ghost sm" id="upd-check">Check now</button> <span id="upd-out" class="dim"></span>`;
  uc.appendChild(urow);
  gen.appendChild(uc);
  uc.querySelector('#upd-check').addEventListener('click', async () => {
    const out = uc.querySelector('#upd-out');
    out.textContent = 'Checking…';
    const info = await window.xavaniDesktop.checkForUpdates();
    out.textContent = info.error ? info.error
      : info.updateAvailable ? `Update available: v${info.latest}` : `Up to date (v${info.current})`;
    renderUpdateBadge(info);
  });

  // --- About ---
  const ac = settingsCard('About', '', 'general');
  ac.appendChild(cardEl(`Xavani Desktop`, `engine ${s.engine_version || '?'} · python ${s.python || '?'}`, null, (() => {
    const b = document.createElement('button');
    b.className = 'btn ghost sm';
    b.textContent = 'Reveal data folder';
    b.addEventListener('click', () => s.xavani_home && window.xavaniDesktop.revealPath(s.xavani_home));
    return b;
  })()));
  gen.appendChild(ac);
}

/* ---------------- agent ops (loops · eval · diff · permissions) ---------------- */

// These features are session slash-commands inside the engine, not one-shot
// CLI subcommands — so ops actions route through the live Console PTY.
function opsConsole(line) {
  switchView('console');
  ensureConsole();
  setTimeout(() => consoleSendLine(line), 450);
}

async function loadOps() {
  const box = $('#ops-panel');
  box.innerHTML = '<div class="panel-title">Agent ops</div><div class="panel-desc">Long-running engine features. Buttons run in the Console view — output appears there.</div>';

  const mkCard = (title, desc) => {
    const c = settingsCard(title, desc);
    box.appendChild(c);
    return c;
  };

  // --- Loops ---
  {
    const card = mkCard('Loops', 'Repeating tasks with stop conditions.');
    const row = document.createElement('div');
    row.className = 'set-row';
    row.innerHTML = `<button class="btn ghost sm" data-line="/loops">List loops</button>
      <input id="ops-loop-id" placeholder="loop id" style="width:110px">
      <button class="btn danger sm" id="ops-loop-stop">Stop loop</button>`;
    card.appendChild(row);
    card.querySelector('[data-line]').addEventListener('click', () => opsConsole('/loops'));
    card.querySelector('#ops-loop-stop').addEventListener('click', () => {
      const id = card.querySelector('#ops-loop-id').value.trim();
      if (!id) { toast('loop id required'); return; }
      opsConsole(`/loop stop ${id}`);
    });
  }

  // --- Eval ---
  {
    const card = mkCard('Eval harness', 'Baseline task bench. Faux runs spend no provider credits.');
    const row = document.createElement('div');
    row.className = 'set-row';
    row.innerHTML = `<button class="btn ghost sm" data-line="/eval --faux">Run faux bench</button>
      <span class="dim">real runs cost tokens — type /eval in Console with your flags</span>`;
    card.appendChild(row);
    card.querySelector('[data-line]').addEventListener('click', () => opsConsole('/eval --faux'));
  }

  // --- Staged changes / diff ---
  {
    const card = mkCard('Staged writes & diff review', 'Review what the agent wants to write before it lands.');
    const row = document.createElement('div');
    row.className = 'set-row';
    row.innerHTML = `<button class="btn ghost sm" data-line="/diff">Status</button>
      <button class="btn primary sm" data-line="/diff on">Diff on</button>
      <button class="btn ghost sm" data-line="/diff off">Diff off</button>`;
    card.appendChild(row);
    for (const b of card.querySelectorAll('[data-line]')) {
      b.addEventListener('click', () => opsConsole(b.dataset.line));
    }
  }

  // --- Permissions ---
  {
    const card = mkCard('Permissions', 'Command approval patterns (always-allow rules).');
    const row = document.createElement('div');
    row.className = 'set-row';
    row.innerHTML = `<button class="btn ghost sm" data-line="/permissions">List</button>
      <input id="ops-perm-pat" placeholder="pattern e.g. git *" style="width:150px">
      <button class="btn primary sm" id="ops-perm-add">Add</button>
      <button class="btn danger sm" id="ops-perm-remove">Remove</button>`;
    card.appendChild(row);
    card.querySelector('[data-line]').addEventListener('click', () => opsConsole('/permissions'));
    const patternAction = (sub) => {
      const pat = card.querySelector('#ops-perm-pat').value.trim();
      if (!pat) { toast('pattern required'); return; }
      opsConsole(`/permissions ${sub} ${pat}`);
    };
    card.querySelector('#ops-perm-add').addEventListener('click', () => patternAction('add'));
    card.querySelector('#ops-perm-remove').addEventListener('click', () => patternAction('remove'));
  }
}

/* ---------------- console (full CLI via PTY) ---------------- */

const termState = { term: null, sock: null, fit: null, booted: false, pending: [] };

function buildChips() {
  const box = $('#cli-chips');
  box.innerHTML = '';
  for (const c of state.cliCommands) {
    const b = document.createElement('button');
    b.className = 'chip-cmd';
    b.textContent = c.name;
    b.title = c.desc;
    b.addEventListener('click', () => {
      switchView('console');
      ensureConsole();
      consoleSendLine(c.args.join(' '));
    });
    box.appendChild(b);
  }
}

function ensureConsole() {
  if (termState.booted) {
    setTimeout(() => { try { termState.fit.fit(); } catch {} }, 30);
    return;
  }
  if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') return;
  termState.booted = true;
  const host = $('#terminal-host');
  host.innerHTML = '';

  const term = new Terminal({
    fontFamily: "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12.5,
    lineHeight: 1.25,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
    theme: {
      background: '#0f1011',
      foreground: '#d0d6e0',
      cursor: '#7170ff',
      cursorAccent: '#08090a',
      selectionBackground: 'rgba(113,112,255,0.30)',
      black: '#191a1b',
      brightBlack: '#62666d',
      green: '#10b981',
      red: '#eb5757',
      brightBlue: '#828fff',
      blue: '#7170ff',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  try { fit.fit(); } catch {}

  const sock = new WebSocket(`ws://127.0.0.1:${state.desktopPort}/desktop/term`);
  sock.onopen = () => {
    sock.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    for (const line of termState.pending.splice(0)) consoleSendLine(line);
  };
  sock.onmessage = (ev) => { if (term) term.write(ev.data); };
  sock.onclose = () => {
    if (term) term.write('\r\n\x1b[38;5;245m[console session closed — switch views and back to restart]\x1b[0m\r\n');
  };
  sock.onerror = () => {};
  term.onData((d) => {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'input', data: d }));
  });

  const refit = () => {
    try {
      fit.fit();
      if (sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    } catch {}
  };
  window.addEventListener('resize', refit);
  new ResizeObserver(refit).observe(host);

  termState.term = term;
  termState.sock = sock;
  termState.fit = fit;
  term.focus();
}

function consoleSendLine(line) {
  if (!line) return;
  if (!termState.sock || termState.sock.readyState !== WebSocket.OPEN) {
    ensureConsole();
    termState.pending.push(line);
    return;
  }
  termState.sock.send(JSON.stringify({ type: 'input', data: `${line}\r` }));
  if (termState.term) termState.term.focus();
}

/* ---------------- slash command routing ---------------- */

function setupSlash() {
  const input = $('#input');
  const menu = document.createElement('div');
  menu.className = 'slash-menu';
  document.body.appendChild(menu);

  let items = [];
  let sel = 0;

  const renderMenu = () => {
    menu.innerHTML = '';
    items.slice(0, 8).forEach((c, i) => {
      const el = document.createElement('div');
      el.className = `slash-item${i === sel ? ' sel' : ''}`;
      el.innerHTML = `<span class="s-cmd">/${c.name}</span><span class="s-desc">${escapeHtml(c.desc || '')}</span>`;
      el.addEventListener('click', () => pickCommand(c));
      menu.appendChild(el);
    });
  };
  const position = () => {
    const r = input.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
    menu.style.width = `${Math.max(r.width, 380)}px`;
  };
  const closeMenu = () => { menu.classList.remove('open'); items = []; };
  const openMenu = () => {
    const q = input.value.slice(1).toLowerCase();
    items = state.cliCommands.filter((c) => c.name.toLowerCase().includes(q));
    if (!items.length) { closeMenu(); return; }
    sel = 0;
    renderMenu();
    position();
    menu.classList.add('open');
  };
  const pickCommand = (c) => {
    input.value = '';
    closeMenu();
    autosize();
    if (c.native) { c.action(); return; }
    switchView('console');
    ensureConsole();
    consoleSendLine(c.args.join(' '));
  };

  input.addEventListener('input', () => {
    const v = input.value;
    if (v.startsWith('/') && !v.includes(' ') && state.cliCommands.length) openMenu();
    else closeMenu();
  });
  input.addEventListener('keydown', (e) => {
    if (!menu.classList.contains('open')) return;
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, Math.min(items.length, 8) - 1); renderMenu(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); renderMenu(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (items[sel]) pickCommand(items[sel]); }
    else if (e.key === 'Escape') closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== input) closeMenu();
  });

  const nativeCommands = [
    { name: 'new', desc: 'Start a fresh chat session', native: true, action: newChat },
    { name: 'studio', desc: 'Toggle Studio: explorer + code editor + live preview', native: true, action: () => toggleStudio() },
    { name: 'flip', desc: "Flip the right dock between the live site and files the agent is writing", native: true, action: () => dockFlip() },
  ];
  state.cliCommands = [...nativeCommands, ...state.cliCommands];
  buildChips();
}

/* ---------------- constellation panel ---------------- */

const CONST_PRODUCTS = [
  {
    name: 'Gavaza', tag: 'POPIA',
    desc: 'POPIA compliance toolkit for South African organisations — eight conditions, PAIA manual, privacy policy, breach register with a 72-hour checklist.',
    repo: 'https://github.com/enternovate/gavaza',
  },
  {
    name: 'Nyarhi', tag: 'Knowledge graph',
    desc: 'Local-first knowledge graph — nodes, edges, paths, GraphML and JSON/SQLite stores. The memory layer of the Enternovate constellation.',
    repo: 'https://github.com/enternovate/nyarhi',
  },
  {
    name: 'Mhangani', tag: 'Web audit',
    desc: 'Ethical web security audit — headers, TLS, cookies and CORS checked against OWASP-aligned expectations, scored 0-100. Passive and authorized.',
    repo: 'https://github.com/enternovate/mhangani',
  },
];

function loadConstellation() {
  const box = $('#constellation-panel');
  box.innerHTML = '<div class="panel-title">Constellation</div><div class="panel-desc">Gavaza · Nyarhi · Mhangani — sixteen tools exposed to the agent through the constellation MCP server.</div>';

  const grid = document.createElement('div');
  grid.className = 'const-grid';
  for (const p of CONST_PRODUCTS) {
    const card = document.createElement('div');
    card.className = 'const-card';
    card.innerHTML = `<div class="c-name">${p.name}<span class="c-tag">${p.tag}</span></div><div class="c-desc">${p.desc}</div>`;
    const actions = document.createElement('div');
    actions.className = 'c-actions';
    const repoBtn = document.createElement('button');
    repoBtn.className = 'btn ghost sm';
    repoBtn.textContent = 'Repository';
    repoBtn.addEventListener('click', () => window.xavaniDesktop.openExternal(p.repo));
    actions.appendChild(repoBtn);
    card.appendChild(actions);
    grid.appendChild(card);
  }
  box.appendChild(grid);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap';
  const mkBtn = (label, fn, cls = 'ghost') => {
    const b = document.createElement('button');
    b.className = `btn ${cls} sm`;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  row.appendChild(mkBtn('Status', () => constCommand('status')));
  row.appendChild(mkBtn('Doctor', () => constCommand('doctor')));
  row.appendChild(mkBtn('Install / repair', () => constCommand('install'), 'primary'));
  row.appendChild(mkBtn('Enable in agent', enableConstellation));
  box.appendChild(row);

  const out = document.createElement('pre');
  out.className = 'const-out';
  out.id = 'const-out';
  out.textContent = 'Run Status / Doctor / Install here — or open the Console for the full CLI.';
  box.appendChild(out);
}

async function constCommand(sub) {
  const out = $('#const-out');
  if (!out) return;
  out.textContent = `Running: xavani constellation ${sub} …`;
  try {
    const res = await dapi('/desktop/api/cli', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: ['constellation', sub], timeout: 300 }),
    });
    const d = await res.json();
    out.textContent = (d.output || '(no output)') + (d.exit_code ? `\n(exit code ${d.exit_code})` : '');
  } catch (err) {
    out.textContent = `failed: ${err}`;
  }
}

async function enableConstellation() {
  const out = $('#const-out');
  try {
    const res = await dapi('/desktop/api/constellation/enable', { method: 'POST' });
    const d = await res.json();
    if (out) {
      out.textContent = d.ok
        ? `Constellation MCP server registered in config.yaml\ncommand: ${d.command}\n\nStart a New chat to pick up all sixteen gavaza_* · nyarhi_* · mhangani_* tools.`
        : `failed: ${d.error}`;
    }
  } catch (err) {
    if (out) out.textContent = `failed: ${err}`;
  }
}

/* ---------------- provider & model menus ---------------- */

function floatingMenu(anchor, buildItems) {
  let menu = document.querySelector('.menu.model-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.className = 'menu model-menu';
    document.body.appendChild(menu);
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && !menu._anchor?.contains(e.target)) menu.classList.remove('open');
    });
  }
  menu._anchor = anchor;
  if (menu.classList.contains('open') && menu._for === anchor.id) {
    menu.classList.remove('open');
    return;
  }
  menu.innerHTML = '';
  buildItems(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 12)}px`;
  menu.classList.add('open');
}

function setupModelMenus() {
  $('#chip-provider').addEventListener('click', () => {
    floatingMenu($('#chip-provider'), (menu) => {
      dapi('/desktop/api/providers').then((r) => r.json()).then(({ providers, current }) => {
        for (const p of providers) {
          const el = document.createElement('div');
          el.className = 'menu-item';
          el.innerHTML = `<span class="check">${current.provider === p.id ? '✓' : ''}</span>${p.label}`;
          el.addEventListener('click', () => {
            menu.classList.remove('open');
            openModelModal(p);
          });
          menu.appendChild(el);
        }
        menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
        const add = document.createElement('div');
        add.className = 'menu-item';
        add.innerHTML = '<span class="check">+</span>Add provider / set API key…';
        add.addEventListener('click', () => {
          menu.classList.remove('open');
          openModelModal(null);
        });
        menu.appendChild(add);
      }).catch(() => {
        menu.innerHTML = '<div class="menu-item">Backend unreachable</div>';
      });
    });
  });

  $('#chip-model').addEventListener('click', () => {
    floatingMenu($('#chip-model'), (menu) => {
      dapi('/desktop/api/providers').then((r) => r.json()).then(({ providers, current }) => {
        const meta = providers.find((p) => p.id === current.provider);
        for (const m of (meta ? meta.models : []).slice(0, 10)) {
          const el = document.createElement('div');
          el.className = 'menu-item';
          el.innerHTML = `<span class="check">${current.model === m ? '✓' : ''}</span><span class="s-cmd mono" style="font-size:12px">${m}</span>`;
          el.addEventListener('click', () => { menu.classList.remove('open'); saveModel(current.provider, m); });
          menu.appendChild(el);
        }
        menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
        const custom = document.createElement('div');
        custom.className = 'menu-item';
        custom.innerHTML = '<span class="check">✎</span>Set a different model…';
        custom.addEventListener('click', () => {
          menu.classList.remove('open');
          openModelModal(meta || null, true);
        });
        menu.appendChild(custom);
      });
    });
  });

  $('#mf-cancel').addEventListener('click', closeModal);
  $('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });
  $('#mf-save').addEventListener('click', saveModal);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  $('#chip-effort').addEventListener('click', () => {
    floatingMenu($('#chip-effort'), (menu) => {
      for (const level of EFFORTS) {
        const el = document.createElement('div');
        el.className = 'menu-item';
        el.innerHTML = `<span class="check">${state.prefs.effort === level ? '✓' : ''}</span>${level}`;
        el.addEventListener('click', () => {
          menu.classList.remove('open');
          setPrefs({ effort: level });
        });
        menu.appendChild(el);
      }
    });
  });
  $('#chip-fast').addEventListener('click', () => setPrefs({ fast_mode: !state.prefs.fast_mode }));
}

/* ---------------- effort / fast-mode prefs ---------------- */

async function loadPrefs() {
  try {
    const res = await dapi('/desktop/api/model/prefs');
    state.prefs = await res.json();
  } catch {
    state.prefs = { effort: 'medium', fast_mode: false, fast_supported: false };
  }
  renderPrefChips();
}

function renderPrefChips() {
  const p = state.prefs || {};
  const effort = p.effort || 'medium';
  const effChip = $('#chip-effort');
  effChip.textContent = `Effort: ${effort}`;
  effChip.classList.toggle('on', effort !== 'medium');
  const fastChip = $('#chip-fast');
  fastChip.textContent = `Fast: ${p.fast_mode ? 'on' : 'off'}`;
  fastChip.classList.toggle('on', !!p.fast_mode);
  fastChip.classList.toggle('unsupported', p.fast_supported === false);
  if (p.fast_supported === false) {
    fastChip.title = 'Fast mode — current model does not advertise priority processing; the provider decides';
  } else {
    fastChip.title = 'Fast mode — priority processing where the provider supports it';
  }
}

async function setPrefs(patch) {
  try {
    const res = await dapi('/desktop/api/model/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'save failed');
    if (typeof d.effort === 'string') state.prefs.effort = d.effort;
    if (typeof d.fast_mode === 'boolean') state.prefs.fast_mode = d.fast_mode;
  } catch (e) {
    toast(`prefs: ${e.message || e}`);
  }
  renderPrefChips();
}

let modalProvider = null;

function openModelModal(providerMeta, keepCurrentModel) {
  modalProvider = providerMeta;
  dapi('/desktop/api/providers').then((r) => r.json()).then(({ providers, current }) => {
    state.providers = providers;
    const sel = $('#mf-provider');
    sel.innerHTML = '';
    for (const p of providers) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      sel.appendChild(o);
    }
    sel.value = providerMeta ? providerMeta.id : (current.provider || 'openrouter');
    syncModalFields();
    $('#mf-model').value = keepCurrentModel && current.model ? current.model : '';
    $('#mf-key').value = '';
    $('#mf-err').classList.add('hidden');
    $('#modal-backdrop').classList.remove('hidden');
    $('#mf-model').focus();
  });
}

function syncModalFields() {
  const id = $('#mf-provider').value;
  const meta = (state.providers || []).find((p) => p.id === id);
  const list = $('#mf-model-list');
  list.innerHTML = '';
  for (const m of (meta ? meta.models : [])) {
    const o = document.createElement('option');
    o.value = m;
    list.appendChild(o);
  }
  $('#mf-key-note').textContent = meta && meta.env ? `stored as ${meta.env}` : '(not required)';
  $('#mf-url-row').classList.toggle('hidden', id !== 'custom');
}

function closeModal() {
  $('#modal-backdrop').classList.add('hidden');
}

async function saveModal() {
  const err = $('#mf-err');
  err.classList.add('hidden');
  const payload = {
    provider: $('#mf-provider').value,
    model: $('#mf-model').value.trim(),
    api_key: $('#mf-key').value.trim(),
    base_url: $('#mf-url').value.trim(),
  };
  try {
    const res = await dapi('/desktop/api/model/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await res.json();
    if (!d.ok && !d.provider) throw new Error(d.error || 'save failed');
    closeModal();
    refreshStatus();
  } catch (e) {
    err.textContent = String(e.message || e);
    err.classList.remove('hidden');
  }
}

/* ---------------- voice recorder ---------------- */

const micState = { rec: null, chunks: [], stream: null, timer: null };

function setMicUI(stateName) {
  const btn = $('#mic');
  if (!btn) return;
  btn.classList.toggle('recording', stateName === 'recording');
  if (stateName === 'recording') {
    const started = Date.now();
    btn.title = 'Stop recording';
    micState.timer = setInterval(() => {
      btn.textContent = `${Math.floor((Date.now() - started) / 1000)}s`;
    }, 500);
  } else {
    clearInterval(micState.timer);
    btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><rect x="4.25" y="1" width="3.5" height="6.5" rx="1.75" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 6a3.5 3.5 0 0 0 7 0M6 9.5V11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    btn.title = 'Record voice — transcribed into this box';
  }
}

async function toggleRecord() {
  if (micState.rec && micState.rec.state === 'recording') {
    micState.rec.stop();
    return;
  }
  try {
    micState.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast(`mic blocked: ${e.message || e}`);
    return;
  }
  micState.chunks = [];
  let rec;
  try {
    rec = new MediaRecorder(micState.stream);
  } catch (e) {
    toast(`MediaRecorder unavailable: ${e.message || e}`);
    micState.stream.getTracks().forEach((t) => t.stop());
    return;
  }
  micState.rec = rec;
  rec.ondataavailable = (ev) => { if (ev.data.size) micState.chunks.push(ev.data); };
  rec.onstop = async () => {
    setMicUI('idle');
    micState.stream.getTracks().forEach((t) => t.stop());
    micState.stream = null;
    const blob = new Blob(micState.chunks, { type: 'audio/webm' });
    micState.rec = null;
    await submitTranscription(blob);
  };
  rec.start();
  setMicUI('recording');
}

async function submitTranscription(blob) {
  if (!blob.size) { toast('nothing recorded'); return; }
  toast('transcribing…', 8000);
  try {
    const form = new FormData();
    form.append('audio', blob, 'speech.webm');
    const res = await dapi('/desktop/api/transcribe', { method: 'POST', body: form });
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    const input = $('#input');
    const cur = input.value;
    input.value = cur ? `${cur} ${d.text}` : d.text;
    autosize();
    input.focus();
    toast(`transcribed ${d.text.length} chars — review, then send`);
  } catch (e) {
    toast(`transcription: ${e.message || e}`);
  }
}

/* ---------------- first-run setup wizard ---------------- */

const WIZ_SOURCES = [
  { id: 'claude_code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'hermes', label: 'Hermes Agent' },
  { id: 'cursor', label: 'Cursor' },
];

function wizRenderProgress(idx, total) {
  const box = $('#wiz-progress');
  box.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const d = document.createElement('div');
    d.className = `wiz-dot${i <= idx ? ' done' : ''}`;
    box.appendChild(d);
  }
}

function wizField(label, inputHtml) {
  return `<label class="wiz-field"><span>${label}</span>${inputHtml}</label>`;
}

async function openWizard() {
  $('#wizard').classList.remove('hidden');
  let providers = [];
  try {
    const r = await dapi('/desktop/api/providers');
    providers = (await r.json()).providers || [];
  } catch {}

  const steps = [
    {
      title: 'Welcome to Xavani',
      sub: 'Your full agent engine, now in a native app. This one-time setup connects a model, your tools, and your workspace. Everything stays on this machine.',
      body: () => `<div class="wiz-title">Welcome to Xavani</div>
        <div class="wiz-sub">${steps[0].sub}</div>`,
      next: () => {},
    },
    {
      title: 'Choose a provider',
      sub: 'Pick the API provider and paste its key. The key is stored locally in ~/.xavani/.env.',
      body: () => `<div class="wiz-title">Connect a model</div>
        <div class="wiz-sub">${steps[1].sub}</div>
        ${wizField('Provider', `<select id="wz-provider">${providers.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}</select>`)}
        <div id="wz-model-wrap">
          ${wizField('Model', '<input id="wz-model" class="mono" placeholder="provider/model or model id" autocomplete="off">')}
          <datalist id="wz-model-list"></datalist>
        </div>
        ${wizField('API key', '<input id="wz-key" type="password" placeholder="paste key (stored in .env)">')}`,
      onshow: () => {
        const sel = $('#wz-provider');
        const fill = () => {
          const meta = providers.find((p) => p.id === sel.value);
          const list = $('#wz-model-list');
          if (list) list.innerHTML = (meta ? meta.models : []).map((m) => `<option value="${m}"></option>`).join('');
        };
        sel.addEventListener('change', fill);
        fill();
      },
      next: async () => {
        const payload = {
          provider: $('#wz-provider').value,
          model: $('#wz-model').value.trim() || undefined,
          api_key: $('#wz-key').value.trim() || undefined,
        };
        const res = await dapi('/desktop/api/model/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const d = await res.json();
        if (d.error) throw new Error(d.error);
      },
    },
    {
      title: 'Enable toolsets',
      sub: 'Toolsets decide what the agent may do. You can change these any time in Settings.',
      body: () => `<div class="wiz-title">Enable toolsets</div>
        <div class="wiz-sub">${steps[2].sub}</div><div id="wz-tools" class="dim">Loading…</div>`,
      onshow: () => {
        state.wizToolsInitial = {};
        dapi('/desktop/api/tools').then((r) => r.json()).then(({ toolsets }) => {
          for (const t of (toolsets || [])) state.wizToolsInitial[t.name] = t.enabled;
          $('#wz-tools').innerHTML = (toolsets || []).map((t) =>
            `<label class="wiz-check"><input type="checkbox" data-ts="${t.name}" ${t.enabled ? 'checked' : ''}> ${t.name}<span class="dim"> — ${(t.description || '').slice(0, 70)}</span></label>`
          ).join('') || '<span class="dim">No toolsets found.</span>';
        }).catch(() => { $('#wz-tools').textContent = 'Could not load toolsets.'; });
      },
      next: async () => {
        for (const cb of document.querySelectorAll('#wz-tools input[data-ts]')) {
          if (cb.checked !== state.wizToolsInitial?.[cb.dataset.ts]) {
            await dapi('/desktop/api/tools/toggle', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: cb.dataset.ts, enabled: cb.checked }),
            }).catch(() => {});
          }
        }
      },
    },
    {
      title: 'Bring your history',
      sub: 'Import past sessions and memory files from other AI tools. Optional.',
      body: () => `<div class="wiz-title">Bring your history</div>
        <div class="wiz-sub">${steps[3].sub}</div><div id="wz-import" class="dim">Scanning…</div>`,
      onshow: () => {
        dapi('/desktop/api/migrate/scan').then((r) => r.json()).then((report) => {
          $('#wz-import').innerHTML = WIZ_SOURCES.filter((s) => report[s.id] && report[s.id].found).map((s) => {
            const n = report[s.id].transcripts || 0;
            return `<div class="wiz-row"><button class="btn ghost sm wz-imp" data-src="${s.id}">Import</button> ${s.label} — ${n} transcript${n === 1 ? '' : 's'} found<span class="wz-imp-out dim"></span></div>`;
          }).join('') || '<span class="dim">No imports from other tools found.</span>';
          document.querySelectorAll('.wz-imp').forEach((b) => {
            b.addEventListener('click', async () => {
              b.disabled = true;
              const out = b.parentElement.querySelector('.wz-imp-out');
              try {
                const res = await dapi('/desktop/api/migrate/import', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ source: b.dataset.src }),
                });
                const d = await res.json();
                out.textContent = d.error ? ` ${d.error}` : ` imported ${d.sessions} sessions, ${d.messages} messages`;
                out.className = `wz-imp-out dim ${d.error ? 'wiz-bad' : 'wiz-ok'}`;
              } catch (e) {
                out.textContent = ` failed: ${e.message || e}`;
              }
              b.disabled = false;
            });
          });
        }).catch(() => { $('#wz-import').textContent = 'Scan failed.'; });
      },
      next: () => {},
    },
    {
      title: 'Set your workspace',
      sub: 'Default folder for the file explorer and Studio. Use ~ for home.',
      body: () => `<div class="wiz-title">Set your workspace</div>
        <div class="wiz-sub">${steps[4].sub}</div>
        ${wizField('Workspace root', '<input id="wz-root" class="mono" placeholder="~/projects">')}
        <span id="wz-root-out" class="dim"></span>`,
      onshow: () => {
        dapi('/desktop/api/fs/root').then((r) => r.json()).then((d) => { $('#wz-root').value = d.root || ''; }).catch(() => {});
      },
      next: async () => {
        const root = $('#wz-root').value.trim();
        if (!root) return;
        const res = await dapi('/desktop/api/fs/root', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root }),
        });
        const d = await res.json();
        if (d.error) throw new Error(d.error);
      },
    },
    {
      title: 'You are set',
      sub: 'Everything is connected. Type a task in chat, or press / to see every command the engine has.',
      body: () => `<div class="wiz-title">You are set</div>
        <div class="wiz-sub">${steps[5].sub}</div>`,
      next: () => {},
    },
  ];

  let idx = 0;
  const show = () => {
    const s = steps[idx];
    wizRenderProgress(idx, steps.length - 1);
    $('#wiz-body').innerHTML = '';
    $('#wiz-body').insertAdjacentHTML('beforeend', typeof s.body === 'string' ? s.body : s.body());
    $('#wiz-back').classList.toggle('hidden', idx === 0);
    $('#wiz-next').textContent = idx === steps.length - 1 ? 'Start using Xavani' : 'Continue';
    if (s.onshow) s.onshow();
  };
  const advance = async () => {
    try {
      await steps[idx].next();
      if (idx < steps.length - 1) { idx += 1; show(); return; }
      await dapi('/desktop/api/setup/complete', { method: 'POST' }).catch(() => {});
      $('#wizard').classList.add('hidden');
      refreshStatus();
      refreshSessions();
      loadPrefs();
    } catch (e) {
      toast(`setup: ${e.message || e}`);
    }
  };
  $('#wiz-next').onclick = advance;
  $('#wiz-back').onclick = () => { if (idx > 0) { idx -= 1; show(); } };
  $('#wiz-skip').onclick = async () => {
    await dapi('/desktop/api/setup/skip', { method: 'POST' }).catch(() => {});
    $('#wizard').classList.add('hidden');
  };
  show();
}

async function checkFirstRun() {
  try {
    const res = await dapi('/desktop/api/setup/status');
    const d = await res.json();
    if (d.first_run) await openWizard();
  } catch {}
}

/* ---------------- right IDE dock (live preview + visual edit) ---------------- */

function setupDock() {
  $('#dock-toggle').addEventListener('click', () => {
    $('#app').classList.toggle('dock-open');
    setTimeout(() => { try { termState.fit && termState.fit.fit(); } catch {} }, 60);
  });
  $('#dock-close').addEventListener('click', () => $('#app').classList.remove('dock-open'));
  const go = () => {
    const url = $('#dock-url').value.trim();
    if (!/^https?:\/\//.test(url)) return;
    $('#dock-hint').style.display = 'none';
    state.dockNavigated = true;
    $('#dock-webview').setAttribute('src', url);
  };
  $('#dock-go').addEventListener('click', go);
  $('#dock-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('#dock-edit').addEventListener('click', toggleVisualEdit);
  setupDockTabs();
  setupDockResize();
}

let visualEditOn = false;

function toggleVisualEdit() {
  visualEditOn = !visualEditOn;
  $('#dock').classList.toggle('edit-active', visualEditOn);
  const wv = $('#dock-webview');
  if (!wv || !wv.executeJavaScript) return;
  wv.executeJavaScript(VISUAL_EDIT_SCRIPT.replace('__MODE__', visualEditOn ? '1' : '0'), true)
    .then((edits) => {
      if (Array.isArray(edits) && edits.length) sendEditsToAgent(edits);
    })
    .catch(() => {});
}

const VISUAL_EDIT_SCRIPT = `
(function(){
  window.__xdEdits = window.__xdEdits || [];
  var prevStyle = document.getElementById('__xd_style');
  if (prevStyle) prevStyle.remove();
  var prevPanel = document.getElementById('__xd_panel');
  if (prevPanel) prevPanel.remove();
  if (!__MODE__) { return JSON.stringify(window.__xdEdits); }

  var ANIMS = ['fade-in', 'slide-up', 'pop', 'pulse', 'float', 'spin', 'shake'];
  var st = document.createElement('style');
  st.id = '__xd_style';
  st.textContent = [
    '[__xd-hover]{outline:2px dashed #7170ff !important; cursor:pointer !important;}',
    '[__xd-sel]{outline:2px solid #7170ff !important; outline-offset:1px !important;}',
    '#__xd_panel{position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#16171a;color:#d0d6e0;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:10px;width:240px;max-height:72vh;overflow:auto;box-shadow:0 6px 24px rgba(0,0,0,.55);}',
    '#__xd_panel .xdt{color:#f7f8f8;font-weight:bold;font-size:12px;}',
    '#__xd_target{color:#9ba2ff;margin:5px 0;word-break:break-all;min-height:14px;}',
    '#__xd_panel .xsec{margin-top:7px;padding-top:5px;border-top:1px solid rgba(255,255,255,.09);color:#8b93a7;font-size:9px;text-transform:uppercase;letter-spacing:.08em;}',
    '#__xd_panel .xrow{display:flex;flex-wrap:wrap;gap:3px;margin:4px 0;align-items:center;}',
    '#__xd_panel button{padding:3px 7px;background:rgba(255,255,255,.06);color:#d0d6e0;border:1px solid rgba(255,255,255,.16);border-radius:5px;cursor:pointer;font-size:10px;font-family:inherit;}',
    '#__xd_panel button:hover{background:rgba(113,112,255,.28);border-color:#7170ff;}',
    '#__xd_panel label{color:#8b93a7;font-size:10px;margin-right:2px;}',
    '#__xd_panel input[type=color]{width:30px;height:20px;padding:0;border:1px solid rgba(255,255,255,.22);border-radius:4px;background:none;cursor:pointer;}',
    '@keyframes xd-fade-in{from{opacity:0}to{opacity:1}}',
    '@keyframes xd-slide-up{from{opacity:0;transform:translateY(26px)}to{opacity:1;transform:translateY(0)}}',
    '@keyframes xd-pop{0%{transform:scale(.35);opacity:0}62%{transform:scale(1.12)}100%{transform:scale(1);opacity:1}}',
    '@keyframes xd-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}',
    '@keyframes xd-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}',
    '@keyframes xd-spin{to{transform:rotate(360deg)}}',
    '@keyframes xd-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}',
    '.xd-anim-fade-in{animation:xd-fade-in .9s ease both !important;}',
    '.xd-anim-slide-up{animation:xd-slide-up .8s ease both !important;}',
    '.xd-anim-pop{animation:xd-pop .7s cubic-bezier(.34,1.56,.64,1) both !important;}',
    '.xd-anim-pulse{animation:xd-pulse 1.6s ease-in-out infinite !important;}',
    '.xd-anim-float{animation:xd-float 3s ease-in-out infinite !important;}',
    '.xd-anim-spin{animation:xd-spin 2.4s linear infinite !important;}',
    '.xd-anim-shake{animation:xd-shake .5s ease-in-out 2 !important;}'
  ].join('');
  document.head.appendChild(st);

  var panel = document.createElement('div');
  panel.id = '__xd_panel';
  var animBtns = ANIMS.map(function(n){ return '<button data-a="anim" data-v="' + n + '">' + n + '</button>'; }).join('');
  panel.innerHTML =
    '<div class="xdt">Visual edit</div>'
    + '<div id="__xd_target">&lt;click an element&gt;</div>'
    + '<div class="xsec">Element</div>'
    + '<div class="xrow"><button data-a="text">&#9998; Edit text</button><button data-a="del">&#10005; Delete</button><button data-a="resetmove">&#8634; Un-move</button></div>'
    + '<div class="xrow"><label>Text</label><input type="color" id="__xd_c1"><label>Fill</label><input type="color" id="__xd_c2"></div>'
    + '<div class="xsec">Size &amp; spacing</div>'
    + '<div class="xrow"><button data-a="fs+">A+</button><button data-a="fs-">A&minus;</button><button data-a="rad+">round+</button><button data-a="pl-">pad&minus;</button><button data-a="pl+">pad+</button></div>'
    + '<div class="xrow"><button data-a="mt-">mar&minus;</button><button data-a="mt+">mar+</button><button data-a="w-">w&minus;</button><button data-a="w+">w+</button><button data-a="gap+">gap+</button><button data-a="gap-">gap&minus;</button></div>'
    + '<div class="xsec">Animate</div>'
    + '<div class="xrow">' + animBtns + '</div>'
    + '<div class="xsec" id="__xd_msec" style="display:none">Media</div>'
    + '<div class="xrow" id="__xd_mrow" style="display:none"><button data-a="mrot">rotate 90&deg;</button><button data-a="mflip">flip H</button><button data-a="mgray">gray</button><button data-a="mblur">blur</button><button data-a="mbright">bright+</button></div>'
    + '<div class="xrow" id="__xd_srow" style="display:none"><label>SVG fill</label><input type="color" id="__xd_sfill"><label>stroke</label><input type="color" id="__xd_sstroke"></div>'
    + '<div class="xsec">Apply</div>'
    + '<div class="xrow"><button data-a="undo">undo last</button><button data-a="clear">clear all</button><button data-a="send" style="background:rgba(113,112,255,.4);border-color:#7170ff;">send to agent</button></div>';
  document.body.appendChild(panel);

  var label = panel.querySelector('#__xd_target');
  var sel = null, hover = null;
  var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
  var editingEl = null;

  function tagOf(el){
    return el.tagName.toLowerCase()
      + (el.id ? '#' + el.id : '')
      + (el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\\s+/).filter(function(c){ return c.indexOf('xd-') !== 0; }).slice(0, 2).join('.')
        : '');
  }

  function px(el, prop){ return parseInt(getComputedStyle(el)[prop], 10) || 0; }
  function setPx(el, prop, delta){
    var next = Math.max(0, px(el, prop) + delta);
    el.style.setProperty(prop, next + 'px');
    record(el, prop, next + 'px');
  }
  function record(el, prop, val){
    var t = tagOf(el);
    var entry = window.__xdEdits.find(function(e){ return e.target === t && e.prop === prop; });
    if (entry) entry.value = val;
    else window.__xdEdits.push({ target: t, prop: prop, value: val });
    label.textContent = t + ' \u2192 ' + prop + ': ' + val;
  }
  function recordOp(el, entry){
    var t = tagOf(el);
    var existing = window.__xdEdits.find(function(e){ return e.target === t && e.op === entry.op; });
    if (existing) Object.assign(existing, entry);
    else window.__xdEdits.push(Object.assign({ target: t }, entry));
    label.textContent = t + ' \u2192 ' + (entry.op === 'move' ? 'moved' : entry.op);
  }

  function syncColourInputs(){
    if (!sel) return;
    var cs = getComputedStyle(sel);
    panel.querySelector('#__xd_c1').value = rgbToHex(cs.color);
    panel.querySelector('#__xd_c2').value = rgbToHex(cs.backgroundColor);
  }
  function rgbToHex(v){
    var m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(v || '');
    if (!m) return '#000000';
    return '#' + m.slice(1).map(function(x){ return ('0' + parseInt(x, 10).toString(16)).slice(-2); }).join('');
  }

  function isRaster(el){ return el && el.tagName === 'IMG'; }
  function isSvgNode(el){ return !!(el && (el instanceof SVGElement || (el.closest && el.closest('svg')))); }
  function syncMediaSection(){
    var media = sel && (isRaster(sel) || isSvgNode(sel));
    panel.querySelector('#__xd_msec').style.display = media ? '' : 'none';
    panel.querySelector('#__xd_mrow').style.display = (media && isRaster(sel)) ? '' : 'none';
    panel.querySelector('#__xd_srow').style.display = (media && isSvgNode(sel)) ? '' : 'none';
  }

  function select(el){
    if (sel) sel.removeAttribute('__xd-sel');
    sel = el;
    sel.setAttribute('__xd-sel', '');
    label.textContent = tagOf(sel);
    syncColourInputs();
    syncMediaSection();
  }

  document.addEventListener('mouseover', function(e){
    if (hover) hover.removeAttribute('__xd-hover');
    hover = e.target;
    if (hover !== document.body && !panel.contains(hover)) hover.setAttribute('__xd-hover', '');
  }, true);
  document.addEventListener('mouseout', function(){ if (hover) hover.removeAttribute('__xd-hover'); }, true);

  document.addEventListener('click', function(e){
    if (panel.contains(e.target)) return;
    if (editingEl || (sel && sel.isContentEditable)) return;
    e.preventDefault(); e.stopPropagation();
    select(e.target);
  }, true);

  /* --- drag selected element to move it --- */
  document.addEventListener('mousedown', function(e){
    if (panel.contains(e.target) || !sel || e.button !== 0) return;
    if (editingEl || (sel && sel.isContentEditable)) return;
    if (e.target !== sel) return;
    dragging = true; moved = false;
    sx = e.clientX; sy = e.clientY;
    ox = sel.__xdX || 0; oy = sel.__xdY || 0;
    e.preventDefault();
  }, true);
  document.addEventListener('mousemove', function(e){
    if (!dragging || !sel) return;
    var dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    moved = true;
    sel.__xdX = ox + dx; sel.__xdY = oy + dy;
    sel.style.transform = 'translate(' + sel.__xdX + 'px, ' + sel.__xdY + 'px)';
  }, true);
  document.addEventListener('mouseup', function(){
    if (!dragging) return;
    dragging = false;
    if (moved && sel) recordOp(sel, { op: 'move', value: 'translate(' + sel.__xdX + 'px, ' + sel.__xdY + 'px)' });
  }, true);

  /* --- inline text editing --- */
  function startTextEdit(){
    if (!sel) return;
    editingEl = sel;
    sel.setAttribute('contenteditable', 'plaintext-only');
    if (!sel.isContentEditable) sel.setAttribute('contenteditable', 'true');
    sel.focus();
    label.textContent = tagOf(sel) + ' \u2014 typing\u2026 click elsewhere to finish';
  }
  document.addEventListener('focusout', function(e){
    if (!editingEl || e.target !== editingEl) return;
    var t = (editingEl.textContent || '').trim().slice(0, 160);
    record(editingEl, 'text', t || '(empty)');
    editingEl.removeAttribute('contenteditable');
    editingEl = null;
  }, true);

  panel.addEventListener('click', function(e){
    var btn = e.target.closest('button[data-a]');
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    var a = btn.getAttribute('data-a');
    if (a === 'undo'){ window.__xdEdits.pop(); label.textContent = '(' + window.__xdEdits.length + ' edits queued)'; return; }
    if (a === 'clear'){ window.__xdEdits.length = 0; label.textContent = '(edits cleared)'; return; }
    if (a === 'send'){ window.__XD_SEND = true; return; }
    if (a === 'text'){ startTextEdit(); return; }
    if (!sel) { label.textContent = 'select an element first'; return; }
    if (a === 'del'){
      recordOp(sel, { op: 'delete' });
      sel.removeAttribute('__xd-sel');
      sel.remove();
      sel = null;
      return;
    }
    if (a === 'resetmove'){
      sel.style.transform = '';
      sel.__xdX = 0; sel.__xdY = 0;
      record(sel, 'transform', 'none');
      return;
    }
    var map = { 'pl+': ['padding-left', 4], 'pl-': ['padding-left', -4],
                'mt+': ['margin-top', 4], 'mt-': ['margin-top', -4],
                'w+': ['width', 20], 'w-': ['width', -20] };
    if (a in map) { setPx(sel, map[a][0], map[a][1]); return; }
    if (a === 'fs+' || a === 'fs-'){
      var fs = Math.max(8, px(sel, 'fontSize') + (a === 'fs+' ? 2 : -2));
      sel.style.fontSize = fs + 'px';
      record(sel, 'fontSize', fs + 'px');
      return;
    }
    if (a === 'rad+'){
      var r = px(sel, 'borderRadius') + 4;
      sel.style.borderRadius = r + 'px';
      record(sel, 'borderRadius', r + 'px');
      return;
    }
    if (a === 'gap+' || a === 'gap-'){
      var g = (parseInt(sel.style.gap, 10) || 0) + (a === 'gap+' ? 4 : -4);
      g = Math.max(0, g);
      sel.style.gap = g + 'px';
      record(sel, 'gap', g + 'px');
      return;
    }
    if (a === 'anim'){
      var name = btn.getAttribute('data-v');
      for (var i = 0; i < ANIMS.length; i++) sel.classList.remove('xd-anim-' + ANIMS[i]);
      void sel.offsetWidth; /* restart animation */
      sel.classList.add('xd-anim-' + name);
      record(sel, 'animation', name);
      return;
    }
    if (a === 'mrot' || a === 'mflip' || a === 'mgray' || a === 'mblur' || a === 'mbright'){
      processRaster(a);
      return;
    }
  });

  function processRaster(kind){
    if (!isRaster(sel)) { label.textContent = 'select an image first'; return; }
    var w = sel.naturalWidth, h = sel.naturalHeight;
    if (!w || !h) { label.textContent = 'image not fully loaded'; return; }
    try {
      var c = document.createElement('canvas');
      var rot = kind === 'mrot';
      c.width = rot ? h : w;
      c.height = rot ? w : h;
      var ctx = c.getContext('2d');
      ctx.filter = kind === 'mgray' ? 'grayscale(1)'
        : kind === 'mblur' ? 'blur(3px)'
        : kind === 'mbright' ? 'brightness(1.3)' : 'none';
      ctx.save();
      if (rot) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
      if (kind === 'mflip') { ctx.translate(w, 0); ctx.scale(-1, 1); }
      ctx.drawImage(sel, 0, 0);
      ctx.restore();
      var url = c.toDataURL('image/png');
      var origSrc = sel.getAttribute('src') || '';
      sel.src = url;
      recordOp(sel, { op: 'image', kind: kind.replace(/^m/, ''), src: origSrc, dataUrl: url });
    } catch (err) {
      label.textContent = 'image edit blocked (' + (String(err).slice(0, 40)) + ')';
    }
  }

  panel.querySelector('#__xd_c1').addEventListener('input', function(e){
    if (sel) { sel.style.color = e.target.value; record(sel, 'color', e.target.value); }
  });
  panel.querySelector('#__xd_c2').addEventListener('input', function(e){
    if (sel) { sel.style.backgroundColor = e.target.value; record(sel, 'backgroundColor', e.target.value); }
  });
  panel.querySelector('#__xd_sfill').addEventListener('input', function(e){
    if (sel && isSvgNode(sel)) {
      sel.setAttribute('fill', e.target.value);
      sel.style.fill = e.target.value;
      recordOp(sel, { op: 'svg-attr', attr: 'fill', value: e.target.value });
    }
  });
  panel.querySelector('#__xd_sstroke').addEventListener('input', function(e){
    if (sel && isSvgNode(sel)) {
      sel.setAttribute('stroke', e.target.value);
      sel.style.stroke = e.target.value;
      recordOp(sel, { op: 'svg-attr', attr: 'stroke', value: e.target.value });
    }
  });

  setInterval(function(){
    if (window.__XD_SEND){
      window.__XD_SEND = false;
      window.__xdDone = JSON.stringify(window.__xdEdits);
    }
  }, 300);
  return JSON.stringify([]);
})();
`;

function pollDockEdits() {
  if (!visualEditOn) return;
  const wv = $('#dock-webview');
  if (!wv || !wv.executeJavaScript) return;
  wv.executeJavaScript('window.__xdDone || ""', true)
    .then((done) => {
      if (done) {
        wv.executeJavaScript('(function(){ window.__xdDone=null; return "ok"; })()', true);
        sendEditsToAgent(JSON.parse(done));
        toggleVisualEdit();
        toggleVisualEdit();
      }
    })
    .catch(() => {});
}
setInterval(pollDockEdits, 1200);

async function sendEditsToAgent(edits) {
  if (!edits.length) return;
  const lines = [];
  for (const e of edits) {
    if (e.op === 'delete') { lines.push(`- \`${e.target}\` → DELETE this element entirely`); continue; }
    if (e.op === 'move') { lines.push(`- \`${e.target}\` → offset it with \`transform: ${e.value}\``); continue; }
    if (e.op === 'svg-attr') {
      lines.push(`- SVG element \`${e.target}\` → set attribute \`${e.attr}: ${e.value}\``);
      continue;
    }
    if (e.op === 'image' && e.dataUrl) {
      const base = decodeURIComponent(String(e.src || '').split('/').pop().split('?')[0]);
      const ext = (base.match(/\.(png|jpe?g|webp|gif|svg)$/i) || [])[1];
      let written = null;
      if (base && ext) {
        try {
          const found = await dapi(`/desktop/api/fs/find?name=${encodeURIComponent(base)}`).then((r) => r.json());
          if (found.path) {
            const res = await dapi('/desktop/api/fs/write-b64', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: found.path, data_b64: e.dataUrl.split(',').pop() }),
            });
            const d = await res.json();
            if (d.ok) written = d.path;
          }
        } catch {}
      }
      lines.push(written
        ? `- image \`${e.target}\` → I already overwrote the file \`${written}\` on disk with a ${e.kind} version (a .bak backup sits next to it). Update markup/styles only if dimensions or references changed.`
        : `- image \`${e.target}\` → replace the source asset with a ${e.kind} processed version${ext ? '' : ' (save it as a new PNG in the project and update the reference)'}`);
      continue;
    }
    lines.push(`- \`${e.target}\` → set \`${e.prop}: ${e.value}\``);
  }
  const msg = `I adjusted the running preview visually. Apply these exact changes to the project's source code:\n${lines.join('\n')}\nUpdate the relevant source files/styles so the change is permanent, then confirm.`;
  switchView('chat');
  const input = $('#input');
  input.value = msg;
  autosize();
  input.focus();
}

/* ---------------- studio IDE layout (explorer · editor · preview) ---------------- */

const studio = {
  open: false,
  root: null,
  expanded: {},
  selectedDir: null,
  tabs: [],
  activePath: null,
};

function toggleStudio(force) {
  const want = typeof force === 'boolean' ? force : !studio.open;
  if (want === studio.open) return;
  studio.open = want;
  $('#app').classList.toggle('studio', studio.open);
  $('#explorer').classList.toggle('hidden', !studio.open);
  if (studio.open) {
    switchView('studio');
    if (!$('#app').classList.contains('dock-open')) $('#dock-toggle').click();
    loadWorkspaceRoot();
  } else {
    switchView('chat');
    $('#input').focus();
  }
  setTimeout(() => { try { termState.fit && termState.fit.fit(); } catch {} }, 80);
}

function setupStudio() {
  $('#explorer-exit').addEventListener('click', () => toggleStudio(false));
  $('#ws-root-go').addEventListener('click', setWorkspaceRoot);
  $('#ws-root').addEventListener('keydown', (e) => { if (e.key === 'Enter') setWorkspaceRoot(); });
  $('#fs-refresh').addEventListener('click', () => renderTree(studio.root));
  $('#fs-newfile').addEventListener('click', () => fsCreate('newfile'));
  $('#fs-newdir').addEventListener('click', () => fsCreate('mkdir'));
  $('#editor-save').addEventListener('click', saveActiveFile);

  const editor = $('#editor');
  editor.addEventListener('input', () => {
    const tab = activeTab();
    if (tab) {
      tab.dirty = true;
      tab.content = editor.value;
      renderTabs();
    }
    syncGutter();
  });
  editor.addEventListener('scroll', () => {
    $('#editor-gutter').scrollTop = editor.scrollTop;
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (e.shiftKey && k === 's') { e.preventDefault(); toggleStudio(); }
    else if (!e.shiftKey && k === 's' && studio.open && studio.activePath) { e.preventDefault(); saveActiveFile(); }
  });
}

async function setWorkspaceRoot() {
  const p = $('#ws-root').value.trim();
  if (!p) return;
  try {
    const res = await dapi('/desktop/api/fs/root', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: p }),
    });
    const d = await res.json();
    if (d.error) { treeError(d.error); return; }
    studio.root = d.root;
    studio.expanded = {};
    studio.selectedDir = null;
    renderTree(studio.root);
  } catch (err) { treeError(String(err)); }
}

async function loadWorkspaceRoot() {
  try {
    const res = await dapi('/desktop/api/fs/root');
    const d = await res.json();
    studio.root = d.root;
    $('#ws-root').value = d.root;
    renderTree(d.root);
  } catch { treeError('Backend unreachable'); }
}

function treeError(msg) { $('#file-tree').innerHTML = `<div class="empty">${escapeHtml(msg)}</div>`; }

function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

async function renderTree(dir) {
  if (!dir) return;
  const box = $('#file-tree');
  try {
    const res = await dapi(`/desktop/api/fs/tree?path=${encodeURIComponent(dir)}`);
    const d = await res.json();
    if (d.error) { if (dir === studio.root) treeError(d.error); return; }
    const container = dir === studio.root ? box : box.querySelector(`[data-dir="${cssEscape(dir)}"]`);
    if (!container) return;
    container.innerHTML = '';
    if (dir === studio.root) {
      const rootRow = document.createElement('div');
      rootRow.className = 'tree-row root-row';
      rootRow.innerHTML = `<span class="tw">▾</span><span class="tname" title="${escapeHtml(d.path)}">${escapeHtml(d.path.split('/').filter(Boolean).pop() || d.path)}</span>`;
      container.appendChild(rootRow);
    }
    for (const ent of d.entries) container.appendChild(treeRow(d.path, ent));
  } catch (err) { if (dir === studio.root) treeError(String(err)); }
}

function treeRow(parentPath, ent) {
  const full = parentPath.replace(/\/$/, '') + '/' + ent.name;
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.path = full;
  row.dataset.type = ent.type;
  const arrow = ent.type === 'dir' ? (studio.expanded[full] ? '▾' : '▸') : '·';
  row.innerHTML = `<span class="tw">${arrow}</span><span class="tname" title="${escapeHtml(full)}">${escapeHtml(ent.name)}</span><button class="t-del" title="Delete">×</button>`;
  row.addEventListener('click', (e) => {
    if (e.target.classList.contains('t-del')) return;
    studio.selectedDir = ent.type === 'dir' ? full : parentPath;
    if (ent.type === 'dir') toggleDir(row, full);
    else openFile(full);
  });
  row.querySelector('.t-del').addEventListener('click', async () => {
    if (!confirm(`Delete ${ent.name}?`)) return;
    try {
      await dapi('/desktop/api/fs/mutate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'delete', path: full }),
      });
      closeTabsUnder(full);
      renderTree(studio.root);
    } catch (err) { treeError(String(err)); }
  });
  return row;
}

async function toggleDir(row, full) {
  const existing = $('#file-tree').querySelector(`[data-dir="${cssEscape(full)}"]`);
  if (existing) {
    delete studio.expanded[full];
    existing.remove();
    row.querySelector('.tw').textContent = '▸';
    return;
  }
  studio.expanded[full] = true;
  row.querySelector('.tw').textContent = '▾';
  const childBox = document.createElement('div');
  childBox.className = 'tree-children';
  childBox.dataset.dir = full;
  if (row.nextElementSibling) row.parentElement.insertBefore(childBox, row.nextElementSibling);
  else row.parentElement.appendChild(childBox);
  await renderTree(full);
}

function closeTabsUnder(path) {
  const prefix = path.replace(/\/$/, '') + '/';
  const dead = studio.tabs.filter((t) => t.path.startsWith(prefix));
  if (!dead.length) return;
  studio.tabs = studio.tabs.filter((t) => !dead.includes(t));
  if (dead.some((t) => t.path === studio.activePath)) {
    activateTab(studio.tabs.length ? studio.tabs[studio.tabs.length - 1].path : '');
  } else renderTabs();
}

/* ----- editor tabs ----- */

function activeTab() { return studio.tabs.find((t) => t.path === studio.activePath) || null; }

async function openFile(path) {
  if (studio.tabs.find((t) => t.path === path)) { activateTab(path); return; }
  try {
    const res = await dapi(`/desktop/api/fs/file?path=${encodeURIComponent(path)}`);
    const d = await res.json();
    if (d.error) { $('#save-state').textContent = d.error; return; }
    studio.tabs.push({ path, name: path.split('/').pop(), content: d.content, dirty: false });
    activateTab(path);
  } catch (err) { $('#save-state').textContent = String(err); }
}

function activateTab(path) {
  studio.activePath = path || null;
  const tab = activeTab();
  $('#editor-empty').style.display = tab ? 'none' : '';
  $('#editor').style.display = tab ? '' : 'none';
  $('#editor-gutter').style.display = tab ? '' : 'none';
  $('#editor').value = tab ? tab.content : '';
  renderTabs();
  syncGutter();
}

function renderTabs() {
  const wrap = $('#editor-tabs');
  wrap.innerHTML = '';
  for (const t of studio.tabs) {
    const el = document.createElement('div');
    el.className = `tab${t.path === studio.activePath ? ' active' : ''}`;
    el.title = t.path;
    el.innerHTML = `<span class="tab-name">${escapeHtml(t.name)}${t.dirty ? ' •' : ''}</span><span class="tab-close">×</span>`;
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) return;
      activateTab(t.path);
    });
    el.querySelector('.tab-close').addEventListener('click', () => {
      studio.tabs = studio.tabs.filter((x) => x !== t);
      if (studio.activePath === t.path) activateTab(studio.tabs.length ? studio.tabs[studio.tabs.length - 1].path : '');
      else renderTabs();
    });
    wrap.appendChild(el);
  }
}

function syncGutter() {
  const lines = Math.max($('#editor').value.split('\n').length, 1);
  let out = '';
  for (let i = 1; i <= lines; i++) out += i + '\n';
  const g = $('#editor-gutter');
  g.textContent = out;
  g.scrollTop = $('#editor').scrollTop;
}

async function saveActiveFile() {
  const tab = activeTab();
  if (!tab) return;
  tab.content = $('#editor').value;
  try {
    const res = await dapi('/desktop/api/fs/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tab.path, content: tab.content }),
    });
    const d = await res.json();
    if (d.error) { $('#save-state').textContent = d.error; return; }
    tab.dirty = false;
    $('#save-state').textContent = `Saved ${new Date().toLocaleTimeString()}`;
    renderTabs();
  } catch (err) { $('#save-state').textContent = String(err); }
}

function fsCreate(op) {
  const base = studio.selectedDir || studio.root;
  if (!base) return;
  const name = prompt(op === 'mkdir' ? 'New folder name:' : 'New file name:');
  if (!name || name.includes('/')) return;
  dapi('/desktop/api/fs/mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, path: base.replace(/\/$/, '') + '/' + name }),
  })
    .then(() => renderTree(base))
    .catch((err) => treeError(String(err)));
}

/* ---------------- dock tabs: preview ⇄ agent files ---------------- */

const dockState = {
  fileTabs: [],
  active: 'preview',
  follow: true,
  loadSeq: 0,
};

const DOCK_MAX_TABS = 15;
const dockRefreshTimers = {};
const FILE_PATH_RE = /[A-Za-z0-9_@./~-]+\.(?:html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|json|md|txt|py|ya?ml|toml|csv|svg|xml|sh|env|php|rb|go|rs|java|kt|swift|c|cpp|h|hpp|sql|vue|svelte|ini|cfg)\b/gi;

function dockTabName(p) { return p.split('/').pop(); }

function renderDockTabs() {
  const wrap = $('#dock-tabs');
  wrap.innerHTML = '';
  const mk = (id, html, extraCls, title) => {
    const el = document.createElement('div');
    el.className = `dock-tab${extraCls || ''}${dockState.active === id ? ' active' : ''}`;
    el.title = title || id;
    el.innerHTML = html;
    el.addEventListener('click', () => setDockTab(id));
    wrap.appendChild(el);
    return el;
  };
  mk('preview', '<span class="dt-name">◉ Live site</span>', '', 'Hosted site preview — /flip toggles between this and agent files');
  for (const t of dockState.fileTabs) {
    const el = mk(t.path, `<span class="dt-name">${escapeHtml(t.name)}</span><span class="tab-close">×</span>`, t.fresh ? ' fresh' : '');
    el.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      dockState.fileTabs = dockState.fileTabs.filter((x) => x !== t);
      if (dockState.active === t.path) setDockTab('preview');
      else renderDockTabs();
    });
    if (t.fresh) setTimeout(() => { t.fresh = false; el.classList.remove('fresh'); }, 1400);
  }
}

function setDockTab(id) {
  dockState.active = id;
  const isPreview = id === 'preview';
  const isTodo = id === 'todo';
  $('#dock-webview').style.display = (isPreview && !isTodo) ? '' : 'none';
  $('#dock-todoview').classList.toggle('hidden', !isTodo);
  $('#dock-fileview').classList.toggle('hidden', isPreview || isTodo);
  $('#dock-hint').style.display = (isPreview && !isTodo && !state.dockNavigated) ? '' : 'none';
  $('.dock-bar').classList.toggle('in-todo', isTodo);
  renderDockTabs();
  if (isTodo) loadTodos();
  else if (!isPreview) loadFileIntoDock(id);
}

/* ---------------- dock to-do pane ---------------- */

const todoState = { items: [], dragId: null };

async function loadTodos() {
  try {
    const res = await dapi('/desktop/api/todos');
    const d = await res.json();
    todoState.items = d.items || [];
    renderTodos();
  } catch {
    $('#todo-list').innerHTML = '<div class="empty">Could not load tasks.</div>';
  }
}

function renderTodos() {
  const list = $('#todo-list');
  list.innerHTML = '';
  if (!todoState.items.length) {
    list.innerHTML = '<div class="empty">No tasks yet. Add one above.</div>';
    return;
  }
  for (const item of todoState.items) {
    const row = document.createElement('div');
    row.className = `todo-item${item.status === 'completed' ? ' done' : ''}`;
    row.draggable = true;
    row.dataset.id = item.id;
    row.innerHTML = `
      <span class="todo-grip" title="Drag to reprioritise">⋮⋮</span>
      <label class="wiz-check"><input type="checkbox" ${item.status === 'completed' ? 'checked' : ''}></label>
      <span class="todo-text">${escapeHtml(item.content)}</span>
      <button class="todo-del" title="Delete task">×</button>`;
    row.querySelector('input').addEventListener('change', async (ev) => {
      await dapi('/desktop/api/todos/item', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, status: ev.target.checked ? 'completed' : 'pending' }),
      }).catch(() => {});
      loadTodos();
    });
    row.querySelector('.todo-del').addEventListener('click', async () => {
      await dapi('/desktop/api/todos/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      }).catch(() => {});
      loadTodos();
    });
    row.addEventListener('dragstart', () => { todoState.dragId = item.id; row.classList.add('dragging'); });
    row.addEventListener('dragend', () => { todoState.dragId = null; row.classList.remove('dragging'); });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = list.querySelector('.dragging');
      if (!dragging || dragging === row) return;
      const rect = row.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      if (after) row.after(dragging); else row.before(dragging);
    });
    row.addEventListener('drop', async () => {
      const order = [...list.querySelectorAll('.todo-item')].map((el) => el.dataset.id);
      await dapi('/desktop/api/todos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      }).catch(() => {});
      loadTodos();
    });
    list.appendChild(row);
  }
}

async function loadFileIntoDock(path) {
  const seq = ++dockState.loadSeq;
  $('#dock-filepath').textContent = path;
  try {
    const res = await dapi(`/desktop/api/fs/file?path=${encodeURIComponent(path)}`);
    const d = await res.json();
    if (seq !== dockState.loadSeq) return;
    if (d.error) {
      $('#dock-filecode').textContent = d.error;
      $('#dock-filegutter').textContent = '';
      return;
    }
    $('#dock-filecode').textContent = d.content.replace(/\t/g, '  ');
    let g = '';
    const n = d.content.split('\n').length;
    for (let i = 1; i <= n; i++) g += i + '\n';
    $('#dock-filegutter').textContent = g;
    $('#dock-filescroll').scrollTop = 0;
  } catch (err) {
    if (seq === dockState.loadSeq) { $('#dock-filecode').textContent = String(err); $('#dock-filegutter').textContent = ''; }
  }
}

function dockOpenFile(path, activate) {
  if (!path || typeof path !== 'string' || path.length > 500 || path.includes('://')) return;
  let t = dockState.fileTabs.find((x) => x.path === path);
  if (!t) {
    t = { path, name: dockTabName(path) };
    dockState.fileTabs.unshift(t);
    if (dockState.fileTabs.length > DOCK_MAX_TABS) {
      const evicted = dockState.fileTabs.splice(DOCK_MAX_TABS);
      if (evicted.some((x) => x.path === dockState.active)) dockState.active = 'preview';
    }
  }
  t.fresh = true;
  if (activate !== false) setDockTab(path);
  else renderDockTabs();
}

function extractFilePath(evt) {
  const hay = `${evt.preview || ''}`;
  const m = hay.match(FILE_PATH_RE);
  return m ? m[m.length - 1] : null;
}

function agentTouchedFile(evt) {
  if (!evt) return;
  const tool = (evt.tool || '').toLowerCase();
  if (!/writ|patch|edit|creat|save|apply/.test(tool)) return;
  const path = extractFilePath(evt);
  if (!path) return;
  clearTimeout(dockRefreshTimers[path]);
  dockRefreshTimers[path] = setTimeout(() => {
    dockOpenFile(path, false);
    if (dockState.active === path) loadFileIntoDock(path);
  }, 300);
  if (dockState.follow) {
    clearTimeout(dockRefreshTimers[path + ':open']);
    dockRefreshTimers[path + ':open'] = setTimeout(() => {
      dockOpenFile(path, true);
    }, 350);
  }
}

function dockRunEnded() {
  if (!dockState.follow) return;
  if (dockState.active !== 'preview') setDockTab('preview');
}

function dockFlip() {
  if (!$('#app').classList.contains('dock-open')) $('#dock-toggle').click();
  if (dockState.active === 'preview') {
    if (dockState.fileTabs.length) setDockTab(dockState.fileTabs[0].path);
  } else {
    setDockTab('preview');
  }
}

function setupDockTabs() {
  renderDockTabs();
  for (const btn of document.querySelectorAll('.dock-tabs-head .dock-tab')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dock-tabs-head .dock-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      setDockTab(btn.dataset.docktab);
    });
  }
  $('#todo-add').addEventListener('click', async () => {
    const input = $('#todo-input');
    const content = input.value.trim();
    if (!content) return;
    input.value = '';
    await dapi('/desktop/api/todos/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }).catch(() => {});
    loadTodos();
  });
  $('#todo-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#todo-add').click();
  });
}

function setupDockResize() {
  const handle = $('#dock-resize');
  const dock = $('#dock');
  let dragging = false;
  const stored = parseInt(localStorage.getItem('xd-dock-w'), 10);
  if (stored >= 320) dock.style.width = `${stored}px`;
  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    document.body.classList.add('dock-resizing');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(window.innerWidth - 360, Math.max(320, window.innerWidth - e.clientX));
    dock.style.width = `${w}px`;
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dock-resizing');
    localStorage.setItem('xd-dock-w', String(dock.offsetWidth));
    setTimeout(() => { try { termState.fit && termState.fit.fit(); } catch {} }, 60);
  });
  handle.addEventListener('dblclick', () => {
    dock.style.width = '';
    localStorage.removeItem('xd-dock-w');
    setTimeout(() => { try { termState.fit && termState.fit.fit(); } catch {} }, 60);
  });
}

/* ---------------- migration view ---------------- */

const MIG_LABELS = {
  claude_code: 'Claude Code',
  codex: 'OpenAI Codex CLI',
  hermes: 'Hermes Agent',
  cursor: 'Cursor',
};

function loadMigration() {
  const box = $('#import-panel');
  box.innerHTML = '<div class="panel-title">Import</div><div class="panel-desc">Bring memories and conversation history from your other AI tools into Xavani. Memory files land in <span class="mono">~/.xavani/memory-imports/</span>; transcripts appear in the sidebar.</div>';
  box.innerHTML += '<div class="empty">Scanning…</div>';
  dapi('/desktop/api/migrate/scan').then((r) => r.json()).then((report) => {
    const wrap = $('#import-panel');
    wrap.innerHTML = '<div class="panel-title">Import</div><div class="panel-desc">Bring memories and conversation history from your other AI tools into Xavani. Memory files land in <span class="mono">~/.xavani/memory-imports/</span>; transcripts appear in the sidebar.</div>';
    for (const [src, info] of Object.entries(report)) {
      const card = document.createElement('div');
      card.className = 'mig-card';
      const label = MIG_LABELS[src] || src;
      const files = (info.memory_files || []).map((f) => f.split('/').pop());
      card.innerHTML = `
        <div class="mig-head">
          <span class="mig-name">${label}</span>
          <span class="mig-stats">${info.found ? `${info.transcripts} transcript(s) · ${files.length} memory file(s)` : 'not found on this machine'}</span>
        </div>
        ${files.length ? `<div class="mig-files">${escapeHtml(files.join(' · '))}</div>` : ''}
        <div class="mig-actions">
          <button class="btn ghost sm mig-go" ${info.found ? '' : 'disabled'}>Import</button>
          <span class="mig-result"></span>
        </div>`;
      card.querySelector('.mig-go').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        const resEl = card.querySelector('.mig-result');
        btn.disabled = true;
        resEl.textContent = 'Importing…';
        resEl.className = 'mig-result';
        try {
          const res = await dapi('/desktop/api/migrate/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: src }),
          });
          const d = await res.json();
          resEl.textContent = d.error ? `failed: ${d.error}` : `✓ ${d.sessions} session(s), ${d.messages} messages, ${d.memory_files} memory file(s)`;
          refreshSessions();
        } catch (e) {
          resEl.textContent = `failed: ${e}`;
          resEl.style.color = 'var(--red)';
        }
        btn.disabled = false;
      });
      wrap.appendChild(card);
    }
  }).catch(() => {
    $('#import-panel').innerHTML = '<div class="empty">Scan failed — backend unreachable.</div>';
  });
}

/* ---------------- clean results mode ---------------- */

function wireComposerClean() {
  state.cleanMode = true;
}

function activityContainer(block) {
  if (!block._activity) {
    const det = document.createElement('details');
    det.className = 'activity';
    det.innerHTML = '<summary>Working…</summary><div class="act-body"></div>';
    block.insertBefore(det, block._bubble);
    block._activity = det;
    block._actBody = det.querySelector('.act-body');
  }
  return block._actBody;
}
