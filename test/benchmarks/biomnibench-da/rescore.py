#!/usr/bin/env python3
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Re-evaluate saved final evidence; never rerun generation or overwrite it."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import hashlib
from rubrics import require_official
from local_scoring import grade_local
from judge_usage import allows_unknown_judge_usage, usage_summary


def completed_evidence(evidence_dir):
    """Only verified delivery with both nonempty scoring inputs is recoverable."""
    root = Path(evidence_dir)
    try:
        metrics = json.loads((root / 'benchmark-metrics.json').read_text())
        evidence = json.loads((root / 'research-evidence.json').read_text())
        return (metrics.get('integration_status') == 'passed'
                and evidence.get('delivery', {}).get('status') == 'passed'
                and bool(metrics.get('measurements'))
                and all((root / name).is_file() and (root / name).read_text().strip()
                        for name in ('trace.md', 'answer.txt')))
    except (OSError, ValueError, TypeError):
        return False


def rescore(evidence_dir, rubric, output, python=sys.executable, prior_evaluations=()):
    evidence_dir, rubric, output = [Path(p).resolve() for p in (evidence_dir, rubric, output)]
    metrics = json.loads((evidence_dir / 'benchmark-metrics.json').read_text())
    evidence = json.loads((evidence_dir / 'research-evidence.json').read_text())
    if not completed_evidence(evidence_dir):
        raise ValueError('Completed analysis evidence and measured generation usage are required')
    # Recovery feeds the release gate: an arbitrary/local rubric cannot replace it.
    require_official(rubric, metrics['case_id'])
    output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    with (output / 'judge.log').open('w') as log:
        result = subprocess.run([python, str(Path(__file__).with_name('judge.py')),
                    '--rubric', str(rubric), '--case', metrics['case_id'], '--trace', str(evidence_dir / 'trace.md'),
                    '--answer', str(evidence_dir / 'answer.txt'), '--output', str(output / 'quality-scorecard.json')],
                    stdout=log, stderr=subprocess.STDOUT, timeout=3900)
    if result.returncode:
        raise RuntimeError(f'Judge exited {result.returncode}; original analysis retained')
    score = json.loads((output / 'quality-scorecard.json').read_text())
    attempts = json.loads((output / 'quality-scorecard.attempts/attempts.json').read_text())
    usage = usage_summary(attempts)
    prior = []
    # Each on-disk attempt ledger counts once, even if supplied twice by a caller.
    directories = dict.fromkeys([evidence_dir, *(Path(p).resolve() for p in prior_evaluations)])
    for directory in directories:
        if directory == output:
            continue  # Current usage is already counted separately below.
        path = directory / 'quality-scorecard.attempts/attempts.json'
        prior.append(usage_summary(json.loads(path.read_text())) if path.exists() else usage_summary([]))
    usage_keys = ('input', 'output', 'total', 'reported_attempts', 'unknown_attempts',
                  'transport_unknown_attempts', 'blocking_unknown_attempts')
    previous = {key: sum(p[key] for p in prior) for key in usage_keys}
    previous['complete'] = all(p['complete'] for p in prior)
    combined = {key: usage[key] + previous[key] for key in usage_keys}
    combined['complete'] = usage['complete'] and previous['complete']
    if score.get('status') != 'scored' or not isinstance(score.get('score'), (int, float)) or isinstance(score['score'], bool) or not 0 <= score['score'] <= 100:
        raise ValueError('Judge did not return a valid scored result')
    report = {'case_id': metrics['case_id'], 'integration_status': 'passed',
              'evaluation': score, 'judge_usage': usage, 'previous_evaluation_usage': previous,
              'judge_ms': (time.monotonic() - started) * 1000,
              'mode': 'evaluation-only', 'full_e2e_rerun': False,
              'artifact_sha256': {name: hashlib.sha256((evidence_dir / name).read_bytes()).hexdigest()
                                  for name in ('trace.md', 'answer.txt')},
              'all_evaluations_usage_complete': combined['complete']}
    report['all_evaluations_usage'] = combined
    recovered = dict(metrics)
    recovered.pop('error', None)
    recovered['evaluation'] = dict(score, gating=True)
    recovered['measurements'] = dict(metrics['measurements'], score=score['score'], judge_ms=report['judge_ms'],
        judge_tokens=combined['total'], judge_input_tokens=combined['input'], judge_output_tokens=combined['output'],
        total_tokens=metrics['measurements']['generation_tokens'] + combined['total'],
        reported_total_tokens=metrics['measurements']['generation_tokens'] + combined['total'],
        total_tokens_basis='complete' if combined['complete'] else 'known-lower-bound')
    recovered['judge_usage'] = dict(combined, scope='all-evaluation-attempts')
    local = grade_local(metrics['case_id'], evidence_dir / 'trace.md', evidence_dir / 'answer.txt',
                        output / 'quality-scorecard.local.json', python)
    if local:
        recovered['local_evaluation'] = report['local_evaluation'] = local
    else:
        recovered.pop('local_evaluation', None)
    (output / 'benchmark-metrics.json').write_text(json.dumps(recovered, indent=2))
    (output / 'evaluation-recovery.json').write_text(json.dumps(report, indent=2))
    # The scored result survives even when billing cannot be reconstructed.
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--rubric', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--prior-evaluation', type=Path, action='append', default=[])
    args = parser.parse_args()
    report = rescore(args.evidence, args.rubric, args.output, prior_evaluations=args.prior_evaluation)
    print(json.dumps({'case': report['case_id'], 'score': report['evaluation']['score'],
                      'score_channel': 'official', 'official_score': report['evaluation']['score'],
                      'local_variant_score': report.get('local_evaluation', {}).get('score'),
                      'local_variant_status': report.get('local_evaluation', {}).get('status', 'unavailable'),
                      'local_rubric_version': report.get('local_evaluation', {}).get('rubric', {}).get('version'),
                      'usage_complete': report['all_evaluations_usage_complete'], 'full_e2e_rerun': False}))
    usage = report['all_evaluations_usage']
    return 0 if usage['complete'] or allows_unknown_judge_usage(usage) else 1


if __name__ == '__main__':
    sys.exit(main())
