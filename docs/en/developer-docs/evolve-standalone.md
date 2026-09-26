# Evolution sidecar: architecture, engines, and standalone deployment

> This is an engine-internal and deployment note for maintainers. For what `/evolve-design` is,
> when to use it, and how to run it, see [Program evolution](../core/evolve.md) and
> [Use PUCT to optimize a text compression algorithm](../domains/evolve-a-solution.md).

`services/evolve` is the Python FastAPI process that runs evolution searches. It supports two
engines:

- **PUCT** (`puct_engine.py`): flat-PUCT tree search, guided by visit counts and rank. It suits
  continuous refinement from one starting point.
- **OpenEvolve** (`openevolve_engine.py`): multi-island MAP-Elites search with ring migration,
  archiving candidates by code complexity and diversity. It suits broad spaces that converge
  prematurely.

The engines share the Domain seam (four scoring modes), event stream, sandbox, model proxy, and
probe. Only the algorithm core changes (`PuctTree` or `OpenEvolveArchive`). `algorithm` selects
one, and `/evolve-design` lets the user choose before sending a proposal.

This note answers two questions: how the engines differ, and what is required to run the sidecar
outside this repository. In short, **the code is already standalone**. The real work is in four
coupling points: shared filesystem access is hard; the other three are conventions.

## 1. Engine differences

Both engines share the Domain seam, events, sandbox, model proxy, and probe. They differ in state,
parent selection, mutation prompt, options, and emitted events.

| Aspect | PUCT | OpenEvolve |
|---|---|---|
| State | Append-only `PuctTree`; each candidate has a `parent_index`; visits guide later selection | `OpenEvolveArchive`: `num_islands` grids of `feature_bins × feature_bins`; a better candidate replaces a cell occupant; best candidates migrate around a ring every `migration_interval` |
| Parent | Highest flat-PUCT score: `rank_score + c_puct · prior · √total_visits / (1 + visits)` over leaves | Rotating island, ε-greedy selection (70% best, 30% random), plus a maximally different inspiration program |
| Prompt | `domain.prompt(parent.program)` | parent prompt plus archive context: global-best metrics and diverse inspiration code |
| Engine-specific options | `c_puct`, `prior_exponent` | islands, archive size, feature bins, exploitation ratio, migration interval, and model retry options |

PUCT uses `blast_radius: 1.0` and a `solved_threshold` of `2.0` (never skip); OpenEvolve uses
`0.6` and `1.0` (skip once optimal) because its shards are seeds for one objective. Both read
staleness policy from options. OpenEvolve defaults model retries/backoff to `2 / 1.0`.

PUCT emits `expanded` with depth, parent index, and score. OpenEvolve adds island, program ID, and
inspiration indexes, and emits `inserted` (complexity bin, diversity bin, island, insertion or
migration), `migrated`, and a `selected` event with no ancestor visits. The frontend therefore
shows a PUCT tree by depth, but an OpenEvolve timeline forest, island-grid view, and different
table columns.

## 2. How standalone it is today

| Area | Current state |
|---|---|
| Language/process | Python 3.12, independent virtual environment and process |
| Dependencies | `fastapi`, `uvicorn`, `pydantic`, `agentdescent>=0.4.6`; candidate runtime packages are optional groups, not sidecar dependencies |
| Node imports | None |
| Repository path dependencies | None in `pyproject.toml` |
| External surface | Four HTTP endpoints |
| Business state | None: goals, scorecards, artifact locations, and run records stay in the control plane |
| Model credentials | None: it receives only a run-scoped temporary token for the control-plane proxy |

`services/evolve/` can be copied unchanged to another repository and started after `uv sync` with
`uvicorn`; it simply needs a caller to supply valid requests.

## 3. External interface

All four endpoints use one shared internal token (`SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN`). If it is
unset, the process treats itself as local development and loopback binding is the only boundary.

```http
GET  /health                 → {engine, running, sandbox_local, status}
POST /probe                  → discriminative probe: {baseline, worsened, flat, label}
POST /runs                   → long-lived NDJSON event stream
POST /runs/{search_id}/stop  → stop a run
```

`POST /runs` (`RunRequest`) has four kinds of data:

- Plain cross-network data: search identity, engine and options, budget, statement, frozen
  scorecard, scorecard hash, baseline code and score, rubric, evaluator script, source material,
  limits, packages, and resume sequence. Scorecard and script are passed by value so the sidecar
  needs no CAS access.
- Filesystem paths: `dataset_dir` and `workspace_dir`. This is the sole hard coupling.
- Callback URLs and temporary credentials: `llm: {url, token}` and `judge: {url, token}`. URLs
  must be absolute so a remote sidecar need not guess an API origin.
