# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import copy
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import linkage
from scipy.spatial.distance import squareform

from verify import verify_associations, verify_clustering
from judge import score_response


class VerificationTests(unittest.TestCase):
    def test_associations_header_counts_ranking_and_numbers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.csv"
            path.write_text("description\nextra descriptor\nprotein_id,estimate_Percent_Fat,adj.p.value_Percent_Fat,estimate_Breast_Volume,adj.p.value_Breast_Volume\na,1,0.01,3,0.02\nb,-2,0.02,1,0.2\n")
            result = {"phenotypes": {
                "Percent_Fat": {"significant_count": 2, "top": [
                    {"protein_id": "b", "estimate": -2, "adjusted_p": .02},
                    {"protein_id": "a", "estimate": 1, "adjusted_p": .01}]},
                "Breast_Volume": {"significant_count": 1, "top": [{"protein_id": "a", "estimate": 3, "adjusted_p": .02}]}}}
            self.assertEqual(verify_associations(path, result)["rows"], 2)
            mutations = [lambda r: r["phenotypes"]["Percent_Fat"].update(significant_count=1),
                         lambda r: r["phenotypes"]["Percent_Fat"]["top"].reverse(),
                         lambda r: r["phenotypes"]["Breast_Volume"]["top"][0].update(estimate=999),
                         lambda r: r["phenotypes"]["Percent_Fat"]["top"][0].update(protein_id="a")]
            for mutate in mutations:
                bad = copy.deepcopy(result)
                mutate(bad)
                with self.assertRaises(AssertionError):
                    verify_associations(path, bad)

    def test_clustering_recomputed_and_corrupt_results_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.csv"
            frame = pd.DataFrame({"a_score": [1, 2, 4, 8], "b_score": [3, 2, 6, 7], "c_score": [8, 4, 2, 1]})
            frame.to_csv(path, index=False)
            for method in ("spearman", "pearson"):
                corr = frame.corr(method=method).to_numpy()
                result = {"columns": list(frame), "method": method, "missing": "pairwise", "distance": "1-correlation",
                          "correlation": corr.tolist(), "linkage_method": "average",
                          "linkage": linkage(squareform(1 - corr), method="average").tolist()}
                self.assertEqual(verify_clustering(path, result)["selected_scores"], 3)
                swapped = copy.deepcopy(result)
                swapped["linkage"][0][:2] = reversed(swapped["linkage"][0][:2])
                verify_clustering(path, swapped)
                for field in ("correlation", "linkage"):
                    bad = copy.deepcopy(result)
                    bad[field][0][2 if field == "linkage" else 1] += .2
                    with self.assertRaises(AssertionError):
                        verify_clustering(path, bad)

    def test_judge_requires_all_criteria_and_calculates_score_itself(self):
        rubric = "Criterion 1: Analysis\nLevels: A=100 B=50 C=0\nCriterion 2: Reliability\nLevels: A=0 B=-5 C=-10\n"
        result = {"criteria": {"1": {"level": "A", "reason": "valid"}, "2": {"level": "B", "reason": "some unsupported claims"}}}
        self.assertEqual(score_response(result, rubric)["score"], 95)
        del result["criteria"]["2"]
        with self.assertRaises(ValueError):
            score_response(result, rubric)
        with self.assertRaises(ValueError):
            score_response({"criteria": {}}, "unrecognized rubric")


if __name__ == "__main__":
    unittest.main()
