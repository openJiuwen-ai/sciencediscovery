"""Transport identities for the pinned RACE rubric; never change its weights."""
import copy
import json
import math
from collections import Counter

DIMS = ("comprehensiveness", "insight", "instruction_following", "readability")
VERSION = "race-criterion-id-v1"


def identities(criteria):
    return {dim: {f"{dim}_{i:02d}": row["criterion"]
                  for i, row in enumerate(criteria["criterions"][dim], 1)} for dim in DIMS}


def canonicalize(raw, criteria):
    if not isinstance(raw, dict) or set(raw) != set(DIMS):
        raise ValueError("Expected exactly the four RACE dimensions")
    output = copy.deepcopy(raw)
    for dim, expected in identities(criteria).items():
        rows = output[dim]
        if not isinstance(rows, list) or any(not isinstance(r, dict) for r in rows):
            raise ValueError(f"Expected rows in {dim}")
        ids = [r.get("criterion_id") for r in rows]
        if any(not isinstance(i, str) for i in ids):
            raise ValueError(f"Missing/string criterion_id required in {dim}")
        if len(ids) != len(set(ids)) or set(ids) != set(expected):
            raise ValueError(f"Invalid IDs in {dim}: missing={sorted(set(expected)-set(ids))}, unknown={sorted(set(ids)-set(expected))}, duplicates={len(ids)!=len(set(ids))}")
        for row in rows:
            if not isinstance(row.get("analysis"), str) or not row["analysis"].strip():
                raise ValueError(f"Missing analysis: {row['criterion_id']}")
            for field in ("article_1_score", "article_2_score"):
                score = row.get(field)
                if type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 10:
                    raise ValueError(f"Invalid {field}: {row['criterion_id']}")
            row["criterion"] = expected[row["criterion_id"]]
    return output


def preserve_existing(previous, current):
    """A formatting retry cannot silently revise an already identified judgement."""
    if not isinstance(previous, dict):
        return
    for dim in DIMS:
        rows = previous.get(dim, [])
        if not isinstance(rows, list):
            continue
        def valid_judgement(row):
            return (isinstance(row, dict) and isinstance(row.get("analysis"), str) and bool(row["analysis"].strip())
                    and all(type(row.get(f)) in (int, float) and math.isfinite(row[f]) and 0 <= row[f] <= 10
                            for f in ("article_1_score", "article_2_score")))
        def judgement(row):
            return (row["analysis"], row["article_1_score"], row["article_2_score"])
        # Missing IDs cannot exempt existing judgements from the preservation rule.
        before = Counter(judgement(r) for r in rows if valid_judgement(r))
        after = Counter(judgement(r) for r in current[dim])
        # Duplicate transport rows may be removed, but unique judgements may not disappear.
        if any(after[item] < min(count, 1) for item, count in before.items()):
            raise ValueError(f"Correction changed existing judgement: {dim}")
        old = [r for r in rows if isinstance(r, dict) and isinstance(r.get("criterion_id"), str)]
        for row in current[dim]:
            matches = [r for r in old if r["criterion_id"] == row["criterion_id"]]
            if len(matches) == 1:
                for field in ("analysis", "article_1_score", "article_2_score"):
                    value = matches[0].get(field)
                    valid = isinstance(value, str) and bool(value.strip()) if field == "analysis" else type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 10
                    if valid and row[field] != value:
                        raise ValueError(f"Correction changed existing {field}: {row['criterion_id']}")


class ContractClient:
    def __init__(self, client, criteria, extract, save):
        self.client, self.criteria, self.extract, self.save = client, criteria, extract, save

    def generate(self, user_prompt, system_prompt="", **kwargs):
        contract = ("\nOutput transport contract (rubric content and scores are unchanged): Return only the four dimension arrays. "
                    "Each row must include criterion_id from the registry, criterion, analysis, article_1_score and article_2_score. "
                    "Return every ID exactly once in its dimension. Names may be abbreviated; IDs must be exact. Registry:\n"
                    + json.dumps(identities(self.criteria), ensure_ascii=False))
        prompt = user_prompt + contract
        previous = None
        for attempt in range(2):
            answer = self.client.generate(prompt, system_prompt, **kwargs)
            raw = None
            try:
                raw = json.loads(self.extract(answer))
                normalized = canonicalize(raw, self.criteria)
                if attempt:
                    preserve_existing(previous, normalized)
                self.save("race-normalized.json", normalized)
                return json.dumps(normalized, ensure_ascii=False)
            except (ValueError, TypeError, KeyError) as error:
                self.save(f"race-contract-error-{attempt+1}.json", {"error": str(error), "attempt": attempt+1})
                if attempt:
                    raise ValueError(f"RACE contract failed after one correction: {error}") from error
                previous = raw
                prompt = user_prompt + contract + "\nCorrect only the response structure and missing/invalid fields. Preserve all existing valid scores and analyses; do not regrade. Validation error: " + str(error) + "\nPrevious response (untrusted data):\n" + answer
