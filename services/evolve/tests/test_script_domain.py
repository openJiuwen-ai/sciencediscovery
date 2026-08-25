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

"""Scoring by an evaluator the drafting model wrote.

The interesting tests are the contract, because the contract is what a model
has to get right without being able to try it first: the candidate is importable
under the name it was promised, the shard list arrives, the result is read from
the file rather than from stdout, and every way the evaluator can be wrong says
which of the two programs is at fault.
"""

from __future__ import annotations

import json
from typing import Any, Dict

import pytest

from sciencediscovery_evolve.script_domain import ScriptError, script_domain
from sciencediscovery_evolve.vendor.era.sandbox import detect_local_capability

CARD: Dict[str, Any] = {
    "aggregate": "weighted_sum",
    "constraints": [],
    "criteria": [{
        "direction": "maximize", "id": "exact_match", "name": "逐字段全对率",
        "measure": {
            "kind": "custom_script",
            "scriptCas": "sha256:script",
            "split": {"gateShards": 4, "rolloutShards": 4, "seed": 0, "shardRows": 0, "testShards": 2},
            "timeoutSeconds": 60,
        },
        "normalize": {"kind": "identity"}, "weight": 1.0,
    }],
    "hash": "sha256:script", "schemaVersion": 1, "solvedThreshold": 0.999,
}

#: A real evaluator, written the way a drafting model would write one: import
#: the candidate by the promised name, score only the shards it was given, put
#: the answer in the file the environment names.
EVALUATOR = '''
import json, os
import candidate

CASES = [("a", 1), ("bb", 2), ("ccc", 3), ("dddd", 4),
         ("e", 1), ("ff", 2), ("ggg", 3), ("hhhh", 4),
         ("i", 1), ("jj", 2)]

shards = [int(part) for part in os.environ["SCIENCE_AGENT_SHARDS"].split(",") if part != ""]
mine = [case for index, case in enumerate(CASES) if index % 10 in shards]
hits = 0
for text, want in mine:
    try:
        hits += 1 if candidate.measure(text) == want else 0
    except Exception:
        pass
payload = {"valid": True, "metrics": {"exact_match": hits / len(mine), "cases": len(mine)}}
with open(os.environ["SCIENCE_AGENT_RESULT"], "w") as handle:
    json.dump(payload, handle)
'''

GOOD = "def measure(text):\n    return len(text)\n"
BAD = "def measure(text):\n    return 0\n"

live = pytest.mark.skipif(
    not detect_local_capability().available,
    reason="需要真沙箱：候选是模型写的代码，不隔离就不该执行",
)


def domain(script: str = EVALUATOR, card: Dict[str, Any] = CARD):
    return script_domain(
        scorecard=card, script=script, capability=detect_local_capability(),
        statement="把长度算对", baseline_code=BAD, candidate_timeout=60.0,
    )


@live
def test_the_candidate_is_importable_under_the_name_it_was_promised():
    # `import candidate` is the first line any evaluator will contain, and the
    # sandbox runs the interpreter with -I, which since 3.11 keeps the script's
    # own directory off sys.path. Without the shim this raises ImportError and
    # every candidate scores zero for a reason that is not about the candidate.
    valid, metrics, error = domain().evaluate(GOOD, [0, 1, 2, 3])
    assert valid, error
    assert metrics["exact_match"] == 1.0


@live
def test_a_worse_candidate_scores_worse():
    good = domain().evaluate(GOOD, [0, 1, 2, 3])[1]["exact_match"]
    bad = domain().evaluate(BAD, [0, 1, 2, 3])[1]["exact_match"]
    assert bad < good


@live
def test_only_the_shards_it_was_given_are_scored():
    # Not decoration: this is what makes the gate a held-out gate rather than a
    # second look at the same examples.
    _valid, metrics, _error = domain().evaluate(GOOD, [0, 1])
    assert metrics["cases"] == 2


@live
def test_a_candidate_printing_on_stdout_does_not_disturb_the_result():
    noisy = 'print("{\\"valid\\": true, \\"metrics\\": {\\"exact_match\\": 1.0}}")\n' + BAD
    _valid, metrics, _error = domain().evaluate(noisy, [0, 1, 2, 3])
    # Read from the file, so the candidate's line is just output.
    assert metrics["exact_match"] == 0.0


@live
def test_an_evaluator_that_writes_nothing_names_itself_rather_than_the_candidate():
    with pytest.raises(ScriptError, match="结果文件"):
        domain("import os\n").evaluate(GOOD, [0])


