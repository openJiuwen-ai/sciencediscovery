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
 * Turning a proposal from the main agent into a run.
 *
 * The agent designs in the terms it has — text it just wrote, paths it just
 * read — and this is where those become the terms a run needs: content in the
 * store, a frozen scorecard, a hash. That translation is deliberately on this
 * side. An agent that could mint its own goal could also mint one whose scoring
 * it controls, and the whole design rests on the scoring being frozen *away*
 * from the thing being scored.
 *
 * **Every gate stays.** The discrimination probe runs here, not on trust: the
 * tool description tells the agent to check its own scoring with `run_python`
 * first, and that instruction is an efficiency measure, not a substitute. A
 * claim from the party being graded is not evidence. Pre-flight runs too, and
 * both refusals come back as text the agent can act on rather than as failures
 * — "your held-out set cannot tell good from bad" is a design note, and the
 * designer is right there in the loop.
 *
 * This replaced a separate drafting agent that had its own loop, its own
 * progress stream and its own copy of the workspace tools. What it could never
 * have was an interpreter: it wrote evaluators it could not run, so every
 * divide-by-zero and every too-easy sample set had to be discovered by the
 * probe and repaired in another round trip. The main loop has `run_python`.
 */

import type {
  EvolveCaseSplit,
  EvolveRunStatus,
  EvolveRunSummary,
  EvolveGoal,
  EvolvePriorFactor,
  EvolveRunProposal,
  EvolveRunProposalResult,
  EvolveScoring,
  EvolveSearchTuning,
  EvolveSplit,
  ScorecardCriterion,
} from "@sciencediscovery/schema";
import { SOLVED_THRESHOLD_BY_SCORING } from "@sciencediscovery/schema";

import type { EvolveOrchestrator } from "./orchestrator.js";
import { EvolveSidecarError } from "./sidecar.js";
import { preflight, type PreflightIssue } from "./preflight.js";
import { basename } from "node:path";


/** What the assembler needs from the world. Injected so the unit tests need no
 *  store, no sandbox and no model. */
export interface ProposalDeps {
  /** Puts text or a workspace file into the store; returns its `sha256:` ref. */
  store: (input: { content?: string; path?: string }) => Promise<string>;
  casHas?: (hash: string) => Promise<boolean>;
  model?: (id: string) => unknown;
  modelId: string;
  orchestrator: EvolveOrchestrator;
  sessionId: string;
}

/** The gate is what every candidate's score is measured on — the number the
 *  tree ranks, selects and reports on — so it is the split a shortage hurts
 *  most, and the floor under it is the highest. The agent is told the reasoning
 *  in the skill; this is the floor under that. */
const MIN_GATE = 8;

/** The rollout drives the search's own trajectory. Four is enough for two
 *  genuinely different candidates to land on different numbers; one is not. */
const MIN_ROLLOUT = 4;

/** The rollout is what the tree ranks candidates with, and it is the split
 *  people forget: the gate has a floor and this had none. One rollout unit
 *  means every candidate is compared on a single measurement, and a coarse
 *  metric then hands them all the same number — observed as five candidates
 *  scoring exactly 0.6000 with the whole budget spent. */
function splitTooThin(split: EvolveSplit): string | undefined {
  if (split.rolloutShards < MIN_ROLLOUT) {
    return `only ${split.rolloutShards} rollout shards means different candidates land on the `
      + `same score and the search has nothing to compare — use at least ${MIN_ROLLOUT}`;
  }
  if (split.gateShards < split.rolloutShards) {
    return `${split.gateShards} gate shards is fewer than the ${split.rolloutShards} rollout `
      + "shards. Every candidate's score — the number the tree ranks, selects and picks a "
      + "winner by — is measured on the gate alone, so it should be the largest of the three "
      + "rather than the smallest";
  }
  return undefined;
}




/**
 * A workspace path as the agent actually saw it, turned into one the store takes.
 *
 * The sandbox mounts the workspace at `/workspace`, so every path the agent
 * reads out of a tool result is absolute and starts there — writing it back
 * verbatim is the natural thing to do, and the store only accepts relative
 * paths. Stripping the mount point is not a weakening of that guard: anything
 * still absolute afterwards, and every `..`, is left for the guard to refuse.
 */
