---
name: antibody-design
description: Prepare, launch, monitor, and summarize the real RFdiffusion to ProteinMPNN to Protenix antibody pipeline on a local or remote ScienceDiscovery Runner with sandboxed Ascend NPUs.
---

# Sandboxed Ascend antibody Protenix pipeline

Run the model pipeline as one managed background Shell Execution. Use the same
Runner and managed scientific environment for preparation, validation, launch,
monitoring, and output transfer.

## Execution contract

- Launch model/NPU work only with `run_shell(background=true)` and the bundled
  `scripts/run_sandbox_pipeline.sh`. Do not use `run_npu_job`, a host bridge,
  `nohup`, a persistent kernel, or an Agent-authored copy of the bundled scripts.
- Select `runner_id` from the Runners authorized for the Session. Do not hardcode
  `local`. A remote Runner has an independent workspace and independent managed
  environments.
- Retain the returned Shell Execution ID. Monitor it with
  `execution_status` and `execution_logs`; these calls do not take the workspace
  write lock. Never submit the pipeline again because a wait ended or an
  execution is `unknown`.
- Model code, checkpoints, input PDBs, and outputs must resolve inside the
  selected Runner workspace. Put model assets below
  `antibody_pipeline/models/`. Config paths are workspace-relative. Do not use
  host absolute paths, symlink escapes, `python`, `scripts_dir`, `pipeline_env`,
  or `cann_set_env` in `config.json`.
- Python packages belong to the selected Runner's managed scientific
  environment. Install or update them through `environment_*`, never with pip,
  conda, or an environment activation script inside `run_shell`.
- The NPU cards selected for a Runner are exposed inside the sandbox as logical
  devices `0..N-1`. `npus` uses those sandbox-local IDs, not the host's physical
  card numbers. If one card is selected, use `"0"`.
- There is no default antigen or antibody framework. Require a target PDB,
  framework PDB, and chain-labelled hotspots such as `[B45,B46,B49]`.
- Treat a missing target, framework, or hotspot list as missing user input. Stop
  and ask for that input; do not infer an epitope, launch a SubAgent, search the
  web, or choose residues from geometry without an explicit user request.
- On first use in a Session, prepare model code and checkpoints inside the
  selected Runner workspace with the bundled `--prepare-only` entrypoint. It
  uses pinned official sources, applies the bundled RFdiffusion MindSpore
  Tensor-to-PDB compatibility patch, downloads the official RFdiffusion,
  ProteinMPNN, and Protenix checkpoints, verifies their size and SHA-256, and
  reuses verified files on later runs in the same Session. Do not invent mirror
  URLs, scan unrelated host paths, or copy assets from another Session.

## 1. Choose and prepare the Runner

Use the Runner catalog in the `run_shell` / `environment_list` tool schema and
the Session settings. Choose the machine requested by the user, or the single
authorized NPU Runner. Keep its ID as `<runner-id>` for every Runner-scoped call.

For a remote Runner:

1. Call `sync_remote_workspace(operation="list", runner_id="<runner-id>")`.
2. Push only missing local inputs with `operation="push"`. Model repositories
   and checkpoints already present in this Session's remote workspace should
   stay there; do not copy them back and forth.
3. Use remote-workspace paths in `config.json`. Local file tools cannot inspect
   remote-only files.

Before preparation, check the three required user inputs. If one is missing,
ask once and stop this run. The first preparation needs outbound access to the
official `gitcode.com`, `gitee.com`, `tools.mindspore.cn`, and
`af3-dev.tos-cn-beijing.volces.com` domains. The last domain is used by
Protenix for its CCD cache. If the Session sandbox network policy does not
allow these domains, report the required allowlist change before launching the
download. Do not switch the sandbox to unrestricted network access.

The user or operator must select usable Ascend cards for that Runner in system
settings before launch. The sandbox receives only those cards and renumbers
them from zero.

## 2. Select and probe the managed environment

Call `environment_list(runner_id="<runner-id>")`. Probe a candidate environment
on the same Runner with a short foreground `run_shell` call and keep its
environment ID. The environment must provide the packages in `requirements.txt`.
Always pass that explicit `environment_id` to the probe; never validate against
the Runner's starter/default Python. Probe ready task environments whose names
identify this antibody pipeline first (for example, a name containing
`antibody`), then probe the remaining ready task environments if needed. After
one candidate fails, continue to the next candidate instead of inspecting model
source or the uploaded PDBs for a Python dependency problem.
Validate that complete, single-source dependency manifest with the selected
environment's Python:

```sh
python "$SCIENCEDISCOVERY_SKILLS_DIR/antibody-design/scripts/validate_managed_environment.py" \
  "$SCIENCEDISCOVERY_SKILLS_DIR/antibody-design/requirements.txt"
```

The validator reads every dependency and exact pin directly from
`requirements.txt`; do not maintain a separate partial package list.

If no environment passes, create or update one on the same Runner with
`environment_create` / `environment_install`, then probe it again. For a remote
Runner, push any workspace-local wheel before installing it.

## 3. Prepare workspace models and config

Recommended layout on the selected Runner:

```text
antibody_pipeline/
  config.json
  inputs/
    target_antigen.pdb
    antibody_framework.pdb
  models/
    mindscience/
      MindSPONGE/applications/{rf_diffusion,proteinmpnn,protenix}/
  runs/
```

The default checkpoint locations are:

