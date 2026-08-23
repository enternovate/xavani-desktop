'use strict';

const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const IS_MAC = process.platform === 'darwin';
const IS_DEV = !!process.env.XAVANI_DESKTOP_DEV;

let mainWindow = null;
let backend = null;
let backendInfo = null;
let restartAttempts = 0;
let quitting = false;

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
  backend = spawn(spec.cmd, spec.args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdoutBuf = '';
  backend.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.ready) {
          backendInfo = parsed;
          restartAttempts = 0;
          probeReady(parsed.api_port, parsed.desktop_port);
        } else {
          sendToWindow('backend-exit', { error: parsed.error || 'backend failed to start' });
        }
      } catch {}
    }
  });
  backend.stderr.on('data', (chunk) => {
    if (restartAttempts > 0) console.error('[xavani-backend]', chunk.toString().slice(0, 2000));
  });
  backend.on('exit', (code) => {
    backend = null;
    if (!quitting) {
      sendToWindow('backend-exit', { code });
      scheduleRestart();
    }
  });
}

let probing = false;
let backendReadySent = false;
function probeReady(apiPort, desktopPort) {
  if (probing || backendReadySent) return;
  probing = true;
  const attempt = (n) => {
    if (backendReadySent || !backend) { probing = false; return; }
    let settled = false;
    const retryOnce = () => {
      if (settled || backendReadySent) return;
      settled = true;
      setTimeout(() => attempt(n + 1), 300);
    };
    const req = http.get({ host: '127.0.0.1', port: apiPort, path: '/health', timeout: 1500 }, (res) => {
      res.resume();
      if (settled) return;
      if (res.statusCode === 200) {
        settled = true;
        probing = false;
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

/* ---------------- update check (GitHub releases, anonymous GET) ---------------- */

const UPDATE_REPO = 'enternovate/xavani-desktop';
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
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
    const req = http.get(url, {
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
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

  if (process.env.XAVANI_DESKTOP_TEST) {
    let spec = {};
    try { spec = JSON.parse(process.env.XAVANI_DESKTOP_TEST); } catch {}
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
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

    ipcMain.handle('runtime-info', () => ({
      platform: process.platform,
      electron: process.versions.electron,
      isDev: IS_DEV,
      backend: backendInfo,
    }));
    ipcMain.on('backend-restart', () => { stopBackend(); startBackend(); });
    ipcMain.handle('reveal-path', (_e, p) => {
      if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p);
    });
    ipcMain.handle('open-external', (_e, u) => {
      if (typeof u === 'string' && /^https?:\/\//.test(u)) shell.openExternal(u);
    });
    ipcMain.handle('set-zoom', (_e, z) => {
      const factor = Math.min(Math.max(Number(z) || 1, 0.5), 2);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.setZoomFactor(factor);
      return factor;
    });
    ipcMain.handle('check-for-updates', () => checkForUpdates());

    createWindow();
    startBackend();
    setInterval(checkForUpdates, UPDATE_INTERVAL_MS);
    setTimeout(checkForUpdates, 8000);

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
