'use strict';

/* R2 Task 16 — the real desktop E2E fixture.

   Boots the actual Electron app against a temporary XAVANI_HOME and a
   temporary workspace, per the plan's required fixture behavior:

   - Create an isolated XAVANI_HOME (auth + setup marker copied in; the
     provider config points at backend/test_runtime.py, the faux provider
     runtime at the provider boundary).
   - Select free test ports.
   - Disable update checks (XAVANI_DESKTOP_FAKE_UPDATE pins "no update").
   - Deny all external network requests (loopback + file/data/blob stay).
   - Expose only the test workspace (the grant targets the temp dir).
   - Use an explicit readiness event (backend-ready -> shell visible ->
     authenticated tree rendered).
   - Fail on an uncaught renderer error (pageerror is collected; specs
     assert `errors` is empty).
   - Stop only the processes this fixture creates (the app close + a
     serve_desktop PID diff against a pre-launch snapshot + the runtime).
   - Remove only the fixture's temporary directory (mkdtemp handles).

   A missing engine or missing backend secret fails the run: readiness
   never arrives and the waits below time out. */

const { _electron: electronApp } = require('@playwright/test');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const REAL_HOME = path.join(os.homedir(), '.xavani');
const ENGINE = process.env.XAVANI_ENGINE_SRC || path.join(os.homedir(), 'xavani-agent');
const PYTHON = process.env.XAVANI_E2E_PYTHON
  || path.join(os.homedir(), '.cache', 'xavani-r1-venv', 'bin', 'python');
const BACKUPS = path.join(os.homedir(), 'xavani-backups-2026-09-14');
const FAUX_REPLY = 'FAUX-OK: desktop e2e read-only check.';

/* Console noise that must not fail a spec: devtools protocol chatter and
   the aborted external requests the fixture itself blocks. */
const IGNORED_CONSOLE = /Autofill|net::ERR|Failed to load resource/;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, attempts = 50) {
  return new Promise((resolve, reject) => {
    const tryOnce = (left) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (left <= 1) reject(new Error(`port ${port} never opened`));
        else setTimeout(() => tryOnce(left - 1), 100);
      });
    };
    tryOnce(attempts);
  });
}

