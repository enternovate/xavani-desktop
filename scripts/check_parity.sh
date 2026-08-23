#!/usr/bin/env bash
# Parity gate: the desktop app must surface every command the CLI ships.
# Compares the engine's COMMAND_REGISTRY against the committed snapshot.
# New CLI commands make this fail until the desktop covers them.
#
# Usage: scripts/check_parity.sh [engine-root]   (default: $XAVANI_ENGINE_SRC or ~/.xavani/xavani-agent)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE="${1:-${XAVANI_ENGINE_SRC:-$HOME/.xavani/xavani-agent}}"
SNAPSHOT="$ROOT/packaging/parity/commands.snapshot.txt"

[ -f "$ENGINE/run_agent.py" ] || { echo "engine root not found: $ENGINE"; exit 2; }
[ -f "$SNAPSHOT" ] || { echo "snapshot missing: $SNAPSHOT"; exit 2; }

DUMP="$(mktemp)"
ENGINE="$ENGINE" python3 - <<'EOF' > "$DUMP"
import json, os, subprocess, sys
code = (
    "import sys, json; sys.path.insert(0, sys.argv[1]);"
    "from xavani_cli.commands import COMMAND_REGISTRY;"
    "print(json.dumps(sorted(c.name for c in COMMAND_REGISTRY)))"
)
out = subprocess.run(
    [sys.executable, "-c", code, os.environ["ENGINE"]],
    capture_output=True, text=True, timeout=120,
)
if out.returncode != 0:
    sys.stderr.write(out.stderr[-500:])
    sys.exit(2)
print("\n".join(json.loads(out.stdout)))
EOF

NEW="$(comm -13 <(sort "$SNAPSHOT") <(sort "$DUMP"))"
GONE="$(comm -23 <(sort "$SNAPSHOT") <(sort "$DUMP"))"

if [ -n "$NEW" ]; then
  echo "::error::New CLI command(s) not surfaced in the desktop app:"
  echo "$NEW" | sed 's/^/  + /'
  echo "Action: extend desktop autocomplete coverage (it is registry-driven, so"
  echo "usually only the snapshot needs refreshing) and add GUI surfaces for"
  echo "session-scoped features. Then update packaging/parity/commands.snapshot.txt."
fi
if [ -n "$GONE" ]; then
  echo "::warning::CLI command(s) removed upstream; refresh the snapshot:"
  echo "$GONE" | sed 's/^/  - /'
fi

if [ -z "$NEW" ] && [ -z "$GONE" ]; then
  echo "parity OK: $(wc -l < "$SNAPSHOT" | tr -d ' ') commands, desktop matches CLI"
  exit 0
fi
[ -z "$NEW" ]
