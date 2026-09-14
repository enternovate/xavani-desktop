"""Workspace boundary for the Xavani desktop backend.

Every desktop route that touches the filesystem resolves its target through a
:class:`WorkspaceBoundary`.  The boundary holds the single user-selected root
(one root per window) and accepts a path only when *both* the root and the
candidate realpath inside that root.

Implementation follows Code Pack I of the reliability plan with the Task 11
extensions:

* ``resolve_workspace_path`` realpaths the root and the candidate, so a sibling
  directory with a matching string prefix, a ``..`` escape and a symlink that
  points outside the root all fail.
* control directories (``.git``, ``.ssh``, ``.aws``, ``.gnupg``, ``.xavani``,
  ``.hermes``, ``.config/xavani``) refuse **write** actions.
* credential-looking files (``id_rsa``, ``id_ed25519``, ``*.pem``, ``*.key``,
  ``.env*``, ``credentials*.json``, ``auth.json``, ``.netrc``, ``.npmrc``,
  ``.pypirc``, ``.git-credentials``) refuse **read and write** actions.
* an unset / empty root raises :class:`WorkspaceRequired` with the exact
  message ``Workspace required``.

The root is established by a native grant only.  :func:`native_grant` (and
:meth:`WorkspaceBoundary.grant`) demand the shared secret in the
``X-Xavani-Native`` header -- a header the renderer's ``webRequest`` injector
never adds (it adds ``Authorization`` only), so a renderer-originated request
cannot create a grant, and a raw HTTP caller without the secret cannot either.

Route status mapping (see ``backend/serve_desktop.py``)::

    WorkspaceRequired   -> 428  "Workspace required"
    WorkspaceInputError -> 400  malformed path (empty, NUL byte, not a str)
    WorkspaceTraversal  -> 400  parent traversal ("..") attempt
    WorkspaceDenied     -> 403  outside the root, control dir, credential file,
                                non-native grant attempt, symlink
"""

from __future__ import annotations

import fnmatch
import hmac
import os
import threading
from pathlib import Path
from typing import Any

WORKSPACE_REQUIRED = "Workspace required"
NATIVE_GRANT_HEADER = "X-Xavani-Native"
NATIVE_GRANT_SOURCE = "native"

# Control directories: write actions are refused.  Reads stay available unless
# the file itself is credential-like, so the editor can still inspect history
# metadata without ever writing into VCS or secret stores.
_CONTROL_DIRS = frozenset({".git", ".ssh", ".aws", ".gnupg", ".xavani", ".hermes"})
_CONTROL_SEQUENCES = ((".config", "xavani"),)

# Credential-looking files: refused for reads and writes.
_CREDENTIAL_PATTERNS = (
    "id_rsa",
    "id_ed25519",
    "*.pem",
    "*.key",
    ".env",
    ".env.*",
    "credentials*.json",
    "auth.json",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
)


class WorkspaceError(Exception):
    """Base for boundary refusals; ``status`` is the HTTP status to report."""

    status = 403


class WorkspaceRequired(WorkspaceError, ValueError):
    """No workspace root is selected."""

    status = 428

    def __init__(self, message: str = WORKSPACE_REQUIRED) -> None:
        super().__init__(message)


class WorkspaceInputError(WorkspaceError, ValueError):
    """The caller supplied a malformed path or root."""

    status = 400


class WorkspaceTraversal(WorkspaceError, PermissionError):
    """The caller attempted parent traversal."""

    status = 400


class WorkspaceDenied(WorkspaceError, PermissionError):
    """The path is outside the root, protected, or symlinked."""

    status = 403


# Every refusal a route must translate into a response.  ``ValueError`` itself is
# intentionally *not* in this tuple: routes keep their own 400 handling.
WORKSPACE_ERRORS = (WorkspaceRequired, WorkspaceInputError, WorkspaceTraversal, WorkspaceDenied)


def _is_credential_name(name: str) -> bool:
    lowered = name.lower()
    return any(fnmatch.fnmatch(lowered, pattern) for pattern in _CREDENTIAL_PATTERNS)


