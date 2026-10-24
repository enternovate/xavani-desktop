import io
import json
import os
from pathlib import Path

import pytest

SECRET = "ab" * 32
OTHER = "cd" * 32

ENGINE = Path(os.environ.get("XAVANI_ENGINE_ROOT") or Path.home() / "xavani-agent")
os.environ["XAVANI_ENGINE_ROOT"] = str(ENGINE)

from backend.serve_desktop import _read_bootstrap_secret  # noqa: E402


def _line(payload, *, raw=None):
    return io.StringIO(raw if raw is not None else json.dumps(payload) + "\n")


def test_valid_line_returns_secret():
    assert _read_bootstrap_secret(_line({"secret": SECRET, "unrelated": 1})) == SECRET


def test_missing_key_raises():
    with pytest.raises(ValueError):
        _read_bootstrap_secret(_line({"token": SECRET}))


def test_short_secret_raises():
    with pytest.raises(ValueError):
        _read_bootstrap_secret(_line({"secret": "ab"}))


def test_non_hex_secret_raises():
    with pytest.raises(ValueError):
        _read_bootstrap_secret(_line({"secret": "zz" * 32}))


def test_uppercase_hex_secret_raises():
    with pytest.raises(ValueError):
        _read_bootstrap_secret(_line({"secret": SECRET.upper()}))


def test_non_string_secret_raises():
    with pytest.raises(ValueError):
        _read_bootstrap_secret(_line({"secret": 12345}))


def test_non_object_json_raises():
    with pytest.raises(ValueError):
        _read_bootstrap_secret(_line(None, raw="[1, 2, 3]\n"))


def test_invalid_json_raises():
    with pytest.raises(ValueError):
        _read_bootstrap_secret(_line(None, raw="not json\n"))


def test_empty_stream_raises():
    with pytest.raises(ValueError):
        _read_bootstrap_secret(io.StringIO(""))


def test_consumes_exactly_one_line_and_writes_nothing(capsys):
    stream = io.StringIO(
        json.dumps({"secret": SECRET}) + "\n" + json.dumps({"secret": OTHER}) + "\n"
    )
    assert _read_bootstrap_secret(stream) == SECRET
    assert _read_bootstrap_secret(stream) == OTHER
    assert stream.readline() == ""
    assert capsys.readouterr().out == ""
