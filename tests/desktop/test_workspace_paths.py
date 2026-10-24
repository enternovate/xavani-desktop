"""Task 11a: workspace boundary module and desktop route enforcement.

The nine Task 11 microcycles are covered here, plus the route wiring through an
assembled ``build_desktop_app`` app.  The module-level tests exercise
``backend/workspace_paths.py`` directly; the HTTP tests prime the boundary
through its grant path (``WorkspaceBoundary.grant``) — the same code the native
grant route calls — and then assert that every filesystem route honours it.
"""

import asyncio
import base64
import os
import secrets
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# serve_desktop resolves the engine at import time; keep the desktop suite
# runnable from a checkout that sits beside the engine.
os.environ.setdefault("XAVANI_ENGINE_ROOT", str(Path.home() / "xavani-agent"))

from backend.serve_desktop import build_desktop_app  # noqa: E402
from backend.workspace_paths import (  # noqa: E402
    NATIVE_GRANT_HEADER,
    NATIVE_GRANT_SOURCE,
    WORKSPACE_REQUIRED,
    WorkspaceBoundary,
    WorkspaceDenied,
    WorkspaceRequired,
    WorkspaceTraversal,
    native_grant,
    resolve_workspace_path,
)

SECRET = secrets.token_hex(32)
BEARER = {"Authorization": f"Bearer {SECRET}"}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    """A selected workspace root with a little content."""
    root = tmp_path / "workspace"
    (root / "src").mkdir(parents=True)
    (root / "src" / "file.py").write_text("print('ok')\n", encoding="utf-8")
    (root / "styles.css").write_text(".card { color: blue; }\n", encoding="utf-8")
    return root


@pytest.fixture
def outside(tmp_path: Path) -> Path:
    """A file that lives beside the workspace and must never be touched."""
    path = tmp_path / "outside.txt"
    path.write_text("outside\n", encoding="utf-8")
    return path


def _run_app(home: Path, scenario):
    """Run ``scenario(client, app)`` against a freshly assembled desktop app."""

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
    """Prime the app boundary through the programmatic grant path."""
    return app["workspace"].grant(root, granted_by=NATIVE_GRANT_SOURCE)


# --------------------------------------------------------------------------
# microcycle 1: a relative path inside the workspace succeeds
# --------------------------------------------------------------------------


def test_relative_path_inside_workspace_succeeds(workspace: Path):
    resolved = resolve_workspace_path(workspace, "src/file.py")
    assert resolved == workspace.resolve() / "src" / "file.py"
    assert resolved.is_file()


def test_absolute_path_inside_workspace_succeeds(workspace: Path):
    target = workspace / "src" / "file.py"
    assert resolve_workspace_path(workspace, str(target)) == target.resolve()


def test_un_normalised_root_spelling_is_accepted(tmp_path: Path, workspace: Path):
    # macOS spells /var for /private/var: a root echoed back exactly as it was
    # granted must keep resolving, even though its realpath differs.
    alias = tmp_path / "root-alias"
    alias.symlink_to(workspace, target_is_directory=True)
    resolved = resolve_workspace_path(str(alias), str(alias / "src" / "file.py"))
    assert resolved == (workspace / "src" / "file.py").resolve()
    assert resolve_workspace_path(str(alias), "src/file.py") == resolved
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(str(alias), str(tmp_path / "outside.txt"))


def test_root_may_only_be_targeted_when_allowed(workspace: Path):
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(workspace, ".")
    assert resolve_workspace_path(workspace, ".", allow_root=True) == workspace.resolve()
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(workspace, str(workspace), write=True)


# --------------------------------------------------------------------------
# microcycle 2: a sibling directory with a matching string prefix fails
# --------------------------------------------------------------------------


def test_sibling_with_matching_prefix_fails(tmp_path: Path, workspace: Path):
    sibling = tmp_path / "workspace-other"
    (sibling / "file.py").parent.mkdir(parents=True, exist_ok=True)
    (sibling / "file.py").write_text("nope\n", encoding="utf-8")
    # str(sibling) starts with str(workspace) as a string: the old home-prefix
    # style check would have admitted it.  realpath containment refuses it.
    assert str(sibling).startswith(str(workspace))
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(workspace, str(sibling / "file.py"))


