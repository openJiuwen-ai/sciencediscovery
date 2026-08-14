---
name: antibody-protenix-pipeline
description: Prepare, submit, monitor, and summarize the real RFdiffusion to ProteinMPNN to Protenix antibody pipeline through the ScienceDiscovery Runner NPU Broker, including custom workspace-local antigen PDBs and chain-labelled epitopes.
---

# Real Ascend Antibody Protenix Pipeline - Broker only

Use this skill for the Protenix-backed antibody workflow. All model/NPU execution goes through `run_npu_job` with workload `antibody.protenix.v1`.

## Non-negotiable rules

- Never use `host_bridge`, `host_launch_request.json`, `run_shell`, `run_python`, a persistent kernel, `nohup`, or device passthrough to launch model/NPU work.
- This skill is authoritative for a Protenix Broker run. If legacy antibody/host-setup skills are also selected, do not follow their host-shell launch, polling, or artifact workflow; use only the Broker workflow in this file.
- `run_python` may create or inspect small workspace files, create small workspace directories, write `config.json`, probe imports in a selected scientific environment revision, run the read-only progress probe in step 5, and run the sleep TICK in step 5. Never use it to launch model/NPU work or reconstruct bundled scripts/PDB examples. Do not call `run_shell` for `mkdir`, waits, or other housekeeping.
- Do not manually copy files from `scripts/` / `resources/` with `read_skill_resource`; those package files are for the Broker adapter and operator deployment path, not for Agent-authored execution.
- There is no default antigen/framework PDB. If the user has not provided `target_pdb`, `framework_pdb`, or chain-labelled `hotspots`, stop and ask for the missing scientific input. Do not run a bundled example.
- Do not place or guess host paths for MindScience, RFdiffusion, ProteinMPNN, Protenix, checkpoints, HMMER, CANN, Python, or PDB files in `config.json`. Operator assets are injected by the Broker; scientific PDB inputs must be Session workspace-local relative paths. In particular, never set `models_dir`, `protenix_dir`, `protenix_ckpt`, `protenix_ckpt_url`, or `ckpt`; the manager treats these as operator-only and rejects them in Broker mode.
- Do not edit the operator-provided Protenix checkout for Python 3.12 compatibility. The deployed `protenix_py312_compat.py` entrypoint handles integral float bounds such as `random.randint(0, 1e6)` inside the Protenix process.
- Submit exactly once. If the job reaches `failed`, `cancelled`, or `interrupted`, do not edit paths and do not submit a replacement job in the same run. Return the job ID, exact error, failed stage, and next repair action to the user.
- Keep monitoring in the main Agent until the Broker job reaches a terminal state. Submitting the job and then ending the turn while it is still `queued` or `running` is an incomplete run, not a successful handoff. Do not delegate an NPU job to `task` or another subagent, because subagents have private workspaces and cannot safely create or declare files in the parent workspace.
- Immediately after a successful submit, write the returned Broker job ID to `antibody_pipeline/broker_job.json` with `run_python`. This small workspace-local checkpoint is mandatory for long runs because the Agent context may be compacted while the NPU job continues. Before every later `run_npu_job(status/logs/result/cancel)` call, verify that the `job_id` argument is the exact UUID returned by submit or read from `antibody_pipeline/broker_job.json`; if you are uncertain, read that file first. Never call `run_npu_job(status/logs/result/cancel)` with a placeholder job ID such as `JOB_ID_PLACEHOLDER` / `__JOB_ID_PLACEHOLDER__`, and never resubmit just to recover a job ID.
- Workspace files never establish completion. Only Broker `status`/`logs` can say the job is terminal. A progress probe that sees `05_screening` files, expected CIF/PDB counts, or quiet logs is a reason to call `status` next, not a reason to write a report or declare artifacts.
- After Broker `status` returns `succeeded`, the **next tool call** must be `run_npu_job(operation="result", job_id="<job-id>")`. This is the only call that automatically declares Broker `createdFiles` as Project Artifacts (all of them when there are 50 or fewer; the first 50 when there are more). `status=succeeded` does not declare files. Do not call `run_python`, `run_shell`, `declare_artifact`, write any summary/report file, or produce a final answer between successful terminal status and this `result` call. If more than 50 files were created, the final response MUST tell the user that Project Artifacts only show the first 50 files and that the rest are in the Session workspace.
- If `result` returns that the job is not terminal, the completion check was wrong: return to step 5 monitoring. Do not declare artifacts and do not write a summary.
- Before `result` succeeds, do not read generated structure/result file contents, do not read screening CSV/Markdown files, do not write any summary/report file under any name, do not call `declare_artifact` or `list_artifacts`, and do not reconstruct a final stage-count report. The one allowed write before `result` is the job-ID checkpoint in step 4.
- After `result`, treat `result.job.createdFiles`, `result.job.createdFiles.length`, and `result.artifacts` as the source of truth. Do not create an extra pipeline report. Do not replace `result` with a handful of manual `declare_artifact` calls. If `result.artifacts` is missing or empty after a succeeded job, report that artifact registration did not run; do not try to recover by declaring only screening Markdown/CSV.
- Report Protenix device placement only from explicit `device_target` / `device_id` lines in the Broker log. Never infer CPU or Ascend from duration, token counts, or a post-completion `npu-smi` snapshot.
- Do not switch to `antibody.pipeline.v1`. AlphaFold3 requests use the separate `antibody-real-pipeline` skill.