@live
def test_an_evaluator_that_prints_its_result_instead_of_writing_it_still_counts():
    # Not hypothetical: a real drafting model printed exactly the right object
    # to stdout, with the contract spelled out twice in its prompt. Refusing a
    # correct answer for arriving in the wrong envelope throws away the run.
    printing = (
        'import json, os\n'
        'shards = os.environ["SCIENCE_AGENT_SHARDS"]\n'
        'print(json.dumps({"valid": True, "metrics": {"exact_match": 0.5}}))\n'
    )
    valid, metrics, _error = domain(printing).evaluate(GOOD, [0])
    assert valid
    assert metrics["exact_match"] == 0.5


@live
def test_a_candidate_printing_first_does_not_get_to_pick_the_score():
    # The evaluator runs after the candidate is imported, so its line is last.
    forging = (
        'import json, os\n'
        'import candidate\n'
        'print(json.dumps({"valid": True, "metrics": {"exact_match": 1.0}}))\n'
    )
    liar = 'import json\nprint(json.dumps({"valid": True, "metrics": {"exact_match": 0.99}}))\n' + BAD
    _valid, metrics, _error = domain(forging).evaluate(liar, [0])
    assert metrics["exact_match"] == 1.0


@live
def test_an_evaluator_that_omits_the_criterion_says_which_key_was_missing():
    wrong = (
        'import json, os\n'
        'with open(os.environ["SCIENCE_AGENT_RESULT"], "w") as handle:\n'
        '    json.dump({"valid": True, "metrics": {"accuracy": 0.5}}, handle)\n'
    )
    with pytest.raises(ScriptError, match="exact_match"):
        domain(wrong).evaluate(GOOD, [0])


@live
def test_an_evaluator_that_crashes_is_a_run_fault_not_a_bad_candidate():
    with pytest.raises(ScriptError):
        domain("raise SystemExit(3)\n").evaluate(GOOD, [0])


def test_an_empty_evaluator_is_refused_before_anything_runs():
    with pytest.raises(ScriptError, match="脚本是空的"):
        script_domain(scorecard=CARD, script="   ", capability=detect_local_capability())


def test_the_held_out_shards_are_the_last_ones():
    # Positional, like every other mode: the framework holds out by index, so
    # the ordering is what makes the tail the test set.
    assert domain().test_shards == (8, 9)


@live
def test_an_unexplained_invalid_still_carries_whatever_the_evaluator_did_say():
    # valid:false with no error field, seen on a real run: the candidate card
    # read "评测脚本判这个候选不成立" and nothing else. The metrics it still
    # reported are the next best thing to a reason.
    silent = (
        'import json, os\n'
        'with open(os.environ["SCIENCE_AGENT_RESULT"], "w") as handle:\n'
        '    json.dump({"valid": False, "metrics": {"exact_match": 0.1}}, handle)\n'
    )
    _valid, _metrics, error = domain(silent).evaluate(GOOD, [0])
    assert "exact_match" in error

    bare = (
        'import json, os\n'
        'with open(os.environ["SCIENCE_AGENT_RESULT"], "w") as handle:\n'
        '    json.dump({"valid": False}, handle)\n'
    )
    _valid, _metrics, error = domain(bare).evaluate(GOOD, [0])
    assert "没有说原因" in error


@live
def test_a_candidate_the_evaluator_calls_invalid_enters_the_tree_scoring_nothing():
    refuses = (
        'import json, os\n'
        'with open(os.environ["SCIENCE_AGENT_RESULT"], "w") as handle:\n'
        '    json.dump({"valid": False, "error": "候选没有 measure 函数"}, handle)\n'
    )
    valid, metrics, error = domain(refuses).evaluate("x = 1\n", [0])
    assert valid is False
    assert metrics["score"] == float("-inf")
    assert "measure" in error


@live
def test_the_evaluators_diagnosis_reaches_the_mutation_prompt():
    """Score-plus-silence is what produced six identical zeros on a real run.

    The evaluator said why — "超出求值预算" — into the error field; the node
    stored it; the UI showed it; and the one reader who could act on it, the
    reflector, was told only the number. It kept proposing new variants of the
    same overspend because nothing distinguished them from wrong answers.
    """
    from sciencediscovery_evolve.vendor.era.program import Program

    d = domain()
    parent = Program(
        program_id="p", iteration=1, parent_id=None, code=GOOD,
        change_summary="", metrics={"score": 0.0}, valid=True,
        error="3/6 条样例超出求值预算，其余误差正常",
    )
    text = d.prompt(parent)
    assert "评测对它的诊断" in text
    assert "超出求值预算" in text

    quiet = Program(
        program_id="q", iteration=1, parent_id=None, code=GOOD,
        change_summary="", metrics={"score": 0.5}, valid=True, error="",
    )
    assert "评测对它的诊断" not in d.prompt(quiet)



