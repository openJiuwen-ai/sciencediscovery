#!/usr/bin/env python3
"""Launch the installed ScienceFlow CLI with arguments, no shell interpolation.

Auto-detects the CLI binary across multiple locations. Can also be invoked
via the unified entry point:

  install.sh -- run --help
  python scripts/run.py --target ./sf_runtime -- tui
"""
from __future__ import annotations
import argparse
import os
from pathlib import Path
import subprocess
import sys


def find_cli(root: Path, repo: Path) -> Path:
    candidates = [
        root / 'repo' / '.venv' / ('Scripts/scienceflow.exe' if os.name == 'nt' else 'bin/scienceflow'),
        root / '.venv' / ('Scripts/scienceflow.exe' if os.name == 'nt' else 'bin/scienceflow'),
        root / 'bin/scienceflow',
        root / 'scienceflow.sh',
    ]
    for c in candidates:
        if c.is_file():
            return c
    # Also search common locations
    for venv_dir in root.rglob('.venv'):
        cli_path = venv_dir / ('Scripts/scienceflow.exe' if os.name == 'nt' else 'bin/scienceflow')
        if cli_path.is_file():
            return cli_path
    # Check if scienceflow is on PATH
    import shutil
    which = shutil.which('scienceflow')
    if which:
        return Path(which)
    raise FileNotFoundError(
        f'CLI not found in target: {root}. '
        'Run install first or specify --target pointing to an installed ScienceFlow directory.'
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--target', type=Path, default=Path.cwd() / 'sf_runtime')
    ap.add_argument('--cwd', type=Path, help='Working directory for the CLI (default: target)')
    ap.add_argument('args', nargs=argparse.REMAINDER)
    p = ap.parse_args()
    root = p.target.expanduser().resolve()
    try:
        cli = find_cli(root, root / 'repo')
    except FileNotFoundError as e:
        ap.error(str(e))
    args = p.args[1:] if p.args and p.args[0] == '--' else p.args
    if not args:
        args = ['--help']
    cwd = p.cwd.expanduser().resolve() if p.cwd else root
    return subprocess.run([str(cli), *args], cwd=cwd, check=False).returncode


if __name__ == '__main__':
    sys.exit(main())
