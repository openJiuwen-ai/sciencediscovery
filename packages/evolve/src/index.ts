// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * `/evolve` as a capability package: the two LLM tools and nothing else.
 *
 * Registered the way `plan-mode` is — the composition root builds the runtime
 * and hands it over once; a deployment that does not build one simply gets no
 * tools. Before this, `WorkspaceAgentOptions` declared the two callbacks,
 * `createWorkspaceTools` constructed the tools, `buildTools` forwarded the two
 * fields by hand, and `EvolveToolDeps` was threaded through `executeAgentRun`,
 * `scheduleSessionRuns` and `streamAgentRun`. Five places had to agree, and
 * when one of them silently did not — an upstream route added a
 * `scheduleSessionRuns` call site without the deps — both tools vanished from
 * that path with no type error and no failing behaviour, only a missing
 * capability. Four of those five places are gone; the fifth — one factory,
 * still positional through the run layer — is declared required-but-nullable
 * there, so the omission that used to be silent is now a compile error.
 *
 * The runtime is per turn, not per process: `emit`, `beginExternalWait` and
 * `sessionId` all belong to the turn that is running. That is why the export
 * is a factory over a runtime rather than a value like `planRepository`.
 */

import { Type } from "typebox";

import type { EvolveRunProposal, EvolveRunProposalResult, EvolveRunSummary } from "@sciencediscovery/schema";
import type { AgentTool } from "@sciencediscovery/tools";

/** What the two tools need from the turn that is running them. */
export interface EvolveToolRuntime {
  /** Shapes one sentence of the create tool's description; the approval card
   *  is the user's, so the tool has to say which one they will see. */
  approvalMode?: "always_allow" | "ask_for_dangerous";
  /** Validate the proposal, run the discrimination probe, start the run. */
  createEvolveRun(input: EvolveRunProposal, signal?: AbortSignal): Promise<EvolveRunProposalResult>;
  /** Read one finished or running search back into the conversation. */
  getEvolveRun(runId?: string): Promise<EvolveRunSummary>;
}

/**
 * The capability's tools, or an empty list when the deployment has no evolve
 * runtime. Mirrors `createPlanLifecycleTools`: the caller spreads the result
 * into the tool registry, so "not registered" and "registered" differ by one
 * expression at the composition root and by nothing anywhere else.
 */
