"""R1 Task 28a — adversarial corpus for the desktop surfaces.

Methodology
-----------
CyberGym-style, but inverted: every case here is an *executable attack* against a
defense that is already shipped (commit b5e3c15 plus 66a6975 / 9c86f41 / 1f22485
/ 4dbd832), and every test **asserts the defense holds**.  A test that fails is a
finding, not a broken test: the case is left exactly as-is and reported with its
severity.  No case is ever softened to make the suite green.

Each case is a self-contained, sandboxed reproduction:

* no network, no real models, no Electron binary — aiohttp's ``TestClient`` on an
  in-process ``build_desktop_app`` (or on a bare ``desktop_auth`` middleware for
  the pure auth vectors);
* every filesystem case runs inside ``tmp_path`` with a temp ``XAVANI_HOME``, so
  a case that *did* succeed could still not touch the developer's machine;
* the only side effects a passing case proves are negative ones: the victim file
  outside the root still holds its original bytes, the protected path still does
  not exist, no scratch file is left behind.

Naming: ``test_attack_<surface>_<vector>``.  Surfaces and severity:

==========  =========  ===============================================================
surface     severity   attack class
==========  =========  ===============================================================
auth        critical   surface takeover: token/origin/native-grant/generation replay
workspace   critical   boundary escape: prefix, traversal, symlink, encoding, NUL
writes      high       integrity: stale-revision race, scratch redirect, size, UTF-8
==========  =========  ===============================================================

The events surface (``applyRunEvent`` / ``endRunStream`` plus app.js's card
selection) is a separate JS corpus: ``test_adversarial_events.js``.

FINDINGS (two attack cases in this file are deliberately RED)
------------------------------------------------------------
F2  CRITICAL — ``test_attack_workspace_symlink_alias_spelling_disables_protected_paths``
    ``backend/workspace_paths.resolve_workspace_path`` realpaths the root, but
    ``_relative_parts`` then matches the candidate LEXICALLY against ``root_real``
    and ``root_given`` (both the realpath, because ``WorkspaceBoundary.resolve``
    calls ``require_root()`` first).  A candidate spelled through a symlink that
    lives outside the root but points at it --- the ordinary macOS
    ``/var`` -> ``/private/var`` alias needs nothing more --- fails all three
    ``relative_to`` attempts, so ``_relative_parts`` returns ``()`` and BOTH the
    credential denylist and the control-directory denylist, plus the
    per-component symlink walk, are silently skipped.  Reproduced end to end:
    ``GET /desktop/api/fs/file?path=<alias>/.env`` -> 200 with the secret
    contents, ``id_rsa`` -> 200, ``POST /desktop/api/fs/write`` into
    ``<alias>/.git/config`` -> 200 with the real ``.git/config`` rewritten on
    disk (``core.hooksPath`` = code execution on the next git command).  The
    realpath spelling of the same file is correctly refused (403).

F1  HIGH — ``test_attack_workspace_control_dir_case_variant_write_is_refused``
    ``_CONTROL_DIRS`` / ``_CONTROL_SEQUENCES`` are matched case-SENSITIVELY
    while APFS/HFS+ are not, so ``.GIT/config``, ``.SSH/authorized_keys``,
    ``.XAVANI/...``, ``.Config/xavani/...`` pass the denylist and land on the
    real control files.  Reproduced: 200 on ``.GIT/config`` with the on-disk
    ``.git/config`` rewritten, while ``.git/config`` returns 403.  The
    credential patterns are unaffected (``_is_credential_name`` lowercases).

Both cases are left exactly as the attack requires -- they assert the defense
HOLDS and therefore fail.  They are NOT weakened and no regression test pins the
broken behaviour: that decision belongs to the reviewer of this corpus.
"""

import asyncio
import hashlib
import os
import secrets
import sys
import threading
import unicodedata
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# serve_desktop resolves the engine at import time; keep the desktop suite
# runnable from a checkout that sits beside the engine.
os.environ.setdefault("XAVANI_ENGINE_ROOT", str(Path.home() / "xavani-agent"))

from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

from backend.desktop_auth import desktop_auth  # noqa: E402
from backend.serve_desktop import build_desktop_app  # noqa: E402
from backend.workspace_files import (  # noqa: E402
    MAX_TEXT_BYTES,
    RevisionConflict,
    content_hash,
    read_workspace_file,
    save_workspace_file,
)
from backend.workspace_paths import (  # noqa: E402
    NATIVE_GRANT_HEADER,
    NATIVE_GRANT_SOURCE,
    WORKSPACE_REQUIRED,
    WorkspaceError,
    WorkspaceInputError,
    WorkspaceRequired,
    WorkspaceTraversal,
    resolve_workspace_path,
)

SECRET = secrets.token_hex(32)
BEARER = {"Authorization": f"Bearer {SECRET}"}
OTHER_SECRET = secrets.token_hex(32)


# --------------------------------------------------------------------------
# sandbox helpers
# --------------------------------------------------------------------------


async def _ok(_request):
    return web.json_response({"ok": True})


async def _auth_probe(headers, secret: str = SECRET):
    """Run one request through the real ``desktop_auth`` middleware only."""
    app = web.Application(middlewares=[desktop_auth(secret)])
    app.router.add_get("/probe", _ok)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        resp = await client.get("/probe", headers=headers)
        return resp.status, await resp.json()
    finally:
        await client.close()


def _probe(headers, secret: str = SECRET):
    return asyncio.run(_auth_probe(headers, secret))


def _run_app(home: Path, scenario):
    """Run ``scenario(client, app)`` against a freshly assembled desktop app."""

    async def run():
        previous = os.environ.get("XAVANI_HOME")
        os.environ["XAVANI_HOME"] = str(home)
        home.mkdir(parents=True, exist_ok=True)
        try:
            app = build_desktop_app(8642, SECRET)
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


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / "ws"
    (root / "src").mkdir(parents=True)
    (root / "src" / "file.py").write_text("print('ok')\n", encoding="utf-8")
    return root


@pytest.fixture
def victim(tmp_path: Path) -> Path:
    """A file beside the workspace root that no attack may touch."""
    path = tmp_path / "victim.txt"
    path.write_text("VICTIM\n", encoding="utf-8")
    return path


def _inside(resolved: Path, root: Path) -> bool:
    return resolved == Path(os.path.realpath(root)) or Path(os.path.realpath(resolved)).is_relative_to(
        Path(os.path.realpath(root)))


# ==========================================================================
# AUTH (severity: critical)
# ==========================================================================


def test_attack_auth_missing_token_is_denied_everywhere():
    # severity: critical. No Authorization at all, and an empty one.
    for headers in ({}, {"Authorization": ""}, {"Authorization": "   "}):
        status, body = _probe(headers)
        assert status == 401, headers
        assert body == {"error": "Unauthorized."}, headers


