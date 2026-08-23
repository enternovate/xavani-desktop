'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xavaniDesktop', {
  runtime: () => ipcRenderer.invoke('runtime-info'),
  onBackendReady: (cb) => ipcRenderer.on('backend-ready', (_e, info) => cb(info)),
  onBackendExit: (cb) => ipcRenderer.on('backend-exit', (_e, info) => cb(info)),
  restartBackend: () => ipcRenderer.send('backend-restart'),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  openExternal: (u) => ipcRenderer.invoke('open-external', u),
  setZoom: (z) => ipcRenderer.invoke('set-zoom', z),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdateInfo: (cb) => ipcRenderer.on('update-info', (_e, info) => cb(info)),
  quit: () => ipcRenderer.send('app-quit'),
});
