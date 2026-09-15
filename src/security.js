'use strict';

/* Request/sender gates for the desktop control surface. Pure helpers so the
   security rules are unit-testable without booting Electron. */

const CONTROL_PROTOCOLS = new Set(['http:', 'ws:']);
const LOOPBACK_HOST = '127.0.0.1';

/**
 * True only for a loopback control request issued by the main window to one of
 * the current backend's ports. Everything else is denied: no external hosts,
 * no TLS, no urls carrying credentials, no stale webContents.
 */
function controlRequest(details, webContentsId, ports) {
  if (!details || typeof details.url !== 'string') return false;
  if (!(ports instanceof Set) || ports.size === 0) return false;

  const expectedId = Number(webContentsId);
  if (!Number.isInteger(expectedId) || expectedId < 0) return false;
  if (Number(details.webContentsId) !== expectedId) return false;

  let url;
  try {
    url = new URL(details.url);
  } catch {
    return false;
  }

  if (!CONTROL_PROTOCOLS.has(url.protocol)) return false;
  if (url.hostname !== LOOPBACK_HOST) return false;
  if (url.username || url.password) return false;
  if (!url.port) return false;
  return ports.has(Number(url.port));
}

/**
 * True only for IPC that came from the live main window's main frame — not a
 * webview, not a subframe, not a destroyed window.
 */
function trustedSender(event, window) {
  if (!event || !window) return false;
  if (typeof window.isDestroyed !== 'function' || window.isDestroyed()) return false;
  const contents = window.webContents;
  if (!contents) return false;
  if (event.sender !== contents) return false;
  const frame = event.senderFrame;
  return !!frame && frame === contents.mainFrame;
}

module.exports = { controlRequest, trustedSender };