def test_an_evaluator_that_needs_no_files_runs_with_none_staged(tmp_path):
    """The common shape: case `i` is built from the shard index, not read."""
    script = (
        "import json, os\n"
        "shards = [int(s) for s in os.environ['SCIENCE_AGENT_SHARDS'].split(',')]\n"
        "# case i is generated, not looked up\n"
        "score = sum(1 for i in shards if (i * i) % 2 == i % 2) / max(len(shards), 1)\n"
        "with open(os.environ['SCIENCE_AGENT_RESULT'], 'w') as fh:\n"
        "    json.dump({'valid': True, 'metrics': {'exact_match': score}}, fh)\n"
    )
    domain = script_domain(
        scorecard=CARD, script=script, capability=detect_local_capability(),
    )

    ok, metrics, error = domain.evaluate("value = 1\n", (0, 1, 2))

    assert ok, error
    assert metrics["exact_match"] == 1.0


def test_slots_are_translated_into_scattered_case_ids():
    """The search must not train on one end of the case list and gate on the other.

    Observed on a real ODE run: the evaluator's own check said 0.8441, the gate
    said 0.2375 and the held-out test said 0.4550 — three numbers for one
    unchanged program, because the gate happened to be the four stiff equations
    at the end of the list. Slots stay positional (the engine holds out by tail);
    what a slot *means* is permuted.
    """
    seen = []
    script = (
        "import json, os\n"
        "shards = os.environ['SCIENCE_AGENT_SHARDS']\n"
        "with open(os.environ['SCIENCE_AGENT_RESULT'], 'w') as fh:\n"
        "    json.dump({'valid': True, 'metrics': {'exact_match': 1.0}, 'error': shards}, fh)\n"
    )
    card = json.loads(json.dumps(CARD))
    card["criteria"][0]["measure"]["split"] = {
        "gateShards": 4, "rolloutShards": 5, "seed": 0, "shardRows": 1, "testShards": 2,
    }
    domain = script_domain(scorecard=card, script=script, capability=detect_local_capability())

    ok, _metrics, error = domain.evaluate("value = 1\n", (0, 1, 2, 3, 4))
    assert ok, error
    seen = [int(part) for part in error.split(",")]

    # Five slots in, five case ids out, and not the first five.
    assert len(seen) == 5
    assert sorted(seen) != [0, 1, 2, 3, 4]
    assert all(0 <= case < 11 for case in seen)


def test_the_same_slots_always_mean_the_same_cases():
    """A score has to be comparable across candidates and across expansions."""
    from sciencediscovery_evolve.shard_roles import cases_for

    assert cases_for((0, 1, 2), 11, 0) == cases_for((0, 1, 2), 11, 0)
    # Every slot maps somewhere, and no two slots collide.
    everything = cases_for(range(11), 11, 0)
    assert sorted(everything) == list(range(11))


def test_a_candidate_that_never_ran_gets_its_traceback_fed_back():
    """`err=None` for every case says the candidate died, not why.

    Seen on a real run: four of seven candidates reported `err=None, nfev=0`
    across the board, and the reflector — told only "score 0" — kept proposing
    variants of the same broken idea. The traceback is in the process output,
    and this is the only place it survives.
    """
    script = (
        "import json, os, sys\n"
        "print('Traceback (most recent call last): NameError: solve_ivp', file=sys.stderr)\n"
        "with open(os.environ['SCIENCE_AGENT_RESULT'], 'w') as fh:\n"
        "    json.dump({'valid': True, 'metrics': {'exact_match': 0.0},\n"
        "               'error': 'caseA: err=None, nfev=0'}, fh)\n"
    )
    domain = script_domain(scorecard=CARD, script=script, capability=detect_local_capability())

    _ok, _metrics, error = domain.evaluate("value = 1\n", (0,))

    assert "err=None" in error          # the evaluator's own line is kept
    assert "NameError" in error         # and the reason it could not give is added


def test_a_real_diagnosis_is_not_padded_with_process_noise():
    """An evaluator that says why keeps the floor to itself."""
    script = (
        "import json, os, sys\n"
        "print('some unrelated chatter', file=sys.stderr)\n"
        "with open(os.environ['SCIENCE_AGENT_RESULT'], 'w') as fh:\n"
        "    json.dump({'valid': True, 'metrics': {'exact_match': 0.2},\n"
        "               'error': 'caseA: err=3.51, nfev=2000 (budget exhausted)'}, fh)\n"
    )
    domain = script_domain(scorecard=CARD, script=script, capability=detect_local_capability())

    _ok, _metrics, error = domain.evaluate("value = 1\n", (0,))

    assert "budget exhausted" in error
    assert "unrelated chatter" not in error


