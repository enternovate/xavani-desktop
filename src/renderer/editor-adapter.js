'use strict';

/* Code Pack L — the editor adapter contract (R2 Task 15).
   One Monaco instance, one models map, revisions carried per tab. Every
   file read arrives as a payload and every write goes through the host's
   saveFile adapter — Monaco never touches the filesystem directly.

   Extensions beyond the pack text, each mapped to a Task 15 microcycle:
   - activePath / openPaths / modelVersion: read-only accessors for the shell.
   - setDiagnostics: zero-based LSP ranges become one-based Monaco markers,
     attached only when the buffer version matches the document version.
   - openDiff / closeDiff: side-by-side snapshots; both models are disposed
     when the diff closes and every open buffer is left untouched. */
(function expose(root) {
  function createEditorAdapter(monaco, host, saveFile) {
    const models = new Map();
    const editor = monaco.editor.create(host, {
      automaticLayout: true, fontSize: 13, lineHeight: 20,
      minimap: { enabled: false }, scrollBeyondLastLine: false,
    });
    let active = null;
    let diff = null;

    function openFile(file) {
      if (!models.has(file.path)) {
        const model = monaco.editor.createModel(file.content, undefined, monaco.Uri.file(file.path));
        models.set(file.path, { model, revision: file.revision, base: file.content, view: null });
      }
      if (active) models.get(active).view = editor.saveViewState();
      active = file.path;
      const tab = models.get(active);
      editor.setModel(tab.model);
      if (tab.view) editor.restoreViewState(tab.view);
    }

    async function saveActive() {
      if (!active) return null;
      const path = active;
      const tab = models.get(path);
      const submitted = tab.model.getValue();
      const result = await saveFile(path, submitted, tab.revision);
      tab.revision = result.revision;
      tab.base = submitted;
      return result;
    }

    function isDirty(path = active) {
      const tab = models.get(path);
      return Boolean(tab && tab.model.getValue() !== tab.base);
    }

    function closeFile(path) {
      const tab = models.get(path);
      if (!tab) return;
      if (isDirty(path)) throw new Error('Save or discard the buffer before close.');
      if (active === path) {
        active = null;
        editor.setModel(null);
      }
      tab.model.dispose();
      models.delete(path);
    }

    function dispose() {
      closeDiff();
      for (const tab of models.values()) tab.model.dispose();
      models.clear();
      editor.dispose();
      active = null;
    }

    // ── Task 15 extensions ───────────────────────────────────────────────

    function activePath() { return active; }

    function openPaths() { return Array.from(models.keys()); }

    function modelVersion(path = active) {
      const tab = models.get(path);
      return tab ? tab.model.getVersionId() : null;
    }

    // LSP DiagnosticSeverity (1..4) → Monaco MarkerSeverity (8..1).
    const SEVERITY_TO_MARKER = { 1: 8, 2: 4, 3: 2, 4: 1 };

    function setDiagnostics(path, diagnostics, documentVersion) {
      const tab = models.get(path);
      if (!tab) return false;
      if (tab.model.getVersionId() !== documentVersion) return false;
      const markers = (diagnostics || []).map((d) => {
        const range = d.range || {};
        const start = range.start || {};
        const end = range.end || {};
        return {
          severity: SEVERITY_TO_MARKER[d.severity] || 8,
          message: String(d.message || ''),
          source: d.source ? String(d.source) : 'lsp',
          startLineNumber: Number(start.line || 0) + 1,
          startColumn: Number(start.character || 0) + 1,
          endLineNumber: Number(end.line || 0) + 1,
          endColumn: Number(end.character || 0) + 1,
        };
      });
      monaco.editor.setModelMarkers(tab.model, 'lsp', markers);
      return true;
    }

    function openDiff(path, before, after) {
      closeDiff();
      const beforeModel = monaco.editor.createModel(before, undefined, monaco.Uri.file(`${path}.before`));
      const afterModel = monaco.editor.createModel(after, undefined, monaco.Uri.file(`${path}.after`));
      const diffEditor = monaco.editor.createDiffEditor(host, {
        automaticLayout: true, readOnly: true, renderSideBySide: true,
        fontSize: 13, lineHeight: 20, minimap: { enabled: false },
      });
      diffEditor.setModel({ original: beforeModel, modified: afterModel });
      const previous = active;
      editor.setModel(null);
      active = null;
      diff = { editor: diffEditor, beforeModel, afterModel, previous };
      return diffEditor;
    }

    function closeDiff() {
      if (!diff) return;
      const { editor: diffEditor, beforeModel, afterModel, previous } = diff;
      diff = null;
      diffEditor.dispose();
      beforeModel.dispose();
      afterModel.dispose();
      if (previous && models.has(previous)) {
        active = previous;
        const tab = models.get(previous);
        editor.setModel(tab.model);
        if (tab.view) editor.restoreViewState(tab.view);
      }
    }

    // Adopt external content (a forced overwrite or a reload from disk) as
    // the new clean base. The host decides when the buffer is discarded.
    function rebaseFile(path, content, revision) {
      const tab = models.get(path);
      if (!tab) return false;
      tab.model.setValue(content);
      tab.base = content;
      tab.revision = revision;
      return true;
    }

    return {
      openFile, saveActive, isDirty, closeFile, dispose, editor,
      activePath, openPaths, modelVersion, setDiagnostics, openDiff, closeDiff,
      rebaseFile,
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createEditorAdapter };
  else root.XavaniEditor = { createEditorAdapter };
})(globalThis);
