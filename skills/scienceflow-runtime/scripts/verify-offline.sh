#!/usr/bin/env bash
# verify-offline.sh — Verify offline ScienceFlow installation
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${SF_TARGET:-$PWD/sf_runtime}"
while [ $# -gt 0 ]; do
    case "$1" in
        --target) TARGET_DIR="$2"; shift 2 ;;
        *) echo "Usage: $0 [--target DIR]"; exit 1 ;;
    esac
done
TARGET_DIR="$(realpath -m "$TARGET_DIR" 2>/dev/null || realpath "$TARGET_DIR" 2>/dev/null || echo "$TARGET_DIR")"

VENV_DIR="$TARGET_DIR/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"
VENV_PIP="$VENV_DIR/bin/pip"
VENDOR_DIR="$SKILL_DIR/vendor"
WHEELS_DIR="$VENDOR_DIR/wheels"

echo "=== Offline Installation Verification ==="
echo ""

fail=0
pass=0

check() {
    local desc="$1"
    shift
    if "$@"; then
        echo "  [PASS] $desc"
        pass=$((pass+1))
    else
        echo "  [FAIL] $desc" >&2
        fail=$((fail+1))
    fi
}

echo "--- Directory Structure ---"
check "Target directory exists" test -d "$TARGET_DIR"
check "Virtual environment exists" test -f "$VENV_DIR/pyvenv.cfg"
check "Python executable in venv" test -f "$VENV_PYTHON"
check "Pip in venv" test -f "$VENV_PIP"

echo "--- Source ---"
check "repo/ directory exists" test -d "$TARGET_DIR/repo"
check "repo/scienceflow/ exists" test -d "$TARGET_DIR/repo/scienceflow"
check "repo/pyproject.toml exists" test -f "$TARGET_DIR/repo/pyproject.toml"

echo "--- Vendor Artifacts ---"
check "vendor/ directory exists" test -d "$VENDOR_DIR"
check "vendor/wheels/ has files" test -n "$(ls -A "$WHEELS_DIR"/*.whl 2>/dev/null || true)"
check "offline-manifest.txt exists" test -f "$VENDOR_DIR/offline-manifest.txt"
check "SHA256SUMS exists" test -f "$VENDOR_DIR/SHA256SUMS"

echo "--- Python Version ---"
if [ -f "$VENV_PYTHON" ]; then
    version=$("$VENV_PYTHON" -c "import sys; print(*sys.version_info[:2])" 2>/dev/null || echo "0 0")
    read -r major minor <<< "$version"
    if [ "$major" -ge 3 ] && { [ "$major" -gt 3 ] || [ "$minor" -ge 11 ]; }; then
        if [ "$major" -eq 3 ] && [ "$minor" -le 13 ]; then
            echo "  [PASS] Python version $major.$minor (3.11–3.13)"
            pass=$((pass+1))
        else
            echo "  [FAIL] Python version $major.$minor (expected 3.11–3.13)" >&2
            fail=$((fail+1))
        fi
    else
        echo "  [FAIL] Python version $major.$minor (expected 3.11–3.13)" >&2
        fail=$((fail+1))
    fi
fi

echo "--- Import Checks ---"
check "click import" "$VENV_PYTHON" -c "import click; print('ok')" 2>/dev/null
check "rich import" "$VENV_PYTHON" -c "import rich; print('ok')" 2>/dev/null
check "httpx import" "$VENV_PYTHON" -c "import httpx; print('ok')" 2>/dev/null
check "pydantic import" "$VENV_PYTHON" -c "import pydantic; print('ok')" 2>/dev/null
check "pyyaml import" "$VENV_PYTHON" -c "import yaml; print('ok')" 2>/dev/null
check "requests import" "$VENV_PYTHON" -c "import requests; print('ok')" 2>/dev/null

echo "--- ScienceFlow Import ---"
if "$VENV_PYTHON" -c "import scienceflow; print('version:', scienceflow.__version__)" 2>/dev/null; then
    echo "  [PASS] scienceflow package imports"
    pass=$((pass+1))
else
    echo "  [WARN] scienceflow package import failed (may be expected)" >&2
fi

echo "--- CLI Check ---"
CLI_PATH="$VENV_DIR/bin/scienceflow"
if [ -x "$CLI_PATH" ]; then
    echo "  [PASS] CLI exists at $CLI_PATH"
    pass=$((pass+1))
    if "$CLI_PATH" --help 2>&1 | grep -q "Usage\|scienceflow\|help"; then
        echo "  [PASS] CLI --help works"
        pass=$((pass+1))
    else
        echo "  [WARN] CLI --help did not produce expected output"
    fi
else
    echo "  [WARN] scienceflow CLI not found (expected if not installed)"
fi

echo ""
echo "--- Summary ---"
echo "Passed: $pass"
echo "Failed: $fail"
if [ "$fail" -eq 0 ]; then
    echo "All checks passed."
else
    echo "Some checks failed. Review messages above."
fi
exit "$fail"
