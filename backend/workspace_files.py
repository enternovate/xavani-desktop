"""Revision-aware reads and writes for the desktop workspace.

Code Pack J of the reliability plan (Task 12).  A read returns the SHA-256
revision of the exact bytes on disk; a save carries the revision its buffer was
based on and is refused when the file changed underneath it, so a concurrent
writer can never be silently overwritten.

``_WRITE_LOCK`` serialises saves *inside this process* only.  It is deliberately
not presented as a cross-process guarantee: another application can still change
the file between the check and ``os.replace``.  External edits are *detected* by
revision comparison and surfaced as a conflict for review, which is this
release's boundary.  A hostile same-user process sits outside it.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
import threading
from pathlib import Path

try:
    from backend.workspace_paths import workspace_path
except ImportError:
    # Launched as a script (Electron passes an absolute path): backend/ itself
    # is sys.path[0], so the package form does not resolve.
    from workspace_paths import workspace_path  # type: ignore[no-redef]

MAX_TEXT_BYTES = 2 * 1024 * 1024
_WRITE_LOCK = threading.RLock()


class RevisionConflict(Exception):
    """The bytes on disk no longer match the revision a buffer was based on."""


class RevisionRequired(ValueError):
    """A save arrived without the expected revision."""


class FileTooLarge(ValueError):
    """The payload exceeds :data:`MAX_TEXT_BYTES`."""


def content_hash(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def read_workspace_file(root: Path, raw: str) -> dict:
    """Read ``raw`` inside ``root``; the result carries the disk revision."""
    path = workspace_path(root, raw)
    if not path.is_file():
        raise FileNotFoundError(raw)
    with path.open("rb") as handle:
        blob = handle.read(MAX_TEXT_BYTES + 1)
    if len(blob) > MAX_TEXT_BYTES:
        raise FileTooLarge("The file exceeds the text limit.")
    return {
        "path": str(path),
        "content": blob.decode("utf-8"),
        "revision": content_hash(blob),
        "size": len(blob),
    }


def save_workspace_file(root: Path, raw: str, content: str, expected_revision: str) -> dict:
    """Replace ``raw`` only when disk still matches ``expected_revision``."""
    if not isinstance(expected_revision, str) or not expected_revision:
        raise RevisionRequired("An expected revision is required.")
    if not isinstance(content, str):
        raise ValueError("Content is required.")
    blob = content.encode("utf-8")
    if len(blob) > MAX_TEXT_BYTES:
        raise FileTooLarge("The content exceeds the text limit.")
    with _WRITE_LOCK:
        path = workspace_path(root, raw)
        if not path.is_file():
            raise FileNotFoundError(raw)
        current = read_workspace_file(root, raw)
        if current["revision"] != expected_revision:
            raise RevisionConflict("The file changed after the read.")
        mode = path.stat().st_mode & 0o777
        descriptor, name = tempfile.mkstemp(prefix=".xavani-save-", dir=path.parent)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(blob)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, mode)
            if read_workspace_file(root, raw)["revision"] != expected_revision:
                raise RevisionConflict("The file changed during the save.")
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
        return {"path": str(path), "revision": content_hash(blob), "bytes": len(blob)}
