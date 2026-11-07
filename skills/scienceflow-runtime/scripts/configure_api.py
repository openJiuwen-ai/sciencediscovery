#!/usr/bin/env python3
"""Create the upstream ScienceFlow v0.2 model registry from private env vars.

Never place secrets in the published Skill ZIP. This writes a local 0600 file.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import re
import sys

DEFAULT = Path.home() / '.config/scienceflow/models.json'


def parse_env_file(path: Path) -> dict[str, str]:
    values = {}
    for lineno, raw in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[len('export '):]
        m = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)', line)
        if not m:
            raise ValueError(f'Invalid env-file line {lineno}; use KEY=value without shell syntax')
        value = m.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        values[m.group(1)] = value
    return values


def envget(source: dict[str, str], *names: str) -> str:
    return next((source[k] for k in names if source.get(k)), '')


def yes(text: str) -> bool:
    return text.strip().lower() in ('true', '1', 'yes', 'on')


def build_registry(source: dict[str, str]) -> dict:
    model = envget(source, 'SF_MODEL', 'CODE_MODEL')
    url = envget(source, 'SF_BASE_URL', 'CODE_BASE_URL')
    key = envget(source, 'SF_API_KEY', 'CODE_API_KEY')
    feedback_model = envget(source, 'SF_FEEDBACK_MODEL', 'FEEDBACK_MODEL') or model
    feedback_url = envget(source, 'SF_FEEDBACK_BASE_URL', 'FEEDBACK_BASE_URL') or url
    feedback_key = envget(source, 'SF_FEEDBACK_API_KEY', 'FEEDBACK_API_KEY') or key
    if not all((model, url, key, feedback_model, feedback_url, feedback_key)):
        raise ValueError('Provide SF_MODEL, SF_BASE_URL, SF_API_KEY (optional SF_FEEDBACK_*).')
    if not all(u.startswith(('https://', 'http://')) for u in (url, feedback_url)):
        raise ValueError('API URL must be an http(s) URL, usually ending in /v1')
    proxy = yes(envget(source, 'SF_USE_PROXY') or 'false')
    models = {}
    for name in {model, feedback_model}:
        models[name] = {'model': name, 'use_proxy': proxy,
                        'reasoning_replay': 'preserve', 'endpoints': {}}
    models[model]['endpoints']['code'] = [{'url': url, 'key': key}]
    models[feedback_model]['endpoints']['feedback'] = [{'url': feedback_url, 'key': feedback_key}]
    return {'version': 1, 'models': models,
            'defaults': {'code_models': [model], 'feedback_models': [feedback_model],
                         'selection': 'auto'}}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--env-file', type=Path, help='Private KEY=value file (not part of Skill)')
    ap.add_argument('--output', type=Path, default=DEFAULT,
                    help='Default upstream registry ~/.config/scienceflow/models.json')
    ap.add_argument('--force', action='store_true', help='Replace existing registry with a backup')
    args = ap.parse_args()
    values = parse_env_file(args.env_file.expanduser()) if args.env_file else {}
    values.update(os.environ)  # process env overrides private env-file
    registry = build_registry(values)
    path = args.output.expanduser().resolve()
    if path.exists() and not args.force:
        ap.error(f'{path} exists; refusing overwrite. Use --force (creates .bak).')
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        backup = path.with_name(path.name + '.bak')
        if backup.exists():
            ap.error(f'Backup exists at {backup}; move it before overwriting')
        path.rename(backup)
        backup.chmod(0o600)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(registry, f, indent=2, ensure_ascii=False)
            f.write('\n')
    finally:
        path.chmod(0o600)
    print(f'[config OK] Private model registry saved at {path} (mode 0600).')
    print('API keys were not printed. Never add this file to a Skill ZIP or commit it.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError) as e:
        print(f'[config] ERROR: {e}', file=sys.stderr)
        sys.exit(2)