def test_sibling_of_the_root_itself_fails(tmp_path: Path, workspace: Path):
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(workspace, str(tmp_path / "workspace-other"))


# --------------------------------------------------------------------------
# microcycle 3: `..` traversal fails
# --------------------------------------------------------------------------


@pytest.mark.parametrize("raw", ["../outside.txt", "src/../../outside.txt", "./../outside.txt"])
def test_parent_traversal_fails(workspace: Path, raw: str):
    with pytest.raises(WorkspaceTraversal) as excinfo:
        resolve_workspace_path(workspace, raw)
    assert "traversal" in str(excinfo.value).lower()
    assert WorkspaceTraversal.status == 400


def test_parent_traversal_never_reads_the_sibling(workspace: Path, outside: Path):
    with pytest.raises(WorkspaceTraversal):
        resolve_workspace_path(workspace, "../outside.txt")
    assert outside.read_text(encoding="utf-8") == "outside\n"


# --------------------------------------------------------------------------
# microcycle 4: a symlink path fails
# --------------------------------------------------------------------------


def test_symlink_inside_root_pointing_outside_fails(tmp_path: Path, workspace: Path):
    target = tmp_path / "elsewhere"
    target.mkdir()
    (target / "file.py").write_text("secret\n", encoding="utf-8")
    (workspace / "link").symlink_to(target, target_is_directory=True)
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(workspace, "link/file.py")
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(workspace, "link")


def test_symlink_inside_root_is_denied_even_when_it_points_inside(workspace: Path):
    real = workspace / "real"
    real.mkdir()
    (real / "f.py").write_text("x\n", encoding="utf-8")
    (workspace / "internal-link").symlink_to(real, target_is_directory=True)
    with pytest.raises(WorkspaceDenied) as excinfo:
        resolve_workspace_path(workspace, "internal-link/f.py")
    assert "Symbolic links" in str(excinfo.value)


def test_symlink_leaf_fails(workspace: Path, outside: Path):
    (workspace / "leaf.py").symlink_to(outside)
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(workspace, "leaf.py")
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(workspace, "leaf.py", write=True)


# --------------------------------------------------------------------------
# microcycle 5: a control directory fails for write actions
# --------------------------------------------------------------------------


@pytest.mark.parametrize("raw", [
    ".git/config",
    ".git/HEAD",
    ".ssh/authorized_keys",
    ".aws/config",
    ".gnupg/gpg.conf",
    ".config/xavani/config.yaml",
    ".xavani/config.yaml",
    ".hermes/cron/jobs.json",
])
def test_control_directory_write_fails(workspace: Path, raw: str):
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(workspace, raw, write=True)


def test_control_directory_names_as_write_targets_fail(workspace: Path):
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(workspace, ".git", write=True)
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(workspace, "renamed/.ssh", write=True)


def test_control_directory_read_is_not_blocked_by_the_write_rule(workspace: Path):
    # Task 11 denies control directories for writes only; the pack's original
    # deny-list applied to both.  Reads stay available, credentials do not.
    (workspace / ".git").mkdir(exist_ok=True)
    (workspace / ".git" / "config").write_text("[core]\n", encoding="utf-8")
    assert resolve_workspace_path(workspace, ".git/config").is_file()


def test_control_directory_write_does_not_modify_disk(workspace: Path):
    (workspace / ".git").mkdir(exist_ok=True)
    config = workspace / ".git" / "config"
    config.write_text("[core]\n", encoding="utf-8")
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(workspace, ".git/config", write=True)
    assert config.read_text(encoding="utf-8") == "[core]\n"


# --------------------------------------------------------------------------
# microcycle 6: a credential file fails for read and write actions
# --------------------------------------------------------------------------


@pytest.mark.parametrize("raw", [
    "id_rsa",
    ".ssh/id_ed25519",
    "certs/server.pem",
    "certs/private.key",
    ".env",
    ".env.local",
    ".env.production",
    ".env.example",
    "credentials.json",
    "credentials-prod.json",
    "auth.json",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
])
def test_credential_file_read_fails(workspace: Path, raw: str):
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(workspace, raw)