def test_attack_auth_wrong_token_is_denied():
    # severity: critical. Near-miss tokens: all-zero, all-one, one-char mutation.
    mutation = ("a" if SECRET[0] != "a" else "b") + SECRET[1:]
    for token in ("b" * 64, secrets.token_hex(32), "0" * 64, mutation, SECRET[:-1], SECRET + "a"):
        status, _ = _probe({"Authorization": f"Bearer {token}"})
        assert status == 401, token


def test_attack_auth_token_casing_is_exact():
    # severity: critical. The secret is lowercase hex; an uppercased copy (a
    # case-insensitive comparison would let it through) must not authenticate —
    # neither on the renderer surface nor on the native grant header.
    status, _ = _probe({"Authorization": f"Bearer {SECRET.upper()}"})
    assert status == 401
    status, _ = _probe({NATIVE_GRANT_HEADER: SECRET.upper()})
    assert status == 401  # it is not even an Authorization header


def test_attack_auth_bearer_with_trailing_bytes_is_denied():
    # severity: critical. Suffix padding and scheme-confusion that survives HTTP
    # field parsing: the comparison is exact and case-sensitive on the scheme.
    for supplied in (
        f"Bearer {SECRET} ",            # trailing SP survives the parser
        f"Bearer {SECRET}\t",           # trailing HTAB survives the parser
        f"Bearer {SECRET}  ",
        f"Bearer {SECRET}x",
        f"Bearer  {SECRET}",            # doubled internal SP
        f"Bearer {SECRET}{SECRET}",
        f"bearer {SECRET}",
        f"Bearer:{SECRET}",
        f"Basic {SECRET}",
        f"Token {SECRET}",
        f"{SECRET}",                    # the raw secret is not a scheme
    ):
        status, _ = _probe({"Authorization": supplied})
        assert status == 401, supplied


def test_attack_auth_leading_ows_is_normalised_not_bypassed():
    # severity: critical. Leading whitespace after the colon is trimmed by HTTP
    # field parsing itself, so a padded header can arrive byte-identical to the
    # legitimate one. The invariant under attack is narrower than "always 401":
    # a request may only authenticate when the value the SERVER sees is exactly
    # ``Bearer <secret>``. Anything the parser leaves padded is refused.
    async def run():
        seen = []
        for supplied in (f" Bearer {SECRET}", f"\tBearer {SECRET}", f"   Bearer {SECRET}   "):
            captured = {}

            async def echo(request):
                captured["value"] = request.headers.get("Authorization", "")
                return web.json_response({"ok": True})

            app = web.Application(middlewares=[desktop_auth(SECRET)])
            app.router.add_get("/probe", echo)
            client = TestClient(TestServer(app))
            await client.start_server()
            try:
                resp = await client.get("/probe", headers={"Authorization": supplied})
                seen.append((supplied, resp.status, captured.get("value")))
            finally:
                await client.close()
        return seen

    for supplied, status, server_visible in asyncio.run(run()):
        if status == 200:
            # Reached the handler only because the parser handed over exactly
            # the legitimate value — the request is byte-equivalent to a real one.
            assert server_visible == f"Bearer {SECRET}", (supplied, server_visible)
        else:
            assert status == 401, supplied


def test_attack_auth_crlf_header_injection_is_refused_before_the_wire():
    # severity: critical. A CR/LF smuggled into the bearer (the classic way to
    # append a second header) never reaches the server: the stack refuses to
    # serialise the request at all. Either refusal (client-side ValueError, or a
    # 401 if a caller manages to send it) is a hold; a 200 would be a finding.
    for supplied in (f"Bearer {SECRET}\r\nX-Injected: 1", f"Bearer {SECRET}\n"):
        with pytest.raises(ValueError):
            _probe({"Authorization": supplied})


def test_attack_auth_duplicate_authorization_header_does_not_bypass():
    # severity: critical. Two Authorization headers: the middleware reads the
    # FIRST one (aiohttp CIMultiDict.get), so a hostile first value cannot be
    # shadowed by a later valid one, and a hostile trailing value cannot ride in
    # behind a valid first one to reach an intermediary that reads last.
    async def run():
        app = web.Application(middlewares=[desktop_auth(SECRET)])
        app.router.add_get("/probe", _ok)
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            results = []
            for pairs in (
                [("Authorization", f"Bearer {'0' * 64}"), ("Authorization", f"Bearer {SECRET}")],
                [("Authorization", f"Bearer {'0' * 64}"), ("Authorization", f"Bearer {'1' * 64}")],
                [("Authorization", SECRET), ("Authorization", f"Bearer {SECRET}")],
            ):
                resp = await client.get("/probe", headers=pairs)
                results.append(resp.status)
            return results
        finally:
            await client.close()

    assert asyncio.run(run()) == [401, 401, 401]


@pytest.mark.parametrize("origin", [
    "https://evil.example",
    "http://evil.example",
    "https://127.0.0.1.evil.example",
    "https://localhost.evil.example",
    "file://evil",
    "file://evil.example/x",
    "NULL",
    "Null",
    "blob:https://evil.example/uuid",
    "chrome-extension://evil/page.html",
])
def test_attack_auth_foreign_origins_are_denied(origin):
    # severity: critical. A hostile web page's origin must never reach a
    # desktop route, however close it spells the app's own file:// origin.
    status, body = _probe({"Authorization": f"Bearer {SECRET}", "Origin": origin})
    assert status == 403, origin
    assert body == {"error": "Origin denied."}, origin


def test_attack_auth_no_origin_is_checked_before_origin_denial():
    # severity: critical. An unauthenticated foreign-origin request must fail on
    # auth, not leak which of the two gates it tripped.
    status, body = _probe({"Origin": "https://evil.example"})
    assert status == 401
    assert body == {"error": "Unauthorized."}


def test_attack_auth_grant_route_without_native_header_is_denied(tmp_path: Path, workspace: Path):
    # severity: critical. A valid bearer is required AND not sufficient: the
    # grant route must additionally see the per-run secret in X-Xavani-Native,
    # raw. Every renderer-reachable spelling of the secret is refused.
    target = tmp_path / "granted-elsewhere"
    target.mkdir()

    async def scenario(client, app):
        hostile = [
            {},                                                        # absent
            {NATIVE_GRANT_HEADER: ""},                                 # empty
            {NATIVE_GRANT_HEADER: f"Bearer {SECRET}"},                 # wrapped
            {NATIVE_GRANT_HEADER: SECRET.upper()},                     # wrong casing
            {NATIVE_GRANT_HEADER: SECRET[:-1]},                        # near miss
            {NATIVE_GRANT_HEADER: secrets.token_hex(32)},              # unrelated secret
            {NATIVE_GRANT_HEADER: SECRET, "Origin": "https://evil.example"},
        ]
        statuses = []
        for extra in hostile:
            resp = await client.post(
                "/desktop/api/fs/root", headers={**BEARER, **extra}, json={"root": str(target)})
            body = await resp.json()
            statuses.append((resp.status, body.get("error")))
        after = await client.get("/desktop/api/fs/root", headers=BEARER)
        snapshot = app["workspace"].snapshot()
        return statuses, after.status, await after.json(), snapshot

    statuses, after_status, after_body, snapshot = _run_app(tmp_path / "home", scenario)

    for status, error in statuses:
        assert status in (403, 401), (status, error)
        assert error, (status, error)
    # None of them granted anything.
    assert snapshot == {"root": "", "granted": False, "generation": 0}
    assert after_status == 428
    assert after_body["error"] == WORKSPACE_REQUIRED


