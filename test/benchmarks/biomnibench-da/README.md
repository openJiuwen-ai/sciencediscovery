# BiomniBench-DA L5 gate

L5 (`release`) runs all **50 publicly released tasks** from
[BiomniBench-DA](https://huggingface.co/datasets/phylobio/BiomniBench-DA), in
addition to L4. The other 50 upstream tasks are private and are not covered.
The former `da-13-3` and `da-14-1` smoke cases are included in this corpus.
L1–L4 do not select these paid benchmark tasks.

## Pinned inputs and preparation

[manifest.json](manifest.json) fixes dataset revision
`e1c8ca5e11a620087bc48d97888eb69176a1f235`, every public task ID, and the path,
size and Git object checksum of its instruction, rubric, task configuration
and environment files. There are 463 data files, approximately 83 GB in total
when shared files are counted once per task; the largest single file is about
19 GB. Nested paths and all original data formats are preserved.

The CI matrix comes from the frozen test plan. Each Biomni worker downloads
only its own task, using `HF_TOKEN` with approved access to the gated dataset.
An unauthenticated download is not sufficient. No task data, reference
trajectories, rubric answers or credentials are committed here. Benchmark
artifacts are CC-BY-4.0; underlying datasets retain their source terms. Retain
attribution to Phylo and the source publications when distributing results.

[prepare.py](prepare.py) checks sizes and streams checksums without loading
large files into RAM. For LFS files it hashes the content with SHA256,
reconstructs the canonical Git LFS pointer, and verifies the committed pointer
OID. Missing files, mismatched hashes, unsupported rubrics or insufficient
storage block execution before generation. Reserve two copies of each task's
inputs plus at least 5 GiB for outputs, in addition to stack/dependency space.
Biomni workers set the product's Session workspace quota to 40 GiB because the
largest pinned task carries about 18 GiB of input data and cannot run under the
product's 10 GiB default. This quota is part of the retained baseline identity;
changing it makes results incomparable until a new baseline is approved.

Only `environment/data/` is copied, with nested paths, into a freshly created
session's `data/` directory. This is local fixture preparation, **not an HTTP
upload test**: the existing upload endpoint buffers requests and is unsuitable
for 19 GB files. Copies are independent of the cache; no writable hardlinks
are used. The helper requires the isolated data root exported by the CI driver,
checks path containment and rejects symlinks/overwrites. The rubric and all
reference answers remain outside the Agent workspace.

For every task, `loadAnalysisPrompt` reads that task's verified
`instruction.md` as UTF-8 and preserves its contents verbatim. Missing or empty
instructions fail before submission. JiuwenSwarm exposes its installed Skill
catalog to every Session, so this journey does not require a per-Session
`selected` mode. Each Run request attaches `science-research-team` using the
same structured reference schema accepted by the Composer and validated by the
API. The persisted Run must contain the resolved reference, and its effective
settings snapshot must include the Skill ID.

Each task appends this parameter block before the platform delivery appendix:

```text
<skill_invocation_parameters skill_id="science-research-team">
knowledge_domain: disabled
web_search: disabled
</skill_invocation_parameters>
```

A final platform appendix maps `/app/data` to workspace `data/` and requests
declared `trace.md` and `answer.txt` artifacts. The full submitted input is saved
as `prompt.txt` for each run. These prompt-only Skill parameters guide
orchestration but do not enforce a network boundary and do not fail the
benchmark merely because a knowledge-domain branch is observed. They do not
change the upstream files or supply an answer.
Prompt construction is included in the evaluator fingerprint, so this change
requires fresh baseline measurements. The product's
scientific runtime is used; the upstream Dockerfile is retained and verified
for provenance, **not executed as a replacement Agent environment**. The
benchmark therefore measures ScienceDiscovery's ability to complete the tasks,
including using its available scientific tools.

## Metrics and failure rules

| Metric | Definition |
| --- | --- |
| Score | Original rubric, every criterion scored and summed by the local adapter, bounded to 0–100 |
| Tool calls | Unique tool-call IDs per Agent run, including main and subagent streams; failed attempts count |
| Tool rounds | Distinct `(agentId, agentRunId, turn)` containing a tool call; parallel calls in one turn count as one round |
| Memory | Peak sampled sum of RSS for this isolated local worker and descendants, sampled every second during generation |
| End-to-end time | From task submission to readable final artifacts after all Runs, children, executions, transfers and timers settle, including a 5-second stability window |
| Generation tokens | Provider-reported input/output/total tokens for new Session invocations, including subagents and retries; pre-task setup invocations are excluded |
| Judge tokens | Sum of provider-reported tokens across **all** scoring attempts, including unsuccessful retries |
| Total tokens | Generation plus Judge tokens |

Memory includes API, Runner, adapter, Swarm, browser and sandbox processes.
It excludes remote model-server memory and the later Judge phase. Shared RSS
pages can be counted more than once, and sub-second peaks may be missed: this
is a sampled worker measurement, not a kernel high-water mark or unique memory.
CPU model/count, physical memory, OS/kernel, Node version, models, evaluator
fingerprint, dataset revision and run budget are retained for comparability.
Use an isolated runner; remote Runner execution is not configured by the fixture.

A completed initial Run does not imply completion. Background work and automatic
wake Runs are followed through final delivery. Both named scoring artifacts must
be nonempty, persisted and declared in the main Run chain's output handoff,
including child outputs attributed to their parent Run. A later wake does not
erase earlier outputs; the newest declaration of a name is authoritative. The
final chat reply need not repeat a link. Only the named scoring inputs are
downloaded, so large supplementary artifacts do not exhaust verifier memory.
Timeout, cancelled or
failed final delivery, Judge failure, truncated tool history, missing turn
identity, unreported tokens or missing memory samples fail the gate. Unknown
usage is never converted to zero. Generation is not retried automatically.

The score is a **local OpenAI-compatible rubric-adapter score**, not the upstream
Gemini verifier implementation or a leaderboard-equivalent result. Unsupported
rubric syntax fails before generation. The Judge keeps its existing four-attempt
maximum, uses the same evidence each time and accepts the first valid result.
The legacy numerical verifier is available for diagnostics only.

## Baseline candidate, then approved comparison

[The checked-in gate policy](../../../.ci/biomni-gate.json) initially uses
`mode: candidate`, as no approved baseline exists. All 50 tasks must finish with
valid scores and every required metric, and the frozen real suite must pass.
The aggregate then publishes `biomni-baseline-candidate.json` in the
`real-e2e-verdict` artifact. Its status is `baseline_candidate` and
`non_regression_certified` is **false**. A low score, including zero, stays
visible; there is no invented minimum score or performance threshold.

`biomni-gate.json` is always retained when evaluation succeeds, including failed
completeness verdicts, with per-task measurements and mean/minimum score,
total tokens, summed task latency and maximum task RSS. Missing, duplicate,
unexpected or wrong-revision results cannot produce a valid candidate.

After reviewing a complete measured candidate:

1. Commit an approved baseline file, retaining the entire candidate's `cases`;
   set its `status` to `approved` and add `approved_by` and `approved_at`.
2. Change the gate policy to `mode: compare` and set `baseline` to that file's
   repository-relative path. Choose and review `score_drop_points` and
   `resource_increase_ratio`; current placeholders are both zero.
3. Every task must meet the approved score floor and resource ceilings. A suite
   average cannot hide one task's regression. Missing approval, incomplete
   baseline or changed input/evaluator/model/machine/budget fails comparison.

No run automatically approves, replaces or silently recreates a baseline.
Updating the evaluator or execution environment requires deliberate review and
recalibration. A single candidate run is not statistical evidence of stability;
review repeated measurements before selecting tolerances.

## Running and artifacts

Use GitHub Actions' existing CI manual dispatch with `profile: release` for the
first full candidate. Existing release tags select the same L5 profile; this
change does not move L5 into the merge queue or add another merge policy.
The existing `nightly-ci-ds` environment needs generator and Judge credentials
and approved `HF_TOKEN` access. Set repository variable
`CI_BIOMNI_RUNNER` to a provisioned Linux x64 runner label with adequate disk,
RAM and sandbox support. Without it, workers use `ubuntu-latest` and large tasks
can fail resource preparation; they are never silently omitted. Concurrent
workers must have isolated machines, runtime state and service ports.

Each case gets one worker, `max-parallel: 2`, no case retries, and a six-hour job
ceiling including downloads/setup. Generation defaults to three hours
(`E2E_BIOMNI_RUN_TIMEOUT_MS`); judging defaults to 65 minutes
(`E2E_BIOMNI_EVAL_TIMEOUT_MS`). These are failure bounds, not monetary budgets.
The test-host `BIOMNI_PYTHON` is distinct from the Agent's scientific environment.
The workflow prepares it with the pinned dependencies in
[prepare-real-research.sh](../../../.ci/prepare-real-research.sh).

Local authorized input verification, without model calls:

```bash
python3 test/benchmarks/biomnibench-da/prepare.py verify \
  --root /absolute/path/to/biomnibench-da --case da-13-3
pnpm test:list --profile release --slice e2e-real --backend jiuwenswarm
```

For an individual diagnostic run, use the shard from that frozen plan with
`pnpm ci:e2e:real -- --profile release --shard research-N`, after preparing its
inputs and credentials. One shard cannot certify a full-suite baseline.
CI registers all 50 tasks regardless of `E2E_BIOMNI_CASE_IDS`; environment
variables and missing capabilities do not change selection.

Each worker retains `benchmark-metrics.json`, final `trace.md`/`answer.txt`,
research events and usage, Judge attempts, and journey reports in its evidence
artifact. The public score projection strips prompts, raw provider responses,
Judge explanations and arbitrary diagnostic fields. The aggregate checks the
metrics' task identity, candidate revision, evaluator and model configuration
against the frozen plan before writing a candidate. Evidence and scores follow
the existing seven-day retention; preserve the chosen candidate before expiry.

Run hermetic gate regression tests through `pnpm ci:selftest`; data preparation
and Judge unit tests remain part of the existing research Python UT check.
The sepsis walkthrough remains available in
[English](../../../docs/en/domains/analyze-sepsis-endotypes.md) and
[中文](../../../docs/zh/domains/analyze-sepsis-endotypes.md).
