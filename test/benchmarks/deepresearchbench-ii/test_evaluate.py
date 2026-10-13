# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Hermetic runner/transport contracts: no downloaded upstream, no model tokens."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("drb2_evaluate", Path(__file__).with_name("evaluate.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class EvaluationContract(unittest.TestCase):
    def test_json_strings_are_not_rewritten(self):
        data = {"results": [{"rubric_item": '中文 "quoted" rubric', "score": 1, "reason": "a:b", "evidence": "quote"}]}
        raw = json.dumps(data, ensure_ascii=False)
        self.assertEqual(runner.parse_model_text(raw), (data, True))
        self.assertEqual(runner.parse_model_text('```json\n' + raw + '\n```'), (data, True))
        self.assertEqual(runner.parse_model_text(raw[:-1]), (None, False))

    def execute(self, responses, style="openai", missing=False):
        payloads = []
        rubric = {"info_recall": ["a"], "analysis": ["b"], "presentation": ["c"]}
        official = SimpleNamespace()

        def process(*args, **kwargs):
            for _ in range(3):
                try:
                    official.client.query(SimpleNamespace(text="official prompt"))
                    scores = {k: {v[0]: {"score": 1, "reason": "supported", "evidence": "quote"}} for k, v in rubric.items()}
                    if missing:
                        scores["analysis"] = {}
                    return 1, {"scores": scores}, 11
                except ValueError:
                    pass
            return 1, {"error": "exhausted judge retries"}, 0

        official.process_one_with_chunking = process

        def post(url, **kwargs):
            payloads.append(kwargs["json"])
            status, finish = responses.pop(0)
            return SimpleNamespace(status_code=status, json=lambda: {
                "usage": {"prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 11},
                "choices": [{"finish_reason": finish, "message": {"content": "nonempty"}}]})

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            task = {"idx": 1, "license": "CC BY 4.0", "content": {"rubric": rubric}}
            (root / "tasks_and_rubrics.jsonl").write_text(json.dumps(task))
            (root / "report.md").write_text("a report")
            env = {"E2E_JUDGE_BASE_URL": "https://judge.example/v1", "E2E_JUDGE_MODEL": "test-judge",
                   "E2E_JUDGE_TOKEN": "test-secret", "DRB2_JUDGE_API_STYLE": style,
                   "DRB2_JUDGE_MAX_OUTPUT_TOKENS": "32768"}
            modules = {"run_evaluation": official, "gpt_client": SimpleNamespace(GPTOutput=lambda **kw: SimpleNamespace(**kw)),
                       "requests": SimpleNamespace(post=post)}
            argv = ["evaluate.py", "--upstream", temp, "--id", "1", "--report", str(root / "report.md"), "--output", str(root / "out")]
            with patch.dict(os.environ, env), patch.dict(sys.modules, modules), patch.object(sys, "argv", argv), patch("subprocess.run"):
                code = runner.main()
            result = json.loads((root / "out/scorecard.json").read_text())
            self.assertNotIn("test-secret", json.dumps(result))
            calls = [json.loads(line) for line in (root / "out/judge-calls.jsonl").read_text().splitlines()]
            return code, result, payloads, calls

    def test_complete_score_and_openai_transport(self):
        code, result, payloads, calls = self.execute([(200, "stop")])
        self.assertEqual(code, 0)
        self.assertEqual(result["overall_score"], 100)
        self.assertEqual(payloads[0]["max_completion_tokens"], 32768)
        self.assertEqual(calls[0]["usage"]["total_tokens"], 11)

    def test_truncation_retry_records_both_calls_and_raises_budget(self):
        code, result, payloads, calls = self.execute([(200, "length"), (200, "stop")], "deepseek")
        self.assertEqual(code, 0)
        self.assertEqual([p["max_tokens"] for p in payloads], [32768, 65536])
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["finish_reason"], "length")

    def test_missing_score_is_not_success(self):
        code, result, _, _ = self.execute([(200, "stop")], missing=True)
        self.assertEqual(code, 1)
        self.assertEqual(result["status"], "error")
        self.assertNotIn("overall_score", result)

    def test_failed_requests_remain_unreported_not_zero_usage(self):
        code, result, _, calls = self.execute([(503, None)] * 3)
        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 3)
        self.assertTrue(all("usage" not in c for c in calls))


if __name__ == "__main__":
    unittest.main()
