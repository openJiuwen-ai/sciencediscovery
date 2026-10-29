# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Identify scoring inputs without changing the upstream dataset manifest."""
import hashlib
import json
from pathlib import Path

MANIFEST = Path(__file__).with_name('manifest.json')


def rubric_identity(path, case_id=None):
    data = Path(path).read_bytes()
    oid = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
    manifest = json.loads(MANIFEST.read_text())
    matches = [task['id'] for task in manifest['tasks']
               if (case_id is None or task['id'] == case_id)
               and any(f['path'] == 'tests/rubric.txt' and f['oid'] == oid
                       and f['bytes'] == len(data) for f in task['files'])]
    if case_id is not None and not matches:
        raise ValueError(f'Official rubric pin mismatch: {case_id}')
    return {'channel': 'official' if matches else 'diagnostic',
            'version': f"upstream-{manifest['revision']}" if matches else 'unregistered',
            'git_blob_oid': oid, 'sha256': hashlib.sha256(data).hexdigest()}
