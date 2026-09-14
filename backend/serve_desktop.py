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
import shutil
import signal
import socket
import sys
import time
import tomllib
import warnings
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


def build_desktop_app(api_port: int, secret: str):
    from aiohttp import web

    try:
        from backend.desktop_auth import desktop_auth
    except ImportError:
        # Launched as a script (Electron passes an absolute path): backend/
        # itself is sys.path[0], so the package form does not resolve.
        from desktop_auth import desktop_auth

    routes = web.RouteTableDef()

    try:
        from backend.workspace_paths import (
            NATIVE_GRANT_HEADER,
            NATIVE_GRANT_SOURCE,
            WORKSPACE_ERRORS,
            WORKSPACE_REQUIRED,
            WorkspaceBoundary,
            native_grant,
        )
    except ImportError:
        # Launched as a script (Electron passes an absolute path): backend/
        # itself is sys.path[0], so the package form does not resolve.
        from workspace_paths import (  # type: ignore[no-redef]
            NATIVE_GRANT_HEADER,
            NATIVE_GRANT_SOURCE,
            WORKSPACE_ERRORS,
            WORKSPACE_REQUIRED,
            WorkspaceBoundary,
            native_grant,
        )

    try:
        from backend.workspace_files import (
            MAX_TEXT_BYTES,
            FileTooLarge,
            RevisionConflict,
            RevisionRequired,
            read_workspace_file,
            save_workspace_file,
        )
    except ImportError:
        from workspace_files import (  # type: ignore[no-redef]
            MAX_TEXT_BYTES,
            FileTooLarge,
            RevisionConflict,
            RevisionRequired,
            read_workspace_file,
            save_workspace_file,
        )

    # One boundary per desktop app: the single selected workspace root.  It
    # starts empty — only a native grant (POST /desktop/api/fs/root with the
    # X-Xavani-Native header) may set it.
    boundary = WorkspaceBoundary()

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

    @routes.get("/desktop/api/commands")
    async def commands_registry(_request: "web.Request") -> "web.Response":
        try:
            from xavani_cli.commands import COMMAND_REGISTRY
            cmds = [{
                "name": c.name,
                "desc": (c.description or "")[:160],
                "args_hint": c.args_hint or "",
                "category": c.category or "",
            } for c in COMMAND_REGISTRY]
        except Exception as exc:
            return web.json_response({"commands": [], "error": str(exc)})
        return web.json_response({"commands": cmds})

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

    # ---------------- model / provider management ----------------

    PROVIDERS = [
        {"id": "openrouter", "label": "OpenRouter", "env": "OPENROUTER_API_KEY",
         "models": ["anthropic/claude-sonnet-4", "anthropic/claude-opus-4", "openai/gpt-5", "google/gemini-2.5-pro", "deepseek/deepseek-chat-v3"]},
        {"id": "anthropic", "label": "Anthropic", "env": "ANTHROPIC_API_KEY",
         "models": ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4"]},
        {"id": "openai", "label": "OpenAI", "env": "OPENAI_API_KEY",
         "models": ["gpt-5", "gpt-5-mini", "gpt-4.1", "o3"]},
        {"id": "google", "label": "Google Gemini", "env": "GOOGLE_API_KEY",
         "models": ["gemini-2.5-pro", "gemini-2.5-flash"]},
        {"id": "deepseek", "label": "DeepSeek", "env": "DEEPSEEK_API_KEY",
         "models": ["deepseek-chat", "deepseek-reasoner"]},
        {"id": "xai", "label": "xAI Grok", "env": "XAI_API_KEY",
         "models": ["grok-4", "grok-3-mini"]},
        {"id": "groq", "label": "Groq", "env": "GROQ_API_KEY",
         "models": ["llama-3.3-70b-versatile"]},
        {"id": "mistral", "label": "Mistral", "env": "MISTRAL_API_KEY",
         "models": ["mistral-large-latest"]},
        {"id": "moonshot", "label": "Kimi / Moonshot", "env": "MOONSHOT_API_KEY",
         "models": ["kimi-k2-0711-preview"]},
        {"id": "zai", "label": "Z.AI / GLM", "env": "ZAI_API_KEY",
         "models": ["glm-4.6"]},
        {"id": "nous", "label": "Nous Portal (OAuth)", "env": "", "models": []},
        {"id": "custom", "label": "Custom endpoint", "env": "", "models": []},
    ]

    @routes.get("/desktop/api/providers")
    async def providers_list(_request: "web.Request") -> "web.Response":
        cfg = _load_config()
        model_cfg = cfg.get("model") or {}
        return web.json_response({
            "providers": PROVIDERS,
            "current": {
                "provider": model_cfg.get("provider"),
                "model": model_cfg.get("default"),
                "base_url": model_cfg.get("base_url"),
            },
        })

    def _upsert_env(key: str, value: str) -> None:
        env_path = _xavani_home() / ".env"
        lines = []
        if env_path.exists():
            lines = [ln for ln in env_path.read_text(encoding="utf-8").splitlines()
                     if ln.strip() and not ln.strip().startswith(f"{key}=")]
        lines.append(f"{key}={value}")
        env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    @routes.post("/desktop/api/model/set")
    async def model_set(request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
            provider = str(body.get("provider", "")).strip()
            if not provider:
                return web.json_response({"error": "provider required"}, status=400)
            model = str(body.get("model", "")).strip() or None
            api_key = str(body.get("api_key", "")).strip() or None
            base_url = str(body.get("base_url", "")).strip() or None
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)

        meta = next((p for p in PROVIDERS if p["id"] == provider), None)
        config_path = _xavani_home() / "config.yaml"
        try:
            from ruamel.yaml import YAML

            yaml = YAML(typ="rt")
            yaml.preserve_quotes = True
            data = yaml.load(config_path) if config_path.exists() else {}
            if data is None:
                data = {}
            mc = data.setdefault("model", {})
            mc["provider"] = provider
            if model:
                mc["default"] = model
            if base_url:
                mc["base_url"] = base_url
            elif "base_url" in mc and provider != "custom":
                del mc["base_url"]
            with open(config_path, "w", encoding="utf-8") as fh:
                yaml.dump(data, fh)
        except Exception as exc:
            return web.json_response({"error": f"config write failed: {exc}"}, status=500)

        key_written = None
        if api_key and meta and meta.get("env"):
            try:
                _upsert_env(meta["env"], api_key)
                key_written = meta["env"]
            except Exception as exc:
                return web.json_response({"error": f"key write failed: {exc}"}, status=500)

        return web.json_response({
            "ok": True,
            "provider": provider,
            "model": model,
            "key_written": key_written,
            "note": "Applies to new chats.",
        })

    # ---------------- effort / fast-mode preferences ----------------

    VALID_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh")

    @routes.post("/desktop/api/model/prefs")
    async def model_prefs(request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        if "effort" in body and str(body["effort"]) not in VALID_EFFORTS:
            return web.json_response(
                {"error": f"effort must be one of {', '.join(VALID_EFFORTS)}"}, status=400)
        config_path = _xavani_home() / "config.yaml"
        try:
            from ruamel.yaml import YAML

            yaml = YAML(typ="rt")
            yaml.preserve_quotes = True
            data = yaml.load(config_path) if config_path.exists() else {}
            if data is None:
                data = {}
            agent = data.setdefault("agent", {})
            # Engine keys (gateway/run.py): agent.reasoning_effort,
            # agent.service_tier ("fast"/"normal"). Written under `agent`,
            # NOT `model` — the engine reads them from the agent section.
            if "effort" in body:
                agent["reasoning_effort"] = str(body["effort"])
            if "fast_mode" in body:
                agent["service_tier"] = "fast" if bool(body["fast_mode"]) else "normal"
            with open(config_path, "w", encoding="utf-8") as fh:
                yaml.dump(data, fh)
        except Exception as exc:
            return web.json_response({"error": f"config write failed: {exc}"}, status=500)
        cfg = _load_config()
        agent_cfg = cfg.get("agent") or {}
        return web.json_response({
            "ok": True,
            "effort": agent_cfg.get("reasoning_effort") or "medium",
            "fast_mode": (agent_cfg.get("service_tier") or "normal") == "fast",
        })

    @routes.get("/desktop/api/model/prefs")
    async def model_prefs_get(_request: "web.Request") -> "web.Response":
        cfg = _load_config()
        agent_cfg = cfg.get("agent") or {}
        fast_supported = False
        try:
            from xavani_cli.models import model_supports_fast_mode

            model = (cfg.get("model") or {}).get("default") or ""
            fast_supported = bool(model_supports_fast_mode(model))
        except Exception:
            pass
        return web.json_response({
            "effort": agent_cfg.get("reasoning_effort") or "medium",
            "fast_mode": (agent_cfg.get("service_tier") or "normal") == "fast",
            "fast_supported": fast_supported,
        })

    # ---------------- settings (whitelisted config sections) ----------------

    _SETTINGS_KEYS = frozenset({"permissions", "mcp_servers", "memory", "tools", "display", "terminal", "approvals", "privacy", "security"})

    @routes.get("/desktop/api/settings")
    async def settings_get(_request: "web.Request") -> "web.Response":
        cfg = _load_config()
        return web.json_response({k: cfg.get(k) for k in sorted(_SETTINGS_KEYS)})

    @routes.post("/desktop/api/settings")
    async def settings_set(request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        bad = [k for k in body if k not in _SETTINGS_KEYS]
        if bad:
            return web.json_response({"error": f"keys not editable here: {', '.join(bad)}"}, status=400)
        config_path = _xavani_home() / "config.yaml"
        try:
            from ruamel.yaml import YAML

            yaml = YAML(typ="rt")
            yaml.preserve_quotes = True
            data = yaml.load(config_path) if config_path.exists() else {}
            if data is None:
                data = {}
            for key, value in body.items():
                if value is None:
                    data.pop(key, None)
                else:
                    data[key] = value
            with open(config_path, "w", encoding="utf-8") as fh:
                yaml.dump(data, fh)
        except Exception as exc:
            return web.json_response({"error": f"config write failed: {exc}"}, status=500)
        return web.json_response({"ok": True})

    @routes.get("/desktop/api/skins")
    async def skins_list(_request: "web.Request") -> "web.Response":
        try:
            from xavani_cli.skin_engine import get_active_skin_name, list_skins

            return web.json_response({"skins": list_skins(), "active": get_active_skin_name()})
        except Exception as exc:
            return web.json_response({"skins": [], "active": "", "error": str(exc)})

    @routes.post("/desktop/api/skins/activate")
    async def skins_activate(request: "web.Request") -> "web.Response":
        body = await request.json()
        name = str(body.get("name", "")).strip()
        if not name:
            return web.json_response({"error": "name required"}, status=400)
        try:
            from xavani_cli.skin_engine import set_active_skin

            set_active_skin(name)
            return web.json_response({"ok": True, "active": name})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.get("/desktop/api/profiles")
    async def profiles_list(_request: "web.Request") -> "web.Response":
        try:
            from xavani_cli.profiles import get_active_profile_name, list_profiles

            rows = [{"name": p.name, "home": str(getattr(p, "home", ""))} for p in list_profiles()]
            return web.json_response({"profiles": rows, "active": get_active_profile_name()})
        except Exception as exc:
            return web.json_response({"profiles": [], "active": "", "error": str(exc)})

    # ---------------- persistent todos (profile home) ----------------

    def _todo_store():
        from tools.persistent_todo import PersistentTodoStore

        return PersistentTodoStore(_xavani_home() / "todos.json")

    @routes.get("/desktop/api/todos")
    async def todos_get(_request: "web.Request") -> "web.Response":
        try:
            items = _todo_store().read()
            return web.json_response({"items": items})
        except Exception as exc:
            return web.json_response({"items": [], "error": str(exc)})

    @routes.post("/desktop/api/todos")
    async def todos_set(request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        ids = body.get("order")
        if not isinstance(ids, list):
            return web.json_response({"error": "order list required"}, status=400)
        try:
            items = _todo_store().reorder([str(i) for i in ids])
            return web.json_response({"ok": True, "items": items})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @routes.post("/desktop/api/todos/item")
    async def todos_item(request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        item_id = str(body.get("id", "")).strip()
        if not item_id:
            return web.json_response({"error": "id required"}, status=400)
        store = _todo_store()
        if body.get("content") is not None and body.get("status") is None:
            current = {i["id"]: i for i in store.read()}
            if item_id not in current:
                return web.json_response({"error": "no such id"}, status=404)
        updated = store.set_status(item_id, str(body.get("status", "")))
        if updated is None:
            return web.json_response({"error": "no such id or bad status"}, status=404)
        return web.json_response({"ok": True, "item": updated})

    @routes.post("/desktop/api/todos/add")
    async def todos_add(request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        content = str(body.get("content", "")).strip()
        if not content:
            return web.json_response({"error": "content required"}, status=400)
        store = _todo_store()
        current = store.read()
        next_n = 1
        used = set()
        for it in current:
            used.add(it["id"])
        while str(next_n) in used:
            next_n += 1
        merged = store.write(
            [{"id": str(next_n), "content": content, "status": "pending"}],
            merge=True,
        )
        return web.json_response({"ok": True, "items": merged})

    @routes.post("/desktop/api/todos/delete")
    async def todos_delete(request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        item_id = str(body.get("id", "")).strip()
        if not item_id:
            return web.json_response({"error": "id required"}, status=400)
        store = _todo_store()
        remaining = [i for i in store.read() if i["id"] != item_id]
        items = store.write(remaining, merge=False)
        return web.json_response({"ok": True, "items": items})

    @routes.get("/desktop/api/outstanding")
    async def outstanding_get(_request: "web.Request") -> "web.Response":
        try:
            from xavani_wisdom.outstanding import OutstandingLedger

            ledger = OutstandingLedger(_xavani_home() / "outstanding.jsonl")
            return web.json_response({"items": ledger.items()})
        except Exception as exc:
            return web.json_response({"items": [], "error": str(exc)})

    @routes.get("/desktop/api/activity")
    async def activity_get(_request: "web.Request") -> "web.Response":
        activities = []
        try:
            from xavani_cli import loop_runner

            for spec in loop_runner.list_loops():
                if spec.get("status") != "active":
                    continue
                passes = len(spec.get("passes", []))
                activities.append({
                    "kind": "loop",
                    "label": f"Loop running: {str(spec.get('prompt', ''))[:60]}",
                    "detail": f"{passes} pass(es)",
                })
        except Exception:
            pass
        try:
            from xavani_wisdom.outstanding import OutstandingLedger

            open_goals = [
                e for e in OutstandingLedger(_xavani_home() / "outstanding.jsonl").items()
                if e.get("kind") == "goal"
            ]
            for goal in open_goals[:3]:
                activities.append({
                    "kind": "goal",
                    "label": f"Open goal: {str(goal.get('text', ''))[:60]}",
                    "detail": f"#{goal.get('n')}",
                })
        except Exception:
            pass
        return web.json_response({"activities": activities})

    @routes.post("/desktop/api/profiles/switch")
    async def profiles_switch(request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        name = str(body.get("name", "")).strip()
        if not name:
            return web.json_response({"error": "name required"}, status=400)
        try:
            from xavani_cli import profiles as profiles_mod

            canonical = profiles_mod.normalize_profile_name(name)
            if canonical != "default" and not (
                profiles_mod._get_profiles_root() / canonical
            ).exists():
                return web.json_response({"error": f"no such profile: {canonical}"}, status=404)
            path = profiles_mod._get_active_profile_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            if canonical == "default":
                path.unlink(missing_ok=True)
            else:
                path.write_text(canonical, encoding="utf-8")
            return web.json_response({"ok": True, "active": canonical, "restart": True})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    # ---------------- skills hub (GitHub-backed) ----------------

    @routes.get("/desktop/api/skills/hub/search")
    async def skills_hub_search(request: "web.Request") -> "web.Response":
        q = request.query.get("q", "").strip()
        result = await _run_cli(["skills", "search", q] if q else ["skills", "browse"], timeout=120)
        return web.json_response(result)

    @routes.post("/desktop/api/skills/hub/install")
    async def skills_hub_install(request: "web.Request") -> "web.Response":
        body = await request.json()
        skill_id = str(body.get("id", "")).strip()
        if not skill_id:
            return web.json_response({"error": "id required"}, status=400)
        result = await _run_cli(["skills", "install", skill_id], timeout=300)
        return web.json_response(result)

    @routes.post("/desktop/api/skills/uninstall")
    async def skills_uninstall(request: "web.Request") -> "web.Response":
        body = await request.json()
        name = str(body.get("name", "")).strip()
        if not name:
            return web.json_response({"error": "name required"}, status=400)
        result = await _run_cli(["skills", "uninstall", name], timeout=180)
        return web.json_response(result)

    # ---------------- migration (memory + transcripts) ----------------

    MIGRATION_SOURCES = {
        "claude_code": {"home": Path.home() / ".claude", "globs": ["projects/**/*.jsonl"]},
        "codex": {"home": Path.home() / ".codex", "globs": ["sessions/**/*.jsonl", "*.jsonl"]},
        "hermes": {"home": Path.home() / ".hermes", "globs": ["sessions/**/*.jsonl", "terminal-sessions/**/*.jsonl"]},
        "cursor": {"home": Path.home() / "Library" / "Application Support" / "Cursor", "globs": []},
        "gemini": {"home": Path.home() / ".gemini", "globs": ["tmp/**/*.jsonl", "**/*.json"]},
        "opencode": {"home": Path.home() / ".local" / "share" / "opencode", "globs": ["**/*.jsonl"]},
    }

    # Human labels for imported-session titles (referenced by label_for below).
    MIG_LABELS = {
        "claude_code": "Claude Code",
        "codex": "Codex",
        "hermes": "Legacy Agent",
        "cursor": "Cursor",
        "gemini": "Gemini CLI",
        "opencode": "OpenCode",
    }

    def _memory_files(home: Path) -> list[str]:
        out = []
        if not home.exists():
            return out
        seen_names = set()
        for name in ("CLAUDE.md", "AGENTS.md", "SOUL.md", "MEMORY.md"):
            candidate = home / name
            if candidate.exists() and candidate.stat().st_size > 0:
                out.append(str(candidate))
                seen_names.add(name)
        for candidate in sorted(home.glob("*.md")):
            if candidate.name not in seen_names and candidate.stat().st_size > 0:
                out.append(str(candidate))
                seen_names.add(candidate.name)
        return out[:12]

    def _count_transcripts(src: str, spec: dict) -> int:
        home, globs = spec["home"], spec["globs"]
        n = 0
        if src == "hermes" and (home / "sessions.db").exists() and (home / "sessions.db").stat().st_size > 0:
            n += 1
        for g in globs:
            if home.exists():
                n += sum(1 for f in home.glob(g) if f.is_file())
        return n

    @routes.post("/desktop/api/preview/brief")
    async def preview_brief(request: "web.Request") -> "web.Response":
        """Map preview change-set ops to workspace files and build an edit brief."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        ops = body.get("ops")
        if not isinstance(ops, list) or not ops:
            return web.json_response({"error": "ops list required"}, status=400)
        try:
            root = boundary.require_root()
        except WORKSPACE_ERRORS as exc:
            return _fs_error(exc)
        brief_lines: list[str] = []
        unresolved: list[dict] = []
        searched = 0
        for op in ops[:40]:
            selector = str(op.get("selector", "")).strip()
            prop = str(op.get("property", ""))
            new_value = str(op.get("new_value", ""))
            note = str(op.get("note", ""))
            if not selector:
                unresolved.append(op)
                continue
            # Extract a searchable class token from simple css selectors.
            token = ""
            for part in selector.replace(">", " ").split():
                if part.startswith("."):
                    token = part[1:]
                    break
            match_file = None
            match_line = 0
            if token:
                try:
                    import subprocess as _sp

                    proc_ = _sp.run(
                        ["grep", "-rn", "--include=*.css", "--include=*.scss",
                         "--include=*.html", "-l", token, str(root)],
                        capture_output=True, text=True, timeout=20,
                    )
                    files = [f for f in proc_.stdout.strip().splitlines() if f][:5]
                    searched += len(files)
                    if files:
                        match_file = files[0]
                        proc2 = _sp.run(
                            ["grep", "-n", token, files[0]],
                            capture_output=True, text=True, timeout=10,
                        )
                        if proc2.stdout.splitlines():
                            first = proc2.stdout.splitlines()[0]
                            try:
                                match_line = int(first.split(":", 1)[0])
                            except ValueError:
                                match_line = 0
                except Exception:
                    match_file = None
            if match_file:
                brief_lines.append(
                    f"- File {match_file}{':' + str(match_line) if match_line else ''}: "
                    f"change '{prop}' of element matching '{selector}' to: {new_value}"
                    + (f" (context: {note})" if note else "")
                )
            else:
                op["reason"] = f"no source file references '{selector}'"
                unresolved.append(op)
        return web.json_response({
            "ok": True,
            "brief": "\n".join(brief_lines),
            "resolved": len(brief_lines),
            "unresolved": unresolved,
        })

    @routes.post("/desktop/api/migrate/folder")
    async def migrate_folder(request: "web.Request") -> "web.Response":
        """Scan an arbitrary folder for jsonl transcripts and md memory files."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        folder = Path(str(body.get("folder", "")).strip()).expanduser()
        if not folder.is_dir():
            return web.json_response({"error": "folder does not exist"}, status=404)
        transcripts = [str(p) for p in sorted(folder.rglob("*.jsonl")) if p.is_file()][:200]
        memory_files = [str(p) for p in sorted(folder.glob("*.md")) if p.is_file()][:12]
        return web.json_response({
            "found": bool(transcripts or memory_files),
            "transcripts": len(transcripts),
            "memory_files": memory_files,
            "transcript_paths": transcripts,
        })

    @routes.get("/desktop/api/migrate/scan")
    async def migrate_scan(_request: "web.Request") -> "web.Response":
        report = {}
        for src, spec in MIGRATION_SOURCES.items():
            report[src] = {
                "found": spec["home"].exists(),
                "transcripts": _count_transcripts(src, spec),
                "memory_files": _memory_files(spec["home"]),
            }
        return web.json_response(report)

    def _slug(text: str, n: int = 40) -> str:
        keep = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
        return keep[:n] or "session"

    def _extract_jsonl_messages(path: Path) -> list[tuple[str, str]]:
        msgs = []
        try:
            for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
                if not raw.strip():
                    continue
                try:
                    d = json.loads(raw)
                except Exception:
                    continue
                mtype = d.get("type")
                role = None
                content = None
                if mtype in ("user", "assistant"):
                    role = mtype
                    c = d.get("content") or (d.get("message") or {}).get("content")
                    if isinstance(c, list):
                        content = " ".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text")
                    elif isinstance(c, str):
                        content = c
                elif mtype == "message" and isinstance(d.get("content"), list):
                    role = d.get("role", "user")
                    content = " ".join(
                        p.get("text", "") if isinstance(p, dict) else str(p)
                        for p in d["content"]
                    )
                elif mtype == "response_item" and isinstance(d.get("payload"), dict):
                    p = d["payload"]
                    if p.get("type") == "message":
                        role = p.get("role", "user")
                        c = p.get("content")
                        if isinstance(c, list):
                            content = " ".join(
                                pp.get("text", "") for pp in c
                                if isinstance(pp, dict) and pp.get("type") in ("text", "input_text", "output_text")
                            )
                        elif isinstance(c, str):
                            content = c
                if role in ("user", "assistant") and content and content.strip():
                    msgs.append((role, content.strip()))
        except OSError:
            pass
        return msgs

    @routes.post("/desktop/api/migrate/import")
    async def migrate_import(request: "web.Request") -> "web.Response":
        body = await request.json()
        src = str(body.get("source", ""))
        spec = MIGRATION_SOURCES.get(src)
        if not spec:
            return web.json_response({"error": "unknown source"}, status=400)
        home = spec["home"]
        imported_sessions = 0
        imported_msgs = 0
        copied_files = 0

        from xavani_state import SessionDB

        db = SessionDB()

        files: list[Path] = []
        seen: set[Path] = set()
        for g in spec["globs"]:
            if home.exists() and g:
                for f in sorted(home.glob(g)):
                    if f.is_file() and f.resolve() not in seen:
                        seen.add(f.resolve())
                        files.append(f)

        def label_for(source: str) -> str:
            return MIG_LABELS.get(source, source)

        for f in files:
            msgs = _extract_jsonl_messages(f)
            if len(msgs) < 2:
                continue
            first_user = next(
                (c for r, c in msgs if r == "user" and not c.lstrip().startswith("<")),
                next((c for r, c in msgs if r == "user"), "Imported transcript"),
            )
            sid = f"imp_{src[:4]}_{_slug(f.stem)}_{abs(hash(str(f))) % 100000}"
            if db.get_session(sid):
                continue
            try:
                db.ensure_session(sid, source=f"import:{src}")
                db.rename_session(sid, f"[{label_for(src)}] {first_user[:70]}")
            except Exception:
                pass
            ok = True
            for role, content in msgs[:200]:
                try:
                    db.append_message(sid, role, content[:24000])
                    imported_msgs += 1
                except Exception:
                    ok = False
                    break
            if not ok:
                continue
            imported_sessions += 1

        mem_dir = _xavani_home() / "memory-imports" / src
        mem_dir.mkdir(parents=True, exist_ok=True)
        index_lines = [f"# Imported memory — {src}", ""]
        for mp in _memory_files(home):
            srcf = Path(mp)
            dest = mem_dir / srcf.name
            try:
                dest.write_text(srcf.read_text(encoding="utf-8"), encoding="utf-8")
                copied_files += 1
                index_lines.append(f"- {dest.name}")
            except OSError:
                continue
        if copied_files or imported_sessions:
            (mem_dir / "INDEX.md").write_text("\n".join(index_lines) + "\n", encoding="utf-8")

        return web.json_response({
            "ok": True,
            "source": src,
            "sessions": imported_sessions,
            "messages": imported_msgs,
            "memory_files": copied_files,
        })

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

    # ---------------- first-run setup ----------------

    def _setup_flag_path() -> Path:
        return _xavani_home() / "desktop-setup-complete"

    @routes.get("/desktop/api/setup/status")
    async def setup_status(_request: "web.Request") -> "web.Response":
        has_sessions = False
        try:
            from xavani_state import SessionDB

            has_sessions = len(SessionDB().list_sessions_rich(limit=1)) > 0
        except Exception:
            has_sessions = True  # fail open: never trap a working install in the wizard
        done = _setup_flag_path().exists()
        cfg = _load_config()
        configured = bool((cfg.get("model") or {}).get("provider"))
        return web.json_response({
            "first_run": (not has_sessions) and not done,
            "configured": configured,
            "flag_path": str(_setup_flag_path()),
        })

    @routes.post("/desktop/api/setup/complete")
    async def setup_complete(_request: "web.Request") -> "web.Response":
        _setup_flag_path().parent.mkdir(parents=True, exist_ok=True)
        _setup_flag_path().write_text("ok\n", encoding="utf-8")
        return web.json_response({"ok": True})

    @routes.post("/desktop/api/setup/skip")
    async def setup_skip(_request: "web.Request") -> "web.Response":
        _setup_flag_path().parent.mkdir(parents=True, exist_ok=True)
        _setup_flag_path().write_text("skipped\n", encoding="utf-8")
        return web.json_response({"ok": True})

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

    # ---------------- studio IDE: filesystem endpoints ----------------
    #
    # Every path is resolved through the workspace boundary
    # (backend/workspace_paths.py).  A path is accepted only when it realpaths
    # inside the single selected workspace root, so a home-prefix check no
    # longer decides access.  Control directories (.git, .ssh, .aws, .gnupg,
    # .xavani, .hermes, .config/xavani) refuse writes; credential-looking files
    # refuse reads and writes.
    #
    # The root itself comes from a native grant only: POST /desktop/api/fs/root
    # requires the shared secret in the X-Xavani-Native header, which the
    # renderer's webRequest injector never adds (it adds Authorization).  A
    # renderer-originated request therefore cannot create a grant, and a raw
    # HTTP caller without the secret is rejected by the auth middleware (401)
    # or by the grant check (403).
    #
    # Status conventions:
    #   428  no workspace granted yet — {"error": "Workspace required"}
    #   400  malformed path, or a parent-traversal ("..") attempt
    #   403  outside the root, control dir write, credential file, symlink,
    #        or a non-native grant attempt
    _TREE_SKIP = {"node_modules", ".git", "__pycache__", ".venv", "venv",
                  "dist-electron", ".cache", ".DS_Store"}

    def _ws_state_path() -> Path:
        return _xavani_home() / "desktop-workspace.json"

    def _fs_error(exc: Exception) -> "web.Response":
        return web.json_response({"error": str(exc)}, status=getattr(exc, "status", 403))

    @routes.get("/desktop/api/fs/root")
    async def fs_root_get(_request: "web.Request") -> "web.Response":
        snapshot = boundary.snapshot()
        if not snapshot["granted"]:
            return web.json_response(
                {"error": WORKSPACE_REQUIRED, "root": "", "granted": False}, status=428)
        return web.json_response(snapshot)

    @routes.post("/desktop/api/fs/root")
    async def fs_root_set(request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        # A grant entry point: the secret must arrive in X-Xavani-Native.  The
        # renderer's webRequest injector adds Authorization only, and the
        # renderer never holds the raw secret, so an XHR from the page cannot
        # reach this branch.
        try:
            root = native_grant(
                boundary,
                body.get("root", ""),
                header_value=request.headers.get(NATIVE_GRANT_HEADER),
                secret=secret,
            )
        except WORKSPACE_ERRORS as exc:
            return _fs_error(exc)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)
        # Persist the record for the shell's next launch.  This file is a
        # hint, not a grant: the boundary still starts empty every run.
        try:
            _ws_state_path().parent.mkdir(parents=True, exist_ok=True)
            _ws_state_path().write_text(
                json.dumps({"root": str(root), "granted_by": NATIVE_GRANT_SOURCE}),
                encoding="utf-8")
        except Exception:
            pass
        return web.json_response({
            "ok": True,
            "root": str(root),
            "granted": True,
            "generation": boundary.generation,
        })

    @routes.get("/desktop/api/fs/tree")
    async def fs_tree(request: "web.Request") -> "web.Response":
        raw = request.query.get("path") or "."
        try:
            base = boundary.resolve(raw, allow_root=True)
            if not base.exists():
                return web.json_response({"error": f"not found: {base}"}, status=404)
            entries = []
            try:
                for child in sorted(base.iterdir(), key=lambda c: (c.is_file(), c.name.lower())):
                    if child.name in _TREE_SKIP or child.name.startswith("."):
                        continue
                    try:
                        stat = child.stat()
                        entries.append({
                            "name": child.name,
                            "type": "dir" if child.is_dir() else "file",
                            "size": stat.st_size,
                        })
                    except OSError:
                        continue
            except PermissionError:
                pass
            return web.json_response({"path": str(base), "entries": entries})
        except WORKSPACE_ERRORS as exc:
            return _fs_error(exc)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

    # Upper bound on the request body for a text save, checked before the body
    # is read: an oversized write is refused before allocation can grow without
    # bound.  aiohttp's own client_max_size is the second backstop.
    _MAX_WRITE_REQUEST_BYTES = MAX_TEXT_BYTES + 64 * 1024

    @routes.get("/desktop/api/fs/file")
    async def fs_file(request: "web.Request") -> "web.Response":
        raw = request.query.get("path", "")
        try:
            # The boundary authorises the path; the read then reports the exact
            # bytes on disk and their SHA-256 revision, which a save must echo.
            result = read_workspace_file(boundary.require_root(), raw)
        except WORKSPACE_ERRORS as exc:
            return _fs_error(exc)
        except FileNotFoundError:
            return web.json_response({"error": f"not a file: {raw}"}, status=404)
        except FileTooLarge as exc:
            return web.json_response({"error": str(exc)}, status=413)
        except UnicodeDecodeError:
            return web.json_response({"error": "binary file — not editable here"}, status=415)
        except PermissionError as exc:
            return web.json_response({"error": str(exc)}, status=403)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        return web.json_response(result)

    @routes.post("/desktop/api/fs/write")
    async def fs_write(request: "web.Request") -> "web.Response":
        declared = request.content_length
        if declared is not None and declared > _MAX_WRITE_REQUEST_BYTES:
            return web.json_response({"error": "content too large"}, status=413)
        try:
            body = await request.json()
        except Exception as exc:
            if "EntityTooLarge" in type(exc).__name__:
                return web.json_response({"error": "content too large"}, status=413)
            return web.json_response({"error": "invalid body"}, status=400)
        raw = body.get("path", "")
        root = None
        try:
            # Authorise first so a traversal or a protected path keeps its own
            # 400/403 even when the expected revision is missing too.
            boundary.resolve(raw, write=True)
            root = boundary.require_root()
            expected = body.get("expected_revision")
            if not isinstance(expected, str) or not expected:
                # A save always carries the revision its buffer read.  A missing
                # revision is never permission to overwrite.
                return web.json_response({"error": "An expected revision is required."}, status=428)
            content = body.get("content", "")
            if not isinstance(content, str):
                return web.json_response({"error": "content must be a string"}, status=400)
            result = save_workspace_file(root, raw, content, expected)
        except RevisionConflict:
            # The buffer is behind the disk: change nothing and hand the caller
            # both sides so a conflict review can show disk, buffer and base.
            disk: dict = {}
            try:
                disk = read_workspace_file(boundary.require_root(), raw)
            except Exception:
                disk = {}
            return web.json_response({
                "error": "The file changed on disk since it was read.",
                "conflict": True,
                "current_revision": disk.get("revision"),
                "disk": disk.get("content"),
            }, status=409)
        except WORKSPACE_ERRORS as exc:
            return _fs_error(exc)
        except FileNotFoundError:
            return web.json_response({"error": f"not a file: {raw}"}, status=404)
        except FileTooLarge as exc:
            return web.json_response({"error": str(exc)}, status=413)
        except RevisionRequired as exc:
            return web.json_response({"error": str(exc)}, status=428)
        except PermissionError as exc:
            return web.json_response({"error": str(exc)}, status=403)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({
            "ok": True, "path": result["path"], "revision": result["revision"],
            "bytes": result["bytes"],
        })

    # ---------------- language server bridge (task 15) ----------------
    # The UI consults the existing agent/lsp service through these narrow
    # routes.  Diagnostics are fetched with delta=False so a renderer poll
    # never perturbs the agent's write-delta baseline.

    def _lsp_service():
        try:
            from agent.lsp import get_service

            return get_service()
        except Exception:
            return None

    @routes.get("/desktop/api/lsp/status")
    async def lsp_status(_request: "web.Request") -> "web.Response":
        try:
            service = _lsp_service()
            return web.json_response({"available": bool(service is not None and service.is_active())})
        except Exception as exc:
            return web.json_response({"available": False, "error": str(exc)})

    @routes.get("/desktop/api/lsp/diagnostics")
    async def lsp_diagnostics(request: "web.Request") -> "web.Response":
        raw = request.query.get("path", "")
        try:
            target = str(boundary.resolve(raw))
        except WORKSPACE_ERRORS as exc:
            return _fs_error(exc)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        try:
            service = _lsp_service()
            if service is None or not service.is_active():
                return web.json_response({"available": False, "diagnostics": []})
            if not service.enabled_for(target):
                return web.json_response(
                    {"available": False, "diagnostics": [], "reason": "no server for this file"})
            loop = asyncio.get_running_loop()
            diags = await loop.run_in_executor(
                None, lambda: service.get_diagnostics_sync(target, delta=False))
            return web.json_response({"available": True, "diagnostics": diags or []})
        except Exception as exc:
            return web.json_response({"available": False, "diagnostics": [], "error": str(exc)})

    # ---------------- business workspace view (task 21) ----------------
    # The view renders exactly what these routes can serve: workflow
    # capability is decided here, approvals come from the real operator
    # queue (task 19), and no control can claim more than that.

    _BUSINESS_WORKFLOWS = [
        {"id": "B01", "name": "Finance analysis", "needs": ["period", "currency"], "catalog": "finance"},
        {"id": "B02", "name": "Invoice review", "needs": ["currency"], "catalog": "invoices"},
        {"id": "B03", "name": "Daily operations", "needs": [], "catalog": "daily"},
        {"id": "B04", "name": "Inbox and support", "needs": [], "catalog": "inbox"},
        {"id": "B05", "name": "Meetings", "needs": [], "catalog": "meetings"},
        {"id": "B06", "name": "Sales and marketing", "needs": [], "catalog": "sales"},
        {"id": "B07", "name": "People and administration", "needs": [], "catalog": "people"},
        {"id": "B08", "name": "Procurement and inventory", "needs": [], "catalog": "procurement"},
        {"id": "B09", "name": "Legal and compliance support", "needs": [], "catalog": "compliance"},
        {"id": "B10", "name": "Engineering and design", "needs": [], "catalog": "engineering"},
        {"id": "B11", "name": "Executive reporting", "needs": ["period", "currency"], "catalog": "executive"},
        {"id": "B12", "name": "Safety and incidents", "needs": [], "catalog": "incidents"},
    ]

    @routes.get("/desktop/api/business/state")
    async def business_state(_request: "web.Request") -> "web.Response":
        try:
            root = boundary.require_root()
        except WORKSPACE_ERRORS as exc:
            return _fs_error(exc)
        payload = {
            "workflows": _BUSINESS_WORKFLOWS,
            "sources": None, "drafts": None,
            "checks": [], "approvals": [], "outstanding": [],
        }
        try:
            import json as _json
            from pathlib import Path as _Path

            file_state = {}
            state_path = _Path(root) / ".xavani-business" / "state.json"
            if state_path.is_file():
                file_state = _json.loads(state_path.read_text(encoding="utf-8")) or {}
            for key in ("sources", "drafts", "checks", "outstanding"):
                if isinstance(file_state.get(key), list):
                    payload[key] = file_state[key]
            if payload["sources"] is None:
                entries = []
                for name in sorted(os.listdir(root)):
                    if name.startswith("."):
                        continue
                    full = os.path.join(root, name)
                    entries.append({
                        "name": name,
                        "access": "Granted" if os.access(full, os.R_OK) else "Unavailable",
                    })
                payload["sources"] = entries
            if payload["drafts"] is None:
                drafts_dir = _Path(root) / "drafts"
                payload["drafts"] = (
                    [] if not drafts_dir.is_dir()
                    else [{"name": p.name, "path": str(p)} for p in sorted(drafts_dir.iterdir()) if p.is_file()]
                )
            # Approvals: the real operator queue (task 19) when importable.
            try:
                from xavani_operator.approval_queue import ApprovalQueue
                from xavani_operator.state import OperatorState

                queue = ApprovalQueue(OperatorState())
                records = []
                for approval in queue.list_actions():
                    req = approval.request or {}
                    records.append({
                        "id": approval.id,
                        "operation": req.get("operation"),
                        "target": req.get("target"),
                        "recipient": (req.get("payload") or {}).get("recipient"),
                        "state": approval.state,
                        "consumed": approval.consumed,
                    })
                if records or not file_state.get("approvals"):
                    payload["approvals"] = records
            except Exception:
                payload["approvals"] = file_state.get("approvals") or []
            return web.json_response(payload)
        except Exception as exc:
            return web.json_response({"error": str(exc)})

    @routes.post("/desktop/api/business/decide")
    async def business_decide(request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        approval_id = str(body.get("id") or "")
        decision = str(body.get("decision") or "")
        if not approval_id or decision not in ("approve", "deny"):
            return web.json_response({"error": "id and decision are required"}, status=400)
        try:
            import time as _time

            from xavani_operator.approval_queue import ApprovalQueue
            from xavani_operator.state import OperatorState

            queue = ApprovalQueue(OperatorState())
            if decision == "approve":
                record = queue.get_action(approval_id)
                if record is None:
                    return web.json_response({"error": "unknown approval"}, status=404)
                if record.state == "draft":
                    queue.request_approval(approval_id)
                result = queue.approve_action(approval_id, now=_time.time())
            else:
                result = queue.deny_action(approval_id, now=_time.time())
            if result is None:
                return web.json_response({"error": "unknown approval"}, status=404)
            return web.json_response({"ok": True, "state": result.state})
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=409)
        except Exception as exc:
            return web.json_response({"error": str(exc)})

    @routes.post("/desktop/api/business/select")
    async def business_select(request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        workflow_id = str(body.get("workflow_id") or "").upper()
        period = str(body.get("period") or "").strip()
        currency = str(body.get("currency") or "").strip()
        spec = next((w for w in _BUSINESS_WORKFLOWS if w["id"] == workflow_id), None)
        if spec is None:
            return web.json_response({"error": f"unknown workflow {workflow_id!r}"}, status=404)
        values = {"period": period, "currency": currency}
        missing = [need for need in spec["needs"] if not values.get(need)]
        if missing:
            return web.json_response({"error": f"Blocked: missing {' and '.join(missing)}."})
        try:
            from agent.skill_commands import build_workflow_skill_message

            message = build_workflow_skill_message(spec["catalog"], mode="ask")
        except Exception as exc:
            return web.json_response({"error": f"workflow load failed: {exc}"})
        if not message:
            return web.json_response({"error": "the workflow has nothing to load"})
        return web.json_response({"ok": True, "workflow_id": spec["id"], "message": message})

    # ---------------- voice transcription ----------------

    def _read_env_key(name: str) -> str:
        env_path = _xavani_home() / ".env"
        if env_path.exists():
            for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
                if line.startswith(f"{name}="):
                    return line.split("=", 1)[1].strip()
        return os.environ.get(name, "")

    @routes.post("/desktop/api/transcribe")
    async def transcribe(request: "web.Request") -> "web.Response":
        try:
            reader = await request.multipart()
            field = await reader.next() if reader else None
            if field is None or field.name != "audio":
                return web.json_response({"error": "audio multipart part required"}, status=400)
            blob = b""
            while not field.at_eof():
                blob += await field.read_chunk()
        except Exception as exc:
            return web.json_response({"error": f"bad upload: {exc}"}, status=400)
        if not blob:
            return web.json_response({"error": "empty audio"}, status=400)
        if len(blob) > 25 * 1024 * 1024:
            return web.json_response({"error": "audio over 25MB"}, status=413)

        openai_key = _read_env_key("OPENAI_API_KEY")
        groq_key = _read_env_key("GROQ_API_KEY")
        use_groq = bool(groq_key) and not openai_key
        key = groq_key if use_groq else openai_key
        if not key:
            return web.json_response(
                {"error": "no OPENAI_API_KEY or GROQ_API_KEY configured — add one in Settings or ~/.xavani/.env"},
                status=400)

        url = ("https://api.groq.com/openai/v1/audio/transcriptions" if use_groq
               else "https://api.openai.com/v1/audio/transcriptions")
        model = "whisper-large-v3" if use_groq else "gpt-4o-transcribe"

        import aiohttp

        form = aiohttp.FormData()
        form.add_field("file", blob, filename="speech.webm", content_type="audio/webm")
        form.add_field("model", model)
        try:
            async with aiohttp.ClientSession() as http:
                resp = await http.post(
                    url, data=form,
                    headers={"Authorization": f"Bearer {key}"},
                    timeout=aiohttp.ClientTimeout(total=120),
                )
                out = await resp.json(content_type=None)
        except Exception as exc:
            return web.json_response({"error": f"transcription request failed: {exc}"}, status=502)
        if resp.status != 200:
            msg = ""
            if isinstance(out, dict):
                err = out.get("error")
                msg = err.get("message", "") if isinstance(err, dict) else str(err)
            return web.json_response({"error": msg or f"transcription failed ({resp.status})"}, status=502)
        return web.json_response({"text": (out or {}).get("text", "")})

    @routes.get("/desktop/api/fs/find")
    async def fs_find(request: "web.Request") -> "web.Response":
        name = request.query.get("name", "").strip()
        if not name or "/" in name or "\\" in name or ".." in name:
            return web.json_response({"error": "bad name"}, status=400)
        try:
            root = boundary.require_root()
        except WORKSPACE_ERRORS as exc:
            return _fs_error(exc)
        # The boundary filters the walk: symlinks and credential files never
        # appear in a result, even when the name matches.
        matches = sorted(p for p in root.rglob(name) if p.is_file() and boundary.permits(p))
        return web.json_response({"path": str(matches[0]) if matches else None, "count": len(matches)})

    @routes.post("/desktop/api/fs/write-b64")
    async def fs_write_b64(request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
            import base64 as _b64

            raw = _b64.b64decode(str(body.get("data_b64", "")))
        except Exception as exc:
            return web.json_response({"error": f"bad payload: {exc}"}, status=400)
        if not raw:
            return web.json_response({"error": "empty payload"}, status=400)
        if len(raw) > 20 * 1024 * 1024:
            return web.json_response({"error": "over 20MB"}, status=413)
        try:
            path = boundary.resolve(body.get("path", ""), write=True)
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists():
                backup = path.with_suffix(path.suffix + ".bak")
                backup.write_bytes(path.read_bytes())
            path.write_bytes(raw)
            return web.json_response({"ok": True, "path": str(path), "bytes": len(raw)})
        except WORKSPACE_ERRORS as exc:
            return _fs_error(exc)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @routes.post("/desktop/api/fs/mutate")
    async def fs_mutate(request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
            op = str(body.get("op", ""))
            path = boundary.resolve(body.get("path", ""), write=True)
            if op == "mkdir":
                path.mkdir(parents=True, exist_ok=True)
            elif op == "newfile":
                path.touch(exist_ok=False)
            elif op == "delete":
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink(missing_ok=True)
            elif op == "rename":
                dest = boundary.resolve(body.get("to", ""), write=True)
                path.rename(dest)
            else:
                return web.json_response({"error": f"unknown op: {op}"}, status=400)
            return web.json_response({"ok": True, "op": op, "path": str(path)})
        except FileExistsError:
            return web.json_response({"error": "already exists"}, status=409)
        except WORKSPACE_ERRORS as exc:
            return _fs_error(exc)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    app = web.Application(middlewares=[desktop_auth(secret)])
    app.add_routes(routes)
    # Expose the boundary so the shell and the tests can inspect or prime the
    # selected workspace without going through the HTTP grant route.  A plain
    # string key stays stable across aiohttp releases; the AppKey hint is not
    # worth changing the accessor.
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message=".*AppKey instances for keys.*")
        app["workspace"] = boundary
    return app


_BOOTSTRAP_SECRET_RE = re.compile(r"[0-9a-f]{64}")


def _read_bootstrap_secret(stream) -> str:
    """Read the single-line JSON bootstrap secret from ``stream``."""
    line = stream.readline()
    if not line:
        raise ValueError("empty bootstrap stream")
    try:
        payload = json.loads(line)
    except (json.JSONDecodeError, UnicodeDecodeError, TypeError) as exc:
        raise ValueError("bootstrap line is not JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("bootstrap payload must be a JSON object")
    secret = payload.get("secret")
    if not isinstance(secret, str) or not _BOOTSTRAP_SECRET_RE.fullmatch(secret):
        raise ValueError("bootstrap secret must be 64 lowercase hex characters")
    return secret


async def main() -> None:
    try:
        secret = _read_bootstrap_secret(sys.stdin)
    except ValueError:
        print(json.dumps({
            "ready": False,
            "error": "desktop bootstrap secret missing or malformed",
        }), flush=True)
        raise SystemExit(1)

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
        extra={
            "host": "127.0.0.1",
            "port": api_port,
            "key": secret,
            "cors_origins": ["null"],
        },
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

    runner = web.AppRunner(build_desktop_app(api_port, secret))
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