@pytest.mark.parametrize("raw", [
    "id_rsa",
    ".env",
    ".env.example",
    "credentials.json",
    "certs/private.key",
    ".netrc",
])
def test_credential_file_write_fails(workspace: Path, raw: str):
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(workspace, raw, write=True)


def test_credential_directory_component_fails(workspace: Path):
    with pytest.raises(WorkspaceDenied):
        resolve_workspace_path(workspace, "id_rsa/notes.txt")


# --------------------------------------------------------------------------
# microcycle 7: an empty root produces `Workspace required`
# --------------------------------------------------------------------------


@pytest.mark.parametrize("root", [None, "", "   "])
def test_empty_root_requires_a_workspace(root):
    with pytest.raises(WorkspaceRequired) as excinfo:
        resolve_workspace_path(root, "src/file.py")
    assert str(excinfo.value) == WORKSPACE_REQUIRED == "Workspace required"
    assert WorkspaceRequired.status == 428


def test_missing_root_directory_requires_a_workspace(tmp_path: Path):
    with pytest.raises(WorkspaceRequired) as excinfo:
        resolve_workspace_path(tmp_path / "does-not-exist", "src/file.py")
    assert str(excinfo.value) == WORKSPACE_REQUIRED


def test_boundary_without_a_root_requires_a_workspace(tmp_path: Path):
    boundary = WorkspaceBoundary()
    assert boundary.has_root() is False
    assert boundary.snapshot() == {"root": "", "granted": False, "generation": 0}
    with pytest.raises(WorkspaceRequired) as excinfo:
        boundary.resolve("src/file.py")
    assert str(excinfo.value) == WORKSPACE_REQUIRED


# --------------------------------------------------------------------------
# microcycle 8: a valid external selection succeeds after native approval
# --------------------------------------------------------------------------


def test_external_selection_succeeds_after_native_grant(tmp_path: Path):
    external = tmp_path / "external-volume"
    (external / "project").mkdir(parents=True)
    (external / "project" / "main.py").write_text("pass\n", encoding="utf-8")

    boundary = WorkspaceBoundary()
    with pytest.raises(WorkspaceRequired):
        boundary.resolve(str(external / "project" / "main.py"))

    granted = boundary.grant(external, granted_by=NATIVE_GRANT_SOURCE)
    assert granted == external.resolve()
    assert boundary.snapshot()["granted"] is True
    inside = boundary.resolve("project/main.py")
    assert inside == external.resolve() / "project" / "main.py"
    assert inside.is_file()
    # The granted root itself is still not a write target.
    with pytest.raises(WorkspaceDenied):
        boundary.resolve(".", write=True)


def test_grant_without_native_source_is_denied(tmp_path: Path):
    boundary = WorkspaceBoundary()
    with pytest.raises(WorkspaceDenied):
        boundary.grant(tmp_path)
    with pytest.raises(WorkspaceDenied):
        boundary.set_root(tmp_path, granted_by="renderer")
    assert boundary.has_root() is False


def test_grant_rejects_a_non_directory(tmp_path: Path):
    boundary = WorkspaceBoundary()
    with pytest.raises(Exception) as excinfo:
        boundary.grant(tmp_path / "nope", granted_by=NATIVE_GRANT_SOURCE)
    assert "not a directory" in str(excinfo.value)
    assert not boundary.has_root()


def test_native_grant_entry_point_requires_the_native_header(tmp_path: Path):
    boundary = WorkspaceBoundary()
    secret = secrets.token_hex(32)
    # The renderer's webRequest injector adds Authorization, never this header.
    with pytest.raises(WorkspaceDenied):
        native_grant(boundary, tmp_path, header_value=f"Bearer {secret}", secret=secret)
    with pytest.raises(WorkspaceDenied):
        native_grant(boundary, tmp_path, header_value=None, secret=secret)
    with pytest.raises(WorkspaceDenied):
        native_grant(boundary, tmp_path, header_value=secrets.token_hex(32), secret=secret)
    assert boundary.has_root() is False
    assert native_grant(boundary, tmp_path, header_value=secret, secret=secret) == tmp_path.resolve()
    assert boundary.has_root() is True


# --------------------------------------------------------------------------
# microcycle 9: a workspace change invalidates old grants
# --------------------------------------------------------------------------


