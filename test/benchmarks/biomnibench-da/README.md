# BiomniBench-DA L5 gate

L5 (`release`) runs all **50 publicly released tasks** from
[BiomniBench-DA](https://huggingface.co/datasets/phylobio/BiomniBench-DA), in
addition to L4. The other 50 upstream tasks are private and are not covered.
The former `da-13-3` and `da-14-1` smoke cases are included in this corpus.
L1–L4 do not select these paid benchmark tasks.

## Resumable serial execution on a shared host

Prepare and build an isolated, committed checkout first, including the pinned
Playwright installation and JiuwenSwarm. Configure the documented model and
dataset credentials in the process environment; do not put them in scripts or
reports. Select unused stack ports and a task-owned Python/uv cache. Then run:

```bash
CI_ALLOW_REAL=1 python test/benchmarks/biomnibench-da/suite.py \
  --results /path/to/owned-results --runtime /path/to/owned-runtime \
  --data-root /path/to/verified-dataset --python /path/to/benchmark-python
```

The driver freezes the release plan, derives exactly the pinned public 50 from
its source identities, and runs one case at a time. AMD64 remains the default
release target; this driver explicitly selects the actual Linux AMD64 or ARM64
host using `--target-arch`. Actual measured architecture must match the frozen
identity. No machine restriction is disabled, and the 50 cases are not doubled.

Failures are retained and deferred until every previously unattempted case has
run. Preparation, process and resource-check failures are recorded per case and
do not abort the remaining tasks. After the first pass, failed tasks receive
at most **three additional retries**, sharing one counter across recovery modes.
Both nonempty `trace.md` and `answer.txt`, verified delivery evidence and measured
generation usage select evaluation-only recovery; otherwise the task reruns end
to end. Immediate judge retries are disabled inside this driver, so nested
retries cannot multiply its limit. Low scores and resource threshold breaches
do not trigger retries. The first valid result wins; no best-score selection.
Successful cases are skipped on resume, which requires the same candidate SHA.
Every attempt uses a separate directory and retains failure reasons. Unresolved
tasks are listed in `tracking-required.json` for investigation and issue tracking;
the driver does not publish issues automatically. Interrupted directories are
retained and the task is recorded as incomplete rather than aborting later tasks.

Before starting a case, the driver requires 64 GiB of runtime storage and
150,000 free inodes, plus 5 GiB and 10,000 inodes for reports. Thresholds can be
raised with the command-line options. Analysis with no recorded event progress
for 20 minutes is terminated and deferred; a completed analysis receives the
separate bounded judging budget. Only verified descendants of the driver are
terminated. After exit, only inactive environments below the suite-owned
runtime are removed. Inputs, CAS records, artifacts and reports are retained.
The operator must still provide enough memory and disk for these retained
records and other host workloads. A low-resource preflight records the case failure without starting its paid work;
the driver continues checking the remaining tasks and eventually fails if incomplete.

For manual evaluation-only recovery:

```bash
python test/benchmarks/biomnibench-da/rescore.py \
  --evidence /path/to/original-test-results \
  --rubric /path/to/verified-task/tests/rubric.txt \
  --output /path/to/new-evaluation-directory
```

The original evidence is immutable. A valid score is retained even if an
earlier request timed out without usage. Reported token counts are known costs,
not a claim that an unknown-cost request was free. Missing usage remains an
accounting failure for the resource baseline; independent scoring never turns
the original failed E2E into a pass. Neither driver approves a baseline.

### Offline repeat grading (no research generation)

For the eight historical DA-13-3 / DA-14-1 answers, create an input manifest
with exactly four entries per case. Paths are relative to that manifest:

```json
{"answers":[{"id":"a1-research-1-r1","case_id":"da-13-3","evidence":"saved/a1-research-1-r1"}]}
```

The example shows one entry; supply all eight. Each directory must contain the
original nonempty `trace.md` and `answer.txt`. Provide the unchanged official
rubrics under `<data-root>/<case>/tests/rubric.txt`. Configure
`BIOMNI_JUDGE_BASE_URL`, `BIOMNI_JUDGE_MODEL`, and `BIOMNI_JUDGE_API_KEY` in the
process environment. "Offline" means scoring saved answers without research;
the existing `judge.py` still calls that configured provider and incurs cost.

```bash
python test/benchmarks/biomnibench-da/repeat_grade.py \
  --inputs /path/to/eight-answers.json --data-root /path/to/verified-dataset \
  --repeats 3 --output /path/to/new-repeat-grade-directory
```

The runner verifies official rubric pins before calls, snapshots the exact
input bytes, records their SHA256 hashes, and invokes `judge.py` at temperature
0 three times per answer. Each evaluation has a separate directory, including
all bounded recovery attempts; existing outputs cannot be overwritten. The
JSON and Markdown reports retain every score and criterion level, count changes
between adjacent successful repeats and disagreements over all successful
pairs, and disclose failures. Failed repeats are not treated as zero scores or
as stable grades. These diagnostics never replace the formal L5 figures.

The historical input recovery status is recorded in
[issue-346-measurement.md](issue-346-measurement.md). The measured rewrite and
separately pinned local rubric remain pending recovery of those eight inputs.

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

This fidelity boundary applies to the **official baseline**. Any local clarified
rubric/checklist must be a separate file with its own version and pin; it must
never edit the upstream task or rubric in place or be appended to the official
research prompt. A local-variant score is for regression tracking only. Registered pins live in `local-rubrics.json`; the first pin is `da-13-3` `local-rubric-v1` (criteria 4 and 5 only; see `issue-346-measurement.md`).

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
| Official score | Original pinned rubric, every criterion scored and summed by the local adapter, bounded to 0–100; the only score used in gates and release figures |
| Local-variant score | Separately identified clarified rubric, informational only; `da-13-3` registers `local-rubric-v1` (criteria 4/5 clarifications for #346); unavailable/`—` for cases without a registry pin |
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
usage is never converted to zero. The serial driver applies the bounded, deferred
recovery policy above; standalone test invocations do not retry generation.

The score is a **local OpenAI-compatible rubric-adapter score**, not the upstream
Gemini verifier implementation or a leaderboard-equivalent result. Unsupported
rubric syntax fails before generation. The Judge keeps its existing four-attempt
maximum, uses the same evidence each time and accepts the first valid result.
The legacy numerical verifier is available for diagnostics only.

Here, **official** identifies the unchanged upstream rubric channel, not the
upstream Gemini implementation. New scorecards record the rubric channel,
version, Git blob OID and SHA256. Unregistered rubric files are diagnostic and
non-gating; official recovery requires the selected task's pinned rubric.
Historical schema-2 metrics without explicit rubric provenance remain readable.

Published JSON preserves `evaluation` and `measurements.score` as official;
`local_evaluation` is a separate non-gating output with its rubric identity.
CI summaries label both columns; `—` means no local score is available. Local
scores never enter the official mean, baseline comparison or quality threshold.
An explicitly local or diagnostic rubric in the official field fails the gate.

## Temporary A3 aggregate gate

The default [gate policy](../../../.ci/biomni-gate.json) uses `mode: temporary`.
Its fixed baseline equally weights the two complete historical A3 result sets.
These mixed-revision observations are a provisional operational reference, not
an approved identity-matched capability certification. Recalibrate in the formal
environment. The quality target is rounded from 67.73 to the agreed 67.7.

| Metric | Temporary baseline | Warning | Block |
| --- | ---: | ---: | ---: |
| Mean score over exactly 50 tasks | 67.7 | <=64.7 | <=62.7 |
| Total tokens | 195,099,712 | >=224,364,669 | >=243,874,640 |
| Total tool rounds | 2,042 | >=2,655 | >=3,063 |
| Sum of research minutes | 1,312.753472 | +20% | +30% |
| P95 of per-task peak RSS, GiB | 11.201639801 | +max(20%, 1 GiB) | +max(30%, 2 GiB) |

Limits are inclusive; blocking takes precedence over warnings. Memory P95 uses
linear interpolation (Excel PERCENTILE.INC convention). Maximum RSS remains
visible, but the historical 131.07 GiB outlier is not a normal maximum baseline.
The implementation compares unrounded values; table count limits round up.

All 50 selected tasks must have valid delivery, evaluation and complete required
metrics. Missing, duplicate or mismatched results fail, and partial means never
certify the suite. Only aggregate quality is gated; per-task zero scores remain
visible without automatically triggering retries. There are no hard per-task
score regression thresholds in temporary mode.

The final-result resource scope excludes earlier failed research/evaluation
attempts, matching the historical A3 summaries. `attempt-costs.json` separately
reports known spend and elapsed time across every attempt as a lower bound;
unknown usage is not replaced by zero. A new evaluation cannot repair unknown
cost from an earlier request, and required accounting incompleteness still
blocks the gate. A recovered score and resource completeness are separate facts.

`biomni-gate.json` and `biomni-gate.md` contain all 50 task statuses, delivery and
evaluation states, available measurements, structured failure codes, aggregate
values and threshold outcomes. GitHub's real-report step publishes the same
per-task table in its step summary. Detailed attempt errors stay in diagnostic
logs and the serial driver's status/summary files, outside public score fields.

Explicit `candidate` mode remains available to collect an unapproved full
baseline; `compare` mode retains the existing approved identity-matched per-task
comparison for compatibility. Neither mode automatically approves a baseline.
Temporary mode reports `non_regression_certified: false` even when its operational
gate passes. Do not confuse provisional threshold success with approved
historical capability certification.
