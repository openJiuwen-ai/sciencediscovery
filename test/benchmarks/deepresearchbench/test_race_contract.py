import copy
import json
import unittest
from pathlib import Path
from evaluate import validate_race
from race_contract import ContractClient, canonicalize, DIMS


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.criteria = {"criterions": {d: [{"criterion": d}] for d in DIMS}}
        # Exact mismatch from DRB-59 repeat-3. The new interface identifies it by ID.
        self.criteria["criterions"]["readability"][0]["criterion"] = "Effective Use and Clarity of Visual Aids (e.g., Diagrams, Conceptual Models, Maps)"
        self.raw = {d: [{"criterion_id": f"{d}_01", "criterion": d, "analysis": "evidence", "article_1_score": 8, "article_2_score": 9}] for d in DIMS}
        self.raw["readability"][0]["criterion"] = "Effective Use and Clarity of Visual Aids"

    def test_real_abbreviation_is_canonicalized_without_changing_scores_or_input(self):
        before = copy.deepcopy(self.raw)
        result = canonicalize(self.raw, self.criteria)
        self.assertEqual(result["readability"][0]["criterion"], self.criteria["criterions"]["readability"][0]["criterion"])
        self.assertEqual(result["readability"][0]["article_1_score"], 8)
        self.assertEqual(self.raw, before)

    def test_retained_drb59_response_fails_old_validation_and_recovers_with_ids(self):
        data = json.loads((Path(__file__).parent / "fixtures/drb59-repeat3-contract.json").read_text())
        self.criteria = data["criteria"]
        original = data["response"]
        with self.assertRaisesRegex(ValueError, "readability"):
            validate_race(original, self.criteria)
        corrected = copy.deepcopy(original)
        # Explicit known historical alias, only in this fixture. Runtime has no fuzzy matching.
        alias = {"Effective Use and Clarity of Visual Aids": "Effective Use and Clarity of Visual Aids (e.g., Diagrams, Conceptual Models, Maps)"}
        for dim in DIMS:
            names = {c["criterion"]: f"{dim}_{i:02d}" for i, c in enumerate(self.criteria["criterions"][dim], 1)}
            for row in corrected[dim]:
                row["criterion_id"] = names[alias.get(row["criterion"], row["criterion"])]
        result = json.loads(self.run_client([json.dumps(original), json.dumps(corrected)]))
        validate_race(result, self.criteria)
        self.assertEqual(sum(map(len, result.values())), 26)
        for dim in DIMS:
            for before, after in zip(original[dim], result[dim]):
                for field in ("analysis", "article_1_score", "article_2_score"):
                    self.assertEqual(before[field], after[field])

    def test_missing_duplicate_unknown_and_invalid_score_rejected(self):
        for kind in ("missing", "duplicate", "unknown", "no_id", "invalid", "extra_dim"):
            raw = copy.deepcopy(self.raw)
            if kind == "missing": raw["readability"] = []
            elif kind == "duplicate": raw["readability"] *= 2
            elif kind == "unknown": raw["readability"][0]["criterion_id"] = "invented"
            elif kind == "no_id": del raw["readability"][0]["criterion_id"]
            elif kind == "invalid": raw["readability"][0]["article_1_score"] = True
            else: raw["other"] = []
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                canonicalize(raw, self.criteria)

    def run_client(self, replies):
        self.prompts, self.saved = [], {}
        class Client:
            def generate(_, prompt, *args, **kwargs):
                self.prompts.append(prompt)
                return replies[len(self.prompts)-1]
        return ContractClient(Client(), self.criteria, lambda x: x, lambda name, value: self.saved.update({name: value})).generate("official prompt")

    def test_one_correction_and_no_mutation_of_existing_judgements(self):
        bad = copy.deepcopy(self.raw)
        del bad["readability"][0]["criterion_id"]
        result = json.loads(self.run_client([json.dumps(bad), json.dumps(self.raw)]))
        self.assertEqual(len(self.prompts), 2)
        self.assertIn("race-contract-error-1.json", self.saved)
        self.assertIn("race-normalized.json", self.saved)
        self.assertEqual(result["readability"][0]["article_2_score"], 9)
        changed = copy.deepcopy(self.raw)
        changed["insight"][0]["article_1_score"] = 7
        with self.assertRaisesRegex(ValueError, "changed existing"):
            self.run_client([json.dumps(bad), json.dumps(changed)])

    def test_exhausted_recovery_has_no_normalized_score(self):
        with self.assertRaisesRegex(ValueError, "after one correction"):
            self.run_client(["not json", "not json"])
        self.assertEqual(len(self.prompts), 2)
        self.assertNotIn("race-normalized.json", self.saved)
        self.assertIn("race-contract-error-2.json", self.saved)


if __name__ == "__main__":
    unittest.main()