export function createEvolveTools(runtime?: EvolveToolRuntime): AgentTool[] {
  if (!runtime) return [];
  const tools: AgentTool[] = [];
  const getEvolveParameters = Type.Object({
    runId: Type.Optional(Type.String({
      description: "The id create_evolve_run returned (a UUID). Omit it to read this "
        + "session's most recent search — which is usually what \"how did it go\" means. "
        + "Do not invent one.",
      maxLength: 200, minLength: 1,
    })),
  });
  const getEvolveRun: AgentTool<typeof getEvolveParameters> = {
    description:
      "Read an evolution search's outcome: status, how many candidates ran, the best score "
      + "against the starting point, and the score on the test split that never took part in "
      + "the search. Call this when the user asks how a search went, or before summarising one "
      + "— a search runs for minutes after the turn that started it, so its result is never in "
      + "your context. Never describe an outcome you have not read. Do NOT call this to wait "
      + "for a search you just started: end that turn instead. The run's card streams live "
      + "progress to the user on its own, and polling here shows them nothing new while "
      + "spending the budget the search itself needs.",
    execute: async (_toolCallId, params) => {
      const summary = await runtime.getEvolveRun(params.runId);
      return { content: [{ type: "text", text: JSON.stringify(summary) }], details: summary };
    },
    label: "Read evolution run",
    name: "get_evolve_run",
    parameters: getEvolveParameters,
  };
  tools.push(getEvolveRun);
  const evolveParameters = Type.Object({
    caseSplit: Type.Optional(Type.Object({
      gateGroups: Type.Integer({ maximum: 64, minimum: 4 }),
      rolloutGroups: Type.Integer({ maximum: 64, minimum: 1 }),
      testGroups: Type.Integer({ maximum: 64, minimum: 0 }),
    })),
    datasetPath: Type.Optional(Type.String({
      description: "dataset_metric only: the CSV to score against. Relative to the workspace, "
        + "or the /workspace/... path as you saw it in a tool result — both are accepted. "
        + "A custom_script evaluator reads nothing: it builds case `i` from the shard index.",
      maxLength: 2_000, minLength: 1,
    })),
    direction: Type.Optional(Type.Union([Type.Literal("maximize"), Type.Literal("minimize")])),
    entrypointPath: Type.Optional(Type.String({
      description: "test_gate only: which file in the project a candidate replaces. "
        + "Not where an evaluator lives — a custom_script evaluator is passed verbatim "
        + "in evaluatorSource and never read from a path.",
      maxLength: 2_000, minLength: 1,
    })),
    evaluatorSource: Type.Optional(Type.String({
      description: "custom_script only: the whole evaluator, verbatim. It is executed as a "
        + "script with __name__ == \"__main__\" (runpy.run_path), with the scratch directory "
        + "first on sys.path — so top-level code runs, a `if __name__ == \"__main__\":` guard "
        + "runs, and `import candidate` resolves. It runs ALONE in that "
        + "scratch directory with the candidate — it cannot see the workspace and cannot be "
        + "given a data file, so it BUILDS case `i` from the shard index rather than reading "
        + "it. Import the candidate "
        + "as `candidate` — guard that import, since a broken candidate can raise there, "
        + "before any per-case try/except can reach it, and score it WORST (0.0 on a "
        + "larger-is-better scale) rather than best; score only the shards listed in "
        + "SCIENCE_AGENT_SHARDS (the shard is "
        + "an index, and what index i means is the evaluator's choice — generate case i, or "
        + "look it up); write {\"valid\": true, \"metrics\": {\"score\": 0.83}} to the path "
        + "in SCIENCE_AGENT_RESULT. Score is 0-1, larger is better. Also write an `error` "
        + "string carrying each failure's own MESSAGE — repr(e) or a trimmed "
        + "traceback.format_exc(), never bare type(e).__name__: that is the only channel to "
        + "whoever writes the next candidate, and six identical \"IndexError\"s give it "
        + "nothing to fix, so it discards the approach and re-rolls instead of repairing.",
      maxLength: 200_000, minLength: 1,
    })),
    expansions: Type.Integer({ maximum: 40, minimum: 1 }),
    frozenGlobs: Type.Optional(Type.Array(Type.String({ maxLength: 500, minLength: 1 }), { maxItems: 50 })),
    howScored: Type.String({ maxLength: 400, minLength: 1 }),
    judgeModelId: Type.Optional(Type.String({ maxLength: 200, minLength: 1 })),
    metric: Type.Optional(Type.String({
      description: "dataset_metric only: accuracy / mae / r2 / rmse / seconds.",
      maxLength: 40, minLength: 1,
    })),
    mode: Type.Union([
      Type.Literal("dataset_metric"), Type.Literal("test_gate"),
      Type.Literal("custom_script"), Type.Literal("llm_judge"),
    ], {
      description: "Take the first that fits, in this order. dataset_metric: cases with known "
        + "answers and a number to move — generate the table if it does not exist yet, that is "
        + "still this mode. test_gate: correctness pinned down by tests, and whenever the user "
        + "says \"write tests\" or \"make these pass\". custom_script: the FALLBACK, for when "
        + "neither fits — you write and own the measuring apparatus, so every mistake in it is "
        + "yours, and the framework can no longer do the splitting or the freezing for you. "
        + "llm_judge: only when quality is a reading rather than a computation.",
    }),
    normalize: Type.Optional(Type.Union([
      Type.Literal("identity"), Type.Literal("reciprocal"),
      Type.Literal("relative_to_baseline"), Type.Literal("clamp"),
    ])),
    packages: Type.Optional(Type.Array(Type.String({ maxLength: 80, minLength: 1 }), { maxItems: 20 })),
    risks: Type.Optional(Type.Array(Type.String({ maxLength: 400, minLength: 1 }), { maxItems: 2 })),
    rubric: Type.Optional(Type.String({ maxLength: 100_000, minLength: 1 })),
    scaleMax: Type.Optional(Type.Number({ maximum: 100, minimum: 1 })),
    search: Type.Optional(Type.Object({
      cPuct: Type.Optional(Type.Number({
        description: "Exploration constant, default 1.0. Exploitation is the candidate's RANK "
          + "in [0,1]; this scales the exploration term against it, and that term is worth "
          + "about cPuct/sqrt(nodes) at one visit — so it decides between candidates the "
          + "ranking left close together and never overturns a clear one. Lower (0.3-0.7) "
          + "when the gate is large enough to trust and the budget is small: climb the "
          + "lineage that works. Higher (1.5-2.5) when the scoring is noisy or several "
          + "candidates keep tying, which means the ranking is not telling you much. Leave "
          + "it out when neither is true.",
        maximum: 10, minimum: 0.01,
      })),
      priorExponent: Type.Optional(Type.Number({
        description: "How sharply the model's own rating of a direction aims the search, "
          + "default 0. At 0 nothing is asked and every node gets the uniform 1/N — that is "
          + "upstream and it is fine. Above 0 the mutation prompt gains one line asking the "
          + "model to end its reply with PROMISE: <n> (1-10, how far this APPROACH could go "
          + "after further work, not how good this draft is), and that number becomes the "
          + "prior. It rides the reply the search was already paying for, so it costs no "
          + "extra call. 2 is upstream's own non-zero setting: a candidate rated 8 against a "
          + "mean of 5.5 then gets 2.12x the exploration term and a dead end rated 2 gets "
          + "0.13x — aiming rather than merely widening. Set it when you expect the model to "
          + "be able to tell a promising direction from a dead end on THIS task; leave it at "
          + "0 when you do not.",
        maximum: 4, minimum: 0,
      })),
    }, {
      description: "How the search spends its exploration budget. Omit unless something about "
        + "THIS task argues against the defaults — they are upstream's and they are fine.",
    })),
    split: Type.Optional(Type.Object({
      // The gate is what every candidate's score is measured on — what the
      // tree ranks and selects by — so it is the split that must be largest,
      // and the floor under it is the highest of the three.
      gateShards: Type.Integer({ maximum: 64, minimum: 8 }),
      // Minimum 4, like the gate. These are what the tree ranks candidates
      // with, and one of them means every candidate is compared on a single
      // measurement — a coarse metric then gives them all the same number.
      // Observed: rolloutShards 1, five candidates, all exactly 0.6000.
      rolloutShards: Type.Integer({ maximum: 64, minimum: 4 }),
      seed: Type.Integer({ maximum: 2 ** 31, minimum: 0 }),
      shardRows: Type.Integer({ maximum: 100_000, minimum: 1 }),
      testShards: Type.Integer({ maximum: 64, minimum: 0 }),
      trainRows: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
    })),
    startingPointPath: Type.Optional(Type.String({
      description: "The workspace file the search starts from and rewrites. Relative, or the "
        + "/workspace/... path as you saw it in a tool result. Use startingPointText instead "
        + "when you are writing the starting point rather than pointing at one. Whichever you "
        + "use, the seed must already contain the mechanism being improved in its feeblest "
        + "form — seed a working RLE, not an identity function; a seed with no mechanism makes "
        + "every candidate invent one from scratch, and most of those do not run.",
      maxLength: 2_000, minLength: 1,
    })),
    startingPointText: Type.Optional(Type.String({ maxLength: 200_000, minLength: 1 })),
    statement: Type.String({ maxLength: 2_000, minLength: 1 }),
    targetColumn: Type.Optional(Type.String({ maxLength: 200, minLength: 1 })),
    testCmd: Type.Optional(Type.String({ maxLength: 2_000, minLength: 1 })),
    thinking: Type.Optional(Type.Union([Type.Literal("disabled"), Type.Literal("enabled")], {
      description: "Default \"disabled\", and leave it there unless the user asks. Enabling it "
        + "raises the per-call ceiling to 96k and has been measured turning a 20-second "
        + "mutation into one that never returns: the model spends the whole budget reasoning "
        + "and the search makes no progress at all.",
    })),
    workers: Type.Integer({ maximum: 8, minimum: 1 }),
  });
  const createEvolveRun: AgentTool<typeof evolveParameters> = {
    description:
      "Start an evolution search: repeatedly rewrite a program (or a piece of writing) "
      + "and keep what scores better on a held-out split. "
      + `${runtime.approvalMode === "always_allow" ? "Starts immediately." : "Creates an approval card the user confirms."} `
      + "You design the whole run — read the workspace and the conversation, then run your evaluator "
      + "**once** with run_python, against the starting point, to confirm it executes and emits a "
      + "number. Do NOT also score a deliberately broken copy: this call runs a discrimination probe "
      + "that does exactly that on the real shards in the real sandbox, and returns both numbers. Your "
      + "run_python environment and the candidate sandbox are different places with different shard "
      + "indices, so a local second opinion can disagree with the probe and send the turn into "
      + "reconciling them instead of into the search. When they disagree, the probe is right. "
      + "What you verify is the SCORING, never the answer: do not go "
      + "looking for a candidate that beats the starting point first — that is this tool's entire "
      + "job, and doing it by hand costs the turn and then forces you to either discard the result "
      + "or seed it, which spends the search space before the search starts. Load the evolve-design "
      + "skill first — it carries the sizing rules "
      + "and the failure modes worth knowing. Consult it, not your instincts, for how much data to "
      + "hold out.",
    execute: async (_toolCallId, params, signal) => {
      const proposal = params as unknown as EvolveRunProposal;
      const result = await runtime.createEvolveRun(proposal, signal);
      // A refusal is data, not an exception: the probe is *meant* to catch a
      // scoring scheme that cannot rank, and throwing would make the agent
      // treat its own design mistake as a broken tool.
      if (result.refusedBecause) {
        return {
          content: [{ type: "text", text: `the search did not start: ${result.refusedBecause}` }],
          details: result,
        };
      }
      const probe = result.probe;
      const verdict = probe
        ? `Discrimination probe: starting point ${probe.baseline.toFixed(4)}, ${probe.label} ${
          probe.worsened === null ? "did not run" : probe.worsened.toFixed(4)}`
        : "";
      return {
        content: [{ type: "text", text: [
          `Search created: ${result.run?.id ?? "(no id)"}`,
          verdict,
          // The last thing the model reads before deciding what to do next.
          // Left off, it waits: calls get_evolve_run, sees "running", calls it
          // again — showing the user nothing the live card is not already
          // showing them, and spending the budget the search itself needs.
          "Report those two numbers to the user and then end the turn. The search runs for "
          + "minutes to hours and its card streams live progress on its own — do not wait "
          + "for it here, and do not poll get_evolve_run.",
        ].filter(Boolean).join("\n") }],
        details: result,
      };
    },
    label: "Create evolution run",
    name: "create_evolve_run",
    parameters: evolveParameters,
  };
  tools.push(createEvolveRun);
  return tools;
}
