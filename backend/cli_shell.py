#!/usr/bin/env python3
"""Interactive xavani CLI shell for the desktop console.

Executed inside a PTY allocated by serve_desktop.py, so every inner
invocation owns a real TTY: interactive wizards, curses-style pickers and
the prompt_toolkit chat all behave exactly like the installed CLI.

Reads one command line per prompt, runs it against the bundled engine,
prints the result, repeats. `exit` leaves the shell.
"""

import os
import shlex
import signal
import subprocess
import sys
from pathlib import Path

ENGINE_ROOT = os.environ.get("XAVANI_ENGINE_ROOT", "")
XAVANI_ENTRY = os.path.join(ENGINE_ROOT, "xavani.py")

BINDIR = str(Path(sys.executable).parent)
CHILD_ENV = {
    **os.environ,
    "PATH": f"{BINDIR}{os.pathsep}{os.environ.get('PATH', '')}",
}
# Route through xavani_cli.main directly: xavani.py's delegation set omits
# subcommands like doctor / mcp / constellation and would treat them as
# chat queries instead.
INNER_CODE = "import sys; sys.argv = ['xavani'] + sys.argv[1:]; from xavani_cli.main import main; main()"

BANNER = """
\x1b[1;38;5;99mXavani Console\x1b[0m \x1b[38;5;245m— every CLI command, live.\x1b[0m
\x1b[38;5;245mTry: doctor · status · skills list · constellation status · insights\x1b[0m
\x1b[38;5;245mType \x1b[0m\x1b[38;5;141mexit\x1b[0m\x1b[38;5;245m to close.\x1b[0m
"""

PROMPT = "\x1b[38;5;99mxavani>\x1b[0m "

if not ENGINE_ROOT or not os.path.exists(XAVANI_ENTRY):
    print("engine root missing:", XAVANI_ENTRY)
    sys.exit(1)

signal.signal(signal.SIGINT, signal.SIG_IGN)

print(BANNER, flush=True)
while True:
    try:
        print(PROMPT, end="", flush=True)
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
    except KeyboardInterrupt:
        print()
        continue
    if not line:
        continue
    if line in {"exit", "quit", "q"}:
        break
    try:
        args = shlex.split(line)
    except ValueError as exc:
        print(f"\x1b[31mparse error: {exc}\x1b[0m", flush=True)
        continue
    try:
        code = subprocess.run(
            [sys.executable, "-c", INNER_CODE, *args],
            env=CHILD_ENV,
        ).returncode
        if code not in (0, None):
            print(f"\x1b[38;5;245m(exit code {code})\x1b[0m", flush=True)
    except KeyboardInterrupt:
        print("\x1b[38;5;245m(interrupted)\x1b[0m", flush=True)
    except Exception as exc:
        print(f"\x1b[31m{exc}\x1b[0m", flush=True)
print("\x1b[38;5;245msession closed.\x1b[0m", flush=True)
