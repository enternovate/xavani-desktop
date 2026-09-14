'use strict';

/* Code Pack K — the workbench state reducer.
   One source of truth for the dock, the follow flag, and the pane layout.
   Layout preferences are remembered per workspace; every restored size is
   clamped to the range in the desktop specification and to the viewport it
   returns into. Nothing here persists or reads anything itself. */
(function expose(root) {
  // Desktop specification: initial sizes and ranges, in CSS px.
  var LAYOUT_DEFAULTS = { explorerWidth: 240, agentWidth: 360, bottomHeight: 220 };
  var LAYOUT_RANGES = {
    explorerWidth: [180, 400],
    agentWidth: [300, 520],
    bottomHeight: [120, 480],
  };
  var WORKBENCH_TOKENS = {
    titleBarHeight: 40,
    activityRailWidth: 44,
    statusBarHeight: 24,
    fontSize: 13,
    lineHeight: 20,
    controlMinHeight: 28,
    iconTarget: 32,
    focusWidth: 2,
    panelRadius: 4,
    motionMs: 120,
    space: [4, 8, 12, 16, 24],
  };
  // The named grid areas workbench.css lays the shell out with.
  var WORKBENCH_REGIONS = ['activity', 'explorer', 'editor', 'agent', 'bottom', 'status'];
  var PANE_DIMS = { explorer: 'explorerWidth', agent: 'agentWidth', bottom: 'bottomHeight' };
  var LAYOUT_KEYS = ['explorerWidth', 'agentWidth', 'bottomHeight'];
  var MIN_EDITOR_WIDTH = 320;
  var MIN_EDITOR_HEIGHT = 160;

  function initialWorkbench(workspaceId) {
    return {
      workspaceId, dockOpen: true, dockTab: 'preview', follow: true,
      lastFile: null, lastFileSeq: 0, dirty: false,
      explorerWidth: 240, agentWidth: 360, bottomHeight: 220,
      layouts: {},
    };
  }

  function layoutOf(state) {
    return {
      explorerWidth: state.explorerWidth,
      agentWidth: state.agentWidth,
      bottomHeight: state.bottomHeight,
    };
  }

  function inRange(key, value) {
    var range = LAYOUT_RANGES[key];
    var n = Number(value);
    if (!isFinite(n)) return LAYOUT_DEFAULTS[key];
    return Math.min(range[1], Math.max(range[0], Math.round(n)));
  }

  function clampLayout(dims, viewport) {
    var src = dims || {};
    var out = {};
    for (var i = 0; i < LAYOUT_KEYS.length; i += 1) out[LAYOUT_KEYS[i]] = inRange(LAYOUT_KEYS[i], src[LAYOUT_KEYS[i]]);
    var vw = Number(viewport && viewport.width);
    var vh = Number(viewport && viewport.height);
    if (isFinite(vw)) {
      // The side panes shrink to their minimum before the editor gives up room.
      var budget = vw - WORKBENCH_TOKENS.activityRailWidth - MIN_EDITOR_WIDTH;
      var overflow = out.explorerWidth + out.agentWidth - budget;
      if (overflow > 0) {
        out.explorerWidth -= Math.min(out.explorerWidth - LAYOUT_RANGES.explorerWidth[0], overflow);
        overflow = out.explorerWidth + out.agentWidth - budget;
        out.agentWidth -= Math.min(out.agentWidth - LAYOUT_RANGES.agentWidth[0], Math.max(0, overflow));
      }
    }
    if (isFinite(vh)) {
      var maxBottom = vh - WORKBENCH_TOKENS.titleBarHeight - WORKBENCH_TOKENS.statusBarHeight - MIN_EDITOR_HEIGHT;
      out.bottomHeight = Math.max(0, Math.min(out.bottomHeight, Math.round(maxBottom)));
    }
    return out;
  }

  // The layouts map is the only cross-workspace memory; the live sizes are
  // the active workspace's entry.
  function persistLayouts(state) {
    var layouts = Object.assign({}, state.layouts || {});
    if (state.workspaceId) layouts[state.workspaceId] = layoutOf(state);
    return layouts;
  }

  function applyLayout(state, dims) {
    var next = Object.assign({}, state, dims);
    next.layouts = Object.assign({}, state.layouts || {});
    if (state.workspaceId) next.layouts[state.workspaceId] = dims;
    return next;
  }

  function reduceWorkbench(state, action) {
    if (!action || typeof action !== 'object') return state;

    if (action.type === 'workspace') {
      var restored = state.layouts && state.layouts[action.workspaceId];
      var next = Object.assign(initialWorkbench(action.workspaceId), { layouts: persistLayouts(state) });
      return restored ? Object.assign(next, clampLayout(restored, action.viewport)) : next;
    }
    if (action.type === 'close-dock') return Object.assign({}, state, { dockOpen: false });
    if (action.type === 'open-dock') return Object.assign({}, state, { dockOpen: true });
    if (action.type === 'dirty') return Object.assign({}, state, { dirty: Boolean(action.value), follow: action.value ? false : state.follow });
    if (action.type === 'follow') return Object.assign({}, state, { follow: Boolean(action.value) && !state.dirty });
    if (action.type === 'dock-tab') {
      if (!state.dockOpen || (action.tab !== 'preview' && action.tab !== 'files')) return state;
      return Object.assign({}, state, { dockTab: action.tab });
    }
    if (action.type === 'file-changed') {
      if (action.workspaceId !== state.workspaceId || !Number.isInteger(action.seq) || action.seq <= state.lastFileSeq) return state;
      return Object.assign({}, state, {
        lastFile: action.path,
        lastFileSeq: action.seq,
        dockTab: state.dockOpen && state.follow && !state.dirty ? 'files' : state.dockTab,
      });
    }
    if (action.type === 'flip') {
      if (!state.dockOpen || !state.lastFile) return state;
      return Object.assign({}, state, { dockTab: state.dockTab === 'preview' ? 'files' : 'preview' });
    }
    if (action.type === 'resize') {
      var key = PANE_DIMS[action.pane];
      var value = Number(action.value);
      if (!key || !isFinite(value)) return state;
      var moved = Object.assign({}, layoutOf(state));
      moved[key] = value;
      return applyLayout(state, clampLayout(moved, action.viewport));
    }
    if (action.type === 'viewport') return applyLayout(state, clampLayout(layoutOf(state), action.viewport));
    if (action.type === 'restore-layout') {
      if (!action.layout) return state;
      return applyLayout(state, clampLayout(action.layout, action.viewport));
    }
    if (action.type === 'reset-layout') {
      var layouts = Object.assign({}, state.layouts || {});
      delete layouts[state.workspaceId];
      return Object.assign({}, state, LAYOUT_DEFAULTS, { layouts: layouts });
    }
    return state;
  }

  var api = {
    initialWorkbench, reduceWorkbench, clampLayout,
    LAYOUT_DEFAULTS, LAYOUT_RANGES, WORKBENCH_TOKENS, WORKBENCH_REGIONS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XavaniWorkbench = api;
})(globalThis);
