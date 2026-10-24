"""The backend module must import without an engine checkout."""

from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_backend():
    repo = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location(
        "_serve_desktop_under_test", repo / "backend" / "serve_desktop.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_import_does_not_require_an_engine(monkeypatch):
    monkeypatch.delenv("XAVANI_ENGINE_ROOT", raising=False)
    monkeypatch.delenv("XAVANI_ENGINE_SRC", raising=False)
    module = _load_backend()
    assert hasattr(module, "engine_root")