- An upstream sandbox capability probe: `sandbox: {backend, ...}`. The control plane probes once;
  the sidecar does not repeat it.

## 4. Hard coupling: the shared filesystem

The control plane writes a materialized dataset and the sidecar reads its manifest:

```text
manifest.json
<criterionId>/train.csv
<criterionId>/<shard>/test.csv
<criterionId>/<shard>/truth.json
```

The control plane chooses seeds, rows per shard, and gate-shard indices. In `test_gate` mode,
`workspace_dir` is a clean project copy restored into one-use clones before execution.

In the reverse direction, the sidecar writes candidate source as
`evolve-candidates/<runId>/<sha256>.py`, and the control plane reads it directly through
`CandidateSources.read()`. The content-addressed layout is the only shared protocol. Candidates
do not enter CAS until a user saves one: most are rejected, and collecting all of them would fill
the content store with unwanted programs.

For a split deployment:

| Option | Cost | Suitable for |
|---|---|---|
| Keep a shared volume (NFS, one machine, or a Pod `emptyDir`) | No code change | Same-machine or same-Pod deployment |
| Upload datasets and return candidate sources | Multipart/object storage plus sources in `expanded` events or a candidate endpoint | A minimal cross-machine design |
| Use object-store references in both directions | Control plane writes URLs; sidecar downloads, and vice versa | Several replicas and horizontal scale |

## 5. Convention-level coupling

### Event contracts

`events.py` manually mirrors `EvolveEvent` and `EvolveEventRecord` in `packages/schema`; Node
parses those shapes. This is a reasonable same-repository tradeoff but becomes a compatibility
problem across repositories. A separated service needs a versioned stream, a shared published
contract (JSON Schema, protobuf, or paired npm/PyPI packages), or an additive-only rule with a
tolerant control plane. `RunRequest` has the same issue: Pydantic on one side and a hand-written
TypeScript body on the other.

### Cross-process invariants

Two rules are documented in the sidecar but enforced by the control plane:

1. Visit and cell-occupancy counters are absolute rather than incremental. Replaying an absolute
   value is safe; replaying a delta double-counts and prevents event-log recovery.
2. `-inf` never reaches the wire. Python serializes it as bare `-Infinity`, which is not valid
   JSON. Failed candidates use `score: null` and `valid: false` but remain in the tree, because
   dropping them changes later ranking denominators.

A standalone interface must state both explicitly.

### Vendored upstream code

`vendor/puct/` and `vendor/openevolve/` copy `agentdescent` examples because its wheel does not
package examples. A standalone backend therefore owns upstream synchronization. Existing alignment
already found a missing `sys.modules["candidate"]` registration, prior support, and a repair-loop
placement change. Record the upstream commit fingerprint and local diff in each `vendor/*/`'s
`__init__.py` and add periodic comparison in CI.

## 6. Control-plane responsibilities after a split

The sidecar does not implement proposal preflight, frozen scorecards, dataset sharding, sandbox
capability probing, model proxying, run persistence/replay, graph mirroring, or artifact
publication. New callers must implement those responsibilities. `/probe` is the exception: it
returns numbers, while the control plane still decides whether to accept them.

## 7. Minimal split checklist

Without code changes:

1. Copy `services/evolve/` and retain its `pyproject.toml`.
2. Start it with `SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN=... uvicorn sciencediscovery_evolve.server:app`.
3. Deploy on one machine or Pod with a shared `SCIENCE_AGENT_DATA_DIR`; the candidate directory can
   be specified separately with `SCIENCE_AGENT_EVOLVE_CANDIDATE_DIR`.

For cross-machine operation, upload or reference `dataset_dir`, return candidate sources through
an endpoint or events, and do the same for `workspace_dir` when using `test_gate`. Any independent
repository must version `RunRequest` and the event stream, document the two invariants above, and
track vendored upstream code in CI. The sidecar may later probe sandbox capability itself, but it
currently relies on the caller to avoid probing twice.

## 8. Known rough edges

- `options` is an untyped dictionary. It carries PUCT, execution-mode, staleness, archive, and
  model-retry settings; unknown keys are ignored. A misspelled cross-repository setting can then
  look successful.
- `algorithm` still accepts the old `era` alias after its rename to `puct`, because archived
  goals may contain it. A standalone service must set an alias-retirement policy.
- Mode is inferred from `workers` (`workers > 1` means `async_evolve`, otherwise `serial`), an
  implicit rule that interface documentation must state.
- `staleness_policy` defaults to `"full"`. Its comment says nothing should become stale, yet
  production observations lost proposals. Resolve that before making it an external contract.
