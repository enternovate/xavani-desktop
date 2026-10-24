'use strict';

/* R1 Task 11b — the native workspace grant request.
   The grant route (POST /desktop/api/fs/root) demands the per-run secret in
   X-Xavani-Native, raw: the renderer's webRequest injector only ever adds
   Authorization, so the renderer cannot mint a grant. These tests pin the two
   pure helpers main.js builds and parses the grant with. */

const test = require('node:test');
const assert = require('node:assert');

const { buildGrantInit, parseGrantResponse } = require('../../src/workspace-grant');

const SECRET = 'a'.repeat(64);
const ROOT = '/tmp/xavani-ws-demo';

test('buildGrantInit posts the selected path as a native grant', () => {
  const init = buildGrantInit({ secret: SECRET, root: ROOT });
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  // `root` is the key the grant route reads; `path` is the documented alias.
  assert.deepEqual(JSON.parse(init.body), { root: ROOT, path: ROOT, granted_by: 'native' });
});

test('buildGrantInit puts the raw secret in X-Xavani-Native', () => {
  const init = buildGrantInit({ secret: SECRET, root: ROOT });
  assert.equal(init.headers['X-Xavani-Native'], SECRET);
});

test('buildGrantInit never uses the Authorization scheme the renderer injects', () => {
  const init = buildGrantInit({ secret: SECRET, root: ROOT });
  assert.equal(init.headers.Authorization, undefined);
  assert.equal(init.headers.authorization, undefined);
  assert.equal(init.headers['X-Xavani-Native'].startsWith('Bearer'), false);
});

test('buildGrantInit refuses a missing or empty secret', () => {
  for (const secret of [undefined, null, '', '   ', 12345]) {
    assert.throws(() => buildGrantInit({ secret, root: ROOT }), TypeError);
  }
});

test('buildGrantInit refuses a missing or empty path', () => {
  for (const root of [undefined, null, '', '   ']) {
    assert.throws(() => buildGrantInit({ secret: SECRET, root }), TypeError);
  }
});

test('parseGrantResponse accepts the acked realpath', () => {
  const result = parseGrantResponse(200, { ok: true, root: '/private/tmp/xavani-ws-demo', granted: true, generation: 2 });
  assert.deepEqual(result, { ok: true, root: '/private/tmp/xavani-ws-demo' });
});

test('parseGrantResponse rejects a 200 that carries no root', () => {
  for (const payload of [{ ok: true, root: '' }, { ok: true }, {}, null, 'nope']) {
    const result = parseGrantResponse(200, payload);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
  }
});

test('parseGrantResponse surfaces the Workspace required refusal', () => {
  const result = parseGrantResponse(428, { error: 'Workspace required', granted: false });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Workspace required');
});

test('parseGrantResponse surfaces a non-native grant refusal', () => {
  const result = parseGrantResponse(403, { error: 'A native workspace selection is required.' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'A native workspace selection is required.');
});

test('parseGrantResponse surfaces the surface-auth refusal', () => {
  const result = parseGrantResponse(401, { error: 'Unauthorized.' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Unauthorized.');
});

test('parseGrantResponse falls back to the status when the body is unreadable', () => {
  for (const payload of [null, '<html>', 42]) {
    const result = parseGrantResponse(500, payload);
    assert.equal(result.ok, false);
    assert.match(result.error, /500/);
  }
});

test('parseGrantResponse never reports ok for a non-200', () => {
  for (const status of [201, 204, 400, 403, 428, 500]) {
    assert.equal(parseGrantResponse(status, { ok: true, root: ROOT }).ok, false);
  }
});