## Inputs

Confirm only missing scientific/run inputs:

- custom workspace-local target antigen PDB;
- custom workspace-local antibody framework PDB;
- one target-PDB epitope list using the original PDB chain label and residue numbers, for example `B45,B46,B49` or `[B45,B46,B49]`;
- design count;
- run name, using only letters, digits, dot, underscore, and hyphen;
- NPU selection and workers per NPU;
- overwrite permission when reusing a run name.

For a minimal e2e test use one design, NPU `0`, one worker, user-provided PDB inputs under `antibody_pipeline/inputs/`, and no overwrite unless explicitly requested.

## Required workflow

1. Call:

```text
run_npu_job(operation="list_workloads")
```

Stop if `antibody.protenix.v1` is absent. Do not attempt an alternative host execution path.

2. Resolve the Python environment before creating the job:

- Use the complete pip package list from `requirements.txt` when creating a revision: `mindspore==2.7.2`, `numpy==1.26.4`, `pandas`, `biopython==1.83`, `scipy`, `scikit-learn`, `pyyaml`, `hydra-core`, `omegaconf`, `ml-collections`, `dm-tree==0.1.8`, `optree`, `tqdm`, `attrs`, `decorator`, `matplotlib==3.9.2`, `safetensors`, `sympy`, `rdkit==2024.3.5`, `biotite==1.4.0`.
- Call `environment.list`, skip starter/non-scientific environments, and probe candidate `currentRevisionId` values by passing the small probe source to `run_python(environmentRevisionId=...)`.
- Prefer candidates whose environment name clearly identifies the antibody NPU managed environment, especially `antibody-npu-managed-clean`; do not choose an older similarly named environment until the clean/current candidate has been probed.
- If a candidate probe fails, record the missing package/version, then continue probing the next candidate. A single failed `run_python` probe is not terminal.
- Reuse only a revision whose probe prints `MANAGED_ENV_OK`.
- If every candidate fails, call `environment.create` for a named Python environment, then call `environment.install` with `manager="pip"` and the complete package list above. Probe the returned revision again. Never use `pip`, `pip --user`, a host venv, or `run_shell` for dependency installation.
- The deployed MindScience Protenix checkout requires `biotite==1.4.0` and `biotite.structure.io.pdbx.convert.PDBX_BOND_TYPE_ID_TO_TYPE`. Always run `managed_environment_probe.py` after installation. If a candidate revision has an older/incompatible Biotite, call `environment.install` with the complete package list from `requirements.txt`, not only the Biotite entry: installation creates a new immutable revision and the complete list keeps MindSpore, NumPy, and the remaining pipeline dependencies in that revision. Do not patch the Protenix checkout or fall back to a host Biotite package.
- Keep the passing revision ID as `<environment-revision-id>`. A missing/incompatible package is an environment setup task, not a reason to submit the NPU job early.

Use this probe source with `run_python`; dependency discovery must not depend on host `PYTHONPATH`:

```python
from importlib import import_module
from importlib.metadata import version
for module in ["mindspore", "numpy", "pandas", "Bio", "scipy", "sklearn", "yaml", "hydra", "omegaconf", "ml_collections", "tree", "optree", "tqdm", "attrs", "decorator", "matplotlib", "safetensors", "sympy", "rdkit", "biotite"]:
    import_module(module)
for distribution, expected in {"mindspore": "2.7.2", "numpy": "1.26.4", "dm-tree": "0.1.8", "rdkit": "2024.3.5", "biotite": "1.4.0"}.items():
    assert version(distribution) == expected, (distribution, version(distribution), expected)
from biotite.structure.io.pdbx import convert as pdbx_convert
assert hasattr(pdbx_convert, "PDBX_BOND_TYPE_ID_TO_TYPE")
print("MANAGED_ENV_OK")
```

3. Create only `antibody_pipeline/config.json`. The minimal form requires explicit workspace-local PDB inputs:

```json
{
  "workspace": "antibody_pipeline",
  "target_pdb": "antibody_pipeline/inputs/target_antigen.pdb",
  "framework_pdb": "antibody_pipeline/inputs/antibody_framework.pdb",
  "hotspots": "[B45,B46,B49]",
  "num_designs": 4,
  "run_name": "custom-antigen-protenix",
  "npus": "0,1,2,3",
  "workers_per_npu": 1,
  "final_step": 160,
  "diffuser_t": 200,
  "force": false
}
```

