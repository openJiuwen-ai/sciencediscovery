# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Best-effort local grading of saved inputs, separate from official recovery."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

from rubrics import local_rubric_path, local_variant_for, rubric_identity


def grade_local(case_id, trace, answer, output, python=sys.executable):
    output = Path(output)
    identity = {'channel': 'local-variant'}
    try:
        variant = local_variant_for(case_id)
        if not variant:
            return None
        identity.update(version=variant['version'], git_blob_oid=variant['git_blob_oid'], sha256=variant['sha256'])
        rubric = local_rubric_path(case_id)
        identity = rubric_identity(rubric, case_id)
        with output.with_suffix('.log').open('w') as log:
            result = subprocess.run([python, str(Path(__file__).with_name('judge.py')),
                '--case', case_id, '--local-variant', '--rubric', str(rubric), '--trace', str(trace),
                '--answer', str(answer), '--output', str(output)], stdout=log, stderr=subprocess.STDOUT, timeout=3900)
        if result.returncode:
            raise ValueError(f'Local judge exited {result.returncode}')
        card = json.loads(output.read_text())
        if card.get('status') != 'scored' or card.get('rubric') != identity or card.get('gating') is not False:
            raise ValueError('Invalid local scorecard provenance')
        # Billing remains in the local card/attempt ledger, never official resource metrics.
        return card
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        return {'status': 'error', 'score': None, 'gating': False, 'rubric': identity,
                'error_type': type(error).__name__}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('case', 'trace', 'answer', 'output'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists() or output.with_suffix('.attempts').exists():
        raise FileExistsError('Use a new local output path')
    card = grade_local(args.case, args.trace, args.answer, output)
    if card is not None:
        output.write_text(json.dumps(card, indent=2))


if __name__ == '__main__':
    main()
