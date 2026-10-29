#!/usr/bin/env python3
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Measure judge noise on eight saved inputs; never invoke research generation."""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from judge import levels
from rubrics import rubric_identity

CASES = {'da-13-3', 'da-14-1'}


def summarize(cards):
    """Report transitions and all-pair disagreement, not a best/selected score."""
    scored = [c for c in cards if c.get('status') == 'scored']
    criteria = {}
    if scored:
        for number in scored[0]['criteria']:
            sequence = [c['criteria'][number]['level'] if c.get('status') == 'scored' else None for c in cards]
            valid = [x for x in sequence if x is not None]
            adjacent = [(a, b) for a, b in zip(sequence, sequence[1:]) if a is not None and b is not None]
            pairs = [(a, b) for i, a in enumerate(valid) for b in valid[i + 1:]]
            criteria[number] = {'levels': sequence, 'counts': dict(Counter(valid)),
                                'adjacent_changes': sum(a != b for a, b in adjacent),
                                'adjacent_comparisons': len(adjacent),
                                'pair_disagreements': sum(a != b for a, b in pairs),
                                'pair_comparisons': len(pairs)}
    scores = [c.get('score') if c.get('status') == 'scored' else None for c in cards]
    valid_scores = [x for x in scores if x is not None]
    return {'planned': len(cards), 'scored': len(scored), 'failed': len(cards) - len(scored),
            'scores': scores, 'score_range': [min(valid_scores), max(valid_scores)] if valid_scores else None,
            'criteria': criteria}


def preflight(inputs, data_root):
    rows = json.loads(Path(inputs).read_text())['answers']
    if len(rows) != 8 or Counter(r['case_id'] for r in rows) != Counter({'da-13-3': 4, 'da-14-1': 4}):
        raise ValueError('Exactly four saved answers per case (eight total) are required')
    ids = [r['id'] for r in rows]
    if len(set(ids)) != 8 or any(not isinstance(x, str) or not x or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in x) for x in ids):
        raise ValueError('Answer IDs must be unique safe directory names')
    prepared = []
    for row in rows:
        evidence = (Path(inputs).resolve().parent / row['evidence']).resolve()
        rubric = Path(data_root).resolve() / row['case_id'] / 'tests/rubric.txt'
        identity = rubric_identity(rubric, row['case_id'])
        levels(rubric.read_text())
        files = {name: (evidence / name).read_bytes() for name in ('trace.md', 'answer.txt')}
        if any(not content.strip() for content in files.values()):
            raise ValueError(f"Empty saved input: {row['id']}")
        prepared.append((row, rubric.read_bytes(), identity, files))
    return prepared


def run(inputs, data_root, output, repeats=3, python=sys.executable):
    if repeats < 3:
        raise ValueError('At least three repeats are required')
    prepared = preflight(inputs, data_root)
    for name in ('BIOMNI_JUDGE_MODEL', 'BIOMNI_JUDGE_BASE_URL', 'BIOMNI_JUDGE_API_KEY'):
        if not os.environ.get(name):
            raise ValueError(f'Missing judge configuration: {name}')
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = {'status': 'running', 'mode': 'offline-repeat-grade', 'full_e2e_rerun': False,
              'temperature': 0, 'model': os.environ['BIOMNI_JUDGE_MODEL'], 'repeats': repeats, 'answers': []}
    for row, rubric, identity, files in prepared:
        root = output / row['id']
        root.mkdir()
        (root / 'rubric.txt').write_bytes(rubric)
        for name, content in files.items():
            (root / name).write_bytes(content)
        cards = []
        for index in range(1, repeats + 1):
            attempt = root / f'repeat-{index:02}'
            attempt.mkdir()
            with (attempt / 'judge.log').open('w') as log:
                try:
                    result = subprocess.run([python, str(Path(__file__).with_name('judge.py')),
                        '--case', row['case_id'], '--rubric', str(root / 'rubric.txt'),
                        '--trace', str(root / 'trace.md'), '--answer', str(root / 'answer.txt'),
                        '--output', str(attempt / 'quality-scorecard.json')], stdout=log, stderr=subprocess.STDOUT, timeout=3900)
                    card = json.loads((attempt / 'quality-scorecard.json').read_text())
                    if result.returncode:
                        card = {'status': 'error', 'exit_code': result.returncode}
                except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
                    card = {'status': 'error', 'error_type': type(exc).__name__}
            cards.append(card)
        report['answers'].append({'id': row['id'], 'case_id': row['case_id'], 'rubric': identity,
            'artifact_sha256': {name: hashlib.sha256(content).hexdigest() for name, content in files.items()},
            **summarize(cards)})
        (output / 'repeat-grade.json').write_text(json.dumps(report, indent=2) + '\n')
    report['status'] = 'complete' if all(r['failed'] == 0 for r in report['answers']) else 'incomplete'
    (output / 'repeat-grade.json').write_text(json.dumps(report, indent=2) + '\n')
    (output / 'repeat-grade.md').write_text(render(report))
    return report


def render(report):
    lines = ['# Offline official-rubric repeat grading', '',
             f"Status: {report['status']}; judge: {report['model']}; temperature: 0. No research rerun.", '',
             'All repeats are retained. These diagnostics do not replace formal L5 figures or gate scores.', '',
             '| Answer | Case | Scored / planned | Scores |', '|---|---|---|---|']
    for row in report['answers']:
        lines.append(f"| {row['id']} | {row['case_id']} | {row['scored']} / {row['planned']} | {row['scores']} |")
    lines += ['', '| Answer | Criterion | Levels in repeat order | Adjacent changes / comparisons | Pair disagreements / comparisons |', '|---|---|---|---|---|']
    for row in report['answers']:
        for number, criterion in row['criteria'].items():
            lines.append(f"| {row['id']} | {number} | {criterion['levels']} | {criterion['adjacent_changes']} / {criterion['adjacent_comparisons']} | {criterion['pair_disagreements']} / {criterion['pair_comparisons']} |")
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--repeats', type=int, default=3)
    args = parser.parse_args()
    report = run(args.inputs, args.data_root, args.output, args.repeats)
    print(json.dumps({'status': report['status'], 'answers': len(report['answers']), 'repeats': args.repeats}))
    return 0 if report['status'] == 'complete' else 1


if __name__ == '__main__':
    sys.exit(main())
