#!/usr/bin/env bash
# run-smoke-test.sh — Basic smoke test for offline-installed ScienceFlow
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

if [ ! -f "$VENV_PYTHON" ]; then
    echo "ERROR: Virtual environment not found at $VENV_DIR" >&2
    exit 1
fi

echo "=== ScienceFlow Smoke Test ==="
echo ""

# 1. Check Python and environment
echo "--- Python Information ---"
"$VENV_PYTHON" --version
"$VENV_PYTHON" -c "import sys; print(f'Python {sys.version}')"
"$VENV_PYTHON" -c "import sysconfig; print(f'Prefix: {sysconfig.get_config_var(\"prefix\")}')"
echo ""

# 2. Check imports
echo "--- Core Package Imports ---"
for pkg in click rich httpx pydantic yaml requests; do
    if "$VENV_PYTHON" -c "import $pkg; print(f'  {pkg}: {getattr($pkg,\"__version__\",\"ok\")}')" 2>/dev/null; then
        true
    else
        echo "  $pkg: FAILED"
    fi
done
echo ""

# 3. Try to import scienceflow
echo "--- ScienceFlow Import ---"
"$VENV_PYTHON" -c "
try:
    import scienceflow
    print(f'Version: {scienceflow.__version__}')
    print(f'Path: {scienceflow.__file__}')
    print(f'Dir: {dir(scienceflow)}')
except ImportError as e:
    print(f'Not installed: {e}')
" 2>&1 || echo "scienceflow import failed (non-fatal for smoke test)"
echo ""

# 4. Check CLI
echo "--- CLI Check ---"
CLI_PATH="$VENV_DIR/bin/scienceflow"
if [ -x "$CLI_PATH" ]; then
    echo "CLI found at: $CLI_PATH"
    "$CLI_PATH" --help 2>&1 || true
    "$CLI_PATH" --version 2>&1 || true
else
    echo "No scienceflow CLI found (expected if not packaged)"
fi
echo ""

# 5. System environment check
echo "--- Network Isolation Check ---"
echo "PIP_NO_INDEX=${PIP_NO_INDEX:-unset}"
echo "UV_OFFLINE=${UV_OFFLINE:-unset}"
echo "UV_NO_PYTHON_DOWNLOADS=${UV_NO_PYTHON_DOWNLOADS:-unset}"
echo "PIP_DISABLE_PIP_VERSION_CHECK=${PIP_DISABLE_PIP_VERSION_CHECK:-unset}"
echo ""

# 6. Vendor integrity check
echo "--- Vendor Integrity ---"
VENDOR_DIR="$SKILL_DIR/vendor"
if [ -f "$VENDOR_DIR/SHA256SUMS" ]; then
    if (cd "$VENDOR_DIR" && sha256sum -c SHA256SUMS 2>&1) | head -20; then
        echo "SHA256 checksums OK"
    else
        echo "WARNING: Some checksums differ"
    fi
fi
echo ""

echo "=== Smoke Test Complete ==="
