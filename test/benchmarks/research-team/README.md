# TC-E2E-01: research team extension

`test/science-research-team-real.spec.ts` exercises an actual Swarm main agent
and live-LLM specialists. It creates a local HTTP MCP `deliverable_check`, a
custom reviewer bound to that connector, and a managed extension of the built-in
`science-research-team`. Built-in specialists/skills are not edited.

The fixed question concerns 2020–2025 BRCA1 evidence and descriptive effect-size
analysis, followed by an exact-report section audit. Scientific sources and
model responses are real; only the deterministic local audit service is a test
fixture. The extension specifies artifact formats for verifiable handoffs.

## Run manually

Prepare the isolated Swarm stack as described in `../../../jiuwen_swarm/README.md`
(repository-root path: `jiuwen_swarm/README.md`), enable platform task delegation,
and configure the real generator with `E2E_LLM_MODEL_ID` or
`E2E_LLM_BASE_URL`, `E2E_LLM_MODEL`, `E2E_LLM_TOKEN`. Then:

```bash
node test/sync-e2e.mjs --write
E2E_RESEARCH=1 E2E_SWARM_TASK=1 npm --prefix .e2e run test:real -- science-research-team-real.spec.ts
```

The case is excluded from default collection/PR gates. Its run deadline is
`E2E_TEAM_RUN_TIMEOUT_MS` (default one hour); browser/cleanup allowance is four
minutes. No live credentials are committed. Keep result files and browser traces
private: model inputs can contain research content and environment information.

## Assertions and scope

- Verify extension/workflow context, all five built-in roles and the custom
  reviewer, and completion/handoff ordering rather than exact total child count.
- Check the reviewer's connector configuration, actual model-facing MCP tools,
  successful tool call, and full audited text matching the final report version.
- Require source/evidence packages, knowledge and analysis summaries, executed
  code, numerical results and evaluator output; recompute count/mean/min/max
  independently from the declared observations. Require a nontrivial group.
- Preserve the evaluator's original `decision` or `verdict`. The built-in
  evaluator can emit `CONDITIONAL`, unlike the team workflow's two-value
  contract; preserve that distinction. Loop limits are Skill instructions, not
  a runtime-enforced workflow state machine. This scenario requests one analysis
  loop with at most three evaluator calls; conditional revision checks do not
  guarantee the real model exercises the revision or cap branches.
- Verify report sections, source identifiers, actual audit, final handoff and UI
  artifact persistence. Section checking ignores prose and fenced examples.

The deterministic audit does not judge scientific truth. `quality=not_judged`
is recorded; there is no independent LLM Judge score in this case yet. Evidence
identifier/number consistency does not prove that each extracted claim is
supported by its source. An honest insufficient-data delivery is not a passing
complete-analysis case; failed checks remain visible rather than being waived.

Records: `team-metrics.json`, `team-children.json`, `team-artifacts.json`,
`team-trajectory-index.json`, `team-model-inputs.json`, `signoff-calls.json`, and
Playwright failure evidence. Usage is the platform's reported data, not a claim
that all child/provider tokens were counted. Configuration identities and the
final report hash/version are retained. Temporary resources are cleaned up.
