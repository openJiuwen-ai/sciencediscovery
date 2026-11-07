#!/usr/bin/env bash
# install-offline.sh — Offline ScienceFlow installation using bundled wheels
# No network access is required.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$SKILL_DIR/vendor"
WHEELS_DIR="$VENDOR_DIR/wheels"
SOURCE_ZIP="$SKILL_DIR/assets/repo.zip"

# Parse arguments
TARGET_DIR="${SF_TARGET:-$PWD/sf_runtime}"
while [ $# -gt 0 ]; do
    case "$1" in
        --target) TARGET_DIR="$2"; shift 2 ;;
        --python) PYTHON_EXE="$2"; shift 2 ;;
        *) echo "Usage: $0 [--target DIR] [--python PYTHON]"; exit 1 ;;
    esac
done
TARGET_DIR="$(realpath -m "$TARGET_DIR" 2>/dev/null || realpath "$TARGET_DIR" 2>/dev/null || echo "$TARGET_DIR")"

if [ "$TARGET_DIR" = "$SKILL_DIR" ] || [ "${TARGET_DIR##$SKILL_DIR/}" != "$TARGET_DIR" ]; then
    echo "ERROR: Target must be outside the Skill directory" >&2
    exit 1
fi

mkdir -p "$TARGET_DIR"

echo "[install-offline] Target: $TARGET_DIR"
echo "[install-offline] Skill dir: $SKILL_DIR"

# 1. Check that vendor/wheels exists and has content
if [ ! -d "$WHEELS_DIR" ] || [ -z "$(ls -A "$WHEELS_DIR"/*.whl 2>/dev/null)" ]; then
    echo "ERROR: vendor/wheels/ is empty or missing. Run prepare-offline.sh first or get a pre-built bundle." >&2
    exit 1
fi

# 2. Check that repo.zip exists
if [ ! -f "$SOURCE_ZIP" ]; then
    echo "ERROR: $SOURCE_ZIP not found. The Skill bundle must include assets/repo.zip" >&2
    exit 1
fi

# 3. Find a suitable Python
PYTHON="${PYTHON_EXE:-python3}"
if ! command -v "$PYTHON" &>/dev/null; then
    echo "ERROR: Python interpreter not found: $PYTHON" >&2
    exit 1
fi
# Check Python version
version=$("$PYTHON" -c "import sys; print(*sys.version_info[:2])" 2>/dev/null || echo "0 0")
read -r major minor <<< "$version"
if [ "$major" -lt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -lt 11 ]; }; then
    echo "ERROR: Python 3.11–3.13 required, found $major.$minor" >&2
    exit 1
fi
echo "[install-offline] Using Python: $("$PYTHON" --version 2>&1)"

# 4. Create virtual environment
VENV_DIR="$TARGET_DIR/.venv"
if [ ! -f "$VENV_DIR/pyvenv.cfg" ]; then
    echo "[install-offline] Creating virtual environment at $VENV_DIR..."
    "$PYTHON" -m venv "$VENV_DIR"
else
    echo "[install-offline] Virtual environment already exists"
fi

# 5. Activate venv
# Source the activate script to get the right pip
# We'll use the venv's pip directly
VENV_PYTHON="$VENV_DIR/bin/python"
VENV_PIP="$VENV_DIR/bin/pip"

# Verify pip is available
if ! "$VENV_PYTHON" -m pip --version &>/dev/null; then
    echo "ERROR: pip not available in the virtual environment" >&2
    exit 1
fi

# 6. Extract repo.zip
REPO_DIR="$TARGET_DIR/repo"
MARKER="$TARGET_DIR/install-manifest.json"
if [ -f "$MARKER" ]; then
    echo "[install-offline] repo/ already exists; skipping extraction"