def _is_control_path(parts: tuple[str, ...]) -> bool:
    if any(part in _CONTROL_DIRS for part in parts):
        return True
    return any(
        tuple(parts[index:index + 2]) == sequence
        for sequence in _CONTROL_SEQUENCES
        for index in range(len(parts))
    )


def require_root(root: Any) -> Path:
    """Return the realpath of a usable workspace root.

    ``None``, an empty string, and a root that is not an existing directory all
    raise :class:`WorkspaceRequired` with ``Workspace required``.
    """
    if root is None:
        raise WorkspaceRequired()
    if isinstance(root, str) and not root.strip():
        raise WorkspaceRequired()
    if not isinstance(root, (str, os.PathLike)):
        raise WorkspaceRequired()
    path = Path(root).expanduser()
    try:
        usable = path.is_dir()
    except OSError:
        usable = False
    if not usable:
        raise WorkspaceRequired()
    return Path(os.path.realpath(path))


def _relative_parts(target: Path, root_real: Path, root_given: Path) -> tuple[str, ...]:
    """Path parts below the root, tolerating an un-normalised root spelling.

    The candidate may be spelled with a symlinked prefix (macOS ``/var`` versus
    ``/private/var``).  The lexical spelling is preferred so the symlink walk
    sees every component; the resolved spelling is the fallback, and it is only
    reached after containment against the realpath'd root has already held.
    """
    for base in (root_real, root_given):
        try:
            return target.relative_to(base).parts
        except ValueError:
            continue
    try:
        return target.relative_to(root_real).parts
    except ValueError:
        return ()


def resolve_workspace_path(
    root: Any,
    candidate: Any,
    *,
    write: bool = False,
    allow_root: bool = False,
) -> Path:
    """Resolve ``candidate`` inside ``root`` or raise a boundary refusal.

    Both the root and the resolved candidate are realpath'd, so a sibling with a
    matching string prefix, a ``..`` escape, and a symlink pointing outside the
    root are all rejected.  ``write=True`` additionally refuses control
    directories; credential-looking files are refused for reads and writes.
    """
    root_real = require_root(root)
    root_given = Path(str(root)).expanduser()
    raw = candidate
    if not isinstance(raw, str) or not raw.strip() or "\x00" in raw:
        raise WorkspaceInputError("A workspace path is required.")
    target = Path(raw).expanduser()
    if not target.is_absolute():
        target = root_real / target
    if ".." in target.parts:
        raise WorkspaceTraversal("Parent traversal is not permitted.")

    # The OS follows symlinks when it opens the path, so containment is decided
    # on the realpath of the candidate against the realpath of the root.
    resolved = Path(os.path.realpath(target))
    if resolved != root_real and not resolved.is_relative_to(root_real):
        raise WorkspaceDenied("The path leaves the workspace.")

    parts = _relative_parts(target, root_real, root_given)
    if write and _is_control_path(parts):
        raise WorkspaceDenied("The path contains protected data.")
    for part in parts:
        if _is_credential_name(part):
            raise WorkspaceDenied("The path contains protected data.")

    cursor = root_real
    for part in parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise WorkspaceDenied("Symbolic links require a separate access policy.")
    if target.is_symlink():
        raise WorkspaceDenied("Symbolic links require a separate access policy.")

    if resolved == root_real and not allow_root:
        raise WorkspaceDenied("The operation cannot target the workspace root.")
    return resolved


def workspace_path(root: Any, raw: Any, *, write: bool = False, allow_root: bool = False) -> Path:
    """Code Pack I name for :func:`resolve_workspace_path`."""
    return resolve_workspace_path(root, raw, write=write, allow_root=allow_root)


def validate_native_token(header_value: Any, secret: Any) -> bool:
    """True only when ``header_value`` is exactly ``secret`` (``X-Xavani-Native``).

    The value is the raw secret: no ``Bearer`` scheme is accepted, so the one
    header the renderer's ``webRequest`` injector produces (``Authorization``)
    can never satisfy this check even by accident.
    """
    if not isinstance(header_value, str) or not isinstance(secret, str) or not secret:
        return False
    supplied = header_value.strip()
    if not supplied:
        return False
    return hmac.compare_digest(supplied.encode(), secret.encode())


