#!/usr/bin/env python3
"""Xavani Desktop backend.

Boots two localhost services in one asyncio loop:
  1. The gateway API-server adapter (chat completions, runs + SSE lifecycle,
     approvals, stop, cron job CRUD) on ``api_port``.
  2. A small desktop-management REST surface on ``desktop_port`` (status,
     sessions, toolsets, skills, shutdown).

Signals readiness to the Electron shell as a single JSON line on stdout:
    {"ready": true, "api_port": N, "desktop_port": M, ...}
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import shutil
import signal
import socket
import sys
import time
import tomllib
from pathlib import Path

STARTED_AT = time.time()


def _engine_root() -> Path:
    env = os.environ.get("XAVANI_ENGINE_ROOT")
    if env and (Path(env) / "run_agent.py").exists():
        return Path(env)
    here = Path(__file__).resolve().parent
    for candidate in (here.parent / "engine", here.parent, *here.parents):
        if (candidate / "run_agent.py").exists():
            return str(candidate) and Path(candidate)
    raise SystemExit("xavani-agent engine root not found (looked for run_agent.py)")


ENGINE_ROOT = _engine_root()
sys.path.insert(0, str(ENGINE_ROOT))

# All children (CLI one-shots, PTY shell, MCP servers spawned by the engine)
# must see this interpreter's console scripts — e.g. the bundled
# nyarhi/gavaza/mhangani/constellation-mcp CLIs. No resolve(): the venv
# symlink's parent is the dir that holds them.
_BINDIR = str(Path(sys.executable).parent)
os.environ["PATH"] = f"{_BINDIR}{os.pathsep}{os.environ.get('PATH', '')}"


def _free_port(start: int, used: set[int]) -> int:
    port = start
    while port in used or not _port_bindable(port):
        port += 1
        if port > start + 50:
            raise SystemExit("no free ports in range")
    used.add(port)
    return port


def _port_bindable(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _xavani_home() -> Path:
    return Path(os.environ.get("XAVANI_HOME", Path.home() / ".xavani")).expanduser()


def _load_config() -> dict:
    try:
        from xavani_cli.config import load_config

        cfg = load_config()
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        path = _xavani_home() / "config.yaml"
        if path.exists():
            try:
                import yaml

                data = yaml.safe_load(path.read_text(encoding="utf-8"))
                return data if isinstance(data, dict) else {}
            except Exception:
                return {}
        return {}


def _engine_version() -> str:
    try:
        data = tomllib.loads((ENGINE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
        return str(data.get("project", {}).get("version", "unknown"))
    except Exception:
        match = re.search(r'VERSION\s*=\s*"([^"]+)"', (ENGINE_ROOT / "xavani.py").read_text(encoding="utf-8"))
        return match.group(1) if match else "unknown"


def _enabled_toolsets(cfg: dict) -> list[str]:
    try:
        from xavani_cli.tools_config import _get_platform_tools

        return sorted(_get_platform_tools(cfg, "cli"))
    except Exception:
        tools = cfg.get("tools") or {}
        saved = tools.get("platforms", {}).get("cli", {}).get("toolsets")
        return sorted(saved) if isinstance(saved, list) else []


def _list_toolsets(cfg: dict) -> list[dict]:
    try:
        from toolsets import TOOLSETS
    except Exception:
        return []
    enabled = set(_enabled_toolsets(cfg))
    out = []
    for key, val in TOOLSETS.items():
        desc = ""
        if isinstance(val, dict):
            desc = str(val.get("description") or val.get("desc") or "")
        elif isinstance(val, (tuple, list)) and val:
            desc = str(val[-1])
        out.append({"name": key, "description": desc, "enabled": key in enabled})
    return out


def _toggle_toolset(name: str, enable: bool, cfg: dict) -> dict:
    from xavani_cli.tools_config import _save_platform_tools

    current = set(_enabled_toolsets(cfg))
    if enable:
        current.add(name)
    else:
        current.discard(name)
    _save_platform_tools(cfg, "cli", current)
    return {"name": name, "enabled": name in current}


def _frontmatter(path: Path) -> tuple[str, str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return path.parent.name, ""
    if not text.startswith("---"):
        return path.parent.name, ""
    end = text.find("\n---", 3)
    if end == -1:
        return path.parent.name, ""
    name = path.parent.name
    desc = ""
    for line in text[4:end].splitlines():
        m = re.match(r"^(name|description):\s*(.*)$", line)
        if not m:
            continue
        val = m.group(2).strip().strip("'\"").strip()
        if m.group(1) == "name" and val:
            name = val
        elif m.group(1) == "description":
            desc = val
    return name, desc[:200]


def _installed_skills() -> list[dict]:
    skills_dir = _xavani_home() / "skills"
    out = []
    if skills_dir.is_dir():
        for skill_md in sorted(skills_dir.glob("*/SKILL.md")):
            name, desc = _frontmatter(skill_md)
            out.append({"name": name, "description": desc[:200]})
    return out


def build_desktop_app(api_port: int):
    from aiohttp import web

    routes = web.RouteTableDef()

    CLI_COMMANDS = [
        {"name": "doctor", "args": ["doctor"], "desc": "Check dependencies, config and health"},
        {"name": "status", "args": ["status"], "desc": "Component status overview"},
        {"name": "config", "args": ["config"], "desc": "Show current configuration"},
        {"name": "insights", "args": ["insights"], "desc": "Usage analytics"},
        {"name": "tools list", "args": ["tools", "list"], "desc": "All toolsets and their state"},
        {"name": "skills list", "args": ["skills", "list"], "desc": "Installed skills"},
        {"name": "cron list", "args": ["cron", "list"], "desc": "Scheduled jobs"},
        {"name": "sessions list", "args": ["sessions", "list"], "desc": "Recent sessions"},
        {"name": "mcp list", "args": ["mcp", "list"], "desc": "Configured MCP servers"},
        {"name": "profile list", "args": ["profile", "list"], "desc": "Agent profiles"},
        {"name": "memory status", "args": ["memory", "status"], "desc": "Memory provider status"},
        {"name": "constellation status", "args": ["constellation", "status"], "desc": "Gavaza / Nyarhi / Mhangani status"},
        {"name": "constellation doctor", "args": ["constellation", "doctor"], "desc": "Verify the constellation install"},
    ]

    def _runtime_bin(name: str) -> str:
        packaged = Path(__file__).resolve().parent / "runtime" / "bin" / name
        if packaged.exists():
            return str(packaged)
        found = shutil.which(name)
        return found or name

    async def _run_cli(args: list[str], timeout: float) -> dict:
        # No resolve(): sys.executable may be a venv symlink and we need the
        # venv's own bin dir (console scripts), not the base interpreter's.
        bindir = str(Path(sys.executable).parent)
        env = {
            **os.environ,
            "PYTHONPATH": str(ENGINE_ROOT) + os.pathsep + os.environ.get("PYTHONPATH", ""),
            "PATH": f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}",
        }
        # Route through xavani_cli.main directly: xavani.py's delegation set
        # omits several subcommands (doctor, insights, mcp, constellation) and
        # would treat them as chat queries.
        code = "import sys; sys.argv = ['xavani'] + sys.argv[1:]; from xavani_cli.main import main; main()"
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-c", code, *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(Path.home()),
            env=env,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
            return {"exit_code": proc.returncode, "output": out.decode("utf-8", "replace")[-60000:]}
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return {"exit_code": -1, "output": f"timed out after {int(timeout)}s"}

    @routes.get("/desktop/api/cli/commands")
    async def cli_commands(_request: "web.Request") -> "web.Response":
        return web.json_response({"commands": CLI_COMMANDS})

    @routes.post("/desktop/api/cli")
    async def cli_run(request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
            args = [str(a) for a in (body.get("args") or [])][:48]
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        if not args or any(a.startswith("-") and len(a) > 2 and "\x00" in a for a in args):
            return web.json_response({"error": "bad args"}, status=400)
        timeout = min(float(body.get("timeout", 180)), 600.0)
        result = await _run_cli(args, timeout)
        return web.json_response(result)

    @routes.get("/desktop/term")
    async def ws_term(request: "web.Request") -> "web.StreamResponse":
        from aiohttp import WSMsgType, web as _web

        ws = _web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)

        if os.name != "posix":
            await ws.send_json({"type": "exit", "reason": "interactive terminal requires pywinpty on Windows; one-shot commands still work"})
            await ws.close()
            return ws

        import fcntl
        import pty
        import struct
        import termios

        shell_path = Path(__file__).resolve().parent / "cli_shell.py"
        env = {
            **os.environ,
            "TERM": "xterm-256color",
            "PYTHONPATH": str(ENGINE_ROOT) + os.pathsep + os.environ.get("PYTHONPATH", ""),
            "PYTHONUNBUFFERED": "1",
        }

        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(Path.home())
            os.execve(sys.executable, [sys.executable, str(shell_path)], env)

        def set_size(cols: int, rows: int) -> None:
            try:
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(rows, 2), max(cols, 2), 0, 0))
            except OSError:
                pass
        set_size(100, 30)

        loop = asyncio.get_running_loop()
        closed = asyncio.Event()

        def on_readable() -> None:
            try:
                data = os.read(fd, 65536)
            except BlockingIOError:
                return
            except OSError:
                loop.remove_reader(fd)
                closed.set()
                return
            if not data:
                loop.remove_reader(fd)
                closed.set()
                return
            asyncio.create_task(_pump_send(data))

        async def _pump_send(data: bytes) -> None:
            try:
                await ws.send_str(data.decode("utf-8", "replace"))
            except Exception:
                loop.remove_reader(fd)
                closed.set()

        loop.add_reader(fd, on_readable)

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    try:
                        d = json.loads(msg.data)
                    except Exception:
                        continue
                    kind = d.get("type")
                    if kind == "input" and isinstance(d.get("data"), str):
                        os.write(fd, d["data"].encode("utf-8"))
                    elif kind == "resize":
                        set_size(int(d.get("cols", 100)), int(d.get("rows", 30)))
                elif msg.type == WSMsgType.ERROR:
                    break
        finally:
            try:
                loop.remove_reader(fd)
            except Exception:
                pass
            if not closed.is_set():
                closed.set()
            try:
                os.kill(pid, signal.SIGHUP)
            except Exception:
                pass
            try:
                os.close(fd)
            except Exception:
                pass
        return ws

    @routes.get("/desktop/api/constellation/status")
    async def constellation_status(_request: "web.Request") -> "web.Response":
        result = await _run_cli(["constellation", "status"], timeout=90)
        return web.json_response(result)

    @routes.post("/desktop/api/constellation/enable")
    async def constellation_enable(_request: "web.Request") -> "web.Response":
        config_path = _xavani_home() / "config.yaml"
        command = _runtime_bin("constellation-mcp")
        try:
            from ruamel.yaml import YAML

            yaml = YAML(typ="rt")
            yaml.preserve_quotes = True
            data = yaml.load(config_path) if config_path.exists() else {}
            if data is None:
                data = {}
            servers = data.setdefault("mcp_servers", {})
            servers["constellation"] = {"command": command, "args": [], "env": {}}
            with open(config_path, "w", encoding="utf-8") as fh:
                yaml.dump(data, fh)
            return web.json_response({"ok": True, "command": command})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/desktop/api/shutdown")
    async def shutdown(_request: "web.Request") -> "web.Response":
        asyncio.get_running_loop().call_later(0.2, os.kill, os.getpid(), signal.SIGTERM)
        return web.json_response({"ok": True})

    @routes.get("/desktop/api/status")
    async def status(_request: "web.Request") -> "web.Response":
        cfg = _load_config()
        model_cfg = cfg.get("model") or {}
        profile = None
        try:
            from xavani_cli.profiles import get_active_profile_name

            profile = get_active_profile_name()
        except Exception:
            pass
        return web.json_response({
            "app": "xavani-desktop",
            "engine_version": _engine_version(),
            "python": sys.version.split()[0],
            "xavani_home": str(_xavani_home()),
            "engine_root": str(ENGINE_ROOT),
            "profile": profile,
            "model": model_cfg.get("default"),
            "provider": model_cfg.get("provider"),
            "config_ok": bool(model_cfg),
            "api_port": api_port,
            "uptime_s": round(time.time() - STARTED_AT, 1),
        })

    @routes.get("/desktop/api/sessions")
    async def sessions(request: "web.Request") -> "web.Response":
        limit = min(int(request.query.get("limit", "40")), 100)
        try:
            from xavani_state import SessionDB

            db = SessionDB()
            rows = db.list_sessions_rich(limit=limit, order_by_last_active=True)
            return web.json_response({"sessions": rows})
        except Exception as exc:
            return web.json_response({"sessions": [], "error": str(exc)}, status=200)

    @routes.get("/desktop/api/sessions/{sid}/messages")
    async def session_messages(request: "web.Request") -> "web.Response":
        sid = request.match_info["sid"]
        try:
            from xavani_state import SessionDB

            db = SessionDB()
            rows = db.get_messages(sid)
            out = []
            for m in rows:
                content = m.get("content")
                if not isinstance(content, str):
                    if isinstance(content, list):
                        content = " ".join(
                            p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"
                        )
                    else:
                        continue
                role = m.get("role")
                if role not in ("user", "assistant") or not content.strip():
                    continue
                out.append({"role": role, "content": content})
            return web.json_response({"messages": out})
        except Exception as exc:
            return web.json_response({"messages": [], "error": str(exc)})

    @routes.get("/desktop/api/tools")
    async def tools(_request: "web.Request") -> "web.Response":
        return web.json_response({"toolsets": _list_toolsets(_load_config())})

    @routes.post("/desktop/api/tools/toggle")
    async def tools_toggle(request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
            name = str(body.get("name", ""))
            enable = bool(body.get("enabled", True))
            cfg = _load_config()
            if name not in {t["name"] for t in _list_toolsets(cfg)}:
                return web.json_response({"error": f"unknown toolset: {name}"}, status=400)
            result = _toggle_toolset(name, enable, cfg)
            return web.json_response(result)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @routes.get("/desktop/api/skills")
    async def skills(_request: "web.Request") -> "web.Response":
        return web.json_response({"skills": _installed_skills()})

    @routes.post("/desktop/api/shutdown")
    async def shutdown(_request: "web.Request") -> "web.Response":
        asyncio.get_running_loop().call_later(0.2, os.kill, os.getpid(), signal.SIGTERM)
        return web.json_response({"ok": True})

    app = web.Application()
    app.add_routes(routes)
    return app


async def main() -> None:
    from gateway.config import PlatformConfig
    from gateway.platforms.api_server import APIServerAdapter, check_api_server_requirements

    if not check_api_server_requirements():
        print(json.dumps({"ready": False, "error": "aiohttp unavailable"}), flush=True)
        raise SystemExit(1)

    used: set[int] = set()
    api_port = _free_port(int(os.environ.get("XAVANI_DESKTOP_API_PORT", "8642")), used)
    desktop_port = _free_port(api_port + 1, used)

    adapter = APIServerAdapter(PlatformConfig(
        enabled=True,
        extra={"host": "127.0.0.1", "port": api_port},
    ))
    if not await adapter.connect():
        print(json.dumps({"ready": False, "error": "api server failed to start"}), flush=True)
        raise SystemExit(1)

    # The api_server agent path never calls discover_mcp_tools() itself (the
    # gateway / CLI / cron paths each do). Without this, mcp_servers entries
    # in config.yaml — e.g. the constellation MCP server — never reach
    # desktop sessions. Idempotent inside the engine.
    mcp_tool_count = 0
    try:
        from tools.mcp_tool import discover_mcp_tools

        mcp_tool_count = len(await asyncio.to_thread(discover_mcp_tools) or [])
    except Exception as exc:
        print(f"[desktop] MCP init failed (non-fatal): {exc}", file=sys.stderr, flush=True)

    from aiohttp import web

    runner = web.AppRunner(build_desktop_app(api_port))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", desktop_port)
    await site.start()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass

    print(json.dumps({
        "ready": True,
        "api_port": api_port,
        "desktop_port": desktop_port,
        "pid": os.getpid(),
        "engine_version": _engine_version(),
        "mcp_tools": mcp_tool_count,
    }), flush=True)

    await stop.wait()
    await adapter.disconnect()
    await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