function workspaceRelative(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/workspace") return "";
  return trimmed.startsWith("/workspace/") ? trimmed.slice("/workspace/".length) : trimmed;
}

/** Which proposal field a path came from, so a refusal can name it. */
async function storePath(
  deps: ProposalDeps, field: string, path: string,
): Promise<string> {
  try {
    return await deps.store({ path: workspaceRelative(path) });
  } catch (error) {
    throw new PathRefusal(`${field} points at ${path}, which cannot be read: ${
      error instanceof Error ? error.message : String(error)}`);
  }
}

/** Carries a path problem back to the agent as a refusal rather than a crash. */
class PathRefusal extends Error {}


/**
 * Assemble, probe, pre-flight, start.
 *
 * Returns a refusal rather than throwing for anything the agent can fix, and
 * throws only when the environment is broken — the distinction matters because
 * the first is a conversation and the second is an incident.
 */
export async function startProposedRun(
  proposal: EvolveRunProposal,
  deps: ProposalDeps,
): Promise<EvolveRunProposalResult> {
  const shape = shapeOf(proposal);
  if (typeof shape === "string") return { refusedBecause: shape };

  let goal;
  try {
    goal = await assembleGoal(proposal, deps);
  } catch (error) {
    // A path the agent got wrong is something it can fix, so it comes back as a
    // refusal naming the field. Anything else is this side breaking, and throws.
    if (error instanceof PathRefusal) return { refusedBecause: error.message };
    throw error;
  }
  const issues = await preflight({
    casHas: deps.casHas,
    goal,
    model: deps.model?.(goal.modelId) as never,
    sandbox: await deps.orchestrator.sandboxCapability(),
  });
  if (issues.length) return { refusedBecause: describe(issues) };

  // The probe spends two real evaluations, so it runs after the cheap checks.
  let probe;
  try {
    probe = await deps.orchestrator.probe(goal, deps.sessionId);
  } catch (error) {
    // A 4xx is the probe's verdict on this design — "the starting point does
    // not run", "it is already past the threshold" — and the sidecar client
    // has already unwrapped it down to that sentence. Framing it again as
    // "the probe could not be carried out" contradicts it: the probe ran, and
    // this is what it found. Anything else really is an incident, and gets
    // said as one.
    const verdict = error instanceof EvolveSidecarError
      && error.status !== undefined && error.status >= 400 && error.status < 500;
    const said = error instanceof Error ? error.message : String(error);
    return { refusedBecause: verdict ? said : `the discrimination probe could not be taken: ${said}` };
  }
  if (probe.flat) {
    return {
      probe,
      // `flat` requires both numbers, so `worsened` is never null here — a
      // starting point that does not run is refused by the probe itself and
      // arrives on the catch path above with its own sentence.
      refusedBecause: `damaging the starting point (${probe.label}) barely moved the score (${probe.baseline.toFixed(4)} vs ${
        probe.worsened!.toFixed(4)
      }) — this scoring cannot tell good from bad, and the search would wander a flat landscape. `
        + "Make the cases harder, the rubric more mechanical, or pick a more sensitive metric.",
    };
  }

  const run = await deps.orchestrator.start({ goal, sessionId: deps.sessionId });
  return { probe, run };
}

/** What this proposal is missing, or `undefined` when it is coherent.
 *
 *  Checked before anything is stored: a half-written proposal that already put
 *  an evaluator in the content store leaves a blob nobody chose. */
/** Every prior factor the engine implements. Refused, never filtered: a
 *  misspelling that is quietly dropped runs the search under the uniform prior
 *  and reports success, so the run that was meant to test whether the prior
 *  helps has answered a different question. */
const PRIOR_FACTORS: readonly EvolvePriorFactor[] = ["viable", "frontier", "improvement"];

/** Beyond this the exploration term stops being a tie-breaker and starts
 *  outvoting the rank outright, which is a random walk with extra steps. */
const MAX_C_PUCT = 10;

