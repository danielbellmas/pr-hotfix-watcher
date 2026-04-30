#!/usr/bin/env bash
# Smoke-test that the packaged .vsix installs cleanly into a throwaway VS Code /
# Cursor profile and that the extension shows up in `--list-extensions`. Catches
# packaging bugs that the in-process e2e harness misses (bad `main`, files
# excluded by `.vscodeignore`, missing icon, broken activation events).
#
# Usage:
#   scripts/verify-install.sh                # auto-detect `code` or `cursor`
#   CODE_BIN=/path/to/code scripts/verify-install.sh
#   VSIX=hotfix-watcher-0.1.0.vsix scripts/verify-install.sh
#
# Side effects: creates a temp dir under $TMPDIR and removes it on exit.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

EXT_ID="fordefi.hotfix-watcher"

CODE_BIN="${CODE_BIN:-}"
if [[ -z "$CODE_BIN" ]]; then
  if command -v code >/dev/null 2>&1; then
    CODE_BIN="code"
  elif command -v cursor >/dev/null 2>&1; then
    CODE_BIN="cursor"
  else
    echo "verify-install: no 'code' or 'cursor' CLI on PATH. Set CODE_BIN=/path/to/code." >&2
    exit 2
  fi
fi
echo "verify-install: using CLI '$CODE_BIN'"

VSIX="${VSIX:-}"
if [[ -z "$VSIX" ]]; then
  if ls hotfix-watcher-*.vsix >/dev/null 2>&1; then
    VSIX="$(ls -t hotfix-watcher-*.vsix | head -n1)"
  else
    echo "verify-install: no .vsix in repo root, building one with 'npm run package'..."
    npm run package
    VSIX="$(ls -t hotfix-watcher-*.vsix | head -n1)"
  fi
fi
if [[ ! -f "$VSIX" ]]; then
  echo "verify-install: VSIX not found at '$VSIX'" >&2
  exit 2
fi
echo "verify-install: installing '$VSIX'"

TMP_PROFILE="$(mktemp -d -t hotfix-watcher-verify-XXXXXX)"
cleanup() { rm -rf "$TMP_PROFILE"; }
trap cleanup EXIT

set -x
"$CODE_BIN" \
  --user-data-dir "$TMP_PROFILE/user" \
  --extensions-dir "$TMP_PROFILE/exts" \
  --install-extension "$VSIX" \
  --force

INSTALLED="$(
  "$CODE_BIN" \
    --user-data-dir "$TMP_PROFILE/user" \
    --extensions-dir "$TMP_PROFILE/exts" \
    --list-extensions --show-versions
)"
set +x

echo "$INSTALLED"

if ! grep -q "^$EXT_ID@" <<<"$INSTALLED"; then
  echo "verify-install: extension '$EXT_ID' not present after install" >&2
  exit 1
fi

echo "verify-install: OK ($EXT_ID installs into throwaway profile)"
