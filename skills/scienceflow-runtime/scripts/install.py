#!/usr/bin/env python3
"""Install vendored ScienceFlow from a ZIP into an isolated, writable workspace.

Only standard library required; no GitHub access and no writes to the Skill tree.
This is a source-offline workflow, NOT a guarantee of offline Python dependencies.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import tomllib
import zipfile

SKILL = Path(__file__).resolve().parents[1]
MAX_ENTRIES = 25000
MAX_UNCOMPRESSED = 300 * 1024 * 1024
PRIVATE_NAMES = {'.env', '.env.local', '.env.production', 'models.json', 'id_rsa', 'id_ed25519', '.netrc', '.pypirc'}
PRIVATE_SUFFIXES = {'.pem', '.p12', '.pfx', '.key'}
OMIT_DIRS = {'.git', '.venv', '__pycache__', '.pytest_cache', 'node_modules', '.mypy_cache'}


def prohibited(name: str) -> bool:
    p = PurePosixPath(name)
    parts = p.parts
    return any(x in OMIT_DIRS for x in parts) or any(
        x in PRIVATE_NAMES or x.startswith('.env.') or x.endswith(tuple(PRIVATE_SUFFIXES))
        for x in parts
    )


def safe_extract(zfile: Path, destination: Path) -> int:
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zfile) as z:
        if len(z.infolist()) > MAX_ENTRIES:
            raise ValueError('Too many source files; archive may not be a clean repository export')
        seen, total, count = set(), 0, 0
        for info in z.infolist():
            name = info.filename.replace('\\', '/')
            path = PurePosixPath(name)
            if (not name or name.startswith('/') or re.match(r'^[a-zA-Z]:', name)
                    or '..' in path.parts or info.flag_bits & 1):
                raise ValueError(f'Unsafe archive path or encrypted entry: {name!r}')
            normalized = str(path)
            if normalized in seen:
                raise ValueError(f'Duplicate archive entry: {name!r}')
            seen.add(normalized)
            mode = (info.external_attr >> 16)
            if stat.S_ISLNK(mode):
                raise ValueError(f'Symlinks are not allowed in source ZIP: {name!r}')
            if prohibited(name) or info.is_dir():
                continue
            total += info.file_size
            if total > MAX_UNCOMPRESSED:
                raise ValueError('Uncompressed source exceeds configured safety limit')
            out = destination.joinpath(*path.parts)
            out.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, out.open('wb') as dst:
                shutil.copyfileobj(src, dst, length=1024 * 1024)
            count += 1
    return count


def find_root(staging: Path) -> Path:
    matches = [p.parent for p in staging.rglob('pyproject.toml')
               if (p.parent / 'scienceflow').is_dir()]
    if len(matches) != 1:
        raise ValueError(f'Expected exactly one ScienceFlow project root, found {len(matches)}. '
                         'Check repo.zip content.')
    return matches[0]


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def repo_version(repo: Path) -> str:
    try:
        return str(tomllib.loads((repo / 'pyproject.toml').read_text())['project']['version'])
    except (KeyError, ValueError, OSError):
        return 'unknown'


def run(cmd: list[str]) -> None:
    print('[install] exec:', ' '.join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def cli_path(venv: Path) -> Path:
    name = 'scienceflow.exe' if os.name == 'nt' else 'scienceflow'
    return venv / ('Scripts' if os.name == 'nt' else 'bin') / name


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--repo-zip', type=Path, default=SKILL / 'assets' / 'repo.zip')
    ap.add_argument('--target', type=Path, default=Path.cwd() / 'sf_runtime')
    ap.add_argument('--python', default=sys.executable, help='Python 3.11–3.13 with venv support')
    ap.add_argument('--installer', choices=('pip', 'uv'), default='pip')
    ap.add_argument('--extras', default='', help='comma-separated extras from upstream pyproject')
    ap.add_argument('--offline', action='store_true', help='no index/network for dependencies')
    ap.add_argument('--wheelhouse', type=Path, help='pre-downloaded compatible wheels/sdists')
    ap.add_argument('--no-install', action='store_true', help='prepare source only, no venv/pip')
    args = ap.parse_args()

    target, source = args.target.expanduser().resolve(), args.repo_zip.expanduser().resolve()
    if target == SKILL or SKILL in target.parents:
        ap.error('Target must be writable and outside the (read-only) Skill directory')
    if not source.is_file():
        ap.error(f'Missing {source}; provide --repo-zip or run package_release.py with your original repo.zip')
    if args.offline and not args.no_install and args.wheelhouse is None:
        ap.error('--offline dependency installation needs --wheelhouse; repo.zip alone is insufficient')
    if args.wheelhouse and not args.wheelhouse.is_dir():
        ap.error('Wheelhouse path must be an existing directory')
    if args.installer == 'uv' and shutil.which('uv') is None and not args.no_install:
        ap.error('uv requested but not installed; use --installer pip')

    target.mkdir(parents=True, exist_ok=True)
    repo, marker = target / 'repo', target / 'install-manifest.json'
    sha = digest(source)
    if repo.exists():
        try:
            prior = json.loads(marker.read_text())
        except (OSError, ValueError):
            prior = {}
        if prior.get('sha256') != sha:
            ap.error(f'{repo} already exists or its source checksum differs. '
                     'Use a new --target to avoid overwriting data.')
        print('[install] identical source already prepared; reusing it')
    else:
        # In ScienceDiscovery, the target is a provenance-tracked Workspace.
        # Creating and then deleting a large .sf-source-* subtree under the
        # target can leave dangling file paths in the Workspace snapshot.
        # The Runner mounts /tmp separately, so stage source there and copy/move
        # only persistent files into target/repo.  TMPDIR might point inside
        # the Workspace; intentionally do not trust it for this operation.
        scratch_root = Path(os.environ.get(
            'SCIENCEFLOW_STAGING_DIR',
            '/tmp' if os.name != 'nt' else tempfile.gettempdir(),
        )).expanduser().resolve()
        if not scratch_root.is_dir():
            ap.error(f'Staging directory does not exist: {scratch_root}')
        if scratch_root == target or target in scratch_root.parents:
            ap.error('Staging directory must be outside the target Workspace')
        if not os.access(scratch_root, os.W_OK):
            ap.error(f'Staging directory is not writable: {scratch_root}')
        with tempfile.TemporaryDirectory(prefix='scienceflow-source-', dir=scratch_root) as td:
            stage = Path(td)
            n = safe_extract(source, stage)
            found = find_root(stage)
            # On separate mounts shutil.move copies the tree, leaving a stable
            # repo at the destination; cleanup happens only in /tmp.
            shutil.move(str(found), str(repo))
            print(f'[install] extracted {n} files into {repo}')
        marker.write_text(json.dumps({
            'source_archive': source.name,
            'sha256': sha,
            'upstream_version': repo_version(repo),
            'upstream_repository': 'https://github.com/science-learner/ScienceFlow',
        }, indent=2) + '\n')
    if args.no_install:
        print('[install] source prepared; skipped Python environment/dependency install')
        return 0

    py = Path(args.python).expanduser()
    check = subprocess.run([str(py), '-c', 'import sys; print(*sys.version_info[:2])'],
                           capture_output=True, text=True, check=True)
    version = tuple(map(int, check.stdout.split()))
    if not ((3, 11) <= version <= (3, 13)):
        ap.error(f'Python {version} unsupported by current ScienceFlow (requires 3.11–3.13)')
    venv = target / '.venv'
    if not (venv / 'pyvenv.cfg').exists():
        run([str(py), '-m', 'venv', str(venv)])
    python_exe = venv / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    package = str(repo) + (f'[{args.extras}]' if args.extras else '')
    if args.installer == 'uv':
        cmd = ['uv', 'pip', 'install', '--python', str(python_exe)]
        if args.offline:
            cmd += ['--offline', '--no-index']
        if args.wheelhouse:
            cmd += ['--find-links', str(args.wheelhouse.resolve())]
        cmd += ['-e', package]
    else:
        cmd = [str(python_exe), '-m', 'pip', 'install', '--no-input', '--disable-pip-version-check']
        if args.offline:
            cmd += ['--no-index']
        if args.wheelhouse:
            cmd += ['--find-links', str(args.wheelhouse.resolve())]
        cmd += ['-e', package]
    try:
        run(cmd)
    except subprocess.CalledProcessError as e:
        print(f'[install] dependency installation failed (exit {e.returncode}). '
              'Source is retained. For restricted networks configure a package index/proxy '
              'or provide compatible offline wheels.', file=sys.stderr)
        return e.returncode or 1
    cli = cli_path(venv)
    print(f'\n[install OK] Source: {repo}\nPython: {python_exe}\nCLI: {cli}')
    if not cli.is_file():
        print('[install] WARN: scienceflow CLI not found; check upstream revision/entrypoint')
    print(f'Next: {sys.executable} {SKILL / "scripts" / "doctor.py"} --target {target}')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, zipfile.BadZipFile) as e:
        print(f'[install] ERROR: {e}', file=sys.stderr)
        sys.exit(2)
