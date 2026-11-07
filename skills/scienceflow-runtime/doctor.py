#!/usr/bin/env python3
"""Offline checks for prepared ScienceFlow workspace; never calls provider API."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--target', type=Path, default=Path.cwd() / 'sf_runtime')
    ap.add_argument('--check-cli', action='store_true', help='Run local scienceflow --help')
    args = ap.parse_args()
    root = args.target.expanduser().resolve()
    repo = root / 'repo'
    cli = root / '.venv' / ('Scripts/scienceflow.exe' if os.name == 'nt' else 'bin/scienceflow')
    source_ok = (repo / 'pyproject.toml').is_file() and (repo / 'scienceflow').is_dir()
    print('Source:', 'OK' if source_ok else 'MISSING', repo)
    print('CLI:', 'OK' if cli.is_file() else 'MISSING', cli)
    manifest = root / 'install-manifest.json'
    if manifest.is_file():
        m = json.loads(manifest.read_text())
        print('Upstream version:', m.get('upstream_version', '?'))
        print('Source SHA-256:', m.get('sha256', '?'))
    xdg_config = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config'))
    config = xdg_config / 'scienceflow/models.json'
    print('Model registry:', 'EXISTS' if config.is_file() else 'NOT CONFIGURED', config)
    if config.is_file() and os.name != 'nt' and (config.stat().st_mode & 0o077):
        print('WARNING: model registry has group/other permissions; chmod 600 recommended')
    if args.check_cli and cli.is_file():
        done = subprocess.run([str(cli), '--help'], cwd=repo, capture_output=True, text=True,
                              timeout=45)
        print('CLI --help:', 'OK' if done.returncode == 0 else f'FAILED ({done.returncode})')
        if done.returncode != 0:
            print(done.stderr[-800:])
            return 1
    return 0 if source_ok and cli.is_file() else 1


if __name__ == '__main__':
    sys.exit(main())
