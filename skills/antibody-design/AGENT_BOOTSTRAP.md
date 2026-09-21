# Agent bootstrap: sandboxed Protenix antibody run

1. Choose one authorized local or remote NPU Runner and use its `runner_id` for
   every environment, Shell, and workspace-sync call.
2. Require the target PDB, framework PDB, and explicit chain-labelled hotspot
   list before preparing a run. If any is missing, ask the user and stop; do not
   infer hotspots or delegate the decision to a SubAgent.
3. Select and probe a managed scientific environment on the same Runner.
4. Create the workspace-relative config, then launch the frozen Skill
   entrypoint once with `--prepare-only` and `background=true`. The first run
   clones the pinned official MindScience and RFdiffusion `sharker` sources and
   applies the bundled RFdiffusion MindSpore Tensor-to-PDB compatibility patch
   before downloading the three official RFdiffusion, ProteinMPNN, and
   Protenix checkpoints; existing checkouts are
   verified/re-pinned and verified files are reused in the same Session. The
   sandbox network allowlist must contain `gitcode.com`, `gitee.com`,
   `tools.mindspore.cn`, and
   `af3-dev.tos-cn-beijing.volces.com`. Keep the returned Execution ID and
   monitor it; never duplicate a queued, running, or unknown preparation.
5. Validate in the foreground, then launch the frozen Skill entrypoint once with
   `run_shell(scriptPath="$SCIENCEDISCOVERY_SKILLS_DIR/antibody-design/scripts/run_sandbox_pipeline.sh", arguments=["--config", "antibody_pipeline/config.json"], runner_id=..., environment_id=..., background=true)`.
6. Retain the returned Execution ID. Wait and monitor with
   `execution_status` / `execution_logs`; never use `nohup`, shell sleep loops,
   file polling, `run_npu_job`, or automatic replay.
7. Selected host NPU cards are renumbered inside the sandbox. Use logical
   `npus="0"` for one selected card or `"0,1,..."` for multiple selected cards.
8. Remote outputs must be pulled with `sync_remote_workspace` before they can be
   declared as local Project artifacts.
