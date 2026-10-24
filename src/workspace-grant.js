'use strict';

/* R1 Task 11b — the native workspace grant (Electron half of the workspace
   boundary). Pure helpers so the request shape is unit-testable without
   booting Electron.

   POST /desktop/api/fs/root is a *grant* entry point on the desktop backend:
   it accepts only when the per-run secret arrives in X-Xavani-Native, raw.
   The renderer's webRequest injector adds Authorization and nothing else, and
   the renderer never holds the secret, so only this main-process caller can
   satisfy the route. */

(function (root) {
  const GRANT_PATH = '/desktop/api/fs/root';
  const NATIVE_GRANT_HEADER = 'X-Xavani-Native';
  const NATIVE_GRANT_SOURCE = 'native';

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
  }

  /** Build the POST the grant route expects. Throws TypeError on a missing input. */
  function buildGrantInit({ secret, root: workspaceRoot } = {}) {
    if (!isNonEmptyString(secret)) throw new TypeError('a native grant requires the shared secret');
    if (!isNonEmptyString(workspaceRoot)) throw new TypeError('a native grant requires a workspace path');
    return {
      method: 'POST',
      headers: {
        [NATIVE_GRANT_HEADER]: secret,
        'Content-Type': 'application/json',
      },
      // The route reads `root`; `path` rides along as the documented alias for
      // the selected folder.
      body: JSON.stringify({
        root: workspaceRoot,
        path: workspaceRoot,
        granted_by: NATIVE_GRANT_SOURCE,
      }),
    };
  }

  /** Map a grant response onto {ok:true, root} or {ok:false, error}. */
  function parseGrantResponse(status, payload) {
    const body = payload && typeof payload === 'object' ? payload : {};
    const error = isNonEmptyString(body.error) ? body.error : `workspace grant failed (HTTP ${status})`;
    if (status !== 200 || body.ok === false) return { ok: false, error };
    if (!isNonEmptyString(body.root)) return { ok: false, error };
    return { ok: true, root: body.root };
  }

  const api = { buildGrantInit, parseGrantResponse, GRANT_PATH, NATIVE_GRANT_HEADER };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XavaniWorkspaceGrant = api;
})(globalThis);