Paths authored by the Agent must be relative to the Session workspace. Upload PDB inputs under `antibody_pipeline/inputs/` and set `target_pdb` / `framework_pdb` to those relative paths. Do not add host asset paths or `python`.

`npus` is the comma-separated physical Ascend device list requested by the user, for example `"0"` for a one-card smoke test or `"0,1,2,3"` for a four-card run. For normal throughput tests on a four-card Ascend host, prefer `"npus": "0,1,2,3"` with `num_designs` at least `4`; for a quick smoke test only, reduce to `"npus": "0"` and `"num_designs": 1`. `workers_per_npu` controls RFdiffusion shard concurrency per listed NPU. Protenix inference runs one concurrent JSON job per listed NPU and batches the remaining JSON files round-robin across that list.

Use exactly one `hotspots` field for both RFdiffusion and screening. Keep the user's original target-PDB chain label and residue numbers; do not create `screen_hotspots`, rename the chain to `T`, or convert the residue numbers yourself. The pipeline writes an original-PDB-to-Protenix chain/residue map for each Protenix input and maps the requested residues to Protenix sequence positions internally; if mapping is missing or ambiguous, screening marks the row as a mapping failure instead of reporting zero contacts.
If every screened design has a hotspot mapping error, the screening step exits non-zero and the Broker job fails; report the exact `hotspot_mapping_error` instead of summarizing the run as a completed design.
`hotspots` accepts either `B45,B46,B49` or RFdiffusion bracket form `[B45,B46,B49]`; the manager normalizes it before launch. Keep `diffuser_t` at least `15` because RFdiffusion rejects smaller schedules.

For example, when the uploaded antigen is `antibody_pipeline/inputs/custom_antigen.pdb`, the uploaded framework is `antibody_pipeline/inputs/custom_framework.pdb`, its target chain is `B`, and the requested epitope is `B45,B46,B49`, use:

```json
{
  "workspace": "antibody_pipeline",
  "target_pdb": "antibody_pipeline/inputs/custom_antigen.pdb",
  "framework_pdb": "antibody_pipeline/inputs/custom_framework.pdb",
  "hotspots": "[B45,B46,B49]",
  "num_designs": 4,
  "run_name": "custom-antigen-protenix",
  "npus": "0,1,2,3",
  "workers_per_npu": 1,
  "final_step": 160,
  "diffuser_t": 200,
  "force": false
}
```

4. Submit once:

```text
run_npu_job(
  operation="submit",
  workload_id="antibody.protenix.v1",
  config_path="antibody_pipeline/config.json",
  environment_revision_id="<environment-revision-id>"
)
```

Record the returned job ID. Do not submit another job until this job reaches a terminal state; if it fails, this run must stop.

Immediately checkpoint the returned job ID:

```python
import json, os
record = {
    "job_id": "<returned-job-id>",
    "workload_id": "antibody.protenix.v1",
    "config_path": "antibody_pipeline/config.json",
    "run_name": "<run_name>"
}
os.makedirs("antibody_pipeline", exist_ok=True)
with open("antibody_pipeline/broker_job.json", "w", encoding="utf-8") as fh:
    json.dump(record, fh, indent=2)
```

This is a state checkpoint, not a result summary. It is allowed before the terminal `result` call. If later monitoring context loses the job ID, read `antibody_pipeline/broker_job.json` and continue monitoring the recorded job. Before typing any later Broker `job_id`, check that it is a real UUID from this checkpoint or the submit response. Do not use `JOB_ID_PLACEHOLDER` / `__JOB_ID_PLACEHOLDER__`, do not guess the job ID, and do not submit a replacement job.

5. Monitor continuously until Broker `status` is terminal.

A monitoring cycle is:

1. `run_npu_job(operation="status", job_id="<job-id>")` — required every cycle.
2. Optionally `run_npu_job(operation="logs", job_id="<job-id>")`.
3. Optionally one short read-only `run_python` progress probe.
4. If state is still `queued` or `running`, wait with one sleep TICK, then start the next cycle.

Do not skip `status` for several cycles and decide completion from workspace files. Keep calling `status` until it returns one of:

- `succeeded`
- `failed`
- `cancelled`
- `interrupted`

**Sleep TICK (normal wait).** Use a dedicated `run_python` call that only sleeps, then returns. Do not put this sleep in the progress probe, and do not wrap it in `for`/`while`:

```python
import time
time.sleep(100)
print("TICK", flush=True)
```

Forbidden wait patterns: `for`/`while` plus `sleep` inside one tool call; `run_shell sleep … && …`; `tail -f`; `watch`; combining status/probe/sleep into one `run_python`. One TICK per cycle is the correct wait.

