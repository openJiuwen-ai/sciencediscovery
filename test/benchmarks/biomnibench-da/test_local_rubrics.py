# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

import rubrics
import local_scoring
import rescore
from judge import levels


class LocalRubricRegistryTests(unittest.TestCase):
    def test_da_13_3_local_variant_is_pinned_and_non_official(self):
        path = rubrics.local_rubric_path('da-13-3')
        self.assertIsNotNone(path)
        identity = rubrics.rubric_identity(path, 'da-13-3')
        self.assertEqual(identity['channel'], 'local-variant')
        self.assertEqual(identity['version'], 'local-rubric-v1')
        self.assertEqual(identity['clarifies_criteria'], ['4', '5'])
        data = path.read_bytes()
        expected = hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()
        self.assertEqual(identity['git_blob_oid'], expected)

    def test_local_bytes_do_not_satisfy_other_case(self):
        path = rubrics.local_rubric_path('da-13-3')
        with self.assertRaisesRegex(ValueError, 'Local rubric case mismatch'):
            rubrics.rubric_identity(path, 'da-14-1')

    def test_unregistered_case_has_no_local_path(self):
        self.assertIsNone(rubrics.local_rubric_path('da-14-1'))

    def test_local_pin_mismatch_is_hard_error(self):
        variant = dict(rubrics.local_variant_for('da-13-3'))
        variant['sha256'] = '0' * 64
        with patch.object(rubrics, '_load_local_registry', return_value={'variants': [variant]}):
            with self.assertRaisesRegex(ValueError, 'Local rubric pin mismatch'):
                rubrics.local_rubric_path('da-13-3')

    def test_official_only_recovery_rejects_registered_local_rubric(self):
        with self.assertRaisesRegex(ValueError, 'Official rubric required'):
            rubrics.require_official(rubrics.local_rubric_path('da-13-3'), 'da-13-3')

    def test_local_judge_requires_explicit_opt_in_before_provider_call(self):
        with tempfile.TemporaryDirectory() as directory:
            command = [sys.executable, str(Path(__file__).with_name('judge.py')), '--case', 'da-13-3',
                       '--rubric', str(rubrics.local_rubric_path('da-13-3')), '--trace', 'unused', '--answer', 'unused',
                       '--output', str(Path(directory) / 'score.json')]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Official rubric required', result.stderr)

    def test_unmodified_criteria_and_all_weights_match_official_baseline(self):
        # Section hashes from official blob b54c2480ba3da6f95a64fa2a49bd8aa9bdd76082.
        hashes = {'1': '59246b3951a662fb874cb119945129a432ec0f75d71f12d07feeac5319f6cf3f',
                  '2': '08ffc537901b279158f86fc76455dc650c5d22029ea6fda10a392adcff8f817e',
                  '3': 'ec7fab873aac96e97032b1ee325daba5166b1c2acbc2bfcfe7435a05ff6764b1',
                  '6': '952dda56aa63e5044925a615bd351f0fd597b1ec2b0f7ea4337c89944c99e105'}
        text = rubrics.local_rubric_path('da-13-3').read_text()
        sections = dict(re.findall(r'Criterion (\d+):(.*?)(?=\nCriterion \d+:|\Z)', text, re.S))
        for number, digest in hashes.items():
            section = f'Criterion {number}:' + sections[number]
            self.assertEqual(hashlib.sha256(section.strip().encode()).hexdigest(), digest)
        self.assertEqual(levels(text), {str(i): dict(zip('ABC', weights)) for i, weights in enumerate(
            [(15, 8, 0), (15, 7, 0), (25, 12, 0), (27, 13, 0), (18, 9, 0), (0, -5, -10)], 1)})

    def test_local_failure_is_non_gating_and_retains_rubric_identity(self):
        with patch.object(local_scoring, 'local_rubric_path', side_effect=ValueError('tampered pin')), \
             patch.object(local_scoring.subprocess, 'run') as request:
            card = local_scoring.grade_local('da-13-3', 'unused', 'unused', 'unused')
        request.assert_not_called()
        self.assertEqual(card['status'], 'error')
        self.assertFalse(card['gating'])
        self.assertEqual(card['rubric']['version'], 'local-rubric-v1')

    def test_saved_evidence_recovery_exports_real_local_cli_score_separately(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(body)
                content = json.dumps({'criteria': {str(n): {'level': 'A', 'reason': 'Fixture evidence'} for n in range(1, 7)}})
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'content': content}}],
                                            'usage': {'prompt_tokens': 2, 'completion_tokens': 3, 'total_tokens': 5}}).encode())
            def log_message(self, *args):
                pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        real_run = subprocess.run
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                evidence = root / 'saved'
                evidence.mkdir()
                original = {'case_id': 'da-13-3', 'integration_status': 'passed', 'measurements': {'generation_tokens': 100}}
                (evidence / 'benchmark-metrics.json').write_text(json.dumps(original))
                (evidence / 'research-evidence.json').write_text('{"delivery":{"status":"passed"}}')
                for name in ('trace.md', 'answer.txt'):
                    (evidence / name).write_text('Immutable saved fixture')
                attempts = evidence / 'quality-scorecard.attempts'
                attempts.mkdir()
                usage = [{'usage': {'prompt_tokens': 4, 'completion_tokens': 3, 'total_tokens': 7}}]
                (attempts / 'attempts.json').write_text(json.dumps(usage))
                output = root / 'new-evaluation'
                def judge(command, **kwargs):
                    if '--local-variant' in command:
                        return real_run(command, **kwargs)
                    card = Path(command[command.index('--output') + 1])
                    card.write_text('{"status":"scored","score":87,"gating":true}')
                    card.with_suffix('.attempts').mkdir()
                    (card.with_suffix('.attempts') / 'attempts.json').write_text(json.dumps(usage))
                    return subprocess.CompletedProcess(command, 0)
                env = {'BIOMNI_JUDGE_BASE_URL': f'http://127.0.0.1:{server.server_port}',
                       'BIOMNI_JUDGE_MODEL': 'hermetic-fixture', 'BIOMNI_JUDGE_API_KEY': 'test-only'}
                with patch.dict(os.environ, env), patch.object(rescore, 'require_official', return_value={'channel': 'official'}), \
                     patch.object(rescore.subprocess, 'run', side_effect=judge):
                    report = rescore.rescore(evidence, root / 'official-placeholder', output)
                published = json.loads((output / 'benchmark-metrics.json').read_text())
                self.assertEqual(report['evaluation']['score'], 87)
                self.assertEqual(published['measurements']['score'], 87)
                self.assertEqual(published['measurements']['judge_tokens'], 7)
                self.assertEqual(published['measurements']['total_tokens'], 107)
                self.assertEqual(published['local_evaluation']['score'], 100)
                self.assertFalse(published['local_evaluation']['gating'])
                self.assertEqual(published['local_evaluation']['rubric']['channel'], 'local-variant')
                self.assertEqual(published['local_evaluation']['rubric']['version'], 'local-rubric-v1')
                self.assertEqual(len(requests), 1)
                self.assertEqual(requests[0]['temperature'], 0)
                submitted = json.loads(requests[0]['messages'][1]['content'])
                self.assertEqual(submitted['rubric'], rubrics.local_rubric_path('da-13-3').read_text())
                self.assertEqual((evidence / 'answer.txt').read_text(), 'Immutable saved fixture')
                # The real publication projection drops narratives while retaining both scores.
                code = "import {projectMetrics} from './.ci/biomni-gate.mjs'; import {readFileSync} from 'node:fs'; console.log(JSON.stringify(projectMetrics(JSON.parse(readFileSync(process.argv[1])))));"
                projected = real_run(['node', '--input-type=module', '--eval', code, str(output / 'benchmark-metrics.json')],
                                     cwd=Path(__file__).resolve().parents[3], check=True, capture_output=True, text=True)
                doc = json.loads(projected.stdout)
                self.assertEqual(doc['measurements']['score'], 87)
                self.assertEqual(doc['local_evaluation']['score'], 100)
                self.assertNotIn('criteria', doc['local_evaluation'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
