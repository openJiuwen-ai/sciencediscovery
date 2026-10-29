# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

import repeat_grade
import rubrics


class RepeatGradeTests(unittest.TestCase):
    def test_criterion_noise_counts_and_failures_are_explicit(self):
        def card(level, score):
            return {'status': 'scored', 'score': score, 'criteria': {'1': {'level': level}}}
        result = repeat_grade.summarize([card('A', 15), card('B', 8), card('A', 15)])
        self.assertEqual(result['scores'], [15, 8, 15])
        self.assertEqual(result['criteria']['1']['adjacent_changes'], 2)
        self.assertEqual(result['criteria']['1']['pair_disagreements'], 2)
        self.assertEqual(result['criteria']['1']['pair_comparisons'], 3)
        result = repeat_grade.summarize([card('A', 15), {'status': 'error'}, card('B', 8)])
        self.assertEqual(result['failed'], 1)
        self.assertEqual(result['criteria']['1']['adjacent_comparisons'], 0)
        self.assertEqual(result['criteria']['1']['levels'], ['A', None, 'B'])

    def test_eight_answers_are_snapshotted_and_every_repeat_is_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rubric = b'Criterion 1: Example\nLevels: A=15 B=8 C=0\n'
            oid = hashlib.sha1(f'blob {len(rubric)}\0'.encode() + rubric).hexdigest()
            tasks, rows = [], []
            for case in sorted(repeat_grade.CASES):
                path = root / case / 'tests/rubric.txt'
                path.parent.mkdir(parents=True)
                path.write_bytes(rubric)
                tasks.append({'id': case, 'files': [{'path': 'tests/rubric.txt', 'oid': oid, 'bytes': len(rubric)}]})
                for index in range(4):
                    evidence = root / f'{case}-{index}'
                    evidence.mkdir()
                    for name in ('trace.md', 'answer.txt'):
                        (evidence / name).write_text(f'Original {case} {index} {name}')
                    rows.append({'id': evidence.name, 'case_id': case, 'evidence': evidence.name})
            manifest = root / 'pins.json'
            manifest.write_text(json.dumps({'revision': 'test-revision', 'tasks': tasks}))
            inputs = root / 'inputs.json'
            inputs.write_text(json.dumps({'answers': rows}))
            outputs = []
            def judge(command, **kwargs):
                self.assertEqual(Path(command[1]).name, 'judge.py')
                path = Path(command[command.index('--output') + 1])
                outputs.append(path)
                path.write_text(json.dumps({'status': 'scored', 'score': 15, 'criteria': {'1': {'level': 'A'}}}))
                return subprocess.CompletedProcess(command, 0)
            env = {'BIOMNI_JUDGE_MODEL': 'test-only', 'BIOMNI_JUDGE_BASE_URL': 'http://unused', 'BIOMNI_JUDGE_API_KEY': 'test-only'}
            with patch.object(rubrics, 'MANIFEST', manifest), patch.dict(os.environ, env), patch.object(repeat_grade.subprocess, 'run', side_effect=judge):
                result = repeat_grade.run(inputs, root, root / 'output')
                self.assertEqual(result['status'], 'complete')
                self.assertEqual(len(set(outputs)), 24)
                for row in rows:
                    for name in ('trace.md', 'answer.txt'):
                        self.assertEqual((root / row['evidence'] / name).read_bytes(), (root / 'output' / row['id'] / name).read_bytes())
                with self.assertRaises(FileExistsError):
                    repeat_grade.run(inputs, root, root / 'output')
                path.write_bytes(rubric + b'tampered')
                with self.assertRaisesRegex(ValueError, 'pin mismatch'):
                    repeat_grade.preflight(inputs, root)

    def test_judge_cli_uses_temperature_zero_and_preserves_existing_outputs(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                content = json.dumps({'criteria': {'1': {'level': 'A', 'reason': 'Evidence present'}}})
                body = json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'content': content}}],
                                   'usage': {'prompt_tokens': 2, 'completion_tokens': 3, 'total_tokens': 5}}).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args):
                pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for name, content in [('rubric', 'Criterion 1: Example\nLevels: A=15 B=8 C=0'), ('trace', 'trace'), ('answer', 'answer')]:
                    (root / name).write_text(content)
                env = dict(os.environ, BIOMNI_JUDGE_BASE_URL=f'http://127.0.0.1:{server.server_port}', BIOMNI_JUDGE_API_KEY='test-only', BIOMNI_JUDGE_MODEL='test-only')
                command = [sys.executable, str(Path(__file__).with_name('judge.py')),
                           '--rubric', str(root / 'rubric'), '--trace', str(root / 'trace'), '--answer', str(root / 'answer'), '--output', str(root / 'score.json')]
                first = subprocess.run(command, env=env, capture_output=True)
                self.assertEqual(first.returncode, 0, first.stderr)
                original = (root / 'score.json').read_bytes()
                self.assertEqual(json.loads(original)['rubric']['channel'], 'diagnostic')
                self.assertFalse(json.loads(original)['gating'])
                second = subprocess.run(command, env=env, capture_output=True)
                self.assertNotEqual(second.returncode, 0)
                self.assertEqual((root / 'score.json').read_bytes(), original)
                self.assertEqual(len(requests), 1)
                self.assertEqual(requests[0]['temperature'], 0)
                self.assertTrue((root / 'score.attempts/judge-response.json').exists())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
