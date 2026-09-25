import copy
import math
import json
import os
import tempfile
from types import SimpleNamespace
from pathlib import Path
import unittest
from unittest.mock import patch

from evaluate import DIMS, fact_metrics, gate, preflight, validate_race


class EvaluationTests(unittest.TestCase):
    def test_fact_matches_upstream_denominator_and_exposes_unknowns(self):
        result = fact_metrics({"url": {"facts": ["a", "b", "c"], "validate_res": [
            {"idx": 0, "result": "supported"}, {"idx": 1, "result": "unsupported"}, {"idx": 2, "result": "unknown"}]}})
        self.assertEqual(result["citation_accuracy"], 50)
        self.assertAlmostEqual(result["verification_coverage"], 200 / 3)
        self.assertEqual(result["effective_citations"], 1)

    def test_fact_failed_fetch_is_unknown_not_success(self):
        result = fact_metrics({"url": {"facts": ["a", "b"], "validate_error": "Timeout"}})
        self.assertIsNone(result["citation_accuracy"])
        self.assertEqual(result["unknown"], 2)
        self.assertEqual(result["verification_coverage"], 0)

    def test_no_citations_is_not_success(self):
        result = fact_metrics({})
        self.assertIsNone(result["citation_accuracy"])
        self.assertEqual(result["effective_citations"], 0)

    def test_duplicate_or_missing_fact_verdicts_rejected(self):
        for indices in ([0, 0], [0], [0, 2]):
            with self.subTest(indices=indices), self.assertRaises(ValueError):
                fact_metrics({"url": {"facts": ["a", "b"], "validate_res": [
                    {"idx": i, "result": "supported"} for i in indices]}})

    def test_invalid_fact_verdict_rejected(self):
        with self.assertRaises(ValueError):
            fact_metrics({"url": {"facts": ["a"], "validate_res": [{"idx": 0, "result": "maybe"}]}})

    def test_race_requires_all_criteria_and_finite_scores(self):
        criteria = {"criterions": {d: [{"criterion": d}] for d in DIMS}}
        raw = {d: [{"criterion": d, "article_1_score": 8, "article_2_score": 9}] for d in DIMS}
        validate_race(raw, criteria)
        for score in (math.nan, math.inf, -1, 11, True, "8"):
            bad = copy.deepcopy(raw)
            bad[DIMS[0]][0]["article_1_score"] = score
            with self.subTest(score=score), self.assertRaises(ValueError):
                validate_race(bad, criteria)
        for rows in ([], raw[DIMS[0]] * 2):
            with self.assertRaises(ValueError):
                validate_race({**raw, DIMS[0]: rows}, criteria)

    def test_quality_gates_do_not_hide_partial_evaluation(self):
        thresholds = {"race": 40, "fact": 70, "coverage": 80}
        self.assertEqual(gate({}, thresholds), "blocked")
        result = {"race": {"status": "completed", "overall_score": .48}}
        self.assertEqual(gate(result, thresholds), "partial")
        result["fact"] = {"status": "completed", "citation_accuracy": 100,
                          "verification_coverage": 10, "effective_citations": 1}
        self.assertEqual(gate(result, thresholds), "failed")
        result["fact"]["verification_coverage"] = 90
        self.assertEqual(gate(result, thresholds), "passed")
        result["race"]["overall_score"] = .2
        self.assertEqual(gate(result, thresholds), "failed")

    def test_failed_phase_is_error_and_configured_skip_is_not_error(self):
        from evaluate import main
        for mode, phase in (("race", "race"), ("full", "fact")):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp) / "evaluation"
                def fail(args, result):
                    result["race"] = {"status": "running"} if phase == "race" else {"status": "completed", "overall_score": .5}
                    result["fact"] = {"status": "running"} if phase == "fact" else {"status": "skipped", "reason": "race-only configuration"}
                    raise ValueError("fixture invalid response")
                mask = os.umask(0o077)
                try:
                    with patch("sys.argv", ["evaluate", "--upstream", tmp, "--input", tmp+"/input.json", "--output", str(output), "--mode", mode]), patch("evaluate.evaluate", side_effect=fail):
                        self.assertEqual(main(), 1)
                finally:
                    os.umask(mask)
                result = json.loads((output / "scorecard.json").read_text())
                self.assertEqual(result[phase]["status"], "error")
                self.assertNotIn("not_run", json.dumps(result))
                if phase == "fact": self.assertEqual(result["race"]["overall_score"], .5)
                else: self.assertEqual(result["fact"]["status"], "skipped")
                self.assertIn("fixture invalid response", (output / "evaluation-error.json").read_text())

    def test_missing_credentials_block_preflight(self):
        from evaluate import UPSTREAM_COMMIT
        with patch.dict("os.environ", {}, clear=True), patch("subprocess.check_output", side_effect=[UPSTREAM_COMMIT, ""]):
            with self.assertRaisesRegex(ValueError, "OPENROUTER_API_KEY, JINA_API_KEY"):
                preflight(Path("unused"), "full")

    def test_upstream_changes_block_preflight(self):
        with patch("subprocess.check_output", return_value="wrong"):
            with self.assertRaisesRegex(ValueError, "revision"):
                preflight(Path("unused"), "race")