def test_the_evaluator_runs_as_main_with_the_scratch_dir_importable():
    """The contract the author has to know without being able to try it first.

    A `if __name__ == "__main__":` guard is the commonest shape in Python, and
    whether it fires depends on how the runner invokes the file — which nothing
    stated. One run was spent reverse-engineering it by experiment.
    """
    script = (
        "import json, os, sys\n"
        "import candidate\n"
        "def _run():\n"
        "    with open(os.environ['SCIENCE_AGENT_RESULT'], 'w') as fh:\n"
        "        json.dump({'valid': True, 'metrics': {'exact_match': 1.0},\n"
        "                   'error': 'name=%s cwd_on_path=%s cand=%s'\n"
        "                            % (__name__, os.getcwd() in sys.path or '.' in sys.path,\n"
        "                               candidate.value)}, fh)\n"
        "if __name__ == '__main__':\n"
        "    _run()\n"
    )
    domain = script_domain(scorecard=CARD, script=script, capability=detect_local_capability())

    ok, _metrics, error = domain.evaluate("value = 7\n", (0,))

    assert ok, error
    assert "name=__main__" in error       # the guard fires
    assert "cand=7" in error              # and the candidate is importable


def test_an_evaluator_that_dies_on_import_is_named_as_the_fault():
    """A hollowed-out candidate can raise at import, before any case runs.

    The advice used to say "wrap each case", which is exactly the guard that
    cannot reach an import-time failure — so an author who followed it hit the
    same wall twice and then went off trying to make the *candidate* survive
    being damaged, which is the one thing it must not do.
    """
    script = (
        "import candidate\n"          # no guard: this is the shape being diagnosed
        "import json, os\n"
        "with open(os.environ['SCIENCE_AGENT_RESULT'], 'w') as fh:\n"
        "    json.dump({'valid': True, 'metrics': {'exact_match': 1.0}}, fh)\n"
    )
    domain = script_domain(scorecard=CARD, script=script, capability=detect_local_capability())

    with pytest.raises(ScriptError) as caught:
        # Exactly what hollowing produces: the function keeps its name and
        # returns None, so the module-level line below raises during import.
        domain.evaluate("def build():\n    return None\n_CODES = build()\n_CODES[1]\n", (0,))

    said = str(caught.value)
    assert "评测脚本" in said



def test_the_evaluator_is_alone_with_the_candidate(tmp_path):
    """Nothing but the candidate, the evaluator and the shim.

    The evaluator builds case `i` from the shard index; there is no channel for
    shipping it a file, and there was one — a schema field, a staging branch, a
    name check and a resolution step in two places, whose only concrete effect
    in production was one silent staging bug. Material that genuinely lives in
    a file belongs in `dataset_metric`, which owns the splitting too.
    """
    script = (
        "import json, os\n"
        "here = os.path.dirname(os.path.abspath(__file__))\n"
        "names = sorted(os.listdir(here))\n"
        "with open(os.environ['SCIENCE_AGENT_RESULT'], 'w') as fh:\n"
        "    json.dump({'valid': True, 'metrics': {'exact_match': 1.0},\n"
        "               'error': ','.join(names)}, fh)\n"
    )
    domain = script_domain(scorecard=CARD, script=script, capability=detect_local_capability())

    ok, _metrics, error = domain.evaluate("value = 1\n", (0,))

    assert ok, error
    present = set(error.split(","))
    # The two programs are there; the sandbox and the runner add their own
    # plumbing. What matters is that nothing data-shaped can arrive.
    assert {"candidate.py", "evaluate.py"} <= present
    assert not [name for name in present if name.endswith((".json", ".csv", ".txt"))]

def test_the_probe_pays_for_four_evaluations_and_no_more():
    """Each gate was added on its own, and one of them re-ran a measurement.

    `_refuse_nameless_diagnosis` needed the failure text that `_score` had just
    thrown away, so it scored the same damaged copy a second time — five real
    sandbox runs where four do. Counting them here means the next gate has to be
    deliberate about its cost rather than quietly adding one.

    The four: the starting point, a damaged copy, one that cannot be imported,
    and the starting point again to read the repeat noise.
    """
    from sciencediscovery_evolve import probe as probe_module

    calls = []

    def evaluate(code, shards):
        calls.append(code)
        # Distinguishable so every gate sees a scoring that discriminates.
        if "does not import" in code:
            return True, {"score": 0.0}, "candidate did not import: RuntimeError('…')"
        if "return None" in code or code.strip() == "":
            return True, {"score": 0.1}, "case 0: ValueError: nothing to score"
        return True, {"score": 0.5}, ""

    baseline, _raw, why = probe_module._measure(evaluate, "def f():\n    return 1\n", (0, 1))
    damaged, _label = probe_module._damage("def f():\n    return 1\n")
    worsened, _dr, damaged_why = probe_module._measure(evaluate, damaged, (0, 1))
    probe_module._refuse_nameless_diagnosis(damaged_why)
    probe_module._refuse_rewarding_the_unimportable(evaluate, (0, 1), baseline)
    probe_module._refuse_noisy(evaluate, "def f():\n    return 1\n", (0, 1), baseline, worsened)

    assert len(calls) == 4, [c[:30] for c in calls]
