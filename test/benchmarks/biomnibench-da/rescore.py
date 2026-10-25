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


def usage_summary(attempts):
    totals = dict(input=0, output=0, total=0, reported_attempts=0, unknown_attempts=0)
    for attempt in attempts:
        usage = attempt.get('usage') or {}
        values = [usage.get(k) for k in ('prompt_tokens', 'completion_tokens', 'total_tokens')]
        if not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in values):
            totals['unknown_attempts'] += 1
            continue
        for key, value in zip(('input', 'output', 'total'), values):
            totals[key] += value
        totals['reported_attempts'] += 1
    totals['complete'] = bool(attempts) and totals['unknown_attempts'] == 0
    return totals


def rescore(evidence_dir, rubric, output, python=sys.executable, prior_evaluations=()):
    evidence_dir, rubric, output = [Path(p).resolve() for p in (evidence_dir, rubric, output)]
    metrics = json.loads((evidence_dir / 'benchmark-metrics.json').read_text())
    evidence = json.loads((evidence_dir / 'research-evidence.json').read_text())
    if not completed_evidence(evidence_dir):
        raise ValueError('Completed analysis evidence and measured generation usage are required')
    output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    with (output / 'judge.log').open('w') as log:
        result = subprocess.run([python, str(Path(__file__).with_name('judge.py')),
                    '--rubric', str(rubric), '--trace', str(evidence_dir / 'trace.md'),
                    '--answer', str(evidence_dir / 'answer.txt'), '--output', str(output / 'quality-scorecard.json')],
                    stdout=log, stderr=subprocess.STDOUT, timeout=3900)
    if result.returncode:
        raise RuntimeError(f'Judge exited {result.returncode}; original analysis retained')
    score = json.loads((output / 'quality-scorecard.json').read_text())
    attempts = json.loads((output / 'quality-scorecard.attempts/attempts.json').read_text())
    usage = usage_summary(attempts)
    original = evidence_dir / 'quality-scorecard.attempts/attempts.json'
    prior = [usage_summary(json.loads(original.read_text())) if original.exists() else usage_summary([])]
    for directory in prior_evaluations:
        path = Path(directory) / 'quality-scorecard.attempts/attempts.json'
        prior.append(usage_summary(json.loads(path.read_text())) if path.exists() else usage_summary([]))
    previous = {key: sum(p[key] for p in prior) for key in ('input', 'output', 'total', 'reported_attempts', 'unknown_attempts')}
    previous['complete'] = all(p['complete'] for p in prior)
    if score.get('status') != 'scored' or not isinstance(score.get('score'), (int, float)) or isinstance(score['score'], bool) or not 0 <= score['score'] <= 100:
        raise ValueError('Judge did not return a valid scored result')
    report = {'case_id': metrics['case_id'], 'integration_status': 'passed',
              'evaluation': score, 'judge_usage': usage, 'previous_evaluation_usage': previous,
              'judge_ms': (time.monotonic() - started) * 1000,
              'mode': 'evaluation-only', 'full_e2e_rerun': False,
              'artifact_sha256': {name: hashlib.sha256((evidence_dir / name).read_bytes()).hexdigest()
                                  for name in ('trace.md', 'answer.txt')},
              'all_evaluations_usage_complete': usage['complete'] and previous is not None and previous['complete']}
    recovered = dict(metrics)
    recovered.pop('error', None)
    recovered['evaluation'] = dict(score, gating=True)
    recovered['measurements'] = dict(metrics['measurements'], score=score['score'], judge_ms=report['judge_ms'],
        judge_tokens=usage['total'], judge_input_tokens=usage['input'], judge_output_tokens=usage['output'],
        total_tokens=metrics['measurements']['generation_tokens'] + usage['total'])
    recovered['judge_usage'] = dict(complete=report['all_evaluations_usage_complete'],
        unknown_attempts=usage['unknown_attempts'] + (previous['unknown_attempts'] if previous else 1),
        reported_attempts=usage['reported_attempts'], scope='final-evaluation-with-prior-accounting-check')
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
                      'usage_complete': report['judge_usage']['complete'], 'full_e2e_rerun': False}))
    return 0 if report['judge_usage']['complete'] else 1


if __name__ == '__main__':
    sys.exit(main())
