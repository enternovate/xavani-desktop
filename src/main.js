'use strict';

const { app, BrowserWindow, Menu, ipcMain, shell, session, dialog, desktopCapturer } = require('electron');
const { spawn } = require('child_process');
const { randomBytes } = require('node:crypto');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { controlRequest, trustedSender } = require('./security');
const { buildGrantInit, parseGrantResponse } = require('./workspace-grant');
const { createAutoUpdateSchedule } = require('./update-policy');

const IS_MAC = process.platform === 'darwin';
const IS_DEV = !!process.env.XAVANI_DESKTOP_DEV;

let mainWindow = null;
let backend = null;
let backendInfo = null;
let controlSecret = null;
let backendGeneration = 0;
let restartAttempts = 0;
let quitting = false;

function mainWebContentsId() {
  return mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents ? mainWindow.webContents.id : -1;
}

function activeControlPorts() {
  const ports = new Set();
  if (!backendInfo) return ports;
  for (const key of ['api_port', 'desktop_port']) {
    const p = Number(backendInfo[key]);
    if (Number.isInteger(p) && p > 0) ports.add(p);
  }
  return ports;
}

function packagedBackendCommand() {
  const resources = process.resourcesPath;
  const py = IS_MAC
    ? path.join(resources, 'backend', 'runtime', 'bin', 'python3')
    : path.join(resources, 'backend', 'runtime', 'python.exe');
  const script = path.join(resources, 'backend', 'serve_desktop.py');
  return { cmd: py, args: [script], engineRoot: path.join(resources, 'backend', 'engine') };
}

function devBackendCommand() {
  const home = process.env.XAVANI_DESKTOP_ENGINE || path.join(app.getPath('home'), '.xavani', 'xavani-agent');
  const venvPython = process.env.XAVANI_DESKTOP_PYTHON
    || path.join(app.getPath('home'), 'xavani-agent', '.venv', 'bin', 'python');
  return {
    cmd: venvPython,
    args: [path.join(__dirname, '..', 'backend', 'serve_desktop.py')],
    engineRoot: home,
  };
}

function startBackend() {
  const spec = IS_DEV ? devBackendCommand() : packagedBackendCommand();
  if (!fs.existsSync(spec.cmd)) {
    sendToWindow('backend-exit', { error: `backend interpreter missing: ${spec.cmd}` });
    return;
  }
  const env = {
    ...process.env,
    XAVANI_ENGINE_ROOT: spec.engineRoot,
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  backendGeneration += 1;
  const generation = backendGeneration;
  backendInfo = null;
  controlSecret = randomBytes(32).toString('hex');
  backend = spawn(spec.cmd, spec.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    backend.stdin.write(JSON.stringify({ secret: controlSecret }) + '\n');
    backend.stdin.end();
  } catch (err) {
    sendToWindow('backend-exit', { error: `bootstrap secret write failed: ${err && err.message ? err.message : err}` });
    return;
  }

  let stdoutBuf = '';
  backend.stdout.on('data', (chunk) => {
    if (generation !== backendGeneration) return;
    stdoutBuf += chunk.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        if (generation !== backendGeneration) return;
        if (parsed.ready) {
          backendInfo = parsed;
          restartAttempts = 0;
          probeReady(parsed.api_port, parsed.desktop_port, generation);
        } else {
          sendToWindow('backend-exit', { error: parsed.error || 'backend failed to start' });
        }
      } catch {}
    }
  });
  backend.stderr.on('data', (chunk) => {
    if (generation !== backendGeneration) return;
    if (restartAttempts > 0) console.error('[xavani-backend]', chunk.toString().slice(0, 2000));
  });
  backend.on('exit', (code) => {
    if (generation !== backendGeneration) return;
    backend = null;
    if (!quitting) {
      sendToWindow('backend-exit', { code });
      scheduleRestart();
    }
  });
}

