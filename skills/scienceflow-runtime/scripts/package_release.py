#!/usr/bin/env python3
"""Turn a ScienceFlow source archive + this public Skill into an importable ZIP.

Usage: python scripts/package_release.py --repo-zip /path/repo.zip --output dist/scienceflow-runtime.zip
Never bundles .env, models.json, private keys, virtualenvs, or .git.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import tempfile
import zipfile
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from install import SKILL, digest, find_root, repo_version, safe_extract, prohibited

MAX_IMPORT_ZIP = 25 * 1024 * 1024
MAX_RESOURCE = 10 * 1024 * 1024
MAX_EXPANDED = 50 * 1024 * 1024
MAX_FILES = 500
MAX_DOWNLOAD = 90 * 1024 * 1024
UPSTREAM = 'https://github.com/science-learner/ScienceFlow'


def fetch_github_archive(ref: str, output: Path) -> str:
    """Fetch a source ZIP from the public GitHub repo, never reading private .env.

    Use a full 40-character commit SHA for a reproducible release. Tags/branches
    are accepted for experimentation but may move after the release is built.
    """
    if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', ref)
            or '..' in ref or ref.endswith('/') or ref.startswith('-')):
        raise ValueError('Invalid GitHub ref; provide a commit SHA, tag, or branch')
    pinned = re.fullmatch(r'[a-fA-F0-9]{40}', ref) is not None
    if not pinned:
        print(f'[release] WARNING: {ref!r} is not a 40-character commit SHA; '
              'branch/tag contents may change. Prefer a pinned SHA.', file=sys.stderr)
    url = ('https://codeload.github.com/science-learner/ScienceFlow/zip/'
           + quote(ref, safe='/'))
    request = Request(url, headers={'User-Agent': 'scienceflow-runtime-release-builder/1.1',
                                    'Accept': 'application/zip'})
    try:
        with urlopen(request, timeout=50) as response, output.open('wb') as dest:
            total = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_DOWNLOAD:
                    raise ValueError('Upstream source download exceeds 90 MiB safety limit')
                dest.write(chunk)
    except (URLError, HTTPError, TimeoutError) as e:
        output.unlink(missing_ok=True)
        raise ValueError('Could not download GitHub source. On restricted networks, '
                         'download the repo ZIP on another machine and use --repo-zip. '
                         f'Network error: {type(e).__name__}') from e
    if not zipfile.is_zipfile(output):
        output.unlink(missing_ok=True)
        raise ValueError('GitHub download is not a valid ZIP archive')
    print(f'[release] Source archive fetched from {UPSTREAM} at ref {ref}')
    return ref


def sanitized_repo_zip(original: Path) -> tuple[bytes, dict]:
    with tempfile.TemporaryDirectory(prefix='sf-release-') as tmp:
        stage = Path(tmp)
        count = safe_extract(original, stage)
        root = find_root(stage)
        if not (root / 'LICENSE').is_file():
            raise ValueError('Upstream archive lacks LICENSE; cannot repackage without license review')
        bio = io.BytesIO()
        with zipfile.ZipFile(bio, 'w', zipfile.ZIP_DEFLATED, compresslevel=8) as out:
            for file in sorted(root.rglob('*')):
                if not file.is_file():
                    continue
                relative = file.relative_to(root)
                if prohibited(str(relative)):
                    continue
                out.write(file, str(relative).replace('\\', '/'))
        metadata = {'repository': 'https://github.com/science-learner/ScienceFlow',
                    'input_sha256': digest(original),
                    'sanitized_archive_sha256': hashlib.sha256(bio.getvalue()).hexdigest(),
                    'upstream_version': repo_version(root),
                    'file_count': count,
                    'removed_private_files': 'Excluded .env*, models.json, private keys, caches and VCS metadata'}
        return bio.getvalue(), metadata


def build(output: Path, repo_zip: Path | None, upstream_ref: str) -> dict:
    asset = None
    metadata = None
    if repo_zip is not None:
        asset, metadata = sanitized_repo_zip(repo_zip)
        if len(asset) > MAX_RESOURCE:
            raise ValueError(f'sanitized repo.zip is {len(asset)} bytes, exceeding ScienceDiscovery '
                             f'per-resource cap {MAX_RESOURCE} bytes; use an external source ZIP')
        metadata['upstream_ref'] = upstream_ref or 'unverified (provide --upstream-ref)'
    excluded = {'repo.zip', '.DS_Store'}
    files = [p for p in SKILL.rglob('*') if p.is_file() and
             not any(part in {'.git', '__pycache__', '.venv', 'dist', '.pytest_cache'}
                     for part in p.relative_to(SKILL).parts)
             and p.name not in excluded and p.suffix != '.pyc'
             and not prohibited(str(p.relative_to(SKILL)))]
    if len(files) + int(asset is not None) + int(metadata is not None) > MAX_FILES:
        raise ValueError('Too many Skill files for ScienceDiscovery')
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise FileExistsError(f'Will not overwrite {output}. Delete it or choose another output path.')
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=8) as z:
        for p in sorted(files):
            rel = p.relative_to(SKILL)
            z.write(p, f'{SKILL.name}/{rel.as_posix()}')
        if metadata is not None:
            z.writestr(f'{SKILL.name}/assets/source-manifest.json',
                       json.dumps(metadata, indent=2, ensure_ascii=False) + '\n')
            z.writestr(f'{SKILL.name}/assets/repo.zip', asset, compress_type=zipfile.ZIP_STORED)
    with zipfile.ZipFile(output) as archive:
        expanded = sum(e.file_size for e in archive.infolist())
        if output.stat().st_size > MAX_IMPORT_ZIP or expanded > MAX_EXPANDED:
            output.unlink(missing_ok=True)
            raise ValueError('Import ZIP exceeds ScienceDiscovery upload/expanded limits')
        if any(e.file_size > MAX_RESOURCE for e in archive.infolist()):
            output.unlink(missing_ok=True)
            raise ValueError('An individual Skill resource exceeds 10MiB')
    return {'zip': str(output), 'size': output.stat().st_size,
            'bundled_upstream': asset is not None, 'source': metadata}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    group = ap.add_mutually_exclusive_group()
    group.add_argument('--repo-zip', type=Path, help='User supplied repo.zip (may include .env, stripped)')
    group.add_argument('--template-only', action='store_true', help='Build a tool/template ZIP without upstream')
    group.add_argument('--github-ref', type=str,
                       help='Download source at this ScienceFlow GitHub commit/tag/branch; prefer full 40-char SHA')
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--upstream-ref', help='Record source commit/tag when known')
    args = ap.parse_args()
    if args.repo_zip is None and not args.template_only and not args.github_ref:
        ap.error('Provide --github-ref or --repo-zip for a runnable release, '
                 'or --template-only for a starter package')
    if args.repo_zip is not None and not args.repo_zip.is_file():
        ap.error(f'Source archive not found: {args.repo_zip}')
    if args.github_ref and args.upstream_ref:
        ap.error('--upstream-ref is for local --repo-zip only; --github-ref already records the ref')
    if args.github_ref:
        with tempfile.TemporaryDirectory(prefix='scienceflow-download-') as d:
            source = Path(d) / 'upstream.zip'
            ref = fetch_github_archive(args.github_ref, source)
            result = build(args.output.expanduser().resolve(), source, ref)
    else:
        result = build(args.output.expanduser().resolve(), args.repo_zip,
                       args.upstream_ref or '')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, zipfile.BadZipFile) as e:
        print(f'[release] ERROR: {e}', file=sys.stderr)
        sys.exit(2)