def test_attack_auth_second_app_generation_replay_is_denied(tmp_path: Path, workspace: Path):
    # severity: critical. A grant captured from app generation 1 (its bearer,
    # its native header, and its response body) is replayed against generation 2
    # built with a different secret. Every component of the replay must fail,
    # and gen-1's persisted workspace record must not self-grant gen-2.
    home = tmp_path / "home"
    gen1_secret, gen2_secret = secrets.token_hex(32), secrets.token_hex(32)

    async def boot(secret, scenario):
        previous = os.environ.get("XAVANI_HOME")
        os.environ["XAVANI_HOME"] = str(home)
        home.mkdir(parents=True, exist_ok=True)
        try:
            app = build_desktop_app(8642, secret)
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

    async def generation_one(client, _app):
        resp = await client.post(
            "/desktop/api/fs/root",
            headers={"Authorization": f"Bearer {gen1_secret}", NATIVE_GRANT_HEADER: gen1_secret},
            json={"root": str(workspace)},
        )
        return resp.status, await resp.json()

    gen1_status, captured = asyncio.run(boot(gen1_secret, generation_one))
    assert gen1_status == 200 and captured["granted"] is True
    persisted = home / "desktop-workspace.json"
    assert persisted.is_file() and str(workspace.resolve()) in persisted.read_text(encoding="utf-8")

    async def generation_two(client, app):
        # gen-1's persisted grant record is a hint, never a grant.
        before = await client.get("/desktop/api/fs/root", headers={"Authorization": f"Bearer {gen2_secret}"})
        replayed_bearer = await client.post(
            "/desktop/api/fs/root",
            headers={"Authorization": f"Bearer {gen1_secret}", NATIVE_GRANT_HEADER: gen1_secret},
            json={"root": str(workspace)},
        )
        replayed_native = await client.post(
            "/desktop/api/fs/root",
            headers={"Authorization": f"Bearer {gen2_secret}", NATIVE_GRANT_HEADER: gen1_secret},
            json={"root": str(workspace)},
        )
        replayed_body = await client.post(
            "/desktop/api/fs/root",
            headers={"Authorization": f"Bearer {gen2_secret}"},
            json=captured,
        )
        snapshot = app["workspace"].snapshot()
        # The gen-1 root path is not readable through the gen-2 app either.
        read = await client.get(
            "/desktop/api/fs/file",
            headers={"Authorization": f"Bearer {gen2_secret}"},
            params={"path": str(workspace / "src" / "file.py")},
        )
        honest = await client.post(
            "/desktop/api/fs/root",
            headers={"Authorization": f"Bearer {gen2_secret}", NATIVE_GRANT_HEADER: gen2_secret},
            json={"root": str(workspace)},
        )
        return (before.status, replayed_bearer.status, replayed_native.status,
                replayed_body.status, snapshot, read.status, honest.status,
                await honest.json())

    (before_status, bearer_status, native_status, body_status, snapshot,
     read_status, honest_status, honest_body) = asyncio.run(boot(gen2_secret, generation_two))

    assert before_status == 428            # the persisted record did not grant
    assert bearer_status == 401            # gen-1 bearer is not gen-2's
    assert native_status == 403            # gen-1 native header is not gen-2's
    assert body_status == 403              # replaying the response body grants nothing
    assert snapshot == {"root": "", "granted": False, "generation": 0}
    assert read_status == 428              # no workspace in generation 2 yet
    assert honest_status == 200            # the real gen-2 grant still works
    assert honest_body["generation"] == 1
    assert honest_body["root"] == str(workspace.resolve())


def test_attack_auth_second_app_generation_cross_secret_tokens_are_denied(
        tmp_path: Path, workspace: Path):
    # severity: critical. Cross-secret confusion: gen-1's secret in gen-2's
    # Authorization, and gen-2's secret in gen-1's X-Xavani-Native.
    async def boot(secret, scenario):
        previous = os.environ.get("XAVANI_HOME")
        os.environ["XAVANI_HOME"] = str(tmp_path / "home")
        (tmp_path / "home").mkdir(parents=True, exist_ok=True)
        try:
            app = build_desktop_app(8642, secret)
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

    async def only_gen2(client, _app):
        # The app under test is built with SECRET; OTHER_SECRET is the foreign
        # generation's secret. Auth is evaluated before the native grant check,
        # so a foreign bearer stops at 401 and only a bearer that matches can
        # reach — and then fail — the native check.
        a = await client.get("/desktop/api/fs/root", headers={"Authorization": f"Bearer {OTHER_SECRET}"})
        b = await client.post(
            "/desktop/api/fs/root",
            headers={"Authorization": f"Bearer {SECRET}", NATIVE_GRANT_HEADER: OTHER_SECRET},
            json={"root": str(workspace)},
        )
        c = await client.post(
            "/desktop/api/fs/root",
            headers={"Authorization": f"Bearer {OTHER_SECRET}", NATIVE_GRANT_HEADER: SECRET},
            json={"root": str(workspace)},
        )
        d = await client.post(
            "/desktop/api/fs/root",
            headers={"Authorization": f"Bearer {SECRET}", NATIVE_GRANT_HEADER: SECRET},
            json={"root": str(workspace)},
        )
        return a.status, b.status, c.status, d.status

    assert asyncio.run(boot(SECRET, only_gen2)) == (401, 403, 401, 200)


# ==========================================================================
# WORKSPACE (severity: critical)
# ==========================================================================


