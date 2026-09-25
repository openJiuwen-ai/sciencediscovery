# BiomniBench-DA real Swarm E2E

Two small-data tasks complement the literature-review suite. These tests are
manual/benchmark opt-in, never part of the mocked PR gate. They use real data,
real model calls and the running Swarm backend. This change does not add them to
any currently running six-case research suite.

| Task | Scientific scope | Input |
| --- | --- | --- |
| `da-13-3` | Protein associations with changes in body fat and breast volume; precomputed mixed-model estimates | One CSV, 295,386 bytes |
| `da-14-1` | Sepsis endotype score correlation and hierarchical clustering | One CSV, 2,307,055 bytes |

The `da-14-1` user walkthrough is available in [English](../../../docs/en/domains/analyze-sepsis-endotypes.md) and [中文](../../../docs/zh/domains/analyze-sepsis-endotypes.md). It uses the original instruction and the same platform delivery appendix; the examples are not task inputs.

## Data and licensing

Acquire authorized copies from [the original dataset](https://huggingface.co/datasets/phylobio/BiomniBench-DA).
Public release does not mean anonymous download: Hugging Face requires accepting
access conditions. No credentials, patient data, reference trajectories or rubric
answers are committed here. Benchmark artifacts are CC-BY-4.0; underlying data
retain their source terms. Acknowledge Phylo and the source publications in the
task instructions when distributing benchmark-derived material.

Set `BIOMNI_DATA_ROOT` to the downloaded original-layout directory containing:

```text
da-13-3/ (and da-14-1/)
  instruction.md
  environment/data/<original CSV filename>
  tests/rubric.txt
```

`cases.ts` pins Git blob hashes for each instruction, rubric and input file.
The hashes were checked against the official repository metadata on 2026-09-23.
Preflight rejects changed/missing inputs before spending generator tokens. Only
the instruction and CSV enter the Agent's workspace/context. Rubrics remain on
the evaluation side. Source-paper answer lookup is prohibited by the original
instructions; general background references remain allowed.

## Run

Use an isolated API/Runner/Swarm stack with an execution environment containing
the dependencies needed by the analysis. `BIOMNI_PYTHON` selects the test-host
Python for rubric judging and optional numeric diagnostics. The latter need
pandas, NumPy and SciPy; missing diagnostic dependencies do not block scoring.

```bash
export BIOMNI_PYTHON=python3
export BIOMNI_DATA_ROOT=/absolute/path/to/authorized/biomnibench-da
export E2E_API_URL=http://127.0.0.1:4680
export E2E_API_TOKEN='<isolated-stack access token>'
export E2E_LLM_MODEL_ID='<registered real model id>'
export E2E_REAL=1 E2E_RESEARCH=1 E2E_SWARM_TASK=1
export E2E_BIOMNI_EVALUATION=off
node test/sync-e2e.mjs --write
cd .e2e
./node_modules/.bin/playwright test biomnibench-da-swarm.spec.ts --project=real --workers=1
```

Alternatively set `E2E_LLM_BASE_URL`, `E2E_LLM_MODEL`, `E2E_LLM_TOKEN` instead of a
registered model ID. Playwright `--grep BiomniBench-da-13-3` selects one task
locally. CI discovers both from source tags, independent of environment filters.
`E2E_KEEP_RESEARCH_RECORDS=1` preserves application records. Both real cases
belong to daily CI, never to the PR gate; daily enables rubric judging.
Run timeout defaults to 30 minutes; override with `E2E_BIOMNI_RUN_TIMEOUT_MS`.
The runner cancels timed-out tasks; there is no automatic retry or monetary cap.

## Assertions and benchmark fidelity

The pinned original instruction text is preserved verbatim. A platform delivery
appendix only maps `/app` paths to the actual workspace and asks for declaration
of the two originally required artifacts, `trace.md` and `answer.txt`. It adds
no analysis method, ranking convention, JSON schema or delegation restriction.

- Require a completed main run and at least one readable, nonempty persisted
  artifact referenced in its final response. Fixed names are not completion
  assertions. Failed/cancelled runs with outputs are partial deliveries.
- Scientific correctness and completeness are evaluated by the unchanged upstream
  rubric. The scorer still consumes the officially required `trace.md` and
  `answer.txt`; unavailable scoring inputs record an evaluation error without
  changing delivery success. No local numerical assertion blocks scoring.
- Retain raw artifacts and trajectories for investigation when needed. The legacy
  numerical verifier is available offline and is not automatically run.
- Do not execute Agent-generated scripts on the host verifier.
- Delivery success does not imply scientific correctness. Read the rubric score
  separately; a low score remains a low score even when delivery passes.

## Independent quality scoring (enabled by default)

```bash
export E2E_BIOMNI_EVALUATION=rubric
export BIOMNI_JUDGE_BASE_URL=https://your-provider.example/v1
export BIOMNI_JUDGE_MODEL='<judge model>'
export BIOMNI_JUDGE_API_KEY='<judge key>'
```

`judge.py` uses the original expert rubric with an OpenAI-compatible adapter,
passing the complete submitted trace and answer to a separately configured
Judge. Every criterion requires an A/B/C level and justification; code calculates
the total from rubric-defined points (including penalties). Malformed, missing
or truncated judge responses are recorded as evaluation errors with no score;
they do not change the separate delivery result. No automatic
Judge retry. Model calls time out after 180 seconds.

This is **not** the upstream Gemini verifier implementation and must be labelled
as a local rubric-adapter score. Changing Judge models changes comparability.
Scores are recorded without a pass threshold; `E2E_BIOMNI_MIN_SCORE` is no longer
used. With evaluation off, quality is `disabled`, not passed.
RACE/FACT are not used for these data-analysis tasks.

## Diagnostics and resources

Playwright output retains `benchmark-metrics.json`, submitted prompt, partial or
complete deliverables, execution records, assistant messages and failure traces.
Metrics separate delivery status, rubric score and Judge usage from
session generator usage; include input hash/size, wall time, model ID and children.
Missing usage is null, not zero; no currency conversion is invented.

CSV computation needs no GPU. Start with one case at a time and provision roughly
1 CPU and 512 MiB–1 GiB **for analysis only**, subject to measurement. This is not
a measured whole-platform memory requirement or a limit enforced by this test.
Swarm/API/Runner/browser overhead is additional. Peak memory/CPU are explicitly
`not_collected`; use the existing external process/cgroup monitor when running on
the small remote host. Local verifier BLAS threads are limited to one.

Run the verifier's synthetic-data unit tests without a real LLM:

```bash
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 python3 -m unittest discover \
  -s test/benchmarks/biomnibench-da -p 'test_*.py'
```