function shapeOfSearchTuning(search: EvolveSearchTuning | undefined): string | undefined {
  if (!search) return undefined;
  if (search.cPuct !== undefined) {
    if (!Number.isFinite(search.cPuct) || search.cPuct <= 0) {
      return "cPuct has to be a positive number: it scales the exploration term, and zero or "
        + "negative leaves the search reading only the rank, or reading it backwards";
    }
    if (search.cPuct > MAX_C_PUCT) {
      return `cPuct ${search.cPuct} is too large: the exploration term would drown out the rank `
        + "and the search degenerates into a random walk. The usual range is 0.3-2.5";
    }
  }
  const unknown = (search.prior ?? []).filter(
    (factor) => !PRIOR_FACTORS.includes(factor));
  if (unknown.length) {
    return `unknown prior factor(s): ${unknown.join(", ")}. The choices are: ${PRIOR_FACTORS.join(", ")}`;
  }
  return undefined;
}

function shapeOf(proposal: EvolveRunProposal): string | undefined {
  const needsStart = proposal.mode !== "test_gate";
  if (needsStart && !proposal.startingPointPath && !proposal.startingPointText?.trim()) {
    return "there is no starting point. Point startingPointPath at a file in the workspace, "
      + "or write the starting point into startingPointText";
  }
  if (proposal.expansions < proposal.workers * 4) {
    return `${proposal.workers} workers needs at least ${proposal.workers * 4} expansions, or `
      + "the first wave spends most of the budget forking only the root and the tree stays flat";
  }
  const tuning = shapeOfSearchTuning(proposal.search);
  if (tuning) return tuning;
  if (proposal.mode === "dataset_metric") {
    if (!proposal.datasetPath) return "dataset_metric needs a CSV";
    if (!proposal.targetColumn) return "dataset_metric needs the column to predict";
    if (!proposal.metric) return "dataset_metric needs a metric";
    if (!proposal.split) return "dataset_metric needs a split";
    if (proposal.split.gateShards < MIN_GATE) {
      return `only ${proposal.split.gateShards} held-out shards cannot tell an improvement `
        + "from noise";
    }
    const thin = splitTooThin(proposal.split);
    if (thin) return thin;
  }
  if (proposal.mode === "custom_script") {
    if (!proposal.evaluatorSource?.trim()) return "custom_script needs an evaluator script";
    for (const name of ["SCIENCE_AGENT_SHARDS", "SCIENCE_AGENT_RESULT"]) {
      if (!proposal.evaluatorSource.includes(name)) {
        return `the evaluator never mentions ${name} — it has to score by shard and write its result `
          + "to the result file";
      }
    }
    if (!proposal.split) {
      return "custom_script needs a split, and its shard count has to match the one the "
        + "script slices";
    }
    if (proposal.split.gateShards < MIN_GATE) {
      return `only ${proposal.split.gateShards} held-out shards cannot tell an improvement `
        + "from noise";
    }
    const thin = splitTooThin(proposal.split);
    if (thin) return thin;
  }
  if (proposal.mode === "llm_judge") {
    if (!proposal.rubric?.trim()) return "llm_judge needs a rubric";
    if (!proposal.split) {
      return "llm_judge needs a split: gateShards is how many held-out gradings the median "
        + "is taken over";
    }
    if (proposal.split.gateShards < MIN_GATE) {
      return `only ${proposal.split.gateShards} held-out gradings cannot show whether the grading `
        + "is wobbling";
    }
  }
  if (proposal.mode === "test_gate") {
    if (!proposal.testCmd?.trim()) return "test_gate needs the command that runs the tests";
    if (!proposal.frozenGlobs?.length) {
      return "test_gate must freeze the test paths, or the shortest path to a higher score is "
        + "to weaken the tests";
    }
    if (!proposal.entrypointPath) return "test_gate needs the file a candidate replaces";
  }
  return undefined;
}

function describe(issues: PreflightIssue[]): string {
  return issues.map((issue) => `${issue.message}（${issue.fix}）`).join("；");
}

const DEFAULT_SPLIT: EvolveSplit = {
  gateShards: 4, rolloutShards: 4, seed: 0, shardRows: 1, testShards: 0, trainRows: null,
};

const DEFAULT_CASE_SPLIT: EvolveCaseSplit = {
  gateGroups: 4, rolloutGroups: 4, testGroups: 0,
};