**Progress probe (optional, for stage detail).** It may print file existence, paths, counts, log mtimes, per-stage output counts, and short log tails. It may list generated `*.pdb` / `*.cif` / `*.json` names. It must not open or print those files' contents, must not make scientific quality claims, and must not create/edit/delete/declare/launch anything. Reuse the same probe when that is the clearest comparison.

If a probe looks finished (`05_screening` present, expected design counts, logs stopped growing), the next tool call is still `status`. Do not write a summary, do not call `declare_artifact`, and do not give a final answer from the probe.

The Agent must not send a final answer while the job is still `queued` or `running`. During a long run, report Broker state, active stage, output counts, and a short log excerpt. One unchanged check is not a failure; TICK and check again.

For long end-to-end validation, external harnesses may also poll the Broker job, but the ScienceDiscovery skill itself remains responsible for monitoring its submitted job to terminal state.

6. At terminal state:

- `succeeded`: the next tool call is `run_npu_job(operation="result", job_id="<job-id>")`. That call declares Project Artifacts from `createdFiles`: every file when there are 50 or fewer, otherwise the first 50. Summarize stage counts from `result.job.createdFiles` / `result.job.createdFiles.length`, and report how many entries in `result.artifacts` have `ok:true`. If `createdFiles.length` is greater than 50, or `result.artifacts` contains a truncated entry, the final response MUST include this reminder: only 50 files are registered as Project Artifacts; the remaining files are in the Session workspace under `antibody_pipeline/runs/<run_name>/`, and `antibody_pipeline/artifact_manifest.txt` lists them. Tell the user to open the workspace files to find the rest, not only the artifact list. If `result` says the job is not terminal, return to step 5. Do not read screening CSV/Markdown from the workspace before `result`. Do not write any extra summary/report file. After `result` returns, you may read declared screening report/CSV artifacts for top-candidate details.
- `failed`, `cancelled`, or `interrupted`: stop immediately; do not rewrite config/scripts/PDB files and do not resubmit.

## Success criteria

- Broker state is `succeeded`.
- `run_npu_job(operation="result")` was called after that succeeded status and returned `result.artifacts`.
- RFdiffusion, ProteinMPNN, Protenix input/output counts equal `num_designs`.
- Screening reports exist below `antibody_pipeline/runs/<run_name>/05_screening/`.
- Screening rows contain non-empty `target_chain` / `binder_chain`, positive target/binder token counts, and the mapped `hotspot_sequence_positions`.
- Project Artifacts include the Broker `createdFiles` up to the 50-file declaration cap (all of them when there are 50 or fewer).
- When more than 50 files were created, the final response reminds the user that the remaining files are in the Session workspace, not missing.
- The final response is based on `run_npu_job(operation="result")`; it must not be based on an Agent-authored workspace scan or a separately written summary artifact.

Zero candidates passing the scientific screen is a valid result if all pipeline stages and reports completed.

## Failure interpretation

| Symptom | Meaning | Required action |
|---|---|---|
| `run_npu_job` missing or workload absent | Broker disabled or wrong stack | Stop and report deployment mismatch |
| no managed revision passes the dependency probe | Scientific environment is absent or incomplete | Create/update it with `environment.create` / `environment.install`, then probe the new revision before submission |
| missing target/framework PDB | User has not provided the required scientific PDB input, or the Agent did not write it into the Session workspace | Stop and ask the user for the missing PDB; do not run a default example |
| workspace input path error for a custom PDB | Agent-authored custom input is missing or escapes the Session workspace | Stop and report the offending relative input |
| hotspot is absent or insertion-code ambiguous | The requested original PDB residue cannot be mapped safely | Stop and ask the user to correct the target chain/residue list; do not guess a replacement residue |
| target chain or CIF atom mapping is empty/ambiguous | Screening cannot identify the Protenix target structure safely | Treat the job as failed and return the exact mapping error; do not report zero contacts |
| operator asset variable/path error | Server deployment configuration is incomplete | Stop and report the named variable/path to the operator |
| `Container ID verify failed` | Model was launched inside bwrap instead of Broker | Stop; report incorrect execution path |
| `Protenix jobs failed: ... launched X/Y, completed N, skipped M` | One or more parallel Protenix design jobs failed; fail-fast may have intentionally skipped unlaunched designs | Stop; return the failed design names, completed/skipped counts, job ID, stage, and short logs without resubmitting |
| workload exit code / model traceback | Host pipeline or model failure | Stop; return job ID, stage, and short logs without resubmitting |
| `result` says the job is not terminal | Status/probe completion check was early | Return to step 5; do not declare artifacts |
| succeeded job but `result` was never called, or `result.artifacts` is missing/empty | Automatic artifact declaration did not run | Call `result`; do not recover by declaring only screening Markdown/CSV |