def test_attack_workspace_sibling_with_string_prefix_never_resolves(tmp_path: Path, workspace: Path,
                                                                    victim: Path):
    # severity: critical. root=/x/ws and the sibling /x/ws-evil share a string
    # prefix; a prefix check would admit it. Only realpath containment refuses.
    evil = tmp_path / "ws-evil"
    (evil / "src").mkdir(parents=True)
    (evil / "src" / "file.py").write_text("STOLEN\n", encoding="utf-8")
    assert str(evil).startswith(str(workspace))

    for raw in (str(evil / "src" / "file.py"), str(evil), str(evil / "src")):
        with pytest.raises(WorkspaceError):
            resolve_workspace_path(workspace, raw)
        with pytest.raises(WorkspaceError):
            resolve_workspace_path(workspace, raw, write=True)

    async def scenario(client, app):
        _grant(app, workspace)
        read = await client.get(
            "/desktop/api/fs/file", headers=BEARER, params={"path": str(evil / "src" / "file.py")})
        write = await client.post(
            "/desktop/api/fs/write", headers=BEARER,
            json={"path": str(evil / "src" / "file.py"), "content": "pwned",
                  "expected_revision": content_hash(b"STOLEN\n")})
        return read.status, write.status

    assert _run_app(tmp_path / "home", scenario) == (403, 403)
    assert (evil / "src" / "file.py").read_text(encoding="utf-8") == "STOLEN\n"
    assert victim.read_text(encoding="utf-8") == "VICTIM\n"


@pytest.mark.parametrize("raw", [
    "../victim.txt",
    "./../victim.txt",
    "src/../../victim.txt",
    "sub/../../etc/passwd",
    "sub/deep/../../../../etc/passwd",
    "../" * 30 + "etc/passwd",
    "src/./../../victim.txt",
])
def test_attack_workspace_parent_traversal_chains_are_refused(workspace: Path, raw: str):
    # severity: critical. `..` in any position, however deeply nested.
    with pytest.raises(WorkspaceTraversal) as excinfo:
        resolve_workspace_path(workspace, raw)
    assert WorkspaceTraversal.status == 400
    assert "traversal" in str(excinfo.value).lower()


def test_attack_workspace_dot_dot_dot_slash_never_escapes(tmp_path: Path, workspace: Path,
                                                          victim: Path):
    # severity: critical. ``....//....//`` is NOT a traversal on POSIX — ``....``
    # is a literal directory name — so the correct outcome is deterministic
    # containment, not a denial. The invariant under attack is no escape: either
    # a refusal, or a resolved path that stays inside the root. It must never
    # resolve to the parent of the root.
    root_real = Path(os.path.realpath(workspace))
    resolved_count = 0
    for raw in ("....//....//", "....//....//victim.txt", "a/....//b", "..../..",
                "..%2f..%2fvictim.txt", "%2e%2e/%2e%2e/victim.txt"):
        try:
            resolved = resolve_workspace_path(workspace, raw)
        except WorkspaceError:
            continue
        resolved_count += 1
        assert _inside(resolved, workspace), raw
        assert resolved != tmp_path.resolve(), raw
        assert not str(resolved).startswith(str(tmp_path / "ws-")), raw
    # Non-vacuous: the literal ``....`` components are admitted INSIDE the root
    # (they are ordinary directory names), which is exactly what makes the
    # containment assertions above meaningful.  A real ``..`` step is refused.
    assert resolved_count >= 4
    with pytest.raises(WorkspaceError):
        resolve_workspace_path(workspace, "../victim.txt")

    # The percent-encoded spellings are literal names here but become a real
    # traversal once the HTTP query layer decodes them — refused there.  The raw
    # query string is used because ``params=`` would re-encode the ``%``.
    async def scenario(client, app):
        _grant(app, workspace)
        results = []
        for query in ("path=..%2f..%2fvictim.txt", "path=%2e%2e/%2e%2e/victim.txt",
                      "path=....//....//victim.txt"):
            read = await client.get(f"/desktop/api/fs/file?{query}", headers=BEARER)
            body = await read.json()
            results.append((query, read.status, bool(body.get("error"))))
        return results

    for query, status, has_error in _run_app(tmp_path / "home", scenario):
        assert status >= 400, (query, status)
        assert has_error, (query, status)
    assert victim.read_text(encoding="utf-8") == "VICTIM\n"


def test_attack_workspace_symlink_escape_is_refused_for_read_and_write(tmp_path: Path,
                                                                      workspace: Path,
                                                                      victim: Path):
    # severity: critical. A symlink planted inside the root that points outside
    # it, in three shapes: a directory link, a leaf link, and a chained link.
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    (outside_dir / "secret.txt").write_text("SECRET\n", encoding="utf-8")
    (workspace / "escape").symlink_to(outside_dir, target_is_directory=True)
    (workspace / "leaf.txt").symlink_to(victim)
    hop = tmp_path / "hop"
    hop.symlink_to(outside_dir, target_is_directory=True)
    (workspace / "chain").symlink_to(hop, target_is_directory=True)

    for raw in ("escape/secret.txt", "escape", "leaf.txt", "chain/secret.txt", "chain"):
        with pytest.raises(WorkspaceError):
            resolve_workspace_path(workspace, raw)
        with pytest.raises(WorkspaceError):
            resolve_workspace_path(workspace, raw, write=True)
        with pytest.raises(WorkspaceError):
            read_workspace_file(workspace, raw)

    # A write through the link is refused, and the victim is untouched.
    with pytest.raises(WorkspaceError):
        save_workspace_file(workspace, "leaf.txt", "pwned\n", content_hash(b"VICTIM\n"))
    with pytest.raises(WorkspaceError):
        save_workspace_file(workspace, "escape/secret.txt", "pwned\n", content_hash(b"SECRET\n"))
    assert victim.read_text(encoding="utf-8") == "VICTIM\n"
    assert (outside_dir / "secret.txt").read_text(encoding="utf-8") == "SECRET\n"

    async def scenario(client, app):
        _grant(app, workspace)
        read = await client.get("/desktop/api/fs/file", headers=BEARER,
                                params={"path": "leaf.txt"})
        via_dir = await client.get("/desktop/api/fs/file", headers=BEARER,
                                   params={"path": "escape/secret.txt"})
        write = await client.post(
            "/desktop/api/fs/write", headers=BEARER,
            json={"path": "leaf.txt", "content": "pwned\n",
                  "expected_revision": content_hash(b"VICTIM\n")})
        return read.status, via_dir.status, write.status

    assert _run_app(tmp_path / "home", scenario) == (403, 403, 403)
    assert victim.read_text(encoding="utf-8") == "VICTIM\n"


def test_attack_workspace_symlinked_root_spelling_cannot_widen_the_boundary(tmp_path: Path,
                                                                          victim: Path):
    # severity: critical. The root itself is handed over through a symlink (the
    # macOS /var vs /private/var shape). An un-normalised root spelling must not
    # widen containment: a sibling reached through the alias stays refused.
    real_root = tmp_path / "real-root"
    real_root.mkdir()
    (real_root / "inside.txt").write_text("inside\n", encoding="utf-8")
    alias = tmp_path / "root-alias"
    alias.symlink_to(real_root, target_is_directory=True)
    outside = tmp_path / "root-alias-evil"
    outside.mkdir()
    (outside / "loot.txt").write_text("LOOT\n", encoding="utf-8")
    assert str(outside).startswith(str(alias))

    assert resolve_workspace_path(str(alias), "inside.txt").name == "inside.txt"
    for raw in (str(outside / "loot.txt"), str(victim), "../victim.txt"):
        with pytest.raises(WorkspaceError):
            resolve_workspace_path(str(alias), raw)
    assert (outside / "loot.txt").read_text(encoding="utf-8") == "LOOT\n"


