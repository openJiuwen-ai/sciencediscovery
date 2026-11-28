#!/usr/bin/env bash
# Backwards-compatible entry point; no assumptions about /skills or /opt.
# bash bootstrap.sh [TARGET_DIR] [other install.py arguments]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-$PWD/sf_runtime}"
if [ "$#" -gt 0 ]; then shift; fi
PY="${SF_PYTHON:-python3}"
exec "$PY" "$HERE/scripts/install.py" --target "$TARGET" "$@"
