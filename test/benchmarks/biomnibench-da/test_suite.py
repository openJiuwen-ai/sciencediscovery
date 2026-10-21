# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import importlib.util
from pathlib import Path
import tempfile
import unittest
import json
from types import SimpleNamespace
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
        latest['a'] = {'exit': 1, 'phase': 'retry-3', 'retry_count': 3}
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
            with patch.object(Path, 'iterdir', return_value=[]):
                suite.reclaim(runtime, owned)
            self.assertFalse((data / 'envs').exists())
            self.assertEqual((data / 'run-events/evidence').read_text(), 'retain')
            with self.assertRaises(ValueError):
                suite.reclaim(owned, owned)

    def test_insufficient_inodes_blocks_before_case_setup(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(suite.os, 'statvfs', create=True) as vfs, patch.object(suite.shutil, 'disk_usage') as disk:
                vfs.return_value.f_favail = 1
                disk.return_value.free = 1000000
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
            (evidence / 'benchmark-metrics.json').write_text(json.dumps({'case_id': 'da-14-1', 'integration_status': 'passed', 'measurements': {'generation_tokens': 100}}))
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
            # An intervening evaluation with unknown usage must not disappear.
            (previous / 'attempts.json').write_text('[{"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}]')
            failed = Path(root) / 'failed-evaluation'
            failed.mkdir()
            output = Path(root) / 'third-evaluation'
            with patch.object(rescore.subprocess, 'run', side_effect=judge):
                report = rescore.rescore(evidence, Path(root) / 'rubric', output, prior_evaluations=[failed])
            self.assertFalse(report['all_evaluations_usage_complete'])

    def test_failures_continue_first_pass_then_three_retries_and_resume_stops(self):
        entries = [{'case': x} for x in ('a', 'b', 'c')]
        history, latest, order = [], {}, []
        def attempt(entry, row, previous):
            order.append((entry['case'], row['retry_count']))
            if entry['case'] == 'a':
                raise OSError('temporary preparation failure')
            return {'exit': 0, 'completed': True}
        suite.run_deferred(entries, latest, history, attempt, lambda row: None)
        self.assertEqual(order, [('a', 0), ('b', 0), ('c', 0), ('a', 1), ('a', 2), ('a', 3)])
        self.assertEqual(latest['a']['retry_count'], 3)
        self.assertIn('OSError', latest['a']['reason'])
        suite.run_deferred(entries, latest, history, attempt, lambda row: None)
        self.assertEqual(len(order), 6)

    def test_recovery_modes_share_counter_and_stop_at_first_valid_result(self):
        entries, latest, history = [{'case': 'a'}], {}, []
        def attempt(entry, row, previous):
            n = row['retry_count']
            return {'exit': 0 if n == 2 else 1, 'completed': n == 2,
                    'mode': 'end-to-end' if n < 2 else 'evaluation-only'}
        suite.run_deferred(entries, latest, history, attempt, lambda row: None)
        self.assertEqual([r['retry_count'] for r in history], [0, 1, 2])
        self.assertEqual(latest['a']['mode'], 'evaluation-only')

    def test_evaluation_recovery_requires_both_nonempty_artifacts_and_delivery(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            (path / 'benchmark-metrics.json').write_text(json.dumps({
                'case_id': 'a', 'integration_status': 'passed', 'measurements': {'generation_tokens': 10}}))
            (path / 'research-evidence.json').write_text('{"delivery":{"status":"passed"}}')
            (path / 'trace.md').write_text('trace')
            self.assertIsNone(suite.recoverable_evidence(path, 'a'))
            (path / 'answer.txt').write_text('answer')
            self.assertEqual(suite.recoverable_evidence(path, 'a'), path)
            (path / 'answer.txt').write_text(' ')
            self.assertIsNone(suite.recoverable_evidence(path, 'a'))

    def test_run_case_retries_only_evaluation_for_any_completed_research_failure(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            evidence = root / 'results/cases/a/first-pass/evidence'
            evidence.mkdir(parents=True)
            (evidence / 'benchmark-metrics.json').write_text(json.dumps({
                'case_id': 'a', 'integration_status': 'passed', 'measurements': {'generation_tokens': 10},
                'evaluation': {'status': 'error'}, 'error': 'Invalid judge JSON'}))
            (evidence / 'research-evidence.json').write_text('{"delivery":{"status":"passed"}}')
            (evidence / 'trace.md').write_text('trace')
            (evidence / 'answer.txt').write_text('answer')
            args = SimpleNamespace(results=root / 'results', runtime=root / 'runtime', data_root=root / 'data',
                python='python', min_free_gib=1, min_free_inodes=1, idle_seconds=10)
            def execute(command, *args):
                self.assertIn('rescore.py', command[1])
                output = Path(command[command.index('--output') + 1]); output.mkdir()
                (output / 'benchmark-metrics.json').write_text(json.dumps({
                    'case_id': 'a', 'integration_status': 'passed', 'evaluation': {'status': 'scored', 'score': 70},
                    'judge_usage': {'complete': True}}))
                return 0
            row = {'phase': 'retry-1'}
            with patch.object(suite, 'execute', side_effect=execute) as run, patch.object(suite, 'check_resources'), patch.object(suite, 'reclaim'):
                result = suite.run_case(args, {}, [], {'case': 'a'}, row, {'exit': 1})
            self.assertEqual(run.call_count, 1)
            self.assertEqual(result['mode'], 'evaluation-only')
            self.assertEqual(result['exit'], 0)
            self.assertTrue(result['completed'])

    def test_run_case_research_failure_downloads_and_runs_without_stopping_other_cases(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            args = SimpleNamespace(results=root / 'results', runtime=root / 'runtime', data_root=root / 'data',
                python='python', min_free_gib=1, min_free_inodes=1, idle_seconds=10)
            with patch.object(suite, 'execute', side_effect=[0, 124]) as run, patch.object(suite, 'check_resources'), patch.object(suite, 'reclaim'):
                result = suite.run_case(args, {}, [], {'case': 'a', 'shard': 'research-1'}, {'phase': 'retry-1'}, {'exit': 1})
            self.assertEqual(run.call_count, 2)
            self.assertEqual(result['mode'], 'end-to-end')
            self.assertEqual(result['failure_stage'], 'research')
            self.assertFalse(result['completed'])

    def test_attempt_costs_count_generation_once_and_keep_failed_judge_usage(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            history = []
            for n, mode in enumerate(('end-to-end', 'evaluation-only')):
                directory = root / str(n)
                directory.mkdir()
                metrics = directory / 'benchmark-metrics.json'
                metrics.write_text('{"measurements":{"generation_tokens":100}}')
                attempts = directory / 'quality-scorecard.attempts'
                attempts.mkdir()
                (attempts / 'attempts.json').write_text('[{"usage":{"total_tokens":12}},{"status":"error"}]')
                history.append({'mode': mode, 'metrics_path': str(metrics), 'attempt_dir': str(directory), 'started': 1, 'finished': 3})
            costs = suite.attempt_costs(history)
            self.assertEqual(costs['known_generation_tokens'], 100)
            self.assertEqual(costs['known_judge_tokens'], 24)
            self.assertEqual(costs['unknown_judge_attempts'], 2)
            self.assertEqual(costs['sum_attempt_wall_seconds'], 4)

if __name__ == '__main__':
    unittest.main()