@unittest.skipUnless(os.environ.get("DRB_UPSTREAM_DIR"), "Pinned evaluator checkout required for offline pipeline integration")
class UpstreamPipelineTests(unittest.TestCase):
    def test_full_pipeline_with_one_contract_correction_and_mock_fetch(self):
        # Actual upstream cleaner/scorer/extractor/deduplicator/validator, no paid calls.
        from evaluate import evaluate
        upstream = Path(os.environ["DRB_UPSTREAM_DIR"]).resolve()
        def row(path):
            return next(json.loads(l) for l in (upstream/path).read_text().splitlines() if json.loads(l)["id"] == 59)
        task = row("data/prompt_data/query.jsonl")
        criteria = row("data/criteria_data/criteria.jsonl")
        scores = {d: [{"criterion_id": f"{d}_{i:02d}", "criterion": c["criterion"], "analysis": "fixture", "article_1_score": 8,
                       "article_2_score": 8} for i, c in enumerate(criteria["criterions"][d], 1)] for d in DIMS}
        article = "# Bird navigation\n" + "Birds integrate multiple cues. " * 30
        missing_id = copy.deepcopy(scores)
        del missing_id["readability"][0]["criterion_id"]
        replies = iter([article, json.dumps(missing_id), json.dumps(scores), json.dumps([
            {"fact": "Magnetic cues guide direction", "url": "https://example.org/source"},
            {"fact": "Stars guide direction", "url": "https://example.org/source"}]),
            "[1,2]", '[{"idx":1,"result":"supported"},{"idx":2,"result":"unsupported"}]'])
        def post(*args, **kwargs):
            return SimpleNamespace(status_code=200, json=lambda: {"choices": [{"message": {"content": next(replies)},
                "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})
        response = SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"data": {"title": "source", "content": "Magnetic cues guide direction."}})
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"LLM_BACKEND": "openai", "OPENAI_API_KEY": "fixture",
                "JINA_API_KEY": "fixture", "RACE_MODEL": "fixture", "CLEAN_MODEL": "fixture", "FACT_MODEL": "fixture"}), \
                patch("requests.post", side_effect=post), patch("requests.get", return_value=response):
            root = Path(tmp)
            source = root/'input.json'
            source.write_text(json.dumps({"id":59,"prompt":task["prompt"],"article":article}))
            result = {}
            evaluate(SimpleNamespace(upstream=upstream, mode="full", input=source, output=root), result)
            self.assertAlmostEqual(result["race"]["overall_score"], .5)
            self.assertEqual(result["fact"]["citation_accuracy"], 50)
            self.assertEqual(result["fact"]["verification_coverage"], 100)
            self.assertEqual(len(result["judge_calls"]), 6)
            self.assertTrue((root / "race-contract-error-1.json").exists())
            self.assertTrue((root / "judge-response-3.json").exists())


if __name__ == "__main__":
    unittest.main()