class WorkspaceBoundary:
    """The selected workspace root plus the grants made against it."""

    def __init__(self, root: Any = None) -> None:
        self._lock = threading.RLock()
        self._root: Path | None = None
        self._generation = 0
        self._grants: dict[str, int] = {}
        if root is not None:
            self.set_root(root, granted_by=NATIVE_GRANT_SOURCE)

    # ---- state -----------------------------------------------------------

    @property
    def root(self) -> Path | None:
        with self._lock:
            return self._root

    @property
    def generation(self) -> int:
        with self._lock:
            return self._generation

    def has_root(self) -> bool:
        with self._lock:
            return self._root is not None

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "root": str(self._root) if self._root is not None else "",
                "granted": self._root is not None,
                "generation": self._generation,
            }

    def require_root(self) -> Path:
        return require_root(self.root)

    # ---- grants ----------------------------------------------------------

    def set_root(self, root: Any, *, granted_by: str = "") -> Path:
        """Replace the workspace root atomically (a native grant only).

        The swap is a single locked assignment that bumps the generation and
        drops every previous grant, so a workspace change invalidates old
        grants and every previously handed-out path.
        """
        if granted_by != NATIVE_GRANT_SOURCE:
            raise WorkspaceDenied("A native workspace selection is required.")
        if root is None or (isinstance(root, str) and not root.strip()):
            raise WorkspaceInputError("A workspace root is required.")
        path = Path(str(root)).expanduser()
        resolved = Path(os.path.realpath(path))
        try:
            usable = resolved.is_dir()
        except OSError:
            usable = False
        if not usable:
            raise WorkspaceInputError(f"not a directory: {path}")
        with self._lock:
            self._root = resolved
            self._generation += 1
            self._grants = {}
        return resolved

    def grant(self, root: Any, *, granted_by: str = "") -> Path:
        """Alias of :meth:`set_root` for the native grant entry point."""
        return self.set_root(root, granted_by=granted_by)

    def clear(self) -> None:
        with self._lock:
            self._root = None
            self._generation += 1
            self._grants = {}

    def approve(self, raw: Any, *, granted_by: str = "") -> Path:
        """Record an explicit native approval for a path in this workspace."""
        if granted_by != NATIVE_GRANT_SOURCE:
            raise WorkspaceDenied("A native workspace selection is required.")
        path = self.resolve(raw, allow_root=True)
        with self._lock:
            self._grants[str(path)] = self._generation
        return path

    def is_granted(self, raw: Any) -> bool:
        """True when ``raw`` was approved in the current workspace generation."""
        try:
            key = str(Path(str(raw)).expanduser())
            resolved = os.path.realpath(key)
        except (TypeError, ValueError):
            return False
        with self._lock:
            generation = self._generation
            return self._grants.get(resolved) == generation or self._grants.get(key) == generation

    # ---- path resolution -------------------------------------------------

    def resolve(self, raw: Any, *, write: bool = False, allow_root: bool = False) -> Path:
        """Resolve a route path against the current root."""
        return resolve_workspace_path(self.require_root(), raw, write=write, allow_root=allow_root)

    def permits(self, path: Any, *, write: bool = False) -> bool:
        """True when ``path`` (an absolute path already inside the root) passes."""
        try:
            self.resolve(str(path), write=write)
        except WORKSPACE_ERRORS:
            return False
        return True


def native_grant(
    boundary: WorkspaceBoundary,
    root: Any,
    *,
    header_value: Any,
    secret: Any,
) -> Path:
    """Grant entry point: verify ``X-Xavani-Native`` and then set the root."""
    if not validate_native_token(header_value, secret):
        raise WorkspaceDenied("A native workspace selection is required.")
    return boundary.grant(root, granted_by=NATIVE_GRANT_SOURCE)