/** The proposal's own text and paths, resolved into a goal. */
async function assembleGoal(
  proposal: EvolveRunProposal, deps: ProposalDeps,
): Promise<EvolveGoal> {
  const now = new Date().toISOString();
  const split = proposal.split ?? DEFAULT_SPLIT;
  // Stated, never left to the provider. Pre-flight's per-call floor is keyed on
  // this field, so an absent one is read as "thinking on" — and the ceiling this
  // side would then pick is the quiet one, which pre-flight refuses. Off is also
  // the right default on its merits: with thinking on, one whole-program rewrite
  // has been measured taking longer than the proxy's ceiling and returning
  // nothing at all.
  const thinking = proposal.thinking ?? "disabled";

  const startCas = proposal.mode === "test_gate"
    ? ""
    : proposal.startingPointPath
      ? await storePath(deps, "startingPointPath", proposal.startingPointPath)
      : await deps.store({ content: proposal.startingPointText! });

  // The scoring definition goes into the store and into `frozen`, which is what
  // stops a candidate rewriting what marks it. Same treatment for a rubric and
  // an evaluator: both are the scoring, in different languages.
  const scoringCas = proposal.mode === "llm_judge"
    ? await deps.store({ content: proposal.rubric! })
    : proposal.mode === "custom_script"
      ? await deps.store({ content: proposal.evaluatorSource! })
      : "";

  const measure = await measureOf(proposal, deps, split, scoringCas);
  const criterion: ScorecardCriterion = {
    direction: proposal.mode === "dataset_metric" ? (proposal.direction ?? "minimize") : "maximize",
    id: proposal.mode === "dataset_metric" ? (proposal.metric ?? "score") : "score",
    measure,
    name: proposal.howScored.slice(0, 60),
    normalize: normalizeOf(proposal),
    weight: 1,
  };

  return {
    algorithm: "puct",
    baselineProgramCas: startCas,
    budget: {
      candidateTimeoutSeconds: 180,
      expansions: proposal.expansions,
      maxCostCents: 0,
      maxSeconds: 7_200,
      maxTokens: 600_000,
      // Enough for a reasoning model to think *and* answer when thinking is on;
      // a ceiling below that produced whole runs of hidden reasoning and no
      // program, which read as a model that could not write code.
      maxTokensPerCall: thinking === "enabled" ? 96_000 : 16_000,
      workers: proposal.workers,
    },
    frozen: scoringCas ? [scoringCas] : [],
    modelId: deps.modelId,
    ...(proposal.packages?.length ? { packages: proposal.packages } : {}),
    ...(proposal.search ? { search: proposal.search } : {}),
    scorecard: {
      aggregate: "weighted_sum",
      confirmedAt: now,
      confirmedBy: "agent",
      constraints: [],
      criteria: [criterion],
      derivedFrom: { draftRunId: "", statement: proposal.statement },
      hash: `sha256:agent-${proposal.mode}-${(scoringCas || startCas).slice(-12)}-${split.seed}`,
      schemaVersion: 1,
      // A graded scorer rarely reaches 0.999, and at the default every rollout
      // asks for a proposal and the run reports below-threshold — which reads
      // as the reflector failing when nothing was ever counted as done. The
      // per-mode values live in the schema, so a fifth scoring mode gets its
      // threshold from one place instead of two that drift apart.
      solvedThreshold: SOLVED_THRESHOLD_BY_SCORING[proposal.mode],
    },
    schemaVersion: 2,
    statement: proposal.statement,
    target: targetOf(proposal, startCas),
    thinking,
  };
}

function normalizeOf(proposal: EvolveRunProposal): ScorecardCriterion["normalize"] {
  if (proposal.mode !== "dataset_metric") return { kind: "identity" };
  const kind = proposal.normalize ?? "reciprocal";
  // `clamp` needs bounds the proposal has no field for; anything asking for it
  // gets the shape that expresses the same intent without them.
  return kind === "clamp" ? { kind: "reciprocal" } : { kind };
}

function targetOf(proposal: EvolveRunProposal, startCas: string): EvolveGoal["target"] {
  if (proposal.mode === "test_gate") {
    return {
      entrypoint: proposal.entrypointPath ?? "",
      kind: "program",
      programId: proposal.entrypointPath ?? "",
    };
  }
  if (proposal.mode === "llm_judge") {
    return { contentCas: startCas, kind: "text", label: proposal.statement.slice(0, 60) };
  }
  return {
    entrypoint: proposal.mode === "custom_script" ? "candidate.py" : "main.py",
    kind: "program",
    programId: startCas,
  };
}

