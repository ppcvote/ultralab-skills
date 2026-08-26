#!/usr/bin/env bash
# positive-control.sh — a verification template that refuses to report a pass
# when the check itself cannot fail.
#
# Why: verification tools break silently. A "stash and test" step is a no-op on an
# already-clean tree. A parser that is not installed sends its error somewhere nobody
# reads. A command that writes errors to stdout makes the condition always true.
# A pass with no positive control is indistinguishable from no test at all.
#
# Usage:
#   ./positive-control.sh <url> <expected-substring>
#
# Optional environment:
#   NEGATIVE_URL=<url>   this URL must NOT contain the expected string
#   UNIQUE=1             warn if the expected string also appears on the site root
set -euo pipefail

TARGET="${1:-}"
EXPECT="${2:-}"
if [ -z "$TARGET" ] || [ -z "$EXPECT" ]; then
  echo "usage: $0 <url> <expected-substring>" >&2
  exit 64
fi

fetch() { curl -s --max-time 20 "$1"; }

# -F is deliberate: treat EXPECT as a fixed string, not a regex. Article titles
# routinely contain . ? * [ $ and a regex match on those produces false passes.
check() { fetch "$1" | grep -qF -- "$EXPECT"; }

echo "== Positive control: prove this check can fail =="
BOGUS="${TARGET%%\?*}__definitely_not_here_$RANDOM"
if check "$BOGUS"; then
  cat <<'EOF' >&2
ABORT: the check passed against a target that does not exist.
Nothing this run reports can be trusted.

Three common causes:
  1. A single-page app serves the same HTML for unknown routes (HTTP 200), and that
     HTML happens to contain your string.
  2. The 404 page includes site-wide navigation, and your string is in the menu.
  3. The expected string is too generic (a brand or category name that is on every page).

Fix: choose a string unique to this one page, such as a full sentence from the body,
then run again. The control must fail before a pass means anything.
EOF
  exit 2
fi
echo "OK: control failed as expected, so the check is capable of failing."

echo
echo "== Forward check: is what should be there actually there =="
if check "$TARGET"; then
  echo "PASS: $TARGET contains \"$EXPECT\""
else
  echo "FAIL: $TARGET does not contain \"$EXPECT\"" >&2
  exit 1
fi

if [ "${UNIQUE:-0}" = "1" ]; then
  echo
  echo "== Uniqueness: is this string on every page anyway =="
  ROOT="$(printf '%s' "$TARGET" | sed -E 's#(https?://[^/]+).*#\1#')"
  if fetch "$ROOT" | grep -qF -- "$EXPECT"; then
    echo "WARN: the site root also contains \"$EXPECT\". This string is a weak assertion; pick a more specific one."
  else
    echo "OK: not present on the site root, so the assertion is specific enough."
  fi
fi

if [ -n "${NEGATIVE_URL:-}" ]; then
  echo
  echo "== Reverse check: is what should be hidden actually hidden =="
  if check "$NEGATIVE_URL"; then
    echo "FAIL: $NEGATIVE_URL contains \"$EXPECT\" and should not" >&2
    exit 1
  fi
  echo "PASS: reverse check clean"
fi
