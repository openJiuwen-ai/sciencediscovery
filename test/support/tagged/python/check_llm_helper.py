# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Regression checks for the Python assertion transport, called by selftest.mjs."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest

from science_tags import CURRENT
from science_llm import llm_assert

ENV = {'CI_ALLOW_REAL': '1', 'E2E_JUDGE_BASE_URL': 'http://127.0.0.1/v1',
       'E2E_JUDGE_MODEL': 'test-model', 'E2E_JUDGE_TOKEN': 'NOT_A_REAL_SECRET'}


def reply(passed=True, reason='Criterion satisfied'):
    return {'choices': [{'message': {'content': json.dumps({'criteria': [
        {'id': 'criterion-1', 'pass': passed, 'reason': reason}]})}}]}


class LlmHelperTests(unittest.TestCase):
    def setUp(self):
        self.context = {'entry': {'id': 'unit', 'tags': ['judge:llm']}, 'judge_calls': 0, 'evidence': []}
        self.token = CURRENT.set(self.context)

    def tearDown(self):
        CURRENT.reset(self.token)

    def test_valid_result_records_evidence(self):
        result = llm_assert('a report', ['Artifact is identified'], env=ENV, transport=lambda *args: reply())
        self.assertEqual(result['model'], 'test-model')
        self.assertEqual(self.context['judge_calls'], 1)

    def test_false_and_nonboolean_verdicts_fail(self):
        for value in [False, 'true', 1]:
            with self.subTest(value=value), self.assertRaises(AssertionError):
                llm_assert('a report', ['x'], env=ENV, transport=lambda *args: reply(value))

    def test_missing_evidence_or_credentials_prevents_transport(self):
        def forbidden(*args):
            self.fail('Transport must not be called')
        with self.assertRaises(AssertionError):
            llm_assert('', ['x'], env=ENV, transport=forbidden)
        with self.assertRaises(AssertionError):
            llm_assert('x', ['x'], env={}, transport=forbidden)

    def test_missing_tag_prevents_transport(self):
        self.context['entry']['tags'] = ['judge:none']
        with self.assertRaisesRegex(AssertionError, 'declare judge:llm'):
            llm_assert('x', ['x'], env=ENV)

    def test_malformed_and_missing_scores_fail(self):
        for obj in [{}, {'choices': [{'message': {'content': '{}'}}]},
                    {'choices': [{'message': {'content': '{"criteria":[]}'}}]}]:
            with self.subTest(obj=obj), self.assertRaises(AssertionError):
                llm_assert('x', ['x'], env=ENV, transport=lambda *args: obj)

    def test_sensitive_reason_is_redacted(self):
        result = llm_assert('x', ['x'], env=ENV, transport=lambda *args: reply(True, ENV['E2E_JUDGE_TOKEN']))
        self.assertNotIn(ENV['E2E_JUDGE_TOKEN'], json.dumps(result))

    def test_input_limit_rejects_instead_of_truncating(self):
        with self.assertRaisesRegex(AssertionError, 'not truncated'):
            llm_assert('x' * 100, ['x'], env=ENV, max_input_characters=10)

    def test_actual_http_transport_against_local_judge(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                body = json.dumps(reply()).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            env = {**ENV, 'E2E_JUDGE_BASE_URL': f'http://127.0.0.1:{server.server_port}/v1'}
            llm_assert('a report', ['x'], env=env)
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0]['model'], 'test-model')
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