async function measureOf(
  proposal: EvolveRunProposal,
  deps: ProposalDeps,
  split: EvolveSplit,
  scoringCas: string,
): Promise<EvolveScoring> {
  switch (proposal.mode) {
    case "dataset_metric": {
      const datasetCas = await storePath(deps, "datasetPath", proposal.datasetPath!);
      return {
        datasetCas: [datasetCas],
        kind: "dataset_metric",
        metric: {
          direction: proposal.direction ?? "minimize",
          name: proposal.metric ?? "mae",
        },
        split,
        target: proposal.targetColumn!,
      };
    }
    case "custom_script":
      return {
        kind: "custom_script", scriptCas: scoringCas, split, timeoutSeconds: 180,
      };
    case "llm_judge":
      return {
        blind: true,
        judgeModelId: proposal.judgeModelId || deps.modelId,
        kind: "llm_judge",
        rubricCas: scoringCas,
        samplesPerCandidate: 1,
        scale: { max: proposal.scaleMax ?? 10, min: 0 },
        split: { ...split, shardRows: 1, trainRows: null },
        varianceThreshold: 0.2,
      };
    case "test_gate":
      return {
        caseSplit: proposal.caseSplit ?? DEFAULT_CASE_SPLIT,
        entrypoint: [proposal.entrypointPath ?? ""],
        frozen: proposal.frozenGlobs ?? [],
        kind: "test_gate",
        testCmd: proposal.testCmd!.split(/\s+/).filter(Boolean),
      };
  }
}

/**
 * A finished search, reduced to what is worth saying out loud.
 *
 * Read from the event log rather than the run record: the record carries
 * counters, and what a person wants is the shape of the outcome — did it beat
 * the start, by how much, and on the split that never took part. The last of
 * those is the only number quotable outside the run.
 */
export function summariseRun(
  run: { candidates?: number; id: string; status: EvolveRunStatus; tokens?: number },
  events: Array<{ event: Record<string, unknown> }>,
): EvolveRunSummary {
  let baselineScore: number | null = null;
  let bestScore: number | null = null;
  let bestTestScore: number | null = null;
  let bestChange: string | undefined;
  let note: string | undefined;
  let stoppedEarly: string | undefined;

  for (const { event } of events) {
    const kind = event.type;
    if (kind === "seeded" && typeof event.baselineScore === "number") {
      baselineScore = event.baselineScore;
    }
    if (kind === "expanded" && event.valid === true && typeof event.score === "number") {
      if (bestScore === null || event.score > bestScore) {
        bestScore = event.score;
        bestChange = typeof event.changeSummary === "string" ? event.changeSummary : undefined;
      }
    }
    if (kind === "search_finished") {
      if (typeof event.bestTestScore === "number") bestTestScore = event.bestTestScore;
      // A run that made 8 of its 20 expansions reports `succeeded` and a real
      // improvement, and nothing in the summary says it stopped a third of the
      // way in — which is the first thing anyone asks on seeing the tree. The
      // engine deliberately keeps quiet in the log about ordinary endings, so
      // this is where the shortfall becomes sayable.
      const planned = typeof event.expansionsPlanned === "number" ? event.expansionsPlanned : null;
      const made = typeof event.candidates === "number" ? event.candidates - 1 : null;
      if (planned !== null && made !== null && made < planned) {
        const why = typeof event.stopReason === "string" && event.stopReason
          ? event.stopReason
          : "unknown";
        stoppedEarly = `planned ${planned} expansions, made ${made}; it stopped because ${why}`;
      }
    }
    // A run can finish `succeeded` having learned nothing — every score
    // identical, or nothing valid at all. The engine says so in a log line, and
    // that line is the most important thing about such a run.
    if (kind === "log" && (event.level === "warn" || event.level === "error")
      && typeof event.message === "string") {
      note = event.message;
    }
  }

  return {
    baselineScore,
    bestChange,
    bestScore,
    bestTestScore,
    candidates: run.candidates ?? 0,
    id: run.id,
    note,
    status: run.status,
    stoppedEarly,
    tokens: run.tokens ?? 0,
  };
}