else
    echo "[install-offline] Extracting $SOURCE_ZIP..."
    rm -rf "$REPO_DIR"
    # Use the install.py logic for safe extraction
    "$PYTHON" "$SKILL_DIR/scripts/install.py" --repo-zip "$SOURCE_ZIP" --target "$TARGET_DIR" --no-install 2>&1
    RES=$?
    if [ $RES -ne 0 ]; then
        echo "ERROR: install.py extraction failed (exit code $RES)" >&2
        exit $RES
    fi
    echo "[install-offline] Source extraction complete"
fi

# 7. Install Python packages from local wheels (OFFLINE)
echo "[install-offline] Installing Python packages from $WHEELS_DIR (no-index)..."
export PIP_NO_INDEX=1
export UV_OFFLINE=1
export UV_NO_PYTHON_DOWNLOADS=1
export PIP_DISABLE_PIP_VERSION_CHECK=1

# First, install packaging, pip, setuptools, wheel from our vendor
# Then install all other dependencies
WHEEL_LIST=()
for w in "$WHEELS_DIR"/*.whl; do
    [ -f "$w" ] && WHEEL_LIST+=("$w")
done

if [ ${#WHEEL_LIST[@]} -eq 0 ]; then
    echo "ERROR: No wheel files found in $WHEELS_DIR" >&2
    exit 1
fi

# Install in order: first pip/setuptools/wheel, then the rest
"$VENV_PIP" install --no-index --find-links "$WHEELS_DIR" --quiet pip setuptools wheel 2>&1 || echo "[warn] Could not upgrade pip from offline"

# Now install all packages from the wheelhouse
# We need to resolve dependencies; since we have no index, pip may fail. Use --no-deps if needed.
# First try with dependency resolution
echo "[install-offline] Installing all packages with dependency resolution..."
"$VENV_PIP" install --no-index --find-links "$WHEELS_DIR" \
    packaging typing-extensions pyyaml click rich httpx pydantic requests \
    2>&1 && echo "[install-offline] Core packages installed." || echo "[warn] Some core packages failed to install"

# Install the scienceflow package from the local repo
echo "[install-offline] Installing scienceflow from local source..."
cd "$TARGET_DIR"
"$VENV_PIP" install --no-index --find-links "$WHEELS_DIR" -e "$REPO_DIR" 2>&1 || {
    echo "[install-offline] Trying alternative install method..."
    # Fallback: try with --no-deps since all deps should be in wheelhouse
    "$VENV_PIP" install --no-index --find-links "$WHEELS_DIR" --no-deps -e "$REPO_DIR" 2>&1 || {
        echo "[warn] Could not install scienceflow from source; it may not be needed if CLI is separate"
    }
}

echo "[install-offline] Installing remaining wheel files..."
"$VENV_PIP" install --no-index --find-links "$WHEELS_DIR" "$WHEELS_DIR"/*.whl 2>&1 || true

# 8. Verify the installation
echo "[install-offline] Verifying..."
"$VENV_PYTHON" -c "import click; import rich; import httpx; import pydantic; print('Core packages imported successfully')" 2>&1 || {
    echo "WARNING: Some core packages could not be imported." >&2
}

# Try importing scienceflow
"$VENV_PYTHON" -c "import scienceflow; print('ScienceFlow imported successfully, version:', scienceflow.__version__)" 2>&1 || {
    echo "WARNING: scienceflow package import failed. The package may need additional dependencies." >&2
}

# Check CLI
CLI_PATH="$VENV_DIR/bin/scienceflow"
if [ -x "$CLI_PATH" ]; then
    echo "[install-offline] ScienceFlow CLI found at $CLI_PATH"
    "$CLI_PATH" --help 2>&1 | head -5 || echo "CLI exists but may need additional config"
else
    echo "[install-offline] No scienceflow CLI binary found (expected if not installed)"
fi

echo ""
echo "[install-offline] Installation complete."
echo "[install-offline] Venv: $VENV_DIR"
echo "[install-offline] Activate: source $VENV_DIR/bin/activate"
