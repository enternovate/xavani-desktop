"""The release manifest gate rejects dirty, stale, or malformed manifests."""

from __future__ import annotations

import importlib.util
from pathlib import Path


def _load():
    repo = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location(
        "_manifest_under_test", repo / "scripts" / "check_release_manifest.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GOOD = {
    "schema": 1,
    "version": "0.3.1",
    "engine_revision": "a" * 40,
    "engine_dirty": False,
    "built_at": "2026-10-24T07:00:00Z",
    "platform": "macos-arm64",
}


def test_good_manifest_passes():
    module = _load()
    assert module.validate(dict(GOOD), "0.3.1", None) == []


def test_dirty_engine_is_rejected():
    module = _load()
    payload = dict(GOOD, engine_dirty=True)
    assert any("dirty" in problem for problem in module.validate(payload, "0.3.1", None))


def test_version_mismatch_is_rejected():
    module = _load()
    assert any("version" in problem for problem in module.validate(dict(GOOD), "0.3.2", None))


def test_short_revision_is_rejected():
    module = _load()
    payload = dict(GOOD, engine_revision="abc123")
    assert any("40" in problem for problem in module.validate(payload, "0.3.1", None))


def test_engine_revision_mismatch_is_rejected():
    module = _load()
    assert any("revision" in problem for problem in module.validate(dict(GOOD), "0.3.1", "b" * 40))
