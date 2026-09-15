'use strict';

/* R2 Task 15 — the editor adapter contract (Code Pack L + the Task 15
   microcycle extensions). Runs against a mock monaco: no DOM, no Electron,
   no filesystem. The real integration is covered by e2e/editor.spec.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createEditorAdapter } = require('../../src/renderer/editor-adapter');

const ADAPTER_SRC = path.join(__dirname, '../../src/renderer/editor-adapter.js');

function makeMockMonaco() {
  const created = { models: [], diffs: [] };
  const disposed = { models: [], diffs: [] };
  const markers = [];

  function makeModel(value, uri) {
    let text = value;
    let version = 1;
    const model = {
      uri,
      getValue: () => text,
      setValue: (v) => { text = v; version += 1; },
      getVersionId: () => version,
      type: (v) => { text = v; version += 1; }, // simulates a user edit
      dispose: () => { disposed.models.push(uri && uri.path); },
    };
    created.models.push(model);
    return model;
  }

  const editor = {
    calls: { setModel: [], savedViews: 0, restoredViews: [] },
    setModel: (m) => editor.calls.setModel.push(m ? m.uri.path : null),
    saveViewState: () => { editor.calls.savedViews += 1; return { view: editor.calls.savedViews }; },
    restoreViewState: (v) => editor.calls.restoredViews.push(v),
    dispose: () => {},
  };

  return {
    _created: created,
    _disposed: disposed,
    _markers: markers,
    _editor: editor,
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    Uri: { file: (p) => ({ path: p }) },
    editor: {
      create: () => editor,
      createModel: (v, _lang, uri) => makeModel(v, uri),
      createDiffEditor: () => {
        const d = { _pair: null, setModel: (p) => { d._pair = p; }, dispose: () => disposed.diffs.push(true) };
        created.diffs.push(d);
        return d;
      },
      setModelMarkers: (model, owner, list) => markers.push({ model, owner, list }),
    },
  };
}

function makeHarness(saveFileImpl) {
  const monaco = makeMockMonaco();
  const host = {};
  const saves = [];
  const saveFile = async (p, content, revision) => {
    saves.push({ p, content, revision });
    if (saveFileImpl) return saveFileImpl(p, content, revision);
    return { revision: `rev-${saves.length}` };
  };
  const adapter = createEditorAdapter(monaco, host, saveFile);
  return { monaco, host, adapter, saves };
}

// ── 1. Open a UTF-8 file through the workspace API payload ──

test('openFile builds a model from the file payload, never from the disk', () => {
  const { monaco, adapter } = makeHarness();
  adapter.openFile({ path: 'src/a.py', content: 'print("héllo")\n', revision: 'r1' });
  assert.equal(monaco._created.models.length, 1);
  assert.equal(monaco._created.models[0].getValue(), 'print("héllo")\n');
  assert.deepEqual(monaco._created.models[0].uri, { path: 'src/a.py' });
  assert.equal(adapter.activePath(), 'src/a.py');
  assert.deepEqual(adapter.openPaths(), ['src/a.py']);
});

test('the adapter never touches the filesystem itself', () => {
  const src = fs.readFileSync(ADAPTER_SRC, 'utf8');
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /XMLHttpRequest/);
  assert.doesNotMatch(src, /process\./);
});

// ── 2. Two independent tab buffers ──

test('two open files keep independent buffers and view states', () => {
  const { monaco, adapter } = makeHarness();
  adapter.openFile({ path: 'src/a.py', content: 'A1', revision: 'r1' });
  const modelA = monaco._created.models[0];
  adapter.openFile({ path: 'src/b.py', content: 'B1', revision: 'r1' });
  const modelB = monaco._created.models[1];

  modelA.type('A2'); // edits land on A while B is displayed
  assert.equal(modelA.getValue(), 'A2');
  assert.equal(modelB.getValue(), 'B1');
  assert.equal(monaco._disposed.models.length, 0); // nothing leaked on switch

  adapter.openFile({ path: 'src/a.py', content: 'IGNORED', revision: 'r1' });
  const calls = monaco._editor.calls;
  assert.equal(calls.setModel[calls.setModel.length - 1], 'src/a.py');
  assert.equal(modelA.getValue(), 'A2'); // the buffer survived the round trip
  assert.equal(calls.savedViews, 2); // A's view saved on focus loss, B's on the way back
  assert.equal(calls.restoredViews.length, 1); // ...and A's restored on return
  assert.equal(adapter.isDirty('src/a.py'), true);
  assert.equal(adapter.isDirty('src/b.py'), false);
});

// ── 3. Save through expected-revision checks ──

test('saveActive submits the exact revision and tracks the new one', async () => {
  const { adapter, saves } = makeHarness();
  adapter.openFile({ path: 'src/a.py', content: 'one', revision: 'r1' });
  const result = await adapter.saveActive();
  assert.deepEqual(saves[0], { p: 'src/a.py', content: 'one', revision: 'r1' });
  assert.equal(result.revision, 'rev-1');
  assert.equal(adapter.isDirty(), false);

  // A second save carries the revision the first save returned.
  await adapter.saveActive();
  assert.equal(saves[1].revision, 'rev-1');
});

test('a conflicted save leaves the buffer, revision, and dirty flag intact', async () => {
  const { monaco, adapter, saves } = makeHarness(() => { throw new Error('409 conflict'); });
  adapter.openFile({ path: 'src/a.py', content: 'one', revision: 'r1' });
  monaco._created.models[0].type('two');
  await assert.rejects(() => adapter.saveActive(), /409 conflict/);
  assert.equal(adapter.isDirty(), true); // the user's buffer is never lost
  await assert.rejects(() => adapter.saveActive(), /409 conflict/);
  assert.equal(saves[1].revision, 'r1'); // the stale revision was not consumed
});

test('typing during a save keeps the buffer dirty after it', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { monaco, adapter } = makeHarness(async () => { await gate; return { revision: 'rev-x' }; });
  adapter.openFile({ path: 'src/a.py', content: 'one', revision: 'r1' });
  const pending = adapter.saveActive();
  monaco._created.models[0].type('one plus more');
  release();
  await pending;
  assert.equal(adapter.isDirty(), true); // base only advanced to what was submitted
});

// ── 4. A side-by-side diff that never modifies files ──

test('openDiff uses immutable snapshots and disposes both models on close', () => {
  const { monaco, adapter, saves } = makeHarness();
  adapter.openFile({ path: 'src/a.py', content: 'now', revision: 'r1' });
  adapter.openDiff('src/a.py', 'before text', 'after text');
  assert.equal(monaco._created.diffs.length, 1);
  const pair = monaco._created.diffs[0]._pair;
  assert.equal(pair.original.getValue(), 'before text');
  assert.equal(pair.modified.getValue(), 'after text');
  assert.equal(saves.length, 0); // the diff touched no file

  const before = monaco._disposed.models.length;
  adapter.closeDiff();
  assert.equal(monaco._disposed.models.length, before + 2); // both models disposed
  assert.equal(monaco._disposed.diffs.length, 1);
  assert.equal(adapter.isDirty(), false); // the buffer came back untouched
});

// ── 5. Diagnostics map to exact file and line, version-guarded ──

test('diagnostics translate zero-based ranges and only attach on version match', () => {
  const { monaco, adapter } = makeHarness();
  adapter.openFile({ path: 'src/a.py', content: 'x', revision: 'r1' });
  const version = adapter.modelVersion('src/a.py');
  const ok = adapter.setDiagnostics('src/a.py', [{
    range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
    severity: 1, message: 'undefined name', source: 'pylsp',
  }], version);
  assert.equal(ok, true);
  const entry = monaco._markers[monaco._markers.length - 1];
  assert.equal(entry.owner, 'lsp');
  assert.deepEqual(entry.list[0], {
    severity: 8, message: 'undefined name', source: 'pylsp',
    startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 10,
  });

  // A stale document version never reaches the model.
  const count = monaco._markers.length;
  assert.equal(adapter.setDiagnostics('src/a.py', [{ range: {}, severity: 1, message: 'stale' }], version - 1), false);
  assert.equal(monaco._markers.length, count);

  // With no server data the markers clear.
  assert.equal(adapter.setDiagnostics('src/a.py', [], adapter.modelVersion('src/a.py')), true);
  assert.deepEqual(monaco._markers[monaco._markers.length - 1].list, []);
});

// ── 7. Closing tabs disposes models (no leak) ──

test('closeFile disposes the model and dispose() leaves nothing behind', () => {
  const { monaco, adapter } = makeHarness();
  adapter.openFile({ path: 'src/a.py', content: 'A', revision: 'r1' });
  adapter.openFile({ path: 'src/b.py', content: 'B', revision: 'r1' });
  adapter.closeFile('src/b.py');
  assert.deepEqual(adapter.openPaths(), ['src/a.py']);
  assert.deepEqual(monaco._disposed.models, ['src/b.py']);
  adapter.closeFile('src/b.py'); // second close is a no-op

  adapter.closeFile('src/a.py'); // closing the active tab clears the editor model
  const setModels = monaco._editor.calls.setModel;
  assert.equal(setModels[setModels.length - 1], null);

  adapter.openFile({ path: 'src/c.py', content: 'C', revision: 'r1' });
  adapter.dispose();
  assert.equal(adapter.openPaths().length, 0);
  assert.equal(monaco._disposed.models.length, 3); // every model disposed exactly once
});

test('a dirty buffer refuses to close silently', () => {
  const { monaco, adapter } = makeHarness();
  adapter.openFile({ path: 'src/a.py', content: 'A', revision: 'r1' });
  monaco._created.models[0].type('A changed');
  assert.throws(() => adapter.closeFile('src/a.py'), /Save or discard the buffer before close\./);
  assert.deepEqual(adapter.openPaths(), ['src/a.py']); // still open, still dirty
});

// ── 8. Reopening restores fresh content, never the old buffer ──

test('a reopened tab reads the new payload, not the disposed buffer', () => {
  const { monaco, adapter } = makeHarness();
  adapter.openFile({ path: 'notes.md', content: 'SECRET=old', revision: 'r1' });
  adapter.closeFile('notes.md');
  adapter.openFile({ path: 'notes.md', content: 'public', revision: 'r2' });
  const last = monaco._created.models[monaco._created.models.length - 1];
  assert.equal(last.getValue(), 'public');
  assert.equal(adapter.isDirty('notes.md'), false);
});

// ── Host primitive: adopt forced/disk content as the clean base ──

test('rebaseFile adopts forced content as the new clean base', async () => {
  const { monaco, adapter, saves } = makeHarness();
  adapter.openFile({ path: 'src/a.py', content: 'old', revision: 'r1' });
  monaco._created.models[0].type('mine');
  assert.equal(adapter.isDirty(), true);
  assert.equal(adapter.rebaseFile('src/a.py', 'disk version', 'r9'), true);
  assert.equal(adapter.isDirty(), false);
  assert.equal(monaco._created.models[0].getValue(), 'disk version');
  await adapter.saveActive();
  assert.equal(saves[0].revision, 'r9'); // the rebased revision is what a save carries
  assert.equal(adapter.rebaseFile('src/none.py', 'x', 'r1'), false);
});
