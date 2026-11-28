#!/usr/bin/env bash
# prepare-offline.sh — Download wheels for offline ScienceFlow installation
# Run once on a machine with network to populate vendor/wheels/
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$SKILL_DIR/vendor"
WHEELS_DIR="$VENDOR_DIR/wheels"
PYPROJECT="$SKILL_DIR/assets/repo.zip"

# Extract pyproject.toml from repo.zip to get dependencies
# We'll also look for setup.cfg or setup.py in the extracted source
WORK_DIR="${TMPDIR:-/tmp}/scienceflow-prepare-$$"
mkdir -p "$WORK_DIR" "$WHEELS_DIR"
# Find the repo root inside the zip to read pyproject.toml
# If we can't parse it, we rely on a known dependency list
# Since we have assets/repo.zip, let's try to extract pyproject.toml
unzip -q -o "$PYPROJECT" -d "$WORK_DIR" 2>/dev/null || true

# Find the project root (the directory containing pyproject.toml with scienceflow/ subdir)
PROJECT_ROOT=""
for d in "$WORK_DIR"/*/; do
    if [ -f "${d}pyproject.toml" ] && [ -d "${d}scienceflow" ]; then
        PROJECT_ROOT="$d"
        break
    fi
done

echo "[prepare] Using Python: $(python3 --version 2>&1)"

# Unset any proxy that might interfere
unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY

# Official PyPI index — only used during preparation, never during offline install
INDEX_URL="https://pypi.org/simple/"

# Get pip version we'll need
python3 -m pip install --quiet pip setuptools wheel toml packaging 2>/dev/null || true

echo "[prepare] Extracting requirements from pyproject.toml..."
REQUIREMENTS_TXT="$WORK_DIR/requirements.txt"

# Generate a requirements.txt from the project's dependencies
# We'll extract both core and optional dependencies for scienceflow
if [ -n "$PROJECT_ROOT" ]; then
  python3 -c "
import tomllib, sys, os
sys.stdin = open(os.devnull)
try:
    with open('${PROJECT_ROOT}pyproject.toml', 'rb') as f:
        data = tomllib.load(f)
except:
    sys.exit(0)
project = data.get('project', {})
deps = project.get('dependencies', [])
opt_deps = project.get('optional-dependencies', {})
all_deps = deps[:]
for group, items in opt_deps.items():
    all_deps.extend(items)
print('\n'.join(all_deps))
" > "$REQUIREMENTS_TXT" 2>/dev/null || true
fi

# Add core dependencies that we know ScienceFlow needs
cat >> "$REQUIREMENTS_TXT" << 'EOF'
click>=8.1
rich>=13.0
httpx>=0.27
pydantic>=2.0
pyyaml>=6.0
requests>=2.31
typing-extensions>=4.9
platformdirs>=4.0
markdown>=3.5
beautifulsoup4>=4.12
lxml>=5.0
soupsieve>=2.5
cssselect>=1.2
packaging>=23.0
EOF

# Remove duplicates while keeping order
awk '!seen[$0]++' "$REQUIREMENTS_TXT" > "${REQUIREMENTS_TXT}.tmp"
mv "${REQUIREMENTS_TXT}.tmp" "$REQUIREMENTS_TXT"

echo "[prepare] Downloading wheels to $WHEELS_DIR..."
echo "[prepare] Requirements:"
cat "$REQUIREMENTS_TXT"

python3 -m pip download \
    --only-binary=:all: \
    --platform manylinux2014_x86_64 \
    --platform manylinux_2_28_x86_64 \
    --platform linux_x86_64 \
    --python-version 312 \
    --implementation cp \
    -d "$WHEELS_DIR" \
    -r "$REQUIREMENTS_TXT" \
    2>&1 || echo "[warn] Some wheels may not have been downloaded (expected for pure-python)"

# Also download wheel for anymissing pure-python packages by their source
python3 -m pip download \
    --no-binary=:none: \
    -d "$WHEELS_DIR" \
    -r "$REQUIREMENTS_TXT" \
    2>&1 || echo "[warn] Some source distributions may not have been downloaded"

# Clean up temp files
rm -rf "$WORK_DIR"

echo "[prepare] Generating SHA256SUMS..."
cd "$WHEELS_DIR" && sha256sum *.whl 2>/dev/null | sort > "$VENDOR_DIR/SHA256SUMS" || touch "$VENDOR_DIR/SHA256SUMS"

echo "[prepare] Generating offline manifest..."
ls -1 "$WHEELS_DIR"/*.whl 2>/dev/null | sort > "$VENDOR_DIR/offline-manifest.txt" || true

echo "[prepare] Done. Wheel count: $(ls -1 "$WHEELS_DIR"/*.whl 2>/dev/null | wc -l)"
