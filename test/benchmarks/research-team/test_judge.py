# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import judge

IDENTITIES = {"artifact/report.md": {"artifact_id": "a", "version_id": "v"}}


def score():
    return {"rubric_version": judge.VERSION, "status": "scored", "evaluated_artifacts": [{"artifact_id": "a", "version_id": "v"}],
            "dimensions": {k: {"level": 3, "score": 999, "reason": "reason", "evidence": ["artifact/report.md"], "defects": [], "uncertainties": []} for k in judge.WEIGHTS},
            "total_score": 999, "critical_findings": [], "verification_scope": "sampled offline evidence", "summary": "summary"}


class JudgeTests(unittest.TestCase):
    def test_program_computes_weights_without_changing_levels(self):
        original = score()
        result = judge.normalize_score(original, IDENTITIES)
        self.assertEqual(result["total_score"], 75)
        self.assertEqual(result["dimensions"]["E"]["score"], 11.25)
        self.assertEqual(original["dimensions"]["E"]["score"], 999)
        self.assertFalse(result["gating"])

    def test_unknown_is_not_zero_or_renormalized(self):
        raw = score()
        raw["status"] = "insufficient_evidence"
        raw["dimensions"]["B"]["level"] = None
        result = judge.normalize_score(raw, IDENTITIES)
        self.assertIsNone(result["total_score"])
        self.assertIsNone(result["dimensions"]["B"]["score"])

    def test_rejects_invented_version_and_invalid_levels(self):
        for value in (True, 2.5, -1, 5, "3"):
            raw = score()
            raw["dimensions"]["A"]["level"] = value
            with self.assertRaises(ValueError):
                judge.normalize_score(raw, IDENTITIES)
        raw = score()
        raw["evaluated_artifacts"][0]["version_id"] = "invented"
        with self.assertRaises(ValueError):
            judge.normalize_score(raw, IDENTITIES)

    def test_small_audit_mutation_and_later_reaudit(self):
        report = {"id": "a", "version": "v", "text": "References\nphenotypic features"}
        calls = [{"report_text": "References\nphenotype features"}, {"report_text": "References\r\nphenotypic features"}]
        result = judge.audit_comparison(report, calls)
        self.assertFalse(result["calls"][0]["exact_match"])
        self.assertTrue(result["calls"][1]["exact_match"])
        self.assertIn("phenotype features", result["calls"][0]["diff_excerpt"])

    def test_tools_are_bounded_registry_reads_not_file_access(self):
        docs = {"artifact/report.md": "012345 needle 6789"}
        self.assertEqual(judge.read_tool(docs, "read_evidence", {"file": "artifact/report.md", "offset": 7, "limit": 6})["text"], "needle")
        with self.assertRaises(KeyError):
            judge.read_tool(docs, "read_evidence", {"file": "/etc/passwd"})
        with self.assertRaises(ValueError):
            judge.read_tool(docs, "read_evidence", {"file": "artifact/report.md", "limit": 30001})

    def test_finalization_keeps_tool_schema_and_saves_invalid_response(self):
        payload = {"audit_comparison": {}}
        requests = []
        def request(body):
            requests.append(copy.deepcopy(body))
            content = "not-json" if len(requests) < 3 else json.dumps(score())
            return {"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": content}}]}
        with tempfile.TemporaryDirectory() as directory, patch.object(judge, "load_evidence", return_value=({}, IDENTITIES, payload)):
            path = Path(directory)
            result = judge.evaluate(path, path, request)
            self.assertEqual(result["total_score"], 75)
            self.assertEqual(requests[-1]["tool_choice"], "none")
            self.assertEqual(requests[-1]["tools"], judge.TOOLS)
            self.assertTrue((path / "response-02.json").exists())

    def test_truncation_is_not_scored_and_raw_response_survives(self):
        def request(_body):
            return {"choices": [{"finish_reason": "length", "message": {"content": ""}}], "usage": {"completion_tokens": 32768}}
        with tempfile.TemporaryDirectory() as directory, patch.object(judge, "load_evidence", return_value=({}, IDENTITIES, {"audit_comparison": {}})):
            path = Path(directory)
            with self.assertRaisesRegex(ValueError, "truncated"):
                judge.evaluate(path, path, request)
            self.assertEqual(json.loads((path / "response-01.json").read_text())["choices"][0]["finish_reason"], "length")


if __name__ == "__main__":
    unittest.main()
