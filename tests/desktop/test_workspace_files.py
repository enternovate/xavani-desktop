"""Task 12: revision-aware desktop saves with conflict detection.

Code Pack J.  The module-level tests exercise ``backend/workspace_files.py``
directly; the HTTP tests drive the real ``/desktop/api/fs/file`` and
``/desktop/api/fs/write`` routes through an assembled ``build_desktop_app`` and
prime the boundary through its grant path, exactly as ``test_workspace_paths``
does.
"""

import asyncio
import hashlib
import os
import secrets
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# serve_desktop resolves the engine at import time; keep the suite runnable from
# a checkout that sits beside the engine.
os.environ.setdefault("XAVANI_ENGINE_ROOT", str(Path.home() / "xavani-agent"))

from backend.serve_desktop import build_desktop_app  # noqa: E402
from backend.workspace_files import (  # noqa: E402
    MAX_TEXT_BYTES,
    FileTooLarge,
    RevisionConflict,
    RevisionRequired,
    _WRITE_LOCK,
    content_hash,
    read_workspace_file,
    save_workspace_file,
)
from backend.workspace_paths import (  # noqa: E402
    NATIVE_GRANT_SOURCE,
    WORKSPACE_REQUIRED,
)

SECRET = secrets.token_hex(32)
BEARER = {"Authorization": f"Bearer {SECRET}"}


# --------------------------------------------------------------------------
# fixtures / helpers
# --------------------------------------------------------------------------


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / "workspace"
    (root / "src").mkdir(parents=True)
    (root / "src" / "file.py").write_text("print('ok')\n", encoding="utf-8")
    return root


def _run_app(home: Path, scenario):
    async def run():
        previous = os.environ.get("XAVANI_HOME")
        os.environ["XAVANI_HOME"] = str(home)
        try:
            app = build_desktop_app(8642, SECRET)
            from aiohttp.test_utils import TestClient, TestServer

            client = TestClient(TestServer(app))
            await client.start_server()
            try:
                return await scenario(client, app)
            finally:
                await client.close()
        finally:
            if previous is None:
                os.environ.pop("XAVANI_HOME", None)
            else:
                os.environ["XAVANI_HOME"] = previous

    return asyncio.run(run())


def _grant(app, root: Path) -> Path:
    return app["workspace"].grant(root, granted_by=NATIVE_GRANT_SOURCE)


# --------------------------------------------------------------------------
# module: a read reports the exact revision of the bytes on disk
# --------------------------------------------------------------------------


def test_read_returns_the_sha256_revision_of_the_bytes(tmp_path: Path):
    blob = "old\n".encode("utf-8")
    path = tmp_path / "file.py"
    path.write_bytes(blob)
    result = read_workspace_file(tmp_path, "file.py")
    assert result["content"] == "old\n"
    assert result["size"] == len(blob)
    assert result["revision"] == hashlib.sha256(blob).hexdigest()
    assert content_hash(blob) == result["revision"]