def test_workspace_change_invalidates_old_grants(tmp_path: Path):
    first = tmp_path / "first"
    second = tmp_path / "second"
    (first / "src").mkdir(parents=True)
    (second / "src").mkdir(parents=True)
    (first / "src" / "a.py").write_text("a\n", encoding="utf-8")
    (second / "src" / "b.py").write_text("b\n", encoding="utf-8")

    boundary = WorkspaceBoundary()
    boundary.grant(first, granted_by=NATIVE_GRANT_SOURCE)
    approved = boundary.approve("src/a.py", granted_by=NATIVE_GRANT_SOURCE)
    assert boundary.is_granted(approved) is True
    generation = boundary.generation

    boundary.grant(second, granted_by=NATIVE_GRANT_SOURCE)
    assert boundary.generation > generation
    assert boundary.is_granted(approved) is False
    # The old path is now outside the root, so it is refused outright.
    with pytest.raises(WorkspaceDenied):
        boundary.resolve(str(first / "src" / "a.py"))
    assert boundary.resolve("src/b.py") == second.resolve() / "src" / "b.py"


def test_clear_invalidates_grants_and_restores_the_requirement(tmp_path: Path):
    boundary = WorkspaceBoundary()
    boundary.grant(tmp_path, granted_by=NATIVE_GRANT_SOURCE)
    boundary.clear()
    assert boundary.has_root() is False
    with pytest.raises(WorkspaceRequired):
        boundary.resolve(".")


# --------------------------------------------------------------------------
# route wiring
# --------------------------------------------------------------------------


def test_root_route_reports_workspace_required_before_a_grant(tmp_path: Path):
    async def scenario(client, _app):
        resp = await client.get("/desktop/api/fs/root", headers=BEARER)
        return resp.status, await resp.json()

    status, body = _run_app(tmp_path / "home", scenario)
    assert status == 428
    assert body["error"] == WORKSPACE_REQUIRED
    assert body["granted"] is False


def test_grant_route_requires_the_native_header(tmp_path: Path, workspace: Path):
    async def scenario(client, _app):
        payload = {"root": str(workspace)}
        renderer = await client.post("/desktop/api/fs/root", headers=BEARER, json=payload)
        renderer_body = await renderer.json()
        wrong = await client.post(
            "/desktop/api/fs/root",
            headers={**BEARER, NATIVE_GRANT_HEADER: secrets.token_hex(32)},
            json=payload,
        )
        bare = await client.post("/desktop/api/fs/root", json=payload)
        native = await client.post(
            "/desktop/api/fs/root",
            headers={**BEARER, NATIVE_GRANT_HEADER: SECRET},
            json=payload,
        )
        native_body = await native.json()
        after = await client.get("/desktop/api/fs/root", headers=BEARER)
        return (renderer.status, renderer_body, wrong.status, bare.status,
                native.status, native_body, after.status, await after.json())

    (renderer_status, renderer_body, wrong_status, bare_status,
     native_status, native_body, after_status, after_body) = _run_app(tmp_path / "home", scenario)

    assert renderer_status == 403
    assert renderer_body["error"]
    assert wrong_status == 403
    assert bare_status == 401  # the auth middleware, without any secret
    assert native_status == 200
    # The grant acknowledges the resolved root.
    assert native_body["ok"] is True
    assert native_body["root"] == str(workspace.resolve())
    assert native_body["granted"] is True
    assert after_status == 200
    assert after_body["root"] == str(workspace.resolve())


def test_native_grant_rejects_a_non_directory(tmp_path: Path):
    async def scenario(client, _app):
        resp = await client.post(
            "/desktop/api/fs/root",
            headers={**BEARER, NATIVE_GRANT_HEADER: SECRET},
            json={"root": str(tmp_path / "home" / "missing")},
        )
        return resp.status, await resp.json()

    status, body = _run_app(tmp_path / "home", scenario)
    assert status == 400
    assert "not a directory" in body["error"]


