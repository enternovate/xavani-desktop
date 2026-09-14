#!/usr/bin/env python3
# Copyright (c) 2025-2026 Enternovate.
# MIT License -- See LICENSE file for full terms.
# Built by Enternovate -- Open source. Private. Local.

"""Desktop e2e test runtime: an OpenAI-compatible provider stub.

The fixture points the desktop engine at this server through the isolated
home's config.yaml, so e2e runs exercise the real provider boundary instead
of a patched client. Non-streaming payloads are shaped through the agent
repo's test harness faux provider (tests.harness.faux_provider); streaming
answers replay the same scripted text. Read-only by design: the scripted
reply never carries tool calls.

Usage:
    python3 backend/test_runtime.py --port 19001 --reply "FAUX-OK" \
        [--engine-path ~/xavani-agent] [--model faux-1]

Prints one log line per request to stderr; the fixture keeps the output.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_MODEL = "faux-1"

_faux_cache = {"loaded": False, "value": None}


def _faux():
    """Import the agent harness faux provider once; None when unavailable."""
    if _faux_cache["loaded"]:
        return _faux_cache["value"]
    _faux_cache["loaded"] = True
    engine_path = getattr(ARGS, "engine_path", "")
    try:
        if engine_path and engine_path not in sys.path:
            sys.path.insert(0, engine_path)
        from tests.harness.faux_provider import FauxProvider, _Completion  # noqa: PLC2701

        _faux_cache["value"] = (FauxProvider, _Completion)
        sys.stderr.write("[test-runtime] faux provider loaded from the engine harness\n")
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"[test-runtime] faux provider unavailable: {exc}\n")
        _faux_cache["value"] = None
    return _faux_cache["value"]


def build_payload(reply: str, model: str) -> dict:
    """One OpenAI chat.completion payload, shaped via the faux provider."""
    content, finish = reply, "stop"
    faux = _faux()
    if faux is not None:
        provider_cls, completion_cls = faux
        provider = provider_cls(script=[lambda: completion_cls(reply, None, model)])
        result = provider.chat.completions.create(model=model, messages=[], stream=False)
        choice = result.choices[0]
        content = choice.message.content or reply
        finish = choice.finish_reason or "stop"
    return {
        "id": "chatcmpl-faux-1",
        "object": "chat.completion",
        "created": 0,
        "model": model,
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": content},
             "finish_reason": finish}
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def sse_bytes(reply: str, model: str) -> bytes:
    first = {
        "id": "chatcmpl-faux-1", "object": "chat.completion.chunk", "model": model,
        "choices": [{"index": 0, "delta": {"role": "assistant", "content": reply},
                     "finish_reason": None}],
    }
    last = {
        "id": "chatcmpl-faux-1", "object": "chat.completion.chunk", "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }
    body = f"data: {json.dumps(first)}\n\ndata: {json.dumps(last)}\n\ndata: [DONE]\n\n"
    return body.encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature name
        sys.stderr.write(f"[test-runtime] {self.address_string()} {format % args}\n")

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - stdlib signature
        if self.path.rstrip("/").endswith("/models"):
            self._json({"object": "list", "data": [{"id": ARGS.model, "object": "model"}]})
            return
        self._json({"error": "not found"}, status=404)

    def do_POST(self):  # noqa: N802 - stdlib signature
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001
            body = {}
        model = str(body.get("model") or ARGS.model)
        stream = bool(body.get("stream"))
        n_messages = len(body.get("messages") or [])
        sys.stderr.write(
            f"[test-runtime] POST {self.path} stream={stream} messages={n_messages}\n")
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._json({"error": "not found"}, status=404)
            return
        if stream:
            data = sse_bytes(ARGS.reply, model)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self._json(build_payload(ARGS.reply, model))


ARGS = argparse.ArgumentParser().parse_args([])


def main() -> None:
    global ARGS
    parser = argparse.ArgumentParser(description="desktop e2e faux provider runtime")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--reply", required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--engine-path", default="")
    ARGS = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    sys.stderr.write(f"[test-runtime] listening on 127.0.0.1:{ARGS.port}\n")
    sys.stderr.flush()
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
