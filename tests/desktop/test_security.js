'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { controlRequest, trustedSender } = require('../../src/security');

const WID = 7;
const PORTS = new Set([8642, 8643]);

function details(over = {}) {
  return {
    url: 'http://127.0.0.1:8642/desktop/api/state',
    webContentsId: WID,
    method: 'GET',
    requestHeaders: {},
    resourceType: 'xhr',
    ...over,
  };
}

test('allows http on the loopback control port', () => {
  assert.equal(controlRequest(details(), WID, PORTS), true);
});

test('allows ws on the loopback control port', () => {
  const d = details({ url: 'ws://127.0.0.1:8643/desktop/term', resourceType: 'websocket' });
  assert.equal(controlRequest(d, WID, PORTS), true);
});

test('denies https even on the right host and port', () => {
  assert.equal(controlRequest(details({ url: 'https://127.0.0.1:8642/x' }), WID, PORTS), false);
});

test('denies wss even on the right host and port', () => {
  assert.equal(controlRequest(details({ url: 'wss://127.0.0.1:8643/desktop/term' }), WID, PORTS), false);
});

test('denies a foreign host', () => {
  for (const url of [
    'http://example.com:8642/x',
    'http://localhost:8642/x',
    'http://127.0.0.1.evil.example:8642/x',
    'http://[::1]:8642/x',
  ]) {
    assert.equal(controlRequest(details({ url }), WID, PORTS), false, url);
  }
});

test('denies a port outside the active set', () => {
  assert.equal(controlRequest(details({ url: 'http://127.0.0.1:9000/x' }), WID, PORTS), false);
});

test('denies a loopback url with no explicit port', () => {
  assert.equal(controlRequest(details({ url: 'http://127.0.0.1/x' }), WID, PORTS), false);
});

test('denies an empty port set', () => {
  assert.equal(controlRequest(details(), WID, new Set()), false);
});

test('denies another webContents', () => {
  assert.equal(controlRequest(details({ webContentsId: WID + 1 }), WID, PORTS), false);
  assert.equal(controlRequest(details({ webContentsId: undefined }), WID, PORTS), false);
  assert.equal(controlRequest(details(), 7 - 8, PORTS), false);
});

test('denies urls carrying credentials', () => {
  assert.equal(controlRequest(details({ url: 'http://user:pw@127.0.0.1:8642/x' }), WID, PORTS), false);
  assert.equal(controlRequest(details({ url: 'ws://user@127.0.0.1:8643/desktop/term' }), WID, PORTS), false);
});

test('denies malformed or non-http urls', () => {
  for (const url of ['', 'not a url', 'http://', 'http://:', 'file:///etc/passwd', 'blob:http://127.0.0.1:8642/x', 'about:blank']) {
    assert.equal(controlRequest(details({ url }), WID, PORTS), false, JSON.stringify(url));
  }
});

test('denies malformed details', () => {
  assert.equal(controlRequest(null, WID, PORTS), false);
  assert.equal(controlRequest(undefined, WID, PORTS), false);
  assert.equal(controlRequest(details({ url: 42 }), WID, PORTS), false);
});

test('denies every url when there is no live main webContents', () => {
  assert.equal(controlRequest(details(), -1, PORTS), false);
});

function fakeWindow({ destroyed = false, mainFrame = { routingId: 1 } } = {}) {
  const webContents = { id: WID, mainFrame, isDestroyed: () => destroyed };
  return { isDestroyed: () => destroyed, webContents };
}

test('trusts the main frame of the live main window', () => {
  const win = fakeWindow();
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  assert.equal(trustedSender(event, win), true);
});

test('rejects a different sender', () => {
  const win = fakeWindow();
  const event = { sender: { id: 99 }, senderFrame: win.webContents.mainFrame };
  assert.equal(trustedSender(event, win), false);
});

test('rejects a subframe sender', () => {
  const win = fakeWindow();
  const event = { sender: win.webContents, senderFrame: { routingId: 2 } };
  assert.equal(trustedSender(event, win), false);
});

test('rejects a null senderFrame', () => {
  const win = fakeWindow();
  assert.equal(trustedSender({ sender: win.webContents, senderFrame: null }, win), false);
  assert.equal(trustedSender({ sender: win.webContents }, win), false);
});

test('rejects a destroyed window', () => {
  const win = fakeWindow({ destroyed: true });
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  assert.equal(trustedSender(event, win), false);
});

test('rejects missing window or event', () => {
  const win = fakeWindow();
  assert.equal(trustedSender({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, null), false);
  assert.equal(trustedSender(null, win), false);
  assert.equal(trustedSender(undefined, undefined), false);
});
