#!/usr/bin/env bash
# Build Xavani.app + DMG for macOS arm64.
# Layout produced:
#   Xavani.app/Contents/Resources/app/        Electron renderer + main (package.json, src/, minimal node_modules)
#   Xavani.app/Contents/Resources/backend/
#     serve_desktop.py                        desktop REST + api-server launcher
#     runtime/                                standalone CPython (python-build-standalone via uv)
#     engine/                                 xavani-agent source tree (PYTHONPATH target)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE_SRC="${XAVANI_ENGINE_SRC:-$HOME/.xavani/xavani-agent}"
BUILD="$ROOT/build"
STAGE="$BUILD/dmg-stage"
APP="$STAGE/Xavani.app"
RES="$APP/Contents/Resources"
PYVER="3.13"

cd "$ROOT"
VERSION=$(python3 -c "import json; print(json.load(open('$ROOT/package.json'))['version'])")
echo "==> Xavani Desktop $VERSION from engine: $ENGINE_SRC"

rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "==> Electron shell"
cp -R "$ROOT/node_modules/electron/dist/Electron.app" "$APP"
RES="$APP/Contents/Resources"
mkdir -p "$RES/app" "$RES/backend"
PLIST="$APP/Contents/Info.plist"
pb_set() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"; }
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Xavani"
pb_set CFBundleExecutable Xavani
pb_set CFBundleName Xavani
pb_set CFBundleDisplayName Xavani
pb_set CFBundleIdentifier com.enternovate.xavani
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile icon.icns" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string icon.icns" "$PLIST"
cp "$ROOT/build/icon.icns" "$APP/Contents/Resources/icon.icns"

echo "==> App payload (renderer + main)"
mkdir -p "$RES/app"
cp "$ROOT/package.json" "$RES/app/"
cp -R "$ROOT/src" "$RES/app/src"
mkdir -p "$RES/app/node_modules"
cp -R "$ROOT/node_modules/marked" "$RES/app/node_modules/marked"
cp -R "$ROOT/node_modules/dompurify" "$RES/app/node_modules/dompurify"

echo "==> Backend launcher"
cp "$ROOT/backend/serve_desktop.py" "$RES/backend/"

echo "==> Python runtime ($PYVER)"
RUNTIME_SRC=$(ls -d "$HOME/.local/share/uv/python/cpython-${PYVER}"*-macos-aarch64-none 2>/dev/null | sort | tail -1)
[ -n "$RUNTIME_SRC" ] || { echo "no uv python ${PYVER} found"; exit 1; }
echo "    from $RUNTIME_SRC"
cp -R "$RUNTIME_SRC" "$RES/backend/runtime"
rm -f "$RES/backend/runtime/lib/python${PYVER}/EXTERNALLY-MANAGED"

echo "==> Engine source"
rsync -a --delete \
  --exclude '.git' --exclude '__pycache__' --exclude '*.pyc' \
  --exclude 'node_modules' --exclude 'tests' --exclude 'website' \
  --exclude 'docs' --exclude 'docker' --exclude 'nix' --exclude '.github' \
  --exclude 'datagen-config-examples' --exclude 'dist' --exclude 'build' \
  --exclude '.venv' --exclude '*.egg-info' --exclude '.ruff_cache' --exclude '.pytest_cache' \
  --exclude 'package.json' --exclude 'package-lock.json' --exclude 'ui-tui' \
  "$ENGINE_SRC/" "$RES/backend/engine/"

echo "==> Engine dependencies (from uv.lock)"
REQS=$(mktemp)
(cd "$ENGINE_SRC" && uv export --frozen --no-dev --no-hashes --no-emit-project --format requirements-txt -o "$REQS") >/dev/null
uv pip install --python "$RES/backend/runtime/bin/python${PYVER}" -r "$REQS" aiohttp --quiet
rm -f "$REQS"

echo "==> Constellation products (gavaza, nyarhi, mhangani, mcp)"
CONST_DIR="${XAVANI_CONSTELLATION_SRC:-$HOME/constellation-builds}"
for p in gavaza nyarhi mhangani constellation-mcp; do
  if [ -d "$CONST_DIR/$p" ]; then
    uv pip install --python "$RES/backend/runtime/bin/python${PYVER}" "$CONST_DIR/$p" --quiet \
      || echo "WARN: $p failed to install from $CONST_DIR/$p"
  else
    echo "WARN: $CONST_DIR/$p missing — skipping"
  fi
done

echo "==> Ad-hoc code signing"
codesign --force --deep --sign - "$APP" 2>/dev/null

echo "==> DMG"
ln -sf /Applications "$STAGE/Applications"
DMG="$ROOT/dist/Xavani-${VERSION}-macos-arm64.dmg"
mkdir -p "$ROOT/dist"
rm -f "$DMG"
hdiutil create -volname "Xavani" -srcfolder "$STAGE" -ov -format UDZO -quiet "$DMG"

du -sh "$APP" "$DMG"
echo "==> Done: $DMG"
