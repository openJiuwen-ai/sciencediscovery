# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from urllib.error import HTTPError, URLError

from judge_retry import judge_with_retries

spec = importlib.util.spec_from_file_location('puct_judge', Path(__file__).parent / 'evolve-compression/judge.py')
puct = importlib.util.module_from_spec(spec)
spec.loader.exec_module(puct)


def response(content='{"score": 77}', finish='stop'):
    return {'choices': [{'finish_reason': finish, 'message': {'content': content}}],
            'usage': {'completion_tokens': 8192}}


class JudgeRetryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.output = Path(self.tmp.name) / 'attempts'
        self.body = {'model': 'test', 'messages': [{'role': 'user', 'content': 'frozen evidence'}]}
        self.sleep = Mock()

    def run_judge(self, request):
        return judge_with_retries(self.body, request, json.loads, self.output, sleep=self.sleep)

    def test_truncation_retries_same_evidence_and_stops_at_first_valid_score(self):
        request = Mock(side_effect=[response('', 'length'), response(), response('{"score":100}')])
        result, _ = self.run_judge(request)
        self.assertEqual(result['score'], 77)
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args_list[0], request.call_args_list[1])
        self.assertEqual(request.call_args.args[0]['max_tokens'], 65536)
        self.assertNotIn('max_tokens', self.body)
        self.assertEqual(json.loads((self.output / 'response-01.json').read_text()), response('', 'length'))
        self.assertEqual(result['judge_recovery']['attempt'], 2)

    def test_invalid_json_exhausts_exactly_three_retries(self):
        request = Mock(return_value=response('invalid'))
        with self.assertRaisesRegex(ValueError, 'after 4 attempt'):
            self.run_judge(request)
        self.assertEqual(request.call_count, 4)
        self.assertEqual(len(list(self.output.glob('response-*.json'))), 4)
        self.assertEqual(len(json.loads((self.output / 'attempts.json').read_text())), 4)
        self.assertEqual([c.args[0] for c in self.sleep.call_args_list], [5, 10, 15])

    def test_payment_failure_does_not_retry_or_record_sensitive_http_message(self):
        request = Mock(side_effect=HTTPError('https://provider', 402, 'secret', {}, None))
        with self.assertRaisesRegex(ValueError, 'HTTP 402'):
            self.run_judge(request)
        self.assertEqual(request.call_count, 1)
        self.assertNotIn('secret', (self.output / 'attempts.json').read_text())
        self.sleep.assert_not_called()

    def test_transient_transport_errors_retry(self):
        request = Mock(side_effect=[URLError('connection reset'),
                       HTTPError('https://provider', 503, 'unavailable', {}, None), response()])
        result, _ = self.run_judge(request)
        self.assertEqual(result['judge_recovery']['attempt'], 3)

    def test_existing_attempts_cannot_be_overwritten(self):
        self.run_judge(Mock(return_value=response()))
        with self.assertRaises(FileExistsError):
            self.run_judge(Mock(return_value=response()))

    def test_puct_score_contract_is_not_relaxed(self):
        dims = {key: {'rating': 3, 'reason': 'supported', 'evidence': 'result.py:1'} for key in puct.rubric}
        self.assertEqual(puct.validate(json.dumps({'dimensions': dims}))['total_score'], 75)
        dims['correctness']['rating'] = True
        with self.assertRaises(ValueError):
            puct.validate(json.dumps({'dimensions': dims}))
        del dims['correctness']
        with self.assertRaises(ValueError):
            puct.validate(json.dumps({'dimensions': dims}))


if __name__ == '__main__':
    unittest.main()