def test_workspace_routes_require_a_workspace(tmp_path: Path, outside: Path):
    async def scenario(client, _app):
        results = {}
        for label, method, path, payload in (
            ("file", "get", f"/desktop/api/fs/file?path={outside}", None),
            ("tree", "get", "/desktop/api/fs/tree", None),
            ("find", "get", "/desktop/api/fs/find?name=*.py", None),
            ("write", "post", "/desktop/api/fs/write", {"path": "a.txt", "content": "x"}),
            ("write_b64", "post", "/desktop/api/fs/write-b64",
             {"path": "a.bin", "data_b64": base64.b64encode(b"x").decode()}),
            ("mutate", "post", "/desktop/api/fs/mutate", {"op": "mkdir", "path": "new"}),
            ("preview", "post", "/desktop/api/preview/brief",
             {"ops": [{"selector": ".card", "property": "color", "new_value": "red"}]}),
        ):
            call = getattr(client, method)
            resp = await call(path, headers=BEARER, json=payload) if payload is not None \
                else await call(path, headers=BEARER)
            body = await resp.json()
            results[label] = (resp.status, body.get("error"))
        return results

    results = _run_app(tmp_path / "home", scenario)
    for label, (status, error) in results.items():
        assert status == 428, label
        assert error == WORKSPACE_REQUIRED, label


def test_valid_read_inside_root_returns_200(tmp_path: Path, workspace: Path):
    async def scenario(client, app):
        _grant(app, workspace)
        resp = await client.get(
            f"/desktop/api/fs/file?path={workspace / 'src' / 'file.py'}", headers=BEARER)
        body = await resp.json()
        tree = await client.get("/desktop/api/fs/tree", headers=BEARER)
        tree_body = await tree.json()
        return (resp.status, body, tree.status, tree_body)

    status, body, tree_status, tree_body = _run_app(tmp_path / "home", scenario)
    assert status == 200
    assert body["content"] == "print('ok')\n"
    assert body["path"] == str((workspace / "src" / "file.py").resolve())
    assert tree_status == 200
    assert tree_body["path"] == str(workspace.resolve())
    assert {entry["name"] for entry in tree_body["entries"]} >= {"src", "styles.css"}


def test_traversal_attempt_is_refused_and_touches_nothing(
        tmp_path: Path, workspace: Path, outside: Path):
    async def scenario(client, app):
        _grant(app, workspace)
        read = await client.get(
            f"/desktop/api/fs/file?path=../{outside.name}", headers=BEARER)
        read_body = await read.json()
        write = await client.post(
            "/desktop/api/fs/write",
            headers=BEARER,
            json={"path": f"../{outside.name}", "content": "pwned"},
        )
        write_body = await write.json()
        mutate = await client.post(
            "/desktop/api/fs/mutate",
            headers=BEARER,
            json={"op": "delete", "path": f"../{outside.name}"},
        )
        sibling = await client.get(
            f"/desktop/api/fs/file?path={tmp_path / 'workspace-other' / 'file.py'}",
            headers=BEARER)
        return (read.status, read_body, write.status, write_body,
                mutate.status, sibling.status)

    (read_status, read_body, write_status, write_body,
     mutate_status, sibling_status) = _run_app(tmp_path / "home", scenario)

    assert read_status == 400
    assert read_body["error"]
    assert write_status == 400
    assert write_body["error"]
    assert mutate_status == 400
    assert sibling_status == 403
    # Nothing outside the root was read or written.
    assert outside.read_text(encoding="utf-8") == "outside\n"
    assert not (tmp_path / "workspace-other").exists()


def test_b64_write_outside_root_is_refused(tmp_path: Path, workspace: Path):
    payload = base64.b64encode(b"payload").decode()

    async def scenario(client, app):
        _grant(app, workspace)
        escaped = await client.post(
            "/desktop/api/fs/write-b64",
            headers=BEARER,
            json={"path": str(tmp_path / "escaped.bin"), "data_b64": payload},
        )
        escaped_body = await escaped.json()
        traversal = await client.post(
            "/desktop/api/fs/write-b64",
            headers=BEARER,
            json={"path": "../escaped.bin", "data_b64": payload},
        )
        allowed = await client.post(
            "/desktop/api/fs/write-b64",
            headers=BEARER,
            json={"path": "assets/blob.bin", "data_b64": payload},
        )
        allowed_body = await allowed.json()
        return (escaped.status, escaped_body, traversal.status, allowed.status, allowed_body)

    escaped_status, escaped_body, traversal_status, allowed_status, allowed_body = _run_app(
        tmp_path / "home", scenario)

    assert escaped_status == 403
    assert escaped_body["error"]
    assert traversal_status == 400
    assert not (tmp_path / "escaped.bin").exists()
    assert allowed_status == 200
    assert allowed_body["bytes"] == len(b"payload")
    assert (workspace / "assets" / "blob.bin").read_bytes() == b"payload"


