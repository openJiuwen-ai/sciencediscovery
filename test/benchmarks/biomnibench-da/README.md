# BiomniBench-DA real Swarm E2E

Two small-data tasks complement the literature-review suite. These tests are
manual/benchmark opt-in, never part of the mocked PR gate. They use real data,
real model calls and the running Swarm backend. This change does not add them to
any currently running six-case research suite.

| Task | Scientific scope | Input |
| --- | --- | --- |
| `da-13-3` | Protein associations with changes in body fat and breast volume; precomputed mixed-model estimates | One CSV, 295,386 bytes |
| `da-14-1` | Sepsis endotype score correlation and hierarchical clustering | One CSV, 2,307,055 bytes |

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
Python, pandas, NumPy and SciPy (optionally matplotlib for plots). Install matching
verifier dependencies in a separate test-host virtualenv:

```bash
python3 -m venv /tmp/biomni-verifier
/tmp/biomni-verifier/bin/pip install pandas==2.3.3 numpy==2.2.6 scipy==1.15.3
export BIOMNI_PYTHON=/tmp/biomni-verifier/bin/python
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

The original instructions are preserved, with an explicit platform delivery
appendix mapping `/app` paths to the actual workspace. The appendix requests no
subagents, executed Python code, declared `trace.md`, `answer.txt`, `analysis.py`
and a machine-readable `analysis.json` (its schema is in `cases.ts`). This is a
low-cost platform E2E profile, not an unmodified official leaderboard run.

- Require terminal completion, successful execution records, no child agents,
  readable artifacts, browser preview and persistence after reload.
- Independently recompute association counts, top absolute-effect rankings and
  numeric values; find headers by their content, not a fixed skiprows constant.
- Recompute correlation and linkage from the input CSV. Compare cophenetic
  distances rather than raw cluster IDs or left/right branch ordering.
- Clustering permits documented Pearson/Spearman and pairwise/complete missing
  handling. Whether score selection and methods meet scientific expectations is
  a separate rubric judgement: the upstream rubric targets **21 scores**, not
  the 38 mentioned in an earlier demonstration. Numeric consistency alone does
  not imply benchmark quality or correct feature selection.
- Do not execute Agent-generated scripts on the host verifier. Successful
  execution records plus recomputed output are useful evidence, not a proof that
  every line of the delivered script ran. No exact chart-pixel assertions.

## Optional quality scoring

```bash
export E2E_BIOMNI_EVALUATION=rubric
export BIOMNI_JUDGE_BASE_URL=https://your-provider.example/v1
export BIOMNI_JUDGE_MODEL='<judge model>'
export BIOMNI_JUDGE_API_KEY='<judge key>'
export E2E_BIOMNI_MIN_SCORE=60
```

`judge.py` uses the original expert rubric with an OpenAI-compatible adapter,
passing the complete submitted trace and answer to a separately configured
Judge. Every criterion requires an A/B/C level and justification; code calculates
the total from rubric-defined points (including penalties). Malformed, missing
or truncated judge responses are errors, never zero-score passes. No automatic
Judge retry. Model calls time out after 180 seconds.

This is **not** the upstream Gemini verifier implementation and must be labelled
as a local rubric-adapter score. Changing Judge models changes comparability.
The threshold defaults to zero (score recording only); select a quality gate
after calibration. With evaluation off, quality is `disabled`, not passed.
RACE/FACT are not used for these data-analysis tasks.

## Diagnostics and resources

Playwright output retains `benchmark-metrics.json`, submitted prompt, partial or
complete deliverables, execution records, assistant messages and failure traces.
Metrics separate integration/numerical status, rubric score and Judge usage from
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
