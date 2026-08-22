'use strict';

/* global marked, DOMPurify */

const $ = (sel) => document.querySelector(sel);

const state = {
  apiPort: null,
  desktopPort: null,
  sessionId: null,
  running: false,
  currentController: null,
  messages: [],
  status: null,
  activeView: 'chat',
  activeSessionItem: null,
};

const api = (p, opts) => fetch(`http://127.0.0.1:${state.apiPort}${p}`, opts);
const dapi = (p, opts) => fetch(`http://127.0.0.1:${state.desktopPort}${p}`, opts);

/* ---------------- boot ---------------- */

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

  $('#send').addEventListener('click', onSend);
  $('#stop').addEventListener('click', onStop);
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

  $('#input').focus();
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
    renderSessions(data.sessions || []);
  } catch { /* sidebar stays empty */ }
}

/* ---------------- sidebar sessions ---------------- */

function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toTimeString().slice(0, 5);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderSessions(sessions) {
  const box = $('#sessions');
  box.innerHTML = '';
  if (!sessions.length) {
    box.innerHTML = '<div class="session-item" style="cursor:default">No sessions yet</div>';
    return;
  }
  for (const s of sessions) {
    const el = document.createElement('button');
    el.className = 'session-item';
    const label = s.title || s.preview || 'Untitled session';
    el.title = label;
    el.innerHTML = `<span class="s-title">${escapeHtml(String(label).slice(0, 80))}</span><span class="when">${fmtWhen(s.last_active)}</span>`;
    el.addEventListener('click', () => openSession(s.id, el));
    box.appendChild(el);
  }
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
      block.insertBefore(toolsBox, block._bubble);
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
      block.insertBefore(reasoningBox, block._bubble);
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
  finishBlock(block, null);
  block._bubble.innerHTML = md(acc || (finalBlock && finalBlock.output) || '*(no output)*');
  state.messages.push({ role: 'assistant', content: acc || (finalBlock && finalBlock.output) || '' });
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
