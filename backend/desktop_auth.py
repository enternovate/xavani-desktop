"""Per-run bearer-token middleware for the desktop HTTP surfaces."""

import hmac
import re

from aiohttp import web

_SECRET_RE = re.compile(r"[0-9a-f]{64}")


def desktop_auth(secret: str):
    """Build the aiohttp middleware that gates a desktop surface on ``secret``."""
    if not isinstance(secret, str) or not _SECRET_RE.fullmatch(secret):
        raise ValueError("desktop secret must be 64 lowercase hex characters")

    expected = f"Bearer {secret}".encode()

    @web.middleware
    async def _middleware(request: "web.Request", handler):
        supplied = request.headers.get("Authorization", "")
        if not hmac.compare_digest(supplied.encode(), expected):
            return web.json_response({"error": "Unauthorized."}, status=401)
        origin = request.headers.get("Origin")
        if origin and origin != "null":
            return web.json_response({"error": "Origin denied."}, status=403)
        return await handler(request)

    return _middleware
