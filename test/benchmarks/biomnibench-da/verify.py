#!/usr/bin/env python3
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Independent numeric checks. Never execute agent-generated code on the test host."""
import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import is_valid_linkage, linkage
from scipy.spatial.distance import squareform


def load_associations(path):
    # Locate the actual header: upstream instruction and rubric disagree on skiprows.
    for offset, line in enumerate(Path(path).read_text(encoding="utf-8-sig").splitlines()[:20]):
        if "protein_id" in line and "estimate_Percent_Fat" in line:
            return pd.read_csv(path, skiprows=offset)
    raise ValueError("Association CSV header not found")


def verify_associations(path, result):
    df = load_associations(path)
    assert not df["protein_id"].duplicated().any(), "Ambiguous duplicate protein IDs"
    counts = {}
    for phenotype in ("Percent_Fat", "Breast_Volume"):
        effect, p = f"estimate_{phenotype}", f"adj.p.value_{phenotype}"
        df[effect] = pd.to_numeric(df[effect], errors="raise")
        df[p] = pd.to_numeric(df[p], errors="raise")
        selected = df.loc[(df[p] < .05) & df[effect].notna()].copy()
        selected["magnitude"] = selected[effect].abs()
        selected = selected.sort_values("magnitude", ascending=False)
        actual = result["phenotypes"][phenotype]
        assert type(actual["significant_count"]) is int and actual["significant_count"] == len(selected), "Wrong significant count"
        top = actual["top"]
        assert len(top) == min(10, len(selected)), "Incomplete top associations"
        assert len({r["protein_id"] for r in top}) == len(top), "Duplicate top proteins"
        magnitudes = []
        for row in top:
            found = selected.loc[selected["protein_id"].astype(str) == row["protein_id"]]
            assert len(found) == 1, "Non-significant or unknown protein"
            expected = found.iloc[0]
            for key, col in (("estimate", effect), ("adjusted_p", p)):
                assert type(row[key]) in (int, float) and math.isfinite(row[key])
                assert math.isclose(row[key], expected[col], rel_tol=1e-5, abs_tol=1e-10), f"Wrong {key}"
            magnitudes.append(abs(row["estimate"]))
        # Allows legitimate ties, but not cherry-picking weak associations.
        assert np.allclose(magnitudes, selected["magnitude"].head(10), rtol=1e-5, atol=1e-10), "Wrong ranking"
        counts[phenotype] = len(selected)
    return {"rows": len(df), "significant_counts": counts}


def verify_clustering(path, result):
    df = pd.read_csv(path)
    cols = result["columns"]
    assert 2 <= len(cols) <= 69 and len(set(cols)) == len(cols), "Invalid score selection"
    assert all(isinstance(c, str) and c in df.columns for c in cols), "Unknown feature"
    values = df[cols].apply(pd.to_numeric, errors="raise")
    assert result["missing"] in ("pairwise", "complete")
    if result["missing"] == "complete":
        values = values.dropna()
    assert result["method"] in ("pearson", "spearman")
    expected = values.corr(method=result["method"]).to_numpy()
    actual = np.asarray(result["correlation"], dtype=float)
    assert actual.shape == expected.shape and np.isfinite(actual).all(), "Invalid correlation matrix"
    assert np.allclose(actual, expected, rtol=1e-5, atol=1e-6), "Correlation does not match input data"
    assert result["distance"] == "1-correlation"
    assert result["linkage_method"] in ("average", "complete", "single", "ward")
    distances = np.clip(1 - expected, 0, 2)
    np.fill_diagonal(distances, 0)
    predicted = linkage(squareform(distances, checks=False), method=result["linkage_method"])
    reported = np.asarray(result["linkage"], dtype=float)
    assert reported.shape == (len(cols) - 1, 4) and is_valid_linkage(reported), "Invalid linkage"
    # Cophenetic matrices ignore left/right child swaps and cluster label numbering.
    from scipy.cluster.hierarchy import cophenet
    assert np.allclose(cophenet(reported), cophenet(predicted), rtol=1e-5, atol=1e-6), "Linkage does not match correlations"
    return {"rows": len(df), "selected_scores": len(cols), "rubric_target_scores": 21,
            "method": result["method"], "note": "Feature selection and scientific method suitability are scored separately by the rubric judge."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", choices=["da-13-3", "da-14-1"], required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--result", required=True)
    args = parser.parse_args()
    result = json.loads(Path(args.result).read_text())
    check = verify_associations if args.case == "da-13-3" else verify_clustering
    print(json.dumps({"status": "passed", **check(args.data, result)}))


if __name__ == "__main__":
    main()