let probingGeneration = 0;
let backendReadySent = false;
function probeReady(apiPort, desktopPort, generation) {
  if (probingGeneration === generation || backendReadySent) return;
  probingGeneration = generation;
  const stopProbing = () => { if (probingGeneration === generation) probingGeneration = 0; };
  const attempt = (n) => {
    if (generation !== backendGeneration || backendReadySent || !backend) { stopProbing(); return; }
    let settled = false;
    const retryOnce = () => {
      if (settled || backendReadySent) return;
      settled = true;
      if (generation !== backendGeneration) { stopProbing(); return; }
      setTimeout(() => attempt(n + 1), 300);
    };
    const req = http.get({ host: '127.0.0.1', port: apiPort, path: '/health', timeout: 1500 }, (res) => {
      res.resume();
      if (settled || generation !== backendGeneration) return;
      if (res.statusCode === 200) {
        settled = true;
        stopProbing();
        backendReadySent = true;
        sendToWindow('backend-ready', { apiPort, desktopPort });
      } else {
        retryOnce();
      }
    });
    req.on('error', retryOnce);
    req.on('timeout', () => { req.destroy(); retryOnce(); });
  };
  attempt(0);
}

function scheduleRestart() {
  if (quitting || restartAttempts >= 3) return;
  restartAttempts += 1;
  setTimeout(() => { if (!quitting && !backend) startBackend(); }, 1200 * restartAttempts);
}

function stopBackend() {
  if (!backend) return;
  const child = backend;
  backend = null;
  try {
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
  } catch {}
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/* ---------------- native workspace grant ---------------- */

function expandHome(p) {
  if (typeof p !== 'string') return '';
  const raw = p.trim();
  if (raw === '~') return app.getPath('home');
  if (raw.startsWith('~/')) return path.join(app.getPath('home'), raw.slice(2));
  return raw;
}

/**
 * Grant the selected folder to the running backend as a native caller.
 *
 * POST /desktop/api/fs/root accepts a grant only when the per-run secret
 * arrives in X-Xavani-Native (raw). The secret stays in this process: it is
 * never handed to the renderer, and the renderer's webRequest injector adds
 * Authorization only, so a page request can never satisfy the grant check.
 */
async function grantWorkspace(absPath) {
  const generation = backendGeneration;
  const port = backendInfo ? Number(backendInfo.desktop_port) : 0;
  if (!controlSecret) return { ok: false, error: 'backend secret unavailable' };
  if (!Number.isInteger(port) || port <= 0) return { ok: false, error: 'backend not ready' };
  let init;
  try {
    init = buildGrantInit({ secret: controlSecret, root: expandHome(absPath) });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/desktop/api/fs/root',
      method: init.method,
      headers: {
        ...init.headers,
        // The surface auth middleware wants the bearer token; the grant route
        // wants the raw header. Both come from the same per-run secret.
        Authorization: 'Bearer ' + controlSecret,
        'Content-Length': Buffer.byteLength(init.body),
      },
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (generation !== backendGeneration) { settle({ ok: false, error: 'backend restarted during the grant' }); return; }
        let payload = null;
        try { payload = JSON.parse(body); } catch {}
        settle(parseGrantResponse(res.statusCode, payload));
      });
    });
    req.on('error', (err) => settle({ ok: false, error: err && err.message ? err.message : String(err) }));
    req.on('timeout', () => { req.destroy(); settle({ ok: false, error: 'workspace grant timed out' }); });
    req.end(init.body);
  });
}

/* ---------------- update check (GitHub releases, anonymous GET) ---------------- */

const UPDATE_REPO = 'enternovate/xavani-desktop';
let lastUpdateInfo = null;

function isNewer(remote, local) {
  const parse = (s) => String(s).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b, c] = parse(remote);
  const [x, y, z] = parse(local);
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c > z;
}

