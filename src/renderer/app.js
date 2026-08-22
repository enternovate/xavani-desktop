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
  dapi('/desktop/api/cli/commands').then((r) => r.json()).then((d) => {
    state.cliCommands = d.commands || [];
    buildChips();
  }).catch(() => {});
  setupSlash();
  setupModelMenus();
  setupDock();
  wireComposerClean();

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

  $('#toggle-cli').addEventListener('click', () => {
    state.showCli = !state.showCli;
    $('#toggle-cli').classList.toggle('on', state.showCli);
    renderSessions(state.lastSessions || []);
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
    $('#dock-webview').setAttribute('src', url);
  };
  $('#dock-go').addEventListener('click', go);
  $('#dock-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('#dock-edit').addEventListener('click', toggleVisualEdit);
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
  var prev = document.getElementById('__xd_overlay');
  if (prev) prev.remove();
  if (!__MODE__) { return JSON.stringify(window.__xdEdits); }
  var st = document.createElement('style');
  st.id = '__xd_overlay';
  st.textContent = '[__xd-hover]{outline:2px dashed #7170ff !important; cursor:nwse-resize !important;} [__xd-sel]{outline:2px solid #7170ff !important;} #__xd_panel{position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#191a1b;color:#d0d6e0;font:11px/1.5 ui-monospace,monospace;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:10px;box-shadow:0 4px 16px rgba(0,0,0,.5);}#__xd_panel button{margin:2px;padding:3px 7px;background:rgba(255,255,255,.06);color:#d0d6e0;border:1px solid rgba(255,255,255,.15);border-radius:4px;cursor:pointer;font-size:10px;}#__xd_panel .xdv{color:#7170ff;margin:4px 0;}';
  document.head.appendChild(st);

  var panel = document.createElement('div');
  panel.id = '__xd_panel';
  panel.innerHTML = '<b style="color:#f7f8f8">Visual edit</b><br>Pick an element, then adjust.<div class="xdv" id="__xd_target">&lt;none selected&gt;</div>'
    + '<button data-a="pl-">padding −</button><button data-a="pl+">padding +</button>'
    + '<button data-a="mt-">margin −</button><button data-a="mt+">margin +</button>'
    + '<button data-a="gap-">gap −</button><button data-a="gap+">gap +</button>'
    + '<button data-a="w-">width −</button><button data-a="w+">width +</button>'
    + '<div style="margin-top:6px"><button data-a="undo">undo last</button><button data-a="send">send to agent</button></div>';
  document.body.appendChild(panel);

  var sel = null, hover = null;

  function tagOf(el){ return el.tagName.toLowerCase() + (el.id ? '#'+el.id : '') + (el.className && typeof el.className==='string' ? '.'+el.className.trim().split(/\\s+/).slice(0,2).join('.') : ''); }

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
    panel.querySelector('#__xd_target').textContent = t + ' → ' + prop + ': ' + val;
  }

  document.addEventListener('mouseover', function(e){
    if (hover) hover.removeAttribute('__xd-hover');
    hover = e.target;
    if (hover !== document.body) hover.setAttribute('__xd-hover','');
  }, true);
  document.addEventListener('mouseout', function(){ if(hover) hover.removeAttribute('__xd-hover'); }, true);
  document.addEventListener('click', function(e){
    if (panel.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    if (sel) sel.removeAttribute('__xd-sel');
    sel = e.target;
    sel.setAttribute('__xd-sel','');
    panel.querySelector('#__xd_target').textContent = tagOf(sel);
  }, true);

  panel.addEventListener('click', function(e){
    var a = e.target.getAttribute && e.target.getAttribute('data-a');
    if (!a || !sel) return;
    e.preventDefault(); e.stopPropagation();
    var map = { 'pl+': ['padding-left', 4], 'pl-': ['padding-left', -4],
                'mt+': ['margin-top', 4], 'mt-': ['margin-top', -4],
                'w+': ['width', 20], 'w-': ['width', -20] };
    if (a in map) setPx(sel, map[a][0], map[a][1]);
    else if (a === 'gap+' || a === 'gap-'){
      if (sel.style.gap) { var g = parseInt(sel.style.gap)||0; g += (a==='gap+'?4:-4); sel.style.gap = Math.max(0,g)+'px'; record(sel,'gap',Math.max(0,g)+'px'); }
      else { sel.style.gap = (a==='gap+'?'8px':'0px'); record(sel,'gap',sel.style.gap); }
    } else if (a === 'undo'){ window.__xdEdits.pop(); }
      else if (a === 'send'){ window.__XD_SEND = true; }
  });

  setInterval(function(){
    if (window.__XD_SEND){
      window.__XD_SEND = false;
      window.__xdDone = JSON.stringify(window.__xdEdits);
    }
  }, 400);
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

function sendEditsToAgent(edits) {
  if (!edits.length) return;
  const lines = edits.map((e) => `- \`${e.target}\` → set \`${e.prop}: ${e.value}\``).join('\n');
  const msg = `I adjusted the running preview visually. Apply these exact changes to the project's source code:\n${lines}\nUpdate the relevant source files/styles so the change is permanent, then confirm.`;
  switchView('chat');
  const input = $('#input');
  input.value = msg;
  autosize();
  input.focus();
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
