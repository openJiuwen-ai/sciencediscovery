# Agent bootstrap - Broker-only Protenix antibody run

This ScienceDiscovery stack must run real Ascend Protenix antibody work through the Runner NPU Broker.

Immediate rules:

1. Use `run_npu_job`, workload `antibody.protenix.v1`, for the real RFdiffusion -> ProteinMPNN -> Protenix -> screening pipeline.
2. Do not use `host_bridge`, `host_launch_request.json`, `run_shell`, `nohup`, `tail -f`, device passthrough, or a persistent kernel to launch model/NPU work. `run_shell` on the local Runner is only for small input/checkpoint files, import probes and one sleep TICK per monitoring cycle, as described in `SKILL.md`.
3. Do not write host paths into `config.json`. MindScience, RFdiffusion, ProteinMPNN, Protenix, checkpoints, HMMER, CANN, and the manager entrypoint are operator-controlled deployment assets injected by the Broker. Never set `models_dir`, `protenix_dir`, `protenix_ckpt`, `protenix_ckpt_url`, or `ckpt`.
4. There is no default antigen/framework PDB. If the user has not provided a target antigen PDB, antibody framework PDB, and chain-labelled hotspot list, stop and ask for the missing input.
5. Use one `hotspots` field with the user's original target-PDB chain labels and residue numbers, for example `B45,B46,B49` or `[B45,B46,B49]`. Do not create `screen_hotspots` or convert chain/residue labels yourself. Keep `diffuser_t` at least `15`.
6. Respect user-requested device IDs through `npus`, for example `"0"` or `"0,1,2,3"`. RFdiffusion uses `workers_per_npu`; Protenix runs one concurrent inference per listed NPU and batches additional designs round-robin.
7. Select a ScienceDiscovery managed environment ID from `environment_list(runner_id="local")` before submitting. Probe its latest state with `run_shell(runner_id="local", environment_id=..., command=...)` and the dependency check from `SKILL.md`; never submit with a host venv. The API resolves the latest Revision internally; submit rejects `environment_revision_id`.
8. If `run_npu_job` is missing, or `antibody.protenix.v1` is not listed by `run_npu_job(operation="list_workloads")`, stop and report that the active stack is not Protenix-broker-enabled.
9. After submitting a Broker job, keep monitoring it in this same main Agent until the state is terminal: `succeeded`, `failed`, `cancelled`, or `interrupted`. Do not answer as if the task is done while the job is still `queued` or `running`.

Fast path for a one-design smoke/e2e with user-provided PDBs:

- Call `run_npu_job(operation="list_workloads")`.
- Select/probe a managed scientific environment; keep the passing environment ID, not `currentRevisionId`. Use `environment_create` / `environment_install` for dependency changes, then re-probe that ID.
- Create only `antibody_pipeline/config.json` with session-local scientific inputs, for example:

```json
{
  "workspace": "antibody_pipeline",
  "target_pdb": "antibody_pipeline/inputs/target_antigen.pdb",
  "framework_pdb": "antibody_pipeline/inputs/antibody_framework.pdb",
  "hotspots": "[B45,B46,B49]",
  "num_designs": 1,
  "run_name": "custom-antigen-protenix",
  "npus": "0",
  "workers_per_npu": 1,
  "final_step": 160,
  "diffuser_t": 200,
  "force": false
}
```

- Submit once with `run_npu_job(operation="submit", workload_id="antibody.protenix.v1", config_path="antibody_pipeline/config.json", environment_id="<passing-environment-id>")`.
- Immediately use `run_shell` in the same local workspace/environment to save the returned Broker job ID in `antibody_pipeline/broker_job.json`; recover it from that checkpoint rather than resubmitting.
- Monitor with `run_npu_job(operation="status", job_id="<job-id>")` and `run_npu_job(operation="logs", job_id="<job-id>")` until terminal state. While `queued` or `running`, keep monitoring and report concise stage/count/log changes; do not stop with only the job ID.
- Between checks, use the single `run_shell` sleep TICK from `SKILL.md`. If Shell returns `running`, query its Execution ID with `execution_status`; do not start another TICK. Never use a shell loop, `tail -f`, or the Shell Execution ID as the Broker job ID.
- Call `run_npu_job(operation="result", job_id="<job-id>")` only after a terminal `succeeded` state.