function fetchJson(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? require('node:https') : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'xavani-desktop', Accept: 'application/vnd.github+json' },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function checkForUpdates() {
  const fake = process.env.XAVANI_DESKTOP_FAKE_UPDATE;
  if (fake) {
    lastUpdateInfo = { current: app.getVersion(), latest: fake, updateAvailable: isNewer(fake, app.getVersion()), url: `https://github.com/${UPDATE_REPO}/releases/latest` };
    sendToWindow('update-info', lastUpdateInfo);
    return lastUpdateInfo;
  }
  const rel = await fetchJson(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
  if (!rel || !rel.tag_name) {
    lastUpdateInfo = { error: 'could not reach GitHub releases', current: app.getVersion(), updateAvailable: false };
    return lastUpdateInfo;
  }
  lastUpdateInfo = {
    current: app.getVersion(),
    latest: rel.tag_name,
    updateAvailable: isNewer(rel.tag_name, app.getVersion()),
    url: rel.html_url || `https://github.com/${UPDATE_REPO}/releases/latest`,
  };
  sendToWindow('update-info', lastUpdateInfo);
  return lastUpdateInfo;
}

// Update checking is opt-in: the renderer reports the user's stored choice and
// nothing is scheduled before that.
const autoUpdate = createAutoUpdateSchedule({ check: checkForUpdates });

function noticesPath() {
  const packaged = path.join(process.resourcesPath, 'app', 'THIRD_PARTY_NOTICES.md');
  if (fs.existsSync(packaged)) return packaged;
  const repo = path.join(__dirname, '..', 'THIRD_PARTY_NOTICES.md');
  return fs.existsSync(repo) ? repo : null;
}

function installSessionGates() {
  const isMainContents = (wc) => !!mainWindow && !mainWindow.isDestroyed() && wc === mainWindow.webContents;

  // The backend requires a per-run bearer token on both control surfaces. It
  // is injected here, in the main process, and never exposed to the renderer.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    delete headers['Authorization'];
    delete headers['authorization'];
    if (controlSecret && controlRequest(details, mainWebContentsId(), activeControlPorts())) {
      headers['Authorization'] = 'Bearer ' + controlSecret;
    }
    callback({ requestHeaders: headers });
  });

  // Voice input only: mic from the main window. Preview webviews get nothing.
  session.defaultSession.setPermissionCheckHandler(
    (wc, permission) => permission === 'media' && isMainContents(wc),
  );
  session.defaultSession.setPermissionRequestHandler(
    (wc, permission, cb) => cb(permission === 'media' && isMainContents(wc)),
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    show: false,
    backgroundColor: '#08090a',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 16, y: 18 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: true,
    },
  });
  // Preview webviews are untrusted: no preload, no node, sandboxed.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

  if (process.env.XAVANI_DESKTOP_TEST) {
    let spec = {};
    try { spec = JSON.parse(process.env.XAVANI_DESKTOP_TEST); } catch {}
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      if (spec.grant) {
        // Dev-only: drive the real grant route without a native dialog.
        const deadline = Date.now() + 20000;
        while (!backendInfo && Date.now() < deadline) await wait(200);
        const granted = await grantWorkspace(String(spec.grant));
        console.log('[test] grant:', JSON.stringify(granted));
      }
      await wait(spec.scriptDelay || 2500);
      if (spec.script) {
        await mainWindow.webContents.executeJavaScript(spec.script).catch((e) => console.error('[test-script]', e));
      }
      await wait(spec.shotDelay || 4000);
      const dump = await mainWindow.webContents.executeJavaScript(
        'JSON.stringify({errs: window.__errs || [], events: window.__events || [], nAssistant: document.querySelectorAll(".msg-assistant").length, nToolCards: document.querySelectorAll(".tool-card").length, msgs: document.querySelector("#messages") ? document.querySelector("#messages").innerText.slice(0, 600) : "NO #messages"})'
      ).catch((e) => `dump-failed: ${e}`);
      console.log('[test] dom-dump:', String(dump).slice(0, 1200));
      if (spec.shot) {
        const img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(spec.shot, img.toPNG());
        console.log('[test] shot saved:', spec.shot);
      }
      await wait(300);
      app.quit();
    })();
  }
}

