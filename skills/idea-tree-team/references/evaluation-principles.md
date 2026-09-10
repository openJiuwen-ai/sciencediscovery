# Optional Evaluation Principles

Use these principles only when the user prompt selects a multi-perspective evaluation workflow. They are not Runtime requirements.

## General Rules

1. Keep every reported score finite and inside the configured range.
2. State which rubric, evidence, or judgment produced the final leaf score.
3. Preserve disagreements between evaluators instead of silently averaging them away.
4. Do not fabricate sources, measurements, Specialist outputs, or Artifact identities.
5. When durable provenance is useful, declare exact outputs as Artifacts and checkpoint them; otherwise these steps may be skipped.
6. `idea_tree_finalize` accepts the claimed execution identity, final score, semantic insight, and optional exact Artifact identities. It does not require a particular evaluator count or schema.

## Optional Catalyst Triad

For prompts explicitly requesting the traditional catalyst review, three independent perspectives can cover:

- activity: catalytic activity, mechanism, selectivity, efficiency;
- stability: structural stability, durability, recyclability, lifetime;
- sustainability: environmental safety, lifecycle, disposal, resource use.

The workflow or prompt must define how these perspectives are combined. The Runtime does not assume the former `0.35 / 0.35 / 0.30` weighting.

## Artifact Guidance

If Artifacts are supplied to `idea_tree_finalize`:

- use exact `artifact_id`, `version_id`, and a meaningful workflow-defined `role`;
- submit at most one version of each Artifact;
- ensure each version comes from a completed Specialist execution in the same Session and executor contract;
- treat checkpoints as optional retry aids, not mandatory completion gates.
