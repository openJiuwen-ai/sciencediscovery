#!/usr/bin/env bash
# Unified install & run entry point for ScienceFlow Runtime SKILL.
# Designed for the opencode SKILL evaluation harness.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$HERE"
ACTION="${1:-install}"
shift 2>/dev/null || true

export SF_SKILL_DIR="$SKILL_DIR"

case "$ACTION" in
    install)
        PY="${SF_PYTHON:-python3}"
        TARGET="${SF_TARGET:-$PWD/sf_runtime}"
        exec "$PY" "$SKILL_DIR/scripts/install.py" --target "$TARGET" "$@"
        ;;
    configure)
        if [ -f "$SKILL_DIR/config/api.env" ]; then
            PY="${SF_PYTHON:-python3}"
            TARGET="${SF_TARGET:-$PWD/sf_runtime}"
            exec "$PY" "$SKILL_DIR/scripts/configure_api.py" \
                --env-file "$SKILL_DIR/config/api.env" \
                --output "$TARGET/config_home/scienceflow/models.json" --force
        else
            echo "[sf] No config/api.env found; skipping configure step." >&2
            echo "[sf] You can still run: python scripts/configure_api.py --env-file <your-file> --output <path>" >&2
        fi
        ;;
    configure-from-env)
        # Allow manual env-file specification
        ENV_FILE="${1:-$SKILL_DIR/config/api.env}"
        shift 2>/dev/null || true
        PY="${SF_PYTHON:-python3}"
        TARGET="${SF_TARGET:-$PWD/sf_runtime}"
        exec "$PY" "$SKILL_DIR/scripts/configure_api.py" \
            --env-file "$ENV_FILE" \
            --output "$TARGET/config_home/scienceflow/models.json" --force "$@"
        ;;
    run)
        PY="${SF_PYTHON:-python3}"
        TARGET="${SF_TARGET:-$PWD/sf_runtime}"
        exec "$PY" "$SKILL_DIR/scripts/run.py" --target "$TARGET" "$@"
        ;;
    doctor)
        PY="${SF_PYTHON:-python3}"
        TARGET="${SF_TARGET:-$PWD/sf_runtime}"
        exec "$PY" "$SKILL_DIR/scripts/doctor.py" --target "$TARGET" "$@"
        ;;
    env)
        echo "SF_SKILL_DIR=$SKILL_DIR"
        echo "SF_TARGET=${SF_TARGET:-$PWD/sf_runtime}"
        echo "SF_PYTHON=${SF_PYTHON:-python3}"
        ;;
    *)
        echo "Usage: $0 {install|configure|run|doctor|env} [args...]" >&2
        echo "" >&2
        echo "  install    - Install ScienceFlow into target directory" >&2
        echo "  configure  - Configure API from config/api.env" >&2
        echo "  run        - Run the ScienceFlow CLI" >&2
        echo "  doctor     - Check installation health" >&2
        echo "  env        - Print current environment variables" >&2
        exit 1
        ;;
esac