"""Task 24b: desktop product and legal boundary (Code Pack Q).

Everything legal this repository claims is checked against the files on disk:
the notices file, the vendored renderer assets it attributes, the About surface,
the update-check opt-in, and the packaged payload. Nothing here uses the
network, and nothing here is a screenshot test — the parent runs the app smoke.
"""

import hashlib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
NOTICES = ROOT / "THIRD_PARTY_NOTICES.md"
VENDOR = ROOT / "src" / "renderer" / "vendor"
MAIN_JS = ROOT / "src" / "main.js"
PRELOAD_JS = ROOT / "src" / "preload.js"
APP_JS = ROOT / "src" / "renderer" / "app.js"
BUILD_SH = ROOT / "scripts" / "build-macos.sh"
EXTENSION_DOC = ROOT / "docs" / "browser-extension.md"

# First-party sources that must stay free of default telemetry and upstream
# subscription hosts. Vendored bundles are third-party builds and are excluded.
FIRST_PARTY_SOURCES = [
    MAIN_JS,
    PRELOAD_JS,
    ROOT / "src" / "security.js",
    ROOT / "src" / "workspace-grant.js",
    ROOT / "src" / "update-policy.js",
    ROOT / "src" / "renderer" / "app.js",
    ROOT / "src" / "renderer" / "run-state.js",
    ROOT / "src" / "renderer" / "index.html",
]

BANNED_DEFAULT_REQUESTS = [
    "nousresearch",
    "portal.nousresearch.com",
    "telemetry",
    "analytics",
    "posthog",
    "sentry",
    "amplitude",
    "mixpanel",
    "google-analytics",
]

# Section 1 of the notices quotes these lines straight out of the vendored
# files. They must still be there.
VENDORED_NOTICE_LINES = [
    ("marked.min.js", "Copyright (c) 2011-2025, Christopher Jeffrey."),
    ("marked.min.js", "MIT Licensed"),
    ("purify.min.js", "DOMPurify 3.4.14"),
    ("purify.min.js", "Cure53 and other contributors"),
    ("purify.min.js", "Apache license 2.0"),
    ("purify.min.js", "Mozilla Public License 2.0"),
    ("xterm.css", "/npm/xterm@5.3.0/css/xterm.css"),
]

# Files the notices declare as shipping in the app payload.
VENDORED_FILES = [
    "marked.min.js",
    "purify.min.js",
    "xterm.js",
    "xterm-addon-fit.js",
    "xterm.css",
]

# Attribution the notices file must retain.
REQUIRED_ATTRIBUTION = [
    "Xavani",
    "Enternovate",
    "enternovate/xavani-desktop",
    "Christopher Jeffrey",
    "Cure53",
    "DOMPurify",
    "marked",
    "xterm.js",
    "xterm-addon-fit",
    "Apache-2.0",
    "MPL-2.0",
    "MIT",
    "SIL Open Font License",
    "SIL OPEN FONT LICENSE Version 1.1",
    "The xterm.js authors",
    "The Inter Project Authors",
    "The JetBrains Mono Project Authors",
    "Electron",
    "Chromium",
    "Node.js",
    "LICENSES.chromium.html",
]

BROWSER_EXTENSION_ATTRIBUTION = [
    "Derivative of an MIT-licensed upstream browser extension",
    "copyright and permission notices are preserved upstream",
    "Built by Enternovate under the MIT License.",
]


def notices_text() -> str:
    return NOTICES.read_text(encoding="utf-8")


def about_surface() -> str:
    text = APP_JS.read_text(encoding="utf-8")
    start = text.index("// --- About ---")
    end = text.index("/* ---------------- agent ops", start)
    return text[start:end]


# --------------------------------------------------------------------------
# the notices file itself
# --------------------------------------------------------------------------


def test_notices_file_exists_and_is_non_empty():
    assert NOTICES.is_file(), "THIRD_PARTY_NOTICES.md is missing"
    assert len(notices_text().strip()) > 500, "notices file is not substantive"


def test_notices_declares_every_vendored_file():
    text = notices_text()
    for name in VENDORED_FILES:
        assert (VENDOR / name).is_file(), f"declared vendored file is missing: {name}"
        assert name in text, f"notices do not declare the vendored file: {name}"


def test_vendor_directory_has_no_undeclared_asset():
    actual = sorted(p.name for p in VENDOR.iterdir() if p.is_file())
    undeclared = [n for n in actual if n not in VENDORED_FILES]
    assert undeclared == [], f"vendored assets missing from the notices: {undeclared}"


def test_required_attribution_is_retained():
    text = notices_text()
    missing = [s for s in REQUIRED_ATTRIBUTION if s not in text]
    assert missing == [], f"notices dropped required attribution: {missing}"


def test_vendored_notice_lines_are_intact():
    for name, line in VENDORED_NOTICE_LINES:
        blob = (VENDOR / name).read_bytes().decode("utf-8", "replace")
        assert line in blob, f"{name} no longer carries its notice line: {line}"


def test_notices_records_the_unembedded_xterm_gap():
    """xterm.js ships no notice line; the notices must say so, not invent one."""
    text = notices_text()
    assert "no notice embedded" in text or "no embedded copyright or license line" in text
    assert "xterm@5.3.0" in text