function serveDesktopPids() {
  try {
    return execFileSync('pgrep', ['-f', 'serve_desktop'], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function sweepNewBackends(before) {
  const stale = serveDesktopPids().filter((pid) => !before.includes(pid));
  for (const pid of stale) {
    try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ }
  }
}

function configYaml(runtimePort) {
  return [
    'model:',
    '  default: faux-1',
    '  provider: custom',
    `  base_url: http://127.0.0.1:${runtimePort}`,
    '  api_key: e2e-local',
    '  context_length: 200000',
    'custom_providers:',
    '  - name: E2E Faux',
    `    base_url: http://127.0.0.1:${runtimePort}`,
    '    api_key: e2e-local',
    '    default_model: faux-1',
    '    models:',
    '      faux-1:',
    '        context_length: 200000',
    'compression:',
    '  enabled: false',
    'onboarding:',
    '  seen:',
    '    openclaw_residue_cleanup: true',
    '    tool_progress_prompt: true',
    '    busy_input_prompt: true',
    '',
  ].join('\n');
}

async function launchWorkbench(options = {}) {
  const opts = options || {};
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xavani-e2e-home-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xavani-e2e-ws-'));
  fs.writeFileSync(path.join(workspace, 'README.md'),
    '# e2e workspace\n\nThis file is a read-only fixture. Do not edit.\n');
  try {
    fs.copyFileSync(path.join(REAL_HOME, 'auth.json'), path.join(home, 'auth.json'));
  } catch { /* the app can boot without it; the injector recreates it */ }
  fs.writeFileSync(path.join(home, 'desktop-setup-complete'), '1\n');

  const apiPort = await freePort();
  const runtimePort = await freePort();

  const runtime = spawn(PYTHON, [
    path.join(ROOT, 'backend', 'test_runtime.py'),
    '--port', String(runtimePort),
    '--reply', FAUX_REPLY,
    '--engine-path', ENGINE,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let runtimeLog = '';
  runtime.stdout.on('data', (b) => { runtimeLog += String(b); });
  runtime.stderr.on('data', (b) => { runtimeLog += String(b); });
  await waitForPort(runtimePort);

  fs.writeFileSync(path.join(home, 'config.yaml'), configYaml(runtimePort));

  if (opts.seedBusiness) {
    const biz = opts.seedBusiness || {};
    if (biz.state) {
      const bizDir = path.join(workspace, '.xavani-business');
      fs.mkdirSync(bizDir, { recursive: true });
      fs.writeFileSync(path.join(bizDir, 'state.json'), JSON.stringify(biz.state, null, 2));
    }
    if (biz.approval) {
      const dir = path.join(home, 'operator', 'action_approvals');
      fs.mkdirSync(dir, { recursive: true });
      const record = {
        id: biz.approval.id,
        request: biz.approval.request,
        digest: biz.approval.digest || 'f'.repeat(64),
        state: 'pending_approval',
        consumed: false,
        attempts: 0,
        created_at: 0,
        expires_at: null,
        note: '',
      };
      fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2));
    }
  }

  if (opts.seedTimeline) {
    const sessionsDir = path.join(home, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const lines = (opts.seedTimeline.events || []).map((event) => JSON.stringify(event));
    fs.writeFileSync(
      path.join(sessionsDir, 'session_run_e2e.timeline.jsonl'),
      lines.join('\n') + (lines.length ? '\n' : ''),
    );
  }

  const beforeBackends = serveDesktopPids();
  const app = await electronApp.launch({
    args: ['.'],
    cwd: ROOT,
    env: {
      ...process.env,
      XAVANI_DESKTOP_DEV: '1',
      XAVANI_DESKTOP_ENGINE: ENGINE,
      XAVANI_DESKTOP_PYTHON: PYTHON,
      XAVANI_HOME: home,
      XAVANI_DESKTOP_API_PORT: String(apiPort),
      XAVANI_DESKTOP_FAKE_UPDATE: '0.3.0', // no update, no GitHub call
      XAVANI_DESKTOP_TEST: JSON.stringify({
        grant: workspace, scriptDelay: 86400000, shotDelay: 86400000,
      }),
    },
  });

  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !IGNORED_CONSOLE.test(msg.text())) {
      errors.push(`console: ${msg.text()}`);
    }
  });

  // Deny external network only. Loopback and file requests must never be
  // routed: the app authorizes its API calls through a session-level
  // webRequest injector, which CDP interception would bypass.
  await app.context().route(
    (url) => !/^(file|data|blob|devtools|chrome):/.test(url)
      && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url),
    (route) => route.abort(),
  );

  const close = async () => {
    try { await app.close(); } catch { /* already closed */ }
    try { runtime.kill('SIGKILL'); } catch { /* already gone */ }
    sweepNewBackends(beforeBackends);
    if (process.env.XAVANI_E2E_KEEP) {
      // Debug affordance: keep the temporary home/workspace on disk.
      process.stderr.write(`[e2e] kept ${home} ${workspace}\n`);
    } else {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  };

  // The dev build opens a detached DevTools window, so firstWindow() can
  // hand back the wrong page: pick the window that actually renders the app.
  const appPage = await pickAppWindow(app);
  if (appPage !== page) {
    appPage.on('pageerror', (err) => errors.push(`pageerror: ${err}`));
    appPage.on('console', (msg) => {
      if (msg.type() === 'error' && !IGNORED_CONSOLE.test(msg.text())) {
        errors.push(`console: ${msg.text()}`);
      }
    });
  }

  // Explicit readiness: the shell appears only after the authenticated
  // backend-ready event and the boot overlay hides with it. (The tree is
  // a studio-mode surface; specs open studio when they need it.)
  try {
    await appPage.waitForSelector('#app:not(.hidden)', { timeout: 30000 });
    await appPage.waitForFunction(
      () => document.querySelector('#boot').classList.contains('hidden'),
      { timeout: 5000 },
    );
    // The natively-granted workspace must be live before specs run: the
    // record file lands immediately after the backend boundary accepts it,
    // so waiting for it removes the grant-vs-first-fetch race entirely.
    const record = path.join(home, 'desktop-workspace.json');
    const grantDeadline = Date.now() + 20000;
    while (Date.now() < grantDeadline && !fs.existsSync(record)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!fs.existsSync(record)) throw new Error('the workspace grant never landed');
  } catch (err) {
    let boot = '';
    try {
      boot = await appPage.evaluate(() => {
        const sub = document.querySelector('#boot-sub');
        const root = document.querySelector('#ws-root');
        return JSON.stringify({
          bootHidden: !!document.querySelector('#boot.hidden'),
          sub: sub ? sub.textContent : '',
          wsRoot: root ? root.value : '',
        });
      });
    } catch { /* page already gone */ }
    // Keep the home and workspace for diagnosis; stop only our processes.
    try { await app.close(); } catch { /* already closed */ }
    try { runtime.kill('SIGKILL'); } catch { /* already gone */ }
    sweepNewBackends(beforeBackends);
    throw new Error(`readiness failed ${boot} (kept: ${home} ${workspace}): ${err && err.message}`);
  }

  return { app, page: appPage, home, workspace, errors, runtimeLog: () => runtimeLog, close };
}

async function pickAppWindow(app) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      if (w.url().includes('index.html')) return w;
    }
    await app.waitForEvent('window', { timeout: 1500 }).catch(() => {});
  }
  throw new Error('the app window (index.html) never appeared');
}

module.exports = { launchWorkbench, FAUX_REPLY, BACKUPS };
