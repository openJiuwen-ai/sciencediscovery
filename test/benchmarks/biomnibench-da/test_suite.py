# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import importlib.util
from pathlib import Path
import tempfile
import unittest
import json
from unittest.mock import patch

def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

suite = load('suite')
rescore = load('rescore')

class SuiteTests(unittest.TestCase):
    def test_failures_are_deferred_until_all_unattempted_cases(self):
        entries = [{'case': x} for x in ('a', 'b', 'c')]
        latest = {'a': {'exit': 1, 'phase': 'first-pass'}, 'b': {'exit': 0, 'phase': 'first-pass'}}
        first, retry = suite.schedule(entries, latest)
        self.assertEqual(first, [{'case': 'c'}])
        self.assertEqual(retry, [{'case': 'a'}])
        latest['a'] = {'exit': 1, 'phase': 'retry'}
        self.assertEqual(suite.schedule(entries, latest)[1], [])

    def test_cleanup_preserves_evidence_and_only_removes_owned_environments(self):
        with tempfile.TemporaryDirectory() as root:
            owned = Path(root) / 'owned'
            runtime = owned / 'case'
            data = runtime / 'real-standard/data'
            (data / 'envs').mkdir(parents=True)
            (data / 'envs/binary').write_text('replaceable')
            (data / 'run-events').mkdir()
            (data / 'run-events/evidence').write_text('retain')
            suite.reclaim(runtime, owned)
            self.assertFalse((data / 'envs').exists())
            self.assertEqual((data / 'run-events/evidence').read_text(), 'retain')
            with self.assertRaises(ValueError):
                suite.reclaim(owned, owned)

    def test_insufficient_inodes_blocks_before_case_setup(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(RuntimeError):
                suite.check_resources(root, 0, 10**30)

    def test_unknown_judge_attempts_are_not_zero_cost(self):
        usage = {'usage': {'prompt_tokens': 10, 'completion_tokens': 2, 'total_tokens': 12}}
        summary = rescore.usage_summary([{'status': 'error'}, usage])
        self.assertEqual(summary['total'], 12)
        self.assertEqual(summary['unknown_attempts'], 1)
        self.assertFalse(summary['complete'])
        self.assertTrue(rescore.usage_summary([usage])['complete'])
        self.assertFalse(rescore.usage_summary([])['complete'])

    def test_rescoring_retains_original_evidence_and_unknown_previous_cost(self):
        with tempfile.TemporaryDirectory() as root:
            evidence = Path(root) / 'evidence'
            evidence.mkdir()
            (evidence / 'benchmark-metrics.json').write_text(json.dumps({'case_id': 'da-14-1', 'measurements': {'generation_tokens': 100}}))
            (evidence / 'research-evidence.json').write_text(json.dumps({'delivery': {'status': 'passed'}}))
            (evidence / 'trace.md').write_text('original trace')
            (evidence / 'answer.txt').write_text('original answer')
            previous = evidence / 'quality-scorecard.attempts'
            previous.mkdir()
            (previous / 'attempts.json').write_text('[{"status":"error"}]')
            output = Path(root) / 'new-evaluation'
            def judge(*args, **kwargs):
                (output / 'quality-scorecard.json').write_text('{"status":"scored","score":90}')
                attempts = output / 'quality-scorecard.attempts'
                attempts.mkdir()
                (attempts / 'attempts.json').write_text('[{"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}]')
                return type('Result', (), {'returncode': 0})()
            with patch.object(rescore.subprocess, 'run', side_effect=judge) as run:
                report = rescore.rescore(evidence, Path(root) / 'rubric', output)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(report['evaluation']['score'], 90)
            self.assertTrue(report['judge_usage']['complete'])
            self.assertFalse(report['all_evaluations_usage_complete'])
            self.assertFalse(report['full_e2e_rerun'])
            self.assertEqual((evidence / 'trace.md').read_text(), 'original trace')

if __name__ == '__main__':
    unittest.main()