def test_vendored_copies_match_the_installed_packages():
    pairs = [
        (VENDOR / "marked.min.js", ROOT / "node_modules" / "marked" / "marked.min.js"),
        (VENDOR / "purify.min.js", ROOT / "node_modules" / "dompurify" / "dist" / "purify.min.js"),
    ]
    for vendored, installed in pairs:
        if not installed.is_file():
            pytest.skip("node_modules not installed in this checkout")
        assert hashlib.sha256(vendored.read_bytes()).hexdigest() == hashlib.sha256(
            installed.read_bytes()
        ).hexdigest(), f"{vendored.name} diverged from the installed package copy"


def test_browser_extension_attribution_is_retained():
    doc = EXTENSION_DOC.read_text(encoding="utf-8")
    missing = [s for s in BROWSER_EXTENSION_ATTRIBUTION if s not in doc]
    assert missing == [], f"docs/browser-extension.md dropped attribution: {missing}"


# --------------------------------------------------------------------------
# product surface
# --------------------------------------------------------------------------


def test_about_surface_names_product_and_publisher():
    about = about_surface()
    assert "Xavani" in about, "About must name Xavani"
    assert "Enternovate" in about, "About must name Enternovate"


def test_about_surface_shows_the_notices():
    about = about_surface()
    assert "THIRD_PARTY_NOTICES.md" in about, "About must show the notices file"
    assert "rt.notices" in about, "About must open the notices path from the main process"


def test_main_process_exposes_the_packaged_notices_path():
    main = MAIN_JS.read_text(encoding="utf-8")
    assert "process.resourcesPath" in main and "THIRD_PARTY_NOTICES.md" in main
    assert "notices: noticesPath()" in main, "runtime-info must report the notices path"


def test_native_about_panel_names_product_and_publisher():
    main = MAIN_JS.read_text(encoding="utf-8")
    start = main.index("setAboutPanelOptions")
    panel = main[start : start + 400]
    assert "Xavani" in panel and "Enternovate" in panel


# --------------------------------------------------------------------------
# update checks are opt-in
# --------------------------------------------------------------------------


def test_update_check_requires_a_user_action_or_opt_in():
    main = MAIN_JS.read_text(encoding="utf-8")
    app = APP_JS.read_text(encoding="utf-8")

    # No startup or repeating schedule in the main process.
    assert "setInterval(" not in main
    assert "setTimeout(() => checkForUpdates" not in main

    # The renderer reports the stored choice first and only checks when the
    # main process confirms it is enabled.
    assert "setAutoUpdate(autoUpdateOn)" in app
    assert "(on ? window.xavaniDesktop.checkForUpdates() : null)" in app
    assert app.index("setAutoUpdate(autoUpdateOn)") < app.index("(on ? window.xavaniDesktop.checkForUpdates() : null)")

    # The manual check path stays wired, and the IPC surface is sender-gated.
    assert "id=\"upd-check\"" in app, "the existing Check now control must keep working"
    assert "ipcMain.handle('set-auto-update'" in main
    assert "setAutoUpdate: (enabled) => ipcRenderer.invoke('set-auto-update', enabled)" in PRELOAD_JS.read_text(encoding="utf-8")

    # Default opt-in state is off.
    assert "localStorage.getItem('xz-auto-update') === '1'" in app


def test_no_default_telemetry_or_upstream_host():
    problems = []
    for path in FIRST_PARTY_SOURCES:
        blob = path.read_text(encoding="utf-8", errors="replace").lower()
        for token in BANNED_DEFAULT_REQUESTS:
            if token in blob:
                problems.append(f"{path.name}: {token}")
    assert problems == [], f"default telemetry/upstream references found: {problems}"


def test_only_outbound_host_in_first_party_source_is_the_release_repo():
    import re

    hosts = set()
    for path in (MAIN_JS, PRELOAD_JS, APP_JS):
        hosts |= set(re.findall(r"https?://([A-Za-z0-9._-]+)", path.read_text(encoding="utf-8")))
    assert hosts <= {"github.com", "api.github.com", "127.0.0.1"}, f"unexpected hosts: {sorted(hosts)}"


# --------------------------------------------------------------------------
# packaged payload
# --------------------------------------------------------------------------


def test_build_script_ships_the_notices():
    script = BUILD_SH.read_text(encoding="utf-8")
    assert 'cp "$ROOT/THIRD_PARTY_NOTICES.md" "$RES/app/THIRD_PARTY_NOTICES.md"' in script
    assert "LICENSES.chromium.html" in script, "Electron's Chromium notices must ship too"


def test_build_script_packages_the_runtime_dependency_licenses():
    script = BUILD_SH.read_text(encoding="utf-8")
    assert 'cp -R "$ROOT/node_modules/marked" "$RES/app/node_modules/marked"' in script
    assert 'cp -R "$ROOT/node_modules/dompurify" "$RES/app/node_modules/dompurify"' in script
    assert "node_modules/marked/LICENSE.md" in notices_text()
    assert "node_modules/dompurify/LICENSE" in notices_text()