def test_attack_workspace_unicode_normalization_is_deterministic_and_contained(
        tmp_path: Path, workspace: Path, victim: Path):
    # severity: critical. NFC and NFD spellings of the same name must not be a
    # way to reach a path the credential/containment rules refused, and the
    # answer must be deterministic per spelling (a normalising filesystem
    # resolves both to one file; a non-normalising one keeps them distinct).
    nfd = "caf\u0065\u0301.txt"          # café.txt, decomposed
    nfc = unicodedata.normalize("NFC", nfd)
    assert nfd != nfc
    (workspace / nfd).write_text("normalized\n", encoding="utf-8")
    # A credential whose *suffix* is unicode-adjacent is still a credential.
    (workspace / "caf\u00e9.key").write_text("KEYMATERIAL\n", encoding="utf-8")

    for raw in (nfd, nfc):
        first = resolve_workspace_path(workspace, raw)
        second = resolve_workspace_path(workspace, raw)
        assert first == second, raw                       # deterministic
        assert _inside(first, workspace), raw             # never escapes
        assert first != Path(os.path.realpath(victim)), raw

    # Both spellings of the credential name are refused, for read and write.
    for raw in ("caf\u00e9.key", "cafe\u0301.key"):
        with pytest.raises(WorkspaceError):
            resolve_workspace_path(workspace, raw)
        with pytest.raises(WorkspaceError):
            resolve_workspace_path(workspace, raw, write=True)

    # A unicode-named symlink out of the root is refused in either spelling.
    (workspace / "caf\u00e9-link").symlink_to(tmp_path, target_is_directory=True)
    for raw in ("caf\u00e9-link/victim.txt", "cafe\u0301-link/victim.txt"):
        with pytest.raises(WorkspaceError):
            resolve_workspace_path(workspace, raw)
    assert victim.read_text(encoding="utf-8") == "VICTIM\n"


def test_attack_workspace_windows_separators_never_escape(tmp_path: Path, workspace: Path,
                                                          victim: Path):
    # severity: critical. Backslash is a legal filename byte on POSIX, so
    # ``..\\..\\etc`` is one literal component. It must not be interpreted as a
    # parent step, and it must not resolve outside the root on either platform.
    resolved_count = 0
    for raw in ("..\\..\\etc\\passwd", "..\\..\\victim.txt", "sub\\..\\..\\..\\etc",
                "\\..\\..\\etc\\passwd", "C:\\Windows\\system32\\config\\SAM"):
        try:
            resolved = resolve_workspace_path(workspace, raw)
        except WorkspaceError:
            continue
        resolved_count += 1
        assert _inside(resolved, workspace), raw
        assert not str(resolved).startswith(str(tmp_path / "..")), raw
    # Non-vacuous: backslash names are admitted as literal components inside the
    # root, which is what the containment assertions above are checking.
    assert resolved_count == 5

    async def scenario(client, app):
        _grant(app, workspace)
        read = await client.get("/desktop/api/fs/file", headers=BEARER,
                                params={"path": "..\\..\\victim.txt"})
        write = await client.post(
            "/desktop/api/fs/write", headers=BEARER,
            json={"path": "..\\..\\victim.txt", "content": "pwned", "expected_revision": "x"})
        return read.status, write.status

    read_status, write_status = _run_app(tmp_path / "home", scenario)
    assert read_status in (400, 403, 404)
    # The boundary admits the literal name (it stays inside the root), so the
    # save fails closed on the missing file: 404, never a write.
    assert write_status in (400, 403, 404)
    assert victim.read_text(encoding="utf-8") == "VICTIM\n"
    assert not (workspace / "..\\..\\victim.txt").exists()


def test_attack_workspace_nul_byte_in_path_is_rejected(tmp_path: Path, workspace: Path):
    # severity: critical. A NUL byte is the classic truncation trick: the path
    # the check sees and the path the OS opens must be the same string.
    for raw in ("\x00", "src/file.py\x00", "src/file.py\x00/../../etc/passwd",
                "\x00/etc/passwd", "src\x00/file.py"):
        with pytest.raises(WorkspaceInputError):
            resolve_workspace_path(workspace, raw)
        with pytest.raises(WorkspaceInputError):
            resolve_workspace_path(workspace, raw, write=True)
    assert WorkspaceInputError.status == 400

    async def scenario(client, app):
        _grant(app, workspace)
        read = await client.get("/desktop/api/fs/file", headers=BEARER,
                                params={"path": "src/file.py\x00"})
        write = await client.post(
            "/desktop/api/fs/write", headers=BEARER,
            json={"path": "src/file.py\x00", "content": "pwned", "expected_revision": "x"})
        return read.status, write.status

    read_status, write_status = _run_app(tmp_path / "home", scenario)
    assert read_status == 400
    assert write_status == 400
    assert (workspace / "src" / "file.py").read_text(encoding="utf-8") == "print('ok')\n"


@pytest.mark.parametrize("empty_root", [None, "", "   ", "\t\n"])
def test_attack_workspace_empty_root_requires_a_workspace(empty_root):
    # severity: critical. An unset root must refuse, not default to home or cwd.
    with pytest.raises(WorkspaceRequired) as excinfo:
        resolve_workspace_path(empty_root, "src/file.py")
    assert str(excinfo.value) == WORKSPACE_REQUIRED == "Workspace required"
    assert WorkspaceRequired.status == 428
    with pytest.raises(WorkspaceRequired):
        resolve_workspace_path(empty_root, "src/file.py", write=True)


