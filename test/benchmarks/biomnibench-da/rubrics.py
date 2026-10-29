# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Identify scoring inputs without changing the upstream dataset manifest."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / 'manifest.json'
LOCAL_REGISTRY = ROOT / 'local-rubrics.json'


def _blob_oid(data: bytes) -> str:
    return hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _load_local_registry():
    if not LOCAL_REGISTRY.is_file():
        return {'variants': []}
    return json.loads(LOCAL_REGISTRY.read_text())


def local_variant_for(case_id: str):
    """Return the registered local variant for a case, or None."""
    matches = [v for v in _load_local_registry().get('variants', []) if v.get('case_id') == case_id]
    if len(matches) > 1:
        raise ValueError(f'Multiple local rubric variants registered for {case_id}')
    return matches[0] if matches else None


def local_rubric_path(case_id: str):
    variant = local_variant_for(case_id)
    if not variant:
        return None
    path = ROOT / variant['path']
    data = path.read_bytes()
    if (len(data) != variant['bytes'] or _blob_oid(data) != variant['git_blob_oid']
            or _sha256(data) != variant['sha256']):
        raise ValueError(f'Local rubric pin mismatch: {case_id}')
    return path


def rubric_identity(path, case_id=None):
    data = Path(path).read_bytes()
    oid = _blob_oid(data)
    digest = _sha256(data)

    # Prefer an explicit local-variant pin when the bytes match a registry entry.
    for variant in _load_local_registry().get('variants', []):
        if (variant.get('git_blob_oid') == oid and variant.get('bytes') == len(data)
                and variant.get('sha256') == digest):
            if case_id is not None and variant.get('case_id') != case_id:
                raise ValueError(f'Local rubric case mismatch: {case_id}')
            return {
                'channel': 'local-variant',
                'version': variant['version'],
                'git_blob_oid': oid,
                'sha256': digest,
                'case_id': variant.get('case_id'),
                'clarifies_criteria': list(variant.get('clarifies_criteria') or []),
            }

    manifest = json.loads(MANIFEST.read_text())
    matches = [task['id'] for task in manifest['tasks']
               if (case_id is None or task['id'] == case_id)
               and any(f['path'] == 'tests/rubric.txt' and f['oid'] == oid
                       and f['bytes'] == len(data) for f in task['files'])]
    if case_id is not None and not matches:
        raise ValueError(f'Official rubric pin mismatch: {case_id}')
    return {
        'channel': 'official' if matches else 'diagnostic',
        'version': f"upstream-{manifest['revision']}" if matches else 'unregistered',
        'git_blob_oid': oid,
        'sha256': digest,
    }