def test_write_and_mutate_enforce_the_boundary(tmp_path: Path, workspace: Path):
    async def scenario(client, app):
        _grant(app, workspace)
        credential = await client.post(
            "/desktop/api/fs/write",
            headers=BEARER,
            json={"path": ".env", "content": "SECRET=1\n"},
        )
        control = await client.post(
            "/desktop/api/fs/mutate",
            headers=BEARER,
            json={"op": "mkdir", "path": ".git/hooks"},
        )
        root_delete = await client.post(
            "/desktop/api/fs/mutate",
            headers=BEARER,
            json={"op": "delete", "path": "."},
        )
        rename_out = await client.post(
            "/desktop/api/fs/mutate",
            headers=BEARER,
            json={"op": "rename", "path": "src/file.py", "to": "../moved.py"},
        )
        allowed = await client.post(
            "/desktop/api/fs/mutate",
            headers=BEARER,
            json={"op": "mkdir", "path": "src/newdir"},
        )
        return (credential.status, control.status, root_delete.status,
                rename_out.status, allowed.status)

    credential, control, root_delete, rename_out, allowed = _run_app(tmp_path / "home", scenario)
    assert credential == 403
    assert control == 403
    assert root_delete == 403
    assert rename_out == 400
    assert allowed == 200
    assert not (workspace / ".env").exists()
    assert not (workspace / ".git").exists()
    assert (workspace / "src" / "file.py").exists()
    assert (workspace / "src" / "newdir").is_dir()
    assert not (tmp_path / "moved.py").exists()


def test_find_and_preview_stay_inside_the_workspace(tmp_path: Path, workspace: Path):
    (workspace / ".env").write_text("SECRET=1\n", encoding="utf-8")
    (workspace / ".env.example").write_text("SECRET=\n", encoding="utf-8")

    async def scenario(client, app):
        _grant(app, workspace)
        found = await client.get("/desktop/api/fs/find?name=.env", headers=BEARER)
        found_body = await found.json()
        brief = await client.post(
            "/desktop/api/preview/brief",
            headers=BEARER,
            json={"ops": [{"selector": ".card", "property": "color", "new_value": "red"}]},
        )
        brief_body = await brief.json()
        empty = await client.post("/desktop/api/preview/brief", headers=BEARER, json={"ops": []})
        return (found.status, found_body, brief.status, brief_body, empty.status)

    found_status, found_body, brief_status, brief_body, empty_status = _run_app(
        tmp_path / "home", scenario)

    assert found_status == 200
    # The credential file is filtered out of the walk.
    assert found_body["path"] is None
    assert found_body["count"] == 0
    assert brief_status == 200
    assert "styles.css" in brief_body.get("brief", brief_body.get("text", ""))
    assert empty_status == 400


def test_workspace_change_invalidates_grants_on_the_routes(tmp_path: Path, workspace: Path):
    second = tmp_path / "second"
    (second / "main.py").parent.mkdir(parents=True, exist_ok=True)
    (second / "main.py").write_text("pass\n", encoding="utf-8")

    async def scenario(client, app):
        _grant(app, workspace)
        first = await client.get(
            f"/desktop/api/fs/file?path={workspace / 'src' / 'file.py'}", headers=BEARER)
        _grant(app, second)
        old = await client.get(
            f"/desktop/api/fs/file?path={workspace / 'src' / 'file.py'}", headers=BEARER)
        old_body = await old.json()
        new = await client.get(f"/desktop/api/fs/file?path={second / 'main.py'}", headers=BEARER)
        root = await client.get("/desktop/api/fs/root", headers=BEARER)
        root_body = await root.json()
        return first.status, old.status, old_body, new.status, root_body

    first_status, old_status, old_body, new_status, root_body = _run_app(
        tmp_path / "home", scenario)
    assert first_status == 200
    assert old_status == 403
    assert old_body["error"]
    assert new_status == 200
    assert root_body["root"] == str(second.resolve())
