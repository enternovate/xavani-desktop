# Xavani Desktop

The full Xavani Agent engine in a native desktop app — macOS (DMG) and Windows (NSIS installer).

Xavani Desktop is not a port or a rewrite. It bundles the real
[xavani-agent](https://github.com/enternovate/xavani-agent) engine behind a native window:
every tool, skill, memory, cron job, credential pool, and provider the CLI has, driven through
the agent's own HTTP API server with token streaming.

![platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue)
![version](https://img.shields.io/badge/version-0.3.0-5e6ad2)

## Highlights

- **Version-aligned with the CLI** — desktop and xavani-agent ship the same version number
  (0.3.0). Every CLI feature lands here too; `scripts/check_parity.sh` plus the weekly
  `cli-parity` workflow fail loudly when a new CLI command is not yet surfaced in the app.
- **v0.3.0 — Everyday Carry** — persistent tasks and reminders, profile switching,
  richer settings, additional import sources, a skills marketplace, cron creation,
  Studio editing and two-way visual preview editing.
- **Full CLI capability** — same engine, same tools, same `~/.xavani` home. Sessions created in
  the app are visible to the CLI and vice versa.
- **Token streaming** — replies stream live via SSE (`message.delta`), with reasoning blocks,
  tool-activity cards (spinner → duration / error), and structured lifecycle events.
- **Approvals UI** — dangerous commands surface an inline banner: Allow once / This session /
  Always / Deny. Same approval core as the gateway.
- **Stop button** — interrupts a running agent mid-flight.
- **Session sidebar** — resume any past conversation; history loads from the local session store.
- **Tools / Skills / Cron panels** — toggle toolsets per platform, browse installed skills,
  manage scheduled jobs (pause/resume/run/delete) — the same stores the CLI manages.
- **Local & private** — the backend binds to 127.0.0.1 only. No telemetry.

## Architecture

```
┌──────────────────────────── Xavani.app / Xavani.exe ───────────────────────────┐
│  Electron shell (src/main.js)                                                  │
│    └─ spawns bundled backend, parses ready line, restart-on-crash              │
│  Renderer (Linear design system, vanilla JS)                                   │
│    ├─ chat: POST /v1/runs + SSE /v1/runs/{id}/events                           │
│    └─ panels: /desktop/api/* (sessions, tools, skills) + /api/jobs (cron CRUD)  │
│  Backend (backend/serve_desktop.py)                                            │
│    ├─ gateway API-server adapter  → 127.0.0.1:<api_port>                       │
│    │   (chat completions, runs+SSE, approvals, stop, cron CRUD — all OpenAI-     │
│    │    compatible endpoints from enternovate/xavani-agent, unchanged)           │
│    └─ desktop management REST     → 127.0.0.1:<desktop_port>                   │
│  Bundled runtime: standalone CPython 3.13 + engine source + locked deps        │
└─────────────────────────────────────────────────────────────────────────────────┘
```

The engine runs unmodified — the desktop app is a consumer of its public API surface.

## Install

### macOS (Apple Silicon)

Download [Xavani-0.3.0-macos-arm64.dmg](https://github.com/enternovate/xavani-desktop/releases/download/v0.3.0/Xavani-0.3.0-macos-arm64.dmg),
open it, then drag **Xavani** to Applications.

Unsigned build notice: first launch needs right-click → **Open** (Gatekeeper), because the
binary is ad-hoc signed. With a Developer ID certificate this goes away.

On first run the app uses `~/.xavani/`. If you've never configured a model, either run
`xavani setup` in a terminal or edit `~/.xavani/config.yaml` — then restart the app.
(Status panel shows whether a model is configured.)

### Windows (x64)

Download [Xavani-0.3.0-windows-x64-setup.exe](https://github.com/enternovate/xavani-desktop/releases/download/v0.3.0/Xavani-0.3.0-windows-x64-setup.exe) and run it.
SmartScreen will warn on unsigned builds — "More info" → "Run anyway".

Portable ZIP: [Xavani-0.3.0-win.zip](https://github.com/enternovate/xavani-desktop/releases/download/v0.3.0/Xavani-0.3.0-win.zip)

Verified downloads and SHA-256 checksums are also published at
https://enternovate.co.za/xavani-desktop#download.

## Building from source

Requirements: Node 20+, [uv](https://docs.astral.sh/uv/), rsync (macOS).

```bash
npm install
node node_modules/electron/install.js   # ensure the Electron binary is present

# macOS DMG (expects ~/.xavani/xavani-agent clone; override with XAVANI_ENGINE_SRC)
bash scripts/build-macos.sh
# → dist/Xavani-<version>-macos-arm64.dmg

# Windows NSIS installer — built on GitHub Actions (windows-latest):
gh workflow run windows-build   # artifact: xavani-windows
```

Both builds follow the same recipe: copy a standalone CPython runtime, rsync the engine
source, install the engine's exact locked dependencies plus `aiohttp`, assemble the Electron
shell around it, then package (hdiutil on macOS, electron-builder on Windows).

## Dev mode

Point the shell at your dev checkout:

```bash
XAVANI_DESKTOP_DEV=1 npm start
# env knobs:
#   XAVANI_DESKTOP_PYTHON  python interpreter with xavani deps (default: ~/xavani-agent/.venv/bin/python)
#   XAVANI_DESKTOP_ENGINE  xavani-agent source tree      (default: ~/.xavani/xavani-agent)
```

Self-test hook (used by CI and manual QA):

```bash
XAVANI_DESKTOP_TEST='{"script":"document.getElementById(\"input\").value=\"hi\";document.getElementById(\"send\").click();","shotDelay":30000,"shot":"/tmp/x.png"}' npm start
```

## Privacy

Nothing leaves your machine except model API calls made by the engine itself, under your own
API keys. The backend listens on loopback only and refuses non-local binding without an API key
(inherited engine behavior). The app sends no product telemetry. It performs an anonymous
GitHub Releases request to check whether an update is available.

## License

MIT — Enternovate. Engine: [enternovate/xavani-agent](https://github.com/enternovate/xavani-agent).
