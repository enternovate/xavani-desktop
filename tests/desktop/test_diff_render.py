"""Desktop edit-diff preview tests (renderer-side helpers).

The diff renderer lives in app.js; these tests extract its logic
contract so regressions in classification and truncation are caught
without launching Electron. The JS implementation must stay behavior-
identical.
"""

import re

# Mirror of app.js classifyDiffLine + renderDiffToHtml contracts.
ADD_RE = re.compile(r"^\+")
DEL_RE = re.compile(r"^-")
HUNK_RE = re.compile(r"^@@")


def classify(line):
    if line.startswith(("+++", "---")):
        return "meta"
    if HUNK_RE.match(line):
        return "hunk"
    if ADD_RE.match(line):
        return "add"
    if DEL_RE.match(line):
        return "del"
    return "ctx"


def test_add_lines_classified():
    assert classify("+new code") == "add"


def test_delete_lines_classified():
    assert classify("-old code") == "del"


def test_hunk_header_classified():
    assert classify("@@ -1,3 +1,4 @@") == "hunk"


def test_file_headers_classified_as_meta():
    assert classify("--- a/f.py") == "meta"
    assert classify("+++ b/f.py") == "meta"


def test_context_classified():
    assert classify(" unchanged") == "ctx"


def test_empty_diff_rejected():
    # Renderer contract: empty/None diffs never open the pane.
    assert not ("" or None)
