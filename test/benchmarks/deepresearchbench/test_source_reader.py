# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import unittest
from unittest.mock import Mock, patch
import requests
from source_reader import read_source


class SourceReaderTests(unittest.TestCase):
    def response(self, status=200, content="evidence"):
        response = Mock(status_code=status)
        response.json.return_value = {"data": {"title": "Title", "description": "Description", "content": content}}
        if status >= 400:
            response.raise_for_status.side_effect = requests.HTTPError(response=response)
        return response

    def test_success_retains_content_headers_timeout_and_only_caches_source_bytes(self):
        response = self.response()
        cache, diagnostic = {}, {}
        with patch("requests.get", return_value=response) as get:
            content = read_source("https://example.org", "fixture", cache=cache, diagnostic=diagnostic)
            self.assertEqual(content, "Title\n\nDescription\n\nevidence")
            self.assertEqual(read_source("https://example.org", "fixture", cache=cache), content)
        self.assertEqual(get.call_count, 1)
        self.assertEqual(get.call_args.kwargs["headers"]["Authorization"], "fixture")
        self.assertEqual(get.call_args.kwargs["timeout"], (15, 90))
        self.assertEqual(diagnostic, {"attempts": 1, "cache_hit": False, "errors": []})
        response.close.assert_called_once()

    def test_transient_timeout_or_gateway_error_retries_only_once(self):
        for first in [requests.ReadTimeout(), self.response(502), self.response(429)]:
            diagnostic = {}
            with self.subTest(first=type(first).__name__), patch("requests.get", side_effect=[first, self.response()]) as get, patch("source_reader.time.sleep"):
                self.assertIn("evidence", read_source("https://example.org", "fixture", diagnostic=diagnostic))
                self.assertEqual(get.call_count, 2)
                self.assertEqual(diagnostic["attempts"], 2)

    def test_persistent_failure_is_unknown_and_does_not_pollute_content_cache(self):
        from evaluate import fact_metrics
        cache = {}
        with patch("requests.get", side_effect=requests.ReadTimeout()), patch("source_reader.time.sleep"):
            with self.assertRaises(requests.ReadTimeout):
                read_source("https://example.org", "fixture", cache=cache)
        self.assertEqual(cache, {})
        result = fact_metrics({"url": {"facts": ["claim"], "validate_error": "ReadTimeout"}})
        self.assertEqual(result["unknown"], 1)
        self.assertEqual(result["verification_coverage"], 0)

    def test_nontransient_http_errors_and_empty_sources_are_not_retried(self):
        for response, expected in [(self.response(401), requests.HTTPError), (self.response(404), requests.HTTPError), (self.response(content=""), ValueError)]:
            with self.subTest(expected=expected), patch("requests.get", return_value=response) as get:
                with self.assertRaises(expected):
                    read_source("https://example.org", "fixture")
                self.assertEqual(get.call_count, 1)
                response.close.assert_called_once()

    def test_overall_budget_prevents_dispatch_or_retry(self):
        with patch("source_reader.time.monotonic", return_value=100), patch("requests.get") as get:
            with self.assertRaises(requests.Timeout):
                read_source("https://example.org", "fixture", deadline=99)
            get.assert_not_called()
        clock = [0]
        def slow(*args, **kwargs):
            clock[0] = 10
            raise requests.ReadTimeout()
        with patch("source_reader.time.monotonic", side_effect=lambda: clock[0]), patch("requests.get", side_effect=slow) as get:
            with self.assertRaises(requests.ReadTimeout):
                read_source("https://example.org", "fixture", deadline=10)
            self.assertEqual(get.call_count, 1)
            connect, read = get.call_args.kwargs["timeout"]
            self.assertLessEqual(connect + read, 10)


if __name__ == "__main__":
    unittest.main()
