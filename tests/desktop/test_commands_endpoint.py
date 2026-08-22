import json
import os
import subprocess
import sys
from pathlib import Path

ENGINE = Path(os.environ.get("XAVANI_ENGINE_ROOT", Path.home() / "xavani-agent"))


def test_registry_exposes_02_commands():
    code = (
        "import sys, json; sys.path.insert(0, sys.argv[1]);"
        "from xavani_cli.commands import COMMAND_REGISTRY;"
        "print(json.dumps([{'name': c.name, 'desc': c.description or '',"
        "'args_hint': c.args_hint or '', 'category': c.category or ''}"
        "for c in COMMAND_REGISTRY]))"
    )
    out = subprocess.run(
        [sys.executable, "-c", code, str(ENGINE)],
        capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr[-500:]
    cmds = json.loads(out.stdout)
    names = {c["name"] for c in cmds}
    # 0.2.0 headline features must be discoverable by the desktop.
    for required in ("loop", "loops", "eval", "diff", "permissions", "reasoning", "fast", "voice"):
        assert required in names, f"missing {required}"


def test_serve_desktop_maps_registry_fields():
    src = (Path(__file__).resolve().parents[2] / "backend" / "serve_desktop.py").read_text(encoding="utf-8")
    assert '"/desktop/api/commands"' in src
    for field in ("name", "desc", "args_hint", "category"):
        assert f'"{field}"' in src