def test_attack_workspace_empty_root_via_the_routes(tmp_path: Path, workspace: Path):
    # severity: critical. Every filesystem route refuses before touching disk.
    async def scenario(client, _app):
        results = {}
        for label, method, path, payload in (
            ("file", "get", f"/desktop/api/fs/file?path={workspace / 'src' / 'file.py'}", None),
            ("tree", "get", "/desktop/api/fs/tree", None),
            ("write", "post", "/desktop/api/fs/write",
             {"path": "a.txt", "content": "x", "expected_revision": "deadbeef"}),
            ("mutate", "post", "/desktop/api/fs/mutate", {"op": "delete", "path": "src"}),
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
    assert (workspace / "src" / "file.py").is_file()  # nothing was deleted


def test_attack_workspace_control_directory_write_is_refused(tmp_path: Path, workspace: Path):
    # severity: critical. VCS and secret-store control files are never a write
    # target — including via a rename into them and via the b64 route.
    (workspace / ".git").mkdir()
    head = workspace / ".git" / "HEAD"
    head.write_text("ref: refs/heads/main\n", encoding="utf-8")

    for raw in (".git/HEAD", ".git/config", ".git/hooks/pre-commit",
                ".ssh/authorized_keys", ".config/xavani/config.yaml"):
        with pytest.raises(WorkspaceError):
            resolve_workspace_path(workspace, raw, write=True)

    revision = content_hash(head.read_bytes())

    async def scenario(client, app):
        _grant(app, workspace)
        write = await client.post(
            "/desktop/api/fs/write", headers=BEARER,
            json={"path": ".git/HEAD", "content": "ref: refs/heads/pwned\n",
                  "expected_revision": revision})
        rename = await client.post(
            "/desktop/api/fs/mutate", headers=BEARER,
            json={"op": "rename", "path": "src/file.py", "to": ".git/HEAD"})
        hook = await client.post(
            "/desktop/api/fs/mutate", headers=BEARER,
            json={"op": "mkdir", "path": ".git/hooks"})
        return write.status, rename.status, hook.status

    assert _run_app(tmp_path / "home", scenario) == (403, 403, 403)
    assert head.read_text(encoding="utf-8") == "ref: refs/heads/main\n"
    assert (workspace / "src" / "file.py").is_file()


@pytest.mark.parametrize("raw", [
    "id_rsa", ".env", ".ENV", "sub/id_rsa", "sub/.env", "certs/private.key",
    "certs/server.pem", "credentials.json", ".ssh/id_ed25519", ".netrc", ".npmrc",
])
def test_attack_workspace_credential_read_and_write_are_refused(workspace: Path, raw: str):
    # severity: critical. Credential-looking files are refused for BOTH
    # directions, at any depth, case-insensitively.
    with pytest.raises(WorkspaceError):
        resolve_workspace_path(workspace, raw)
    with pytest.raises(WorkspaceError):
        resolve_workspace_path(workspace, raw, write=True)


def test_attack_workspace_credential_routes_never_read_or_create(tmp_path: Path, workspace: Path):
    # severity: critical. Route-level: reading an existing key is refused and a
    # save never creates one.
    secret_file = workspace / "id_rsa"
    secret_file.write_text("PRIVATE KEY MATERIAL\n", encoding="utf-8")
    env_file = workspace / ".env"
    env_file.write_text("TOKEN=abc\n", encoding="utf-8")

    async def scenario(client, app):
        _grant(app, workspace)
        key_read = await client.get("/desktop/api/fs/file", headers=BEARER,
                                    params={"path": str(secret_file)})
        env_read = await client.get("/desktop/api/fs/file", headers=BEARER,
                                    params={"path": str(env_file)})
        env_write = await client.post(
            "/desktop/api/fs/write", headers=BEARER,
            json={"path": ".env", "content": "TOKEN=pwned\n",
                  "expected_revision": content_hash(env_file.read_bytes())})
        new_key = await client.post(
            "/desktop/api/fs/write", headers=BEARER,
            json={"path": "deploy/id_rsa", "content": "pwned\n", "expected_revision": "x"})
        found = await client.get("/desktop/api/fs/find", headers=BEARER, params={"name": "id_rsa"})
        return (key_read.status, env_read.status, env_write.status, new_key.status,
                found.status, await found.json())

    (key_status, env_status, env_write_status, new_key_status,
     found_status, found_body) = _run_app(tmp_path / "home", scenario)

    assert key_status == 403
    assert env_status == 403
    assert env_write_status == 403
    assert new_key_status == 403
    assert found_status == 200
    assert found_body["count"] == 0 and found_body["path"] is None
    assert secret_file.read_text(encoding="utf-8") == "PRIVATE KEY MATERIAL\n"
    assert env_file.read_text(encoding="utf-8") == "TOKEN=abc\n"
    assert not (workspace / "deploy" / "id_rsa").exists()


def test_attack_workspace_control_dir_case_variant_write_is_refused(tmp_path: Path,
                                                                   workspace: Path):
    # severity: HIGH — KNOWN FINDING (see module docstring: F1). This assertion
    # is deliberately STRICT and is expected to FAIL on a case-insensitive
    # filesystem (macOS default APFS/HFS+), which is where the desktop ships.
    #
    # Attack: the control-directory denylist in backend/workspace_paths.py
    # (``_CONTROL_DIRS``) is matched case-SENSITIVELY, while the filesystem is
    # not. ``.GIT/config`` therefore passes the denylist and the OS maps it onto
    # the real ``.git/config`` — a write into VCS control data (.git/config
    # ``core.hooksPath``, .git/hooks/*, .SSH/authorized_keys when the workspace
    # is the home directory). The credential denylist is NOT affected: it
    # lowercases the name (``.ENV`` is refused).
    config = workspace / ".git" / "config"
    config.parent.mkdir()
    original = b"[core]\n\trepositoryformatversion = 0\n"
    config.write_bytes(original)
    hostile_content = "[core]\n\thooksPath = /tmp/evil-hooks\n"

    async def scenario(client, app):
        _grant(app, workspace)
        resp = await client.post(
            "/desktop/api/fs/write", headers=BEARER,
            json={"path": ".GIT/config", "content": hostile_content,
                  "expected_revision": content_hash(original)})
        return resp.status, config.read_bytes()

    status, on_disk = _run_app(tmp_path / "home", scenario)

    refused = status not in range(200, 300)
    assert refused and on_disk == original, (
        "control-directory write was NOT refused for a case variant: "
        f"status={status}, .git/config on disk={on_disk!r}")


def test_attack_workspace_symlink_alias_spelling_disables_protected_paths(tmp_path: Path,
                                                                         workspace: Path):
    # severity: CRITICAL — KNOWN FINDING (see module docstring: F2). STRICT and
    # expected to FAIL. Not weakened.
    #
    # Attack: address a file inside the granted root through a path spelled via
    # a symlink that lives OUTSIDE the root but points at it (an ordinary macOS
    # ``/var`` -> ``/private/var`` alias, or any symlinked parent). Containment
    # holds on the realpath, but ``_relative_parts`` matches lexically, so all
    # three of its ``relative_to`` attempts fail and it returns ``()`` — which
    # silently skips the credential denylist, the control-directory denylist and
    # the per-component symlink walk. Observed: ``.env`` read returns 200 with
    # the secret, and a write into ``.git/config`` lands on disk.
    env_file = workspace / ".env"
    env_file.write_text("TOKEN=SUPERSECRET\n", encoding="utf-8")
    key_file = workspace / "id_rsa"
    key_file.write_text("PRIVATE KEY MATERIAL\n", encoding="utf-8")
    config = workspace / ".git" / "config"
    config.parent.mkdir()
    original_config = b"[core]\n\trepositoryformatversion = 0\n"
    config.write_bytes(original_config)

    alias = tmp_path / "alias-to-root"
    alias.symlink_to(workspace, target_is_directory=True)

    async def scenario(client, app):
        _grant(app, workspace)
        env_read = await client.get("/desktop/api/fs/file", headers=BEARER,
                                    params={"path": str(alias / ".env")})
        key_read = await client.get("/desktop/api/fs/file", headers=BEARER,
                                    params={"path": str(alias / "id_rsa")})
        control_write = await client.post(
            "/desktop/api/fs/write", headers=BEARER,
            json={"path": str(alias / ".git" / "config"),
                  "content": "[core]\n\thooksPath = /tmp/evil-hooks\n",
                  "expected_revision": content_hash(original_config)})
        env_write = await client.post(
            "/desktop/api/fs/write", headers=BEARER,
            json={"path": str(alias / ".env"), "content": "TOKEN=ATTACKER\n",
                  "expected_revision": content_hash(env_file.read_bytes())})
        return (env_read.status, key_read.status, control_write.status, env_write.status,
                config.read_bytes(), env_file.read_bytes())

    (env_status, key_status, control_status, env_write_status,
     config_now, env_now) = _run_app(tmp_path / "home", scenario)

    assert env_status == 403, f".env read through the alias returned {env_status}"
    assert key_status == 403, f"id_rsa read through the alias returned {key_status}"
    assert control_status == 403, f".git/config write returned {control_status}"
    assert env_write_status == 403, f".env write returned {env_write_status}"
    assert config_now == original_config, "the real .git/config was modified"
    assert env_now == b"TOKEN=SUPERSECRET\n", "the real .env was modified"


# ==========================================================================
# WRITES (severity: high)
# ==========================================================================


def test_attack_writes_stale_revision_race_lets_exactly_one_writer_win(tmp_path: Path):
    # severity: high. Two writers hold the SAME revision: one must win, the
    # other must be told the file moved, and the file must never be torn
    # (a mix of both payloads) or left with a scratch file.
    target = tmp_path / "shared.txt"
    target.write_bytes(b"seed\n")
    base = read_workspace_file(tmp_path, "shared.txt")
    payloads = {0: "writer-0\n", 1: "writer-1\n"}
    results: list = []
    start = threading.Barrier(2)

    def worker(index: int):
        start.wait()
        try:
            save_workspace_file(tmp_path, "shared.txt", payloads[index], base["revision"])
            results.append(("win", index))
        except RevisionConflict:
            results.append(("conflict", index))
        except Exception as exc:  # pragma: no cover - surfaced by the assert
            results.append((type(exc).__name__, index))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    outcomes = sorted(kind for kind, _ in results)
    assert outcomes == ["conflict", "win"], results
    winner = next(index for kind, index in results if kind == "win")
    assert target.read_bytes() == payloads[winner].encode("utf-8")
    assert [p.name for p in tmp_path.iterdir()] == ["shared.txt"]


def test_attack_writes_stale_revision_race_via_the_route(tmp_path: Path, workspace: Path):
    # severity: high. The same race over two concurrent HTTP saves carrying one
    # shared expected_revision: exactly one 200, one 409, and the bytes on disk
    # are exactly one payload.
    target = workspace / "src" / "file.py"
    base_revision = content_hash(target.read_bytes())
    bodies = [f"payload-{i}\n" for i in range(2)]

    async def scenario(client, app):
        _grant(app, workspace)

        async def save(content: str):
            resp = await client.post(
                "/desktop/api/fs/write", headers=BEARER,
                json={"path": str(target), "content": content,
                      "expected_revision": base_revision})
            return resp.status, await resp.json()

        first, second = await asyncio.gather(save(bodies[0]), save(bodies[1]))
        return first, second, target.read_text(encoding="utf-8")

    (first, second, final) = _run_app(tmp_path / "home", scenario)
    statuses = sorted((first[0], second[0]))
    assert statuses == [200, 409], (first, second)
    assert final in bodies
    loser = first if first[0] == 409 else second
    assert loser[1].get("conflict") is True
    assert [p.name for p in (workspace / "src").iterdir()] == ["file.py"]


def test_attack_writes_scratch_symlink_precreation_cannot_redirect_the_save(
        tmp_path: Path, workspace: Path, victim: Path):
    # severity: high. The classic mkstemp attack: pre-plant symlinks at the temp
    # name the save is about to create, so the write follows the link out of the
    # root. Observed outcome under the live defense: mkstemp opens with O_EXCL,
    # so it never follows a planted link — the save SUCCEEDS against the real
    # target, the victim keeps its bytes, and no scratch file is left. The test
    # also passes if the save fails closed; what it never tolerates is the
    # victim (or any path outside the root) being written through.
    target = workspace / "src" / "file.py"
    base = read_workspace_file(workspace, "src/file.py")

    inner = workspace / "src"
    planted = []
    for index in range(64):
        link = inner / f".xavani-save-{index:08x}"
        link.symlink_to(victim)
        planted.append(link)
    # A planted link at the other plausible prefix, too.
    (inner / ".xavani-save-attack").symlink_to(victim)

    victim_before = victim.read_bytes()
    outcome: str
    try:
        save_workspace_file(workspace, "src/file.py", "REPLACED\n", base["revision"])
        outcome = "succeeded"
    except (WorkspaceError, OSError) as exc:
        outcome = f"failed closed ({type(exc).__name__})"

    assert outcome == "succeeded", outcome  # documented live behavior
    assert victim.read_bytes() == victim_before       # the exit was never used
    assert target.read_text(encoding="utf-8") == "REPLACED\n"
    # No scratch file survived, planted links aside.
    leftovers = [p.name for p in inner.iterdir()
                 if p.name.startswith(".xavani-save-") and not p.is_symlink()]
    assert leftovers == []
    assert all(link.is_symlink() for link in planted)


def test_attack_writes_forced_scratch_name_collision_never_follows_the_plant(
        tmp_path: Path, workspace: Path, victim: Path, monkeypatch):
    # severity: high. The deterministic form of the case above: the temp-name
    # generator is forced to hand the save the names that were pre-planted as
    # symlinks pointing at the victim. ``tempfile.mkstemp`` opens with O_CREAT |
    # O_EXCL, so a planted link is never followed — it raises FileExistsError,
    # the save moves to the next name, and the write lands on the target.
    inner = workspace / "src"
    target = inner / "file.py"
    base = read_workspace_file(workspace, "src/file.py")
    victim_before = victim.read_bytes()

    planted_names = [f".xavani-save-forced{index}" for index in range(3)]
    for name in planted_names:
        (inner / name).symlink_to(victim)

    import tempfile as tempfile_module

    # Deliberately reaches the private generator: this is the only way to force
    # the collision deterministically instead of hoping for one.
    real_names = getattr(tempfile_module, "_get_candidate_names")()  # noqa: B009

    def forced_names():
        yield from planted_names
        yield from real_names

    monkeypatch.setattr(tempfile_module, "_get_candidate_names", forced_names)

    save_workspace_file(workspace, "src/file.py", "NEWCONTENT\n", base["revision"])

    assert victim.read_bytes() == victim_before      # the planted exit was refused
    assert target.read_text(encoding="utf-8") == "NEWCONTENT\n"
    for name in planted_names:                       # the traps are still traps
        assert (inner / name).is_symlink()
    leftovers = [p.name for p in inner.iterdir()
                 if p.name.startswith(".xavani-save-") and not p.is_symlink()]
    assert leftovers == []


def test_attack_writes_oversized_payload_is_refused_with_413(tmp_path: Path, workspace: Path):
    # severity: high. A payload past the text limit is refused before the body
    # is read (declared content-length) and again by the save itself; the file
    # on disk keeps its bytes either way.
    target = workspace / "src" / "file.py"
    original = target.read_bytes()
    oversized = "x" * (MAX_TEXT_BYTES + 1)

    async def scenario(client, app):
        _grant(app, workspace)
        resp = await client.post(
            "/desktop/api/fs/write", headers=BEARER,
            json={"path": str(target), "content": oversized,
                  "expected_revision": content_hash(original)})
        body = await resp.json()
        second = await client.post(
            "/desktop/api/fs/write", headers=BEARER,
            json={"path": str(target), "content": oversized,
                  "expected_revision": "0" * 64})
        return resp.status, body, second.status

    status, body, second_status = _run_app(tmp_path / "home", scenario)
    assert status == 413
    assert body["error"]
    assert second_status == 413
    assert target.read_bytes() == original


def test_attack_writes_invalid_utf8_never_reaches_the_disk(tmp_path: Path, workspace: Path):
    # severity: high. Two directions: a binary file must not be handed to the
    # editor (415, bytes untouched), and a save body that is not valid UTF-8 /
    # not valid JSON must not overwrite the file.
    binary = workspace / "src" / "asset.bin"
    binary.write_bytes(b"\xff\xfe\x00\x80binary")
    target = workspace / "src" / "file.py"
    original = target.read_bytes()

    async def scenario(client, app):
        _grant(app, workspace)
        read = await client.get("/desktop/api/fs/file", headers=BEARER,
                                params={"path": str(binary)})
        raw = await client.post(
            "/desktop/api/fs/write",
            headers={**BEARER, "Content-Type": "application/json"},
            data=b'{"path": "src/file.py", "content": "\xff\xfe", "expected_revision": "x"}')
        surrogate = await client.post(
            "/desktop/api/fs/write", headers=BEARER,
            json={"path": str(target), "content": "\ud800", "expected_revision": "x"})
        return read.status, raw.status, surrogate.status

    read_status, raw_status, surrogate_status = _run_app(tmp_path / "home", scenario)
    assert read_status == 415
    assert raw_status in (400, 415)
    assert surrogate_status in (400, 415)
    assert binary.read_bytes() == b"\xff\xfe\x00\x80binary"
    assert target.read_bytes() == original


def test_attack_writes_missing_or_garbage_revision_cannot_overwrite(tmp_path: Path,
                                                                    workspace: Path):
    # severity: high. A save with no revision (or an arbitrary hash) is never
    # permission to clobber: 428 for absent, 409 for wrong.
    target = workspace / "src" / "file.py"
    original = target.read_bytes()

    async def scenario(client, app):
        _grant(app, workspace)
        statuses = []
        for payload in (
            {"path": str(target), "content": "pwned\n"},
            {"path": str(target), "content": "pwned\n", "expected_revision": None},
            {"path": str(target), "content": "pwned\n", "expected_revision": ""},
            {"path": str(target), "content": "pwned\n", "expected_revision": 0},
            {"path": str(target), "content": "pwned\n", "expected_revision": "0" * 64},
            {"path": str(target), "content": "pwned\n", "expected_revision": {}},
        ):
            resp = await client.post("/desktop/api/fs/write", headers=BEARER, json=payload)
            statuses.append(resp.status)
        return statuses

    statuses = _run_app(tmp_path / "home", scenario)
    assert statuses == [428, 428, 428, 428, 409, 428]
    assert target.read_bytes() == original


def test_attack_writes_stale_revision_conflict_never_writes_the_buffer(tmp_path: Path,
                                                                     workspace: Path):
    # severity: high. An external writer lands between the read and the save:
    # the buffer must be refused whole (no partial flush) and the disk content
    # handed back for review.
    target = workspace / "src" / "file.py"
    base = read_workspace_file(workspace, "src/file.py")

    async def scenario(client, app):
        _grant(app, workspace)
        target.write_text("EXTERNAL\n", encoding="utf-8")
        resp = await client.post(
            "/desktop/api/fs/write", headers=BEARER,
            json={"path": str(target), "content": "BUFFER\n",
                  "expected_revision": base["revision"]})
        body = await resp.json()
        return resp.status, body, target.read_text(encoding="utf-8")

    status, body, final = _run_app(tmp_path / "home", scenario)
    assert status == 409
    assert body["conflict"] is True
    assert body["disk"] == "EXTERNAL\n"
    assert body["current_revision"] == content_hash(b"EXTERNAL\n")
    assert final == "EXTERNAL\n"
    assert [p.name for p in (workspace / "src").iterdir()] == ["file.py"]


def test_attack_writes_hash_collision_in_expected_revision_is_not_accepted(
        tmp_path: Path, workspace: Path):
    # severity: high. A revision that is well-formed hex but not the disk hash —
    # and one that matches the length/format of a real digest — is refused.
    target = workspace / "src" / "file.py"
    original = target.read_bytes()
    forged = [
        hashlib.sha256(b"something else").hexdigest(),
        "f" * 64,
        content_hash(original)[:-1] + ("0" if content_hash(original)[-1] != "0" else "1"),
        content_hash(original).upper(),
        "  " + content_hash(original),
    ]

    async def scenario(client, app):
        _grant(app, workspace)
        statuses = []
        for revision in forged:
            resp = await client.post(
                "/desktop/api/fs/write", headers=BEARER,
                json={"path": str(target), "content": "pwned\n", "expected_revision": revision})
            statuses.append(resp.status)
        return statuses

    statuses = _run_app(tmp_path / "home", scenario)
    assert statuses == [409, 409, 409, 409, 409]
    assert target.read_bytes() == original