function buildMenu() {
  const template = [
    ...(IS_MAC ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(IS_MAC ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    installSessionGates();
    // The native About panel names the product and the publisher (Task 24b).
    if (IS_MAC) {
      app.setAboutPanelOptions({
        applicationName: 'Xavani',
        applicationVersion: app.getVersion(),
        credits: 'Xavani Desktop by Enternovate. Third-party notices: THIRD_PARTY_NOTICES.md.',
      });
    }

    ipcMain.handle('runtime-info', (event) => {
      if (!trustedSender(event, mainWindow)) return null;
      return {
        platform: process.platform,
        electron: process.versions.electron,
        isDev: IS_DEV,
        backend: backendInfo,
        notices: noticesPath(),
      };
    });
    ipcMain.on('backend-restart', (event) => {
      if (!trustedSender(event, mainWindow)) return;
      stopBackend();
      startBackend();
    });
    ipcMain.handle('reveal-path', (event, p) => {
      if (!trustedSender(event, mainWindow)) return null;
      if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p);
      return null;
    });
    ipcMain.handle('open-external', (event, u) => {
      if (!trustedSender(event, mainWindow)) return null;
      if (typeof u === 'string' && /^https?:\/\//.test(u)) shell.openExternal(u);
      return null;
    });
    ipcMain.handle('set-zoom', (event, z) => {
      if (!trustedSender(event, mainWindow)) return null;
      const factor = Math.min(Math.max(Number(z) || 1, 0.5), 2);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.setZoomFactor(factor);
      return factor;
    });
    ipcMain.handle('check-for-updates', (event) => {
      if (!trustedSender(event, mainWindow)) return null;
      return checkForUpdates();
    });
    ipcMain.handle('set-auto-update', (event, enabled) => {
      if (!trustedSender(event, mainWindow)) return null;
      return autoUpdate.setEnabled(enabled);
    });
    ipcMain.handle('timeline-export', async (event, payload) => {
      if (!trustedSender(event, mainWindow)) return { canceled: true };
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        defaultPath: (payload && payload.defaultName) || 'xavani-timeline.json',
        filters: [{ name: 'Timeline JSON', extensions: ['json'] }],
      });
      if (canceled || !filePath) return { canceled: true };
      try {
        const fsx = require('node:fs');
        await fsx.promises.writeFile(filePath, String((payload && payload.content) || ''), 'utf-8');
        return { canceled: false, filePath };
      } catch (err) {
        return { canceled: false, error: String(err) };
      }
    });

    /* ---- capture adapter (task 23): OS permission + temp file owned here ---- */
    const recording = require('./recording');
    const fsMod = require('node:fs');
    const pathMod = require('node:path');
    let capture = null;
    let pendingSourceId = '';

    function captureSnapshot() {
      if (!capture) return { state: 'idle', bytes: 0, elapsedMs: 0 };
      return {
        state: capture.state,
        bytes: capture.bytes,
        elapsedMs: Date.now() - capture.startedAt,
        tempPath: capture.tempPath,
      };
    }

    function captureEndStream() {
      if (capture && capture.stream) {
        try { capture.stream.end(); } catch { /* already closed */ }
      }
    }

    try {
      // The documented current flow: the main process answers a display
      // media request with the user's chosen source. No capture and no OS
      // prompt happens before an explicit Start gesture.
      session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer.getSources({ types: ['screen', 'window'] })
          .then((sources) => {
            const chosen = sources.find((s) => s.id === pendingSourceId) || sources[0];
            callback(chosen ? { video: chosen, audio: false } : {});
          })
          .catch(() => callback({}));
      });
    } catch { /* the session may not exist in some dev contexts */ }

    ipcMain.handle('capture-sources', async (event) => {
      if (!trustedSender(event, mainWindow)) return [];
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        return sources.map((source) => ({ id: source.id, name: source.name }));
      } catch (err) {
        return { error: String(err) };
      }
    });

    ipcMain.handle('capture-start', async (event, sourceId) => {
      if (!trustedSender(event, mainWindow)) return { error: 'untrusted' };
      if (capture) return { error: 'capture already active' };
      if (!sourceId) return { error: 'select a capture source first' };
      const tempDir = pathMod.join(app.getPath('temp'), 'xavani-capture');
      fsMod.mkdirSync(tempDir, { recursive: true });
      const tempPath = pathMod.join(tempDir, `capture-${Date.now()}.webm`);
      capture = {
        state: 'requesting',
        bytes: 0,
        startedAt: Date.now(),
        tempPath,
        stream: fsMod.createWriteStream(tempPath),
        limitMonitor: null,
      };
      pendingSourceId = String(sourceId);
      capture.limitMonitor = recording.createCaptureLimitMonitor({
        getMeasurement: () => ({
          elapsedMs: capture ? Date.now() - capture.startedAt : 0,
          bytes: capture ? capture.bytes : 0,
        }),
        onLimit: () => {
          if (!capture) return;
          if (capture.state === 'recording' || capture.state === 'paused') {
            captureEndStream();
            capture.state = recording.transitionRecording(capture.state, 'limit');
            sendToWindow('capture-state', captureSnapshot());
          }
        },
      });
      sendToWindow('capture-state', captureSnapshot());
      return captureSnapshot();
    });

    ipcMain.handle('capture-chunk', async (event, chunk) => {
      if (!trustedSender(event, mainWindow)) return { error: 'untrusted' };
      if (!capture || !capture.stream) return { error: 'no active capture' };
      if (capture.state === 'requesting') capture.state = recording.transitionRecording('requesting', 'granted');
      const buffer = Buffer.from(chunk);
      capture.bytes += buffer.byteLength;
      const okToContinue = capture.stream.write(buffer); // bounded chunk writes
      if (!okToContinue) {
        await new Promise((resolve) => capture.stream.once('drain', resolve)); // backpressure
      }
      return { bytes: capture.bytes };
    });

    ipcMain.handle('capture-stop', (event) => {
      if (!trustedSender(event, mainWindow)) return { error: 'untrusted' };
      if (!capture) return captureSnapshot();
      captureEndStream();
      if (capture.limitMonitor) capture.limitMonitor.stop();
      if (capture.state === 'recording' || capture.state === 'paused') {
        capture.state = recording.transitionRecording(capture.state, 'stop');
      }
      sendToWindow('capture-state', captureSnapshot());
      return captureSnapshot();
    });

    ipcMain.handle('capture-save', async (event) => {
      if (!trustedSender(event, mainWindow)) return { canceled: true };
      if (!capture || !capture.tempPath || !fsMod.existsSync(capture.tempPath)) {
        return { canceled: false, error: 'no recording to save' };
      }
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        defaultPath: 'xavani-capture.webm',
        filters: [{ name: 'WebM video', extensions: ['webm'] }],
      });
      if (canceled || !filePath) {
        // Cancelled save retains the temporary recording for retry or discard.
        return { canceled: true };
      }
      try {
        await fsMod.promises.copyFile(capture.tempPath, filePath);
        captureEndStream();
        await fsMod.promises.unlink(capture.tempPath).catch(() => {});
        capture.state = 'saved';
        sendToWindow('capture-state', captureSnapshot());
        return { canceled: false, filePath };
      } catch (err) {
        return { canceled: false, error: String(err) };
      }
    });

    ipcMain.handle('capture-discard', async (event) => {
      if (!trustedSender(event, mainWindow)) return { error: 'untrusted' };
      if (capture) {
        captureEndStream();
        if (capture.limitMonitor) capture.limitMonitor.stop();
        await fsMod.promises.unlink(capture.tempPath).catch(() => {});
      }
      capture = null;
      pendingSourceId = '';
      sendToWindow('capture-state', captureSnapshot());
      return captureSnapshot();
    });

    ipcMain.handle('choose-workspace', async (event) => {
      if (!trustedSender(event, mainWindow)) return null;
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose a workspace folder',
        properties: ['openDirectory'],
      });
      if (!picked || picked.canceled || !Array.isArray(picked.filePaths) || !picked.filePaths.length) {
        return { cancelled: true };
      }
      const result = await grantWorkspace(picked.filePaths[0]);
      if (!result.ok) {
        // The secret is never logged; the route's refusal text is enough.
        console.error('[xavani] workspace grant refused:', result.error);
        return result;
      }
      sendToWindow('workspace-granted', { root: result.root });
      return result;
    });

    createWindow();
    startBackend();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopBackend();
  });
}