```text
antibody_pipeline/models/mindscience/MindSPONGE/applications/rf_diffusion/models/RFdiffusion_Ab.ckpt
antibody_pipeline/models/mindscience/MindSPONGE/applications/protenix/release_data/checkpoint/ms_model_v0.5.0.ckpt
```

Create `antibody_pipeline/config.json` from
`references/real_pipeline_config.example.json`. A minimal config is:

```json
{
  "workspace": "antibody_pipeline",
  "mindscience_root": "antibody_pipeline/models/mindscience",
  "target_pdb": "antibody_pipeline/inputs/target_antigen.pdb",
  "framework_pdb": "antibody_pipeline/inputs/antibody_framework.pdb",
  "hotspots": "[B45,B46,B49]",
  "num_designs": 1,
  "run_name": "custom-antigen-protenix",
  "npus": "0",
  "workers_per_npu": 1,
  "protenix_use_msa": false,
  "protenix_n_sample": 1,
  "protenix_seeds": "42",
  "final_step": 160,
  "diffuser_t": 200,
  "force": false
}
```

Keep the user's original target-PDB chain labels and residue numbers in
`hotspots`. Validation rejects hotspot labels that do not exist as CA residues
in the uploaded target PDB and reports its available chains before any model is
launched. Keep `diffuser_t >= 15`. Reusing a run name with `force=true`
deletes that run's existing stage outputs, so require explicit overwrite intent.

Run first-use preparation as a managed background Shell Execution on the same
Runner and managed environment:

```text
run_shell(
  scriptPath="$SCIENCEDISCOVERY_SKILLS_DIR/antibody-design/scripts/run_sandbox_pipeline.sh",
  arguments=["--prepare-only", "--config", "antibody_pipeline/config.json"],
  runner_id="<runner-id>",
  environment_id="<environment-id>",
  background=true
)
```

Retain the returned Execution ID and wait with `execution_status` while reading
incremental `execution_logs`. Never resubmit preparation because one wait
expired. Preparation checks out the pinned MindScience revision, installs the
pinned RFdiffusion `sharker` source package, and downloads the official
RFdiffusion and Protenix checkpoints to their default locations. Existing
MindScience and `sharker` Git checkouts are verified and moved to their detached
pins when necessary; the package is copied to RFdiffusion's expected
`env/sharker` path. A non-Git source directory is rejected instead of silently
reused.
Each download uses a `.part` file and becomes visible only after its expected
size and SHA-256 match. Existing verified checkpoints are reused. A fresh
Session has a fresh Workspace and therefore downloads once again; sharing model
assets across Sessions is outside this Skill.

After preparation completes with exit code 0, run foreground validation below.
If preparation fails, report its Execution ID and the network, Git, disk-space,
or checksum error from its log. Do not search unrelated mount points or replace
the official URLs.

## 4. Validate and launch once

Run a foreground validation on the selected Runner and environment:

```text
run_shell(
  scriptPath="$SCIENCEDISCOVERY_SKILLS_DIR/antibody-design/scripts/run_sandbox_pipeline.sh",
  arguments=["--validate-only", "--config", "antibody_pipeline/config.json"],
  runner_id="<runner-id>",
  environment_id="<environment-id>",
  wait_ms=30000
)
```

For the actual run, remove `--validate-only`, use `background=true`, and omit
`wait_ms`. The wrapper validates every input before replacing itself with the
pipeline process. Retain the returned `<execution-id>`.

For a smoke test, use one design, one selected card, `npus="0"`, and one RF
worker. For a multi-card run, select the cards on that Runner first and use the
corresponding sandbox-local sequence such as `"0,1,2,3"`.

## 5. Monitor the existing execution

Use only the management channel while the workspace-owning execution runs:

```text
execution_status(execution_id="<execution-id>", wait_ms=30000)
execution_logs(execution_id="<execution-id>", cursor=<nextCursor>)
```

Continue from the returned `nextCursor`. Status `queued` or `running` means the
same command is alive; wait on it again with the positive `wait_ms` shown above.
This blocking management wait is designed to repeat for jobs longer than five
minutes. The framework also emits a completion notification, but inspect the
recorded status after that notice.

Terminal handling:

- `completed`: require `provenance="committed"` and exit code 0, then inspect
  `result.createdFiles` and the final logs.
- `failed` or `cancelled`: report the Execution ID, failing stage, exit code,
  and short error log. Do not launch a replacement automatically.
- `unknown`: list this Agent's executions with `execution_status()` and inspect
  logs. Unknown does not authorize replay. If cancellation is needed, call
  `execution_cancel` and keep checking until terminal.

Do not launch a second Shell to poll files during the run: the active execution
owns the workspace write lease. Stage changes and counts are already printed to
the managed execution log.

## 6. Return outputs

After a local execution completes, declare the screening report, summary CSV,
and selected result structures from `result.createdFiles` with
`declare_artifact`.

After a remote execution completes, pull only the outputs the user needs with
`sync_remote_workspace(operation="pull", runner_id="<runner-id>", paths=[...])`,
verify the transfer result, and then declare those local files as artifacts.
Remote files are not artifacts until they are pulled and declared.

Success requires equal RFdiffusion, ProteinMPNN, Protenix-input, and Protenix-
confidence counts for `num_designs`, plus both files below:

```text
antibody_pipeline/runs/<run_name>/05_screening/protenix_screening_report.md
antibody_pipeline/runs/<run_name>/05_screening/protenix_screening_summary.csv
```

Zero candidates passing the scientific screen is valid when every pipeline
stage and both screening reports completed. A hotspot mapping error is a failed
screening run, not zero contacts.
