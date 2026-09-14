import asyncio
import secrets

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from backend.desktop_auth import desktop_auth

SECRET = secrets.token_hex(32)
BEARER = f"Bearer {SECRET}"


async def _ok(_request):
    return web.json_response({"ok": True})


def _probe(headers):
    async def run():
        app = web.Application(middlewares=[desktop_auth(SECRET)])
        app.router.add_get("/probe", _ok)
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            resp = await client.get("/probe", headers=headers)
            return resp.status, await resp.json()
        finally:
            await client.close()

    return asyncio.run(run())


def test_missing_authorization_is_unauthorized():
    assert _probe({}) == (401, {"error": "Unauthorized."})


def test_wrong_token_is_unauthorized():
    assert _probe({"Authorization": f"Bearer {'b' * 64}"}) == (401, {"error": "Unauthorized."})


def test_authorization_without_bearer_scheme_is_unauthorized():
    assert _probe({"Authorization": SECRET})[0] == 401


def test_valid_bearer_without_origin_is_allowed():
    assert _probe({"Authorization": BEARER}) == (200, {"ok": True})


def test_null_origin_is_allowed():
    assert _probe({"Authorization": BEARER, "Origin": "null"}) == (200, {"ok": True})


def test_foreign_origin_is_denied():
    headers = {"Authorization": BEARER, "Origin": "https://evil.example"}
    assert _probe(headers) == (403, {"error": "Origin denied."})


def test_authorization_is_checked_before_origin():
    headers = {"Authorization": f"Bearer {'0' * 64}", "Origin": "https://evil.example"}
    assert _probe(headers)[0] == 401


@pytest.mark.parametrize("bad", [
    "",
    "a" * 63,
    "a" * 65,
    "A" * 64,
    "z" * 64,
    "a" * 64 + "\n",
    None,
    123,
    b"a" * 64,
    ["a" * 64],
])
def test_factory_rejects_invalid_secrets(bad):
    with pytest.raises(ValueError):
        desktop_auth(bad)