def test_read_rejects_a_missing_file(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        read_workspace_file(tmp_path, "absent.py")


# --------------------------------------------------------------------------
# module: the save microcycles
# --------------------------------------------------------------------------


def test_current_revision_saves(tmp_path: Path):
    path = tmp_path / "file.py"
    path.write_text("old\n", encoding="utf-8")
    base = read_workspace_file(tmp_path, "file.py")
    result = save_workspace_file(tmp_path, "file.py", "new\n", base["revision"])
    assert path.read_text(encoding="utf-8") == "new\n"
    assert result["revision"] != base["revision"]
    assert result["revision"] == content_hash("new\n".encode("utf-8"))


def test_stale_revision_preserves_newer_content(tmp_path: Path):
    path = tmp_path / "file.py"
    path.write_text("old\n", encoding="utf-8")
    base = read_workspace_file(tmp_path, "file.py")
    path.write_text("external\n", encoding="utf-8")
    with pytest.raises(RevisionConflict):
        save_workspace_file(tmp_path, "file.py", "buffer\n", base["revision"])
    assert path.read_text(encoding="utf-8") == "external\n"


def test_missing_expected_revision_is_refused_and_changes_nothing(tmp_path: Path):
    path = tmp_path / "file.py"
    path.write_text("old\n", encoding="utf-8")
    for missing in ("", None, 0):
        with pytest.raises(RevisionRequired):
            save_workspace_file(tmp_path, "file.py", "new\n", missing)  # type: ignore[arg-type]
    assert path.read_text(encoding="utf-8") == "old\n"


def test_oversized_content_is_refused_before_the_write(tmp_path: Path):
    path = tmp_path / "file.py"
    path.write_text("old\n", encoding="utf-8")
    base = read_workspace_file(tmp_path, "file.py")
    too_big = "x" * (MAX_TEXT_BYTES + 1)
    with pytest.raises(FileTooLarge):
        save_workspace_file(tmp_path, "file.py", too_big, base["revision"])
    assert path.read_text(encoding="utf-8") == "old\n"


def test_oversized_file_read_is_refused(tmp_path: Path):
    path = tmp_path / "big.txt"
    path.write_bytes(b"x" * (MAX_TEXT_BYTES + 1))
    with pytest.raises(FileTooLarge):
        read_workspace_file(tmp_path, "big.txt")


def test_invalid_utf8_read_raises_unicode_decode_error(tmp_path: Path):
    path = tmp_path / "blob.bin"
    path.write_bytes(b"\xff\xfe\x00binary")
    with pytest.raises(UnicodeDecodeError):
        read_workspace_file(tmp_path, "blob.bin")


def test_save_of_a_missing_file_is_refused(tmp_path: Path):
    # A missing file must never be created by a save: new files go through the
    # explicit New file action, not a missing-revision overwrite.
    with pytest.raises(FileNotFoundError):
        save_workspace_file(tmp_path, "absent.py", "new\n", "deadbeef")
    assert not (tmp_path / "absent.py").exists()


def test_failed_replacement_preserves_the_previous_file(tmp_path: Path, monkeypatch):
    path = tmp_path / "file.py"
    path.write_bytes(b"precious\n")
    base = read_workspace_file(tmp_path, "file.py")

    def explode(*_args, **_kwargs):
        raise OSError("replace failed")

    monkeypatch.setattr("backend.workspace_files.os.replace", explode)
    with pytest.raises(OSError):
        save_workspace_file(tmp_path, "file.py", "lost\n", base["revision"])
    assert path.read_bytes() == b"precious\n"
    # The scratch file is cleaned up and nothing else is left behind.
    assert [p.name for p in tmp_path.iterdir()] == ["file.py"]


def test_save_keeps_the_file_mode_and_leaves_no_scratch_file(tmp_path: Path):
    path = tmp_path / "file.py"
    path.write_bytes(b"old\n")
    path.chmod(0o640)
    base = read_workspace_file(tmp_path, "file.py")
    save_workspace_file(tmp_path, "file.py", "new\n", base["revision"])
    assert path.stat().st_mode & 0o777 == 0o640
    assert [p.name for p in tmp_path.iterdir()] == ["file.py"]


# --------------------------------------------------------------------------
# module: the process-local lock coordinates desktop requests
# --------------------------------------------------------------------------


def test_write_lock_is_reentrant():
    with _WRITE_LOCK:
        with _WRITE_LOCK:
            assert True


def test_concurrent_saves_never_leave_a_torn_file(tmp_path: Path):
    path = tmp_path / "shared.txt"
    path.write_bytes(b"seed\n")
    payloads = {f"thread-{i}\n" for i in range(4)}
    seen: list = []
    errors: list = []
    start = threading.Barrier(4)

    def worker(index: int):
        start.wait()
        for _ in range(15):
            try:
                current = read_workspace_file(tmp_path, "shared.txt")
                seen.append(current["content"])
                save_workspace_file(
                    tmp_path, "shared.txt", f"thread-{index}\n", current["revision"])
            except RevisionConflict:
                continue
            except Exception as exc:  # pragma: no cover - surfaced below
                errors.append(exc)
                return

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not errors
    final = path.read_text(encoding="utf-8")
    assert final == "seed\n" or final in payloads
    # Every read observed a complete payload — never a partial write.
    assert set(seen) <= payloads | {"seed\n"}
    assert [p.name for p in tmp_path.iterdir()] == ["shared.txt"]


# --------------------------------------------------------------------------
# routes: the read route reports the revision
# --------------------------------------------------------------------------


def test_read_route_returns_the_revision(tmp_path: Path, workspace: Path):
    async def scenario(client, app):
        _grant(app, workspace)
        resp = await client.get(
            f"/desktop/api/fs/file?path={workspace / 'src' / 'file.py'}", headers=BEARER)
        return resp.status, await resp.json()

    status, body = _run_app(tmp_path / "home", scenario)
    assert status == 200
    assert body["content"] == "print('ok')\n"
    assert body["revision"] == hashlib.sha256(b"print('ok')\n").hexdigest()
    assert body["size"] == len(b"print('ok')\n")


def test_read_route_maps_binary_and_oversized_files(tmp_path: Path, workspace: Path):
    (workspace / "blob.bin").write_bytes(b"\xff\xfe\x00binary")
    (workspace / "big.txt").write_bytes(b"x" * (MAX_TEXT_BYTES + 1))

    async def scenario(client, app):
        _grant(app, workspace)
        binary = await client.get(
            f"/desktop/api/fs/file?path={workspace / 'blob.bin'}", headers=BEARER)
        big = await client.get(
            f"/desktop/api/fs/file?path={workspace / 'big.txt'}", headers=BEARER)
        missing = await client.get(
            f"/desktop/api/fs/file?path={workspace / 'nope.py'}", headers=BEARER)
        return binary.status, big.status, missing.status

    assert _run_app(tmp_path / "home", scenario) == (415, 413, 404)


# --------------------------------------------------------------------------
# routes: status mapping for a save
# --------------------------------------------------------------------------


def test_write_route_maps_conflict_revision_and_size(tmp_path: Path, workspace: Path):
    target = workspace / "src" / "file.py"

    async def scenario(client, app):
        _grant(app, workspace)
        read = await client.get(f"/desktop/api/fs/file?path={target}", headers=BEARER)
        read_body = await read.json()

        # A save with no revision is never permission to overwrite.
        missing = await client.post(
            "/desktop/api/fs/write",
            headers=BEARER,
            json={"path": str(target), "content": "no-revision\n"},
        )
        after_missing = target.read_text(encoding="utf-8")

        # An external writer changes the file beneath the buffer.
        target.write_text("external\n", encoding="utf-8")
        stale = await client.post(
            "/desktop/api/fs/write",
            headers=BEARER,
            json={
                "path": str(target),
                "content": "buffer\n",
                "expected_revision": read_body["revision"],
            },
        )
        stale_body = await stale.json()
        after_stale = target.read_text(encoding="utf-8")

        # The current revision saved against the external writer succeeds.
        current = read_workspace_file(workspace, str(target))
        good = await client.post(
            "/desktop/api/fs/write",
            headers=BEARER,
            json={
                "path": str(target),
                "content": "committed\n",
                "expected_revision": current["revision"],
            },
        )
        good_body = await good.json()
        return (missing.status, after_missing, stale.status, stale_body, after_stale,
                good.status, good_body, target.read_text(encoding="utf-8"))

    (missing_status, after_missing, stale_status, stale_body, after_stale,
     good_status, good_body, final) = _run_app(tmp_path / "home", scenario)

    assert missing_status == 428
    assert after_missing == "print('ok')\n"
    assert stale_status == 409
    assert after_stale == "external\n"
    assert stale_body["conflict"] is True
    assert stale_body["disk"] == "external\n"
    assert stale_body["current_revision"] == content_hash(b"external\n")
    assert good_status == 200
    assert good_body["ok"] is True
    assert good_body["revision"] == content_hash(b"committed\n")
    assert final == "committed\n"


def test_write_route_rejects_an_oversized_payload(tmp_path: Path, workspace: Path):
    target = workspace / "src" / "file.py"

    async def scenario(client, app):
        _grant(app, workspace)
        base = read_workspace_file(workspace, str(target))
        resp = await client.post(
            "/desktop/api/fs/write",
            headers=BEARER,
            json={
                "path": str(target),
                "content": "x" * (MAX_TEXT_BYTES + 1),
                "expected_revision": base["revision"],
            },
        )
        return resp.status, target.read_text(encoding="utf-8")

    status, after = _run_app(tmp_path / "home", scenario)
    assert status == 413
    assert after == "print('ok')\n"


def test_write_route_keeps_the_boundary_under_a_revision(tmp_path: Path, workspace: Path):
    outside = tmp_path / "outside.txt"
    outside.write_text("outside\n", encoding="utf-8")
    revision = content_hash(b"outside\n")

    async def scenario(client, app):
        _grant(app, workspace)
        traversal = await client.post(
            "/desktop/api/fs/write",
            headers=BEARER,
            json={"path": "../outside.txt", "content": "pwned",
                  "expected_revision": revision},
        )
        credential = await client.post(
            "/desktop/api/fs/write",
            headers=BEARER,
            json={"path": ".env", "content": "SECRET=1\n", "expected_revision": revision},
        )
        control = await client.post(
            "/desktop/api/fs/write",
            headers=BEARER,
            json={"path": ".git/config", "content": "x", "expected_revision": revision},
        )
        return traversal.status, credential.status, control.status

    statuses = _run_app(tmp_path / "home", scenario)
    assert statuses == (400, 403, 403)
    assert outside.read_text(encoding="utf-8") == "outside\n"
    assert not (workspace / ".env").exists()
    assert not (workspace / ".git").exists()


def test_write_route_requires_a_workspace_before_any_revision_check(tmp_path: Path):
    async def scenario(client, app):
        resp = await client.post(
            "/desktop/api/fs/write",
            headers=BEARER,
            json={"path": "a.txt", "content": "x"},
        )
        return resp.status, await resp.json()

    status, body = _run_app(tmp_path / "home", scenario)
    assert status == 428
    assert body["error"] == WORKSPACE_REQUIRED
