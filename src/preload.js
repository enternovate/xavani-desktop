'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xavaniDesktop', {
  runtime: () => ipcRenderer.invoke('runtime-info'),
  chooseWorkspace: () => ipcRenderer.invoke('choose-workspace'),
  onBackendReady: (cb) => ipcRenderer.on('backend-ready', (_e, info) => cb(info)),
  onBackendExit: (cb) => ipcRenderer.on('backend-exit', (_e, info) => cb(info)),
  restartBackend: () => ipcRenderer.send('backend-restart'),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  openExternal: (u) => ipcRenderer.invoke('open-external', u),
  setZoom: (z) => ipcRenderer.invoke('set-zoom', z),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  setAutoUpdate: (enabled) => ipcRenderer.invoke('set-auto-update', enabled),
  exportTimeline: (payload) => ipcRenderer.invoke('timeline-export', payload),
  listCaptureSources: () => ipcRenderer.invoke('capture-sources'),
  startCapture: (sourceId) => ipcRenderer.invoke('capture-start', sourceId),
  writeCaptureChunk: (buffer) => ipcRenderer.invoke('capture-chunk', buffer),
  stopCapture: () => ipcRenderer.invoke('capture-stop'),
  saveCapture: () => ipcRenderer.invoke('capture-save'),
  discardCapture: () => ipcRenderer.invoke('capture-discard'),
  onCaptureState: (cb) => ipcRenderer.on('capture-state', (_e, info) => cb(info)),
  onUpdateInfo: (cb) => ipcRenderer.on('update-info', (_e, info) => cb(info)),
  quit: () => ipcRenderer.send('app-quit'),
});
