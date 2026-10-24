#!/usr/bin/env python3
"""Validate a Xavani desktop release manifest."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REQUIRED_KEYS = {
    "schema": int,
    "version": str,
    "engine_revision": str,
    "engine_dirty": bool,
    "built_at": str,
    "platform": str,
}
REPO_ROOT = Path(__file__).resolve().parents[1]


def validate(manifest: dict, package_version: str, engine_revision: str | None) -> list[str]:
    """Return a list of problems. An empty list means the manifest is valid."""
    problems: list[str] = []
    for key, kind in REQUIRED_KEYS.items():
        if not isinstance(manifest.get(key), kind):
            problems.append(f"missing or invalid key: {key}")
    if manifest.get("engine_dirty") is not False:
        problems.append("engine tree is dirty")
    if manifest.get("version") != package_version:
        problems.append(f"version mismatch: {manifest.get('version')} != {package_version}")
    revision = str(manifest.get("engine_revision", ""))
    if len(revision) != 40:
        problems.append("engine revision is not a full 40-character commit")
    if engine_revision and revision != engine_revision:
        problems.append(f"engine revision mismatch: {revision} != {engine_revision}")
    return problems


def git_head(repo: Path) -> str:
    """Return the commit at the head of the engine tree."""
    result = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def main(argv: list[str] | None = None) -> int:
    """Validate the manifest and return a process exit code."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--package-json", type=Path, default=REPO_ROOT / "package.json")
    parser.add_argument("--engine", type=Path, default=None)
    args = parser.parse_args(argv)

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    package_version = json.loads(args.package_json.read_text(encoding="utf-8"))["version"]

    engine = args.engine
    if engine is None:
        env = os.environ.get("XAVANI_ENGINE_SRC")
        engine = Path(env) if env else None
    engine_revision = git_head(engine) if engine else None

    problems = validate(manifest, package_version, engine_revision)
    if not engine_revision:
        print("note: XAVANI_ENGINE_SRC is unset; the revision comparison is skipped")
    for problem in problems:
        print(f"FAIL: {problem}")
    if problems:
        return 1
    print(f"OK: {args.manifest} version={package_version} engine={manifest['engine_revision'][:12]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
