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
  EvolveRunProposal,
  EvolveRunProposalResult,
  EvolveScoring,
  EvolveSplit,
  ScorecardCriterion,
} from "@sciencediscovery/schema";
import { SOLVED_THRESHOLD_BY_SCORING } from "@sciencediscovery/schema";

import type { EvolveOrchestrator } from "./orchestrator.js";
import { EvolveSidecarError } from "./sidecar.js";
import { preflight, type PreflightIssue } from "./preflight.js";
import { basename } from "node:path";

import type { ProbeRegistry } from "./discrimination.js";

/** What the assembler needs from the world. Injected so the unit tests need no
 *  store, no sandbox and no model. */
export interface ProposalDeps {
  /** Puts text or a workspace file into the store; returns its `sha256:` ref. */
  store: (input: { content?: string; path?: string }) => Promise<string>;
  casHas?: (hash: string) => Promise<boolean>;
  model?: (id: string) => unknown;
  modelId: string;
  orchestrator: EvolveOrchestrator;
  probes?: ProbeRegistry;
  sessionId: string;
}

/** Held-out sizing this side refuses below, whatever a proposal asks for. The
 *  agent is told the reasoning in the skill; this is the floor under it. */
const MIN_GATE = 4;

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

  const goal = await assembleGoal(proposal, deps);
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
    return { refusedBecause: verdict ? said : `判别力探针没能进行：${said}` };
  }
  if (probe.flat) {
    return {
      probe,
      // `flat` requires both numbers, so `worsened` is never null here — a
      // starting point that does not run is refused by the probe itself and
      // arrives on the catch path above with its own sentence.
      refusedBecause: `把起点${probe.label}之后分数几乎没动（${probe.baseline.toFixed(4)} vs ${
        probe.worsened!.toFixed(4)
      }）——这套评分分不出好坏，搜索会在平坦地形上随机游走。`
        + "把样例出难一点、细则写得更机械，或者换个更敏感的指标。",
    };
  }
  deps.probes?.record(goal.scorecard.hash);

  const run = await deps.orchestrator.start({ goal, sessionId: deps.sessionId });
  return { probe, run };
}

/** What this proposal is missing, or `undefined` when it is coherent.
 *
 *  Checked before anything is stored: a half-written proposal that already put
 *  an evaluator in the content store leaves a blob nobody chose. */
function shapeOf(proposal: EvolveRunProposal): string | undefined {
  const needsStart = proposal.mode !== "test_gate";
  if (needsStart && !proposal.startingPointPath && !proposal.startingPointText?.trim()) {
    return "没有起点。给 startingPointPath 指一个工作区里的文件，或者把起点内容写进 startingPointText";
  }
  if (proposal.expansions < proposal.workers * 4) {
    return `${proposal.workers} 个并行要配至少 ${proposal.workers * 4} 次扩展，`
      + "否则第一轮就用掉了大半预算、每个候选都只从起点分叉，树是平的";
  }
  if (proposal.mode === "dataset_metric") {
    if (!proposal.datasetPath) return "dataset_metric 要指一份 CSV";
    if (!proposal.targetColumn) return "dataset_metric 要说明预测哪一列";
    if (!proposal.metric) return "dataset_metric 要给一个指标";
    if (!proposal.split) return "dataset_metric 要给切分";
    if (proposal.split.gateShards < MIN_GATE) {
      return `留出只有 ${proposal.split.gateShards} 片，判不出一次提升是不是噪声`;
    }
  }
  if (proposal.mode === "custom_script") {
    if (!proposal.evaluatorSource?.trim()) return "custom_script 要给评测脚本";
    for (const name of ["SCIENCE_AGENT_SHARDS", "SCIENCE_AGENT_RESULT"]) {
      if (!proposal.evaluatorSource.includes(name)) {
        return `评测脚本里没有出现 ${name}——它必须按分片评分，并把结果写到结果文件`;
      }
    }
    if (!proposal.split) return "custom_script 要给 split，且片数要和脚本切的片数一致";
    if (proposal.split.gateShards < MIN_GATE) {
      return `留出只有 ${proposal.split.gateShards} 片，判不出一次提升是不是噪声`;
    }
  }
  if (proposal.mode === "llm_judge") {
    if (!proposal.rubric?.trim()) return "llm_judge 要写评分细则";
    if (!proposal.split) return "llm_judge 要给 split：gateShards 就是留出评几次取中位数";
    if (proposal.split.gateShards < MIN_GATE) {
      return `留出只评 ${proposal.split.gateShards} 次，看不出评分是不是在抖`;
    }
  }
  if (proposal.mode === "test_gate") {
    if (!proposal.testCmd?.trim()) return "test_gate 要给跑测试的命令";
    if (!proposal.frozenGlobs?.length) {
      return "test_gate 必须冻结测试路径，否则候选最短的提分路径是把测试改弱";
    }
    if (!proposal.entrypointPath) return "test_gate 要说明候选替换哪个文件";
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
    : await deps.store(proposal.startingPointPath
      ? { path: proposal.startingPointPath }
      : { content: proposal.startingPointText! });

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
    algorithm: "era",
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
      const datasetCas = await deps.store({ path: proposal.datasetPath! });
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
    case "custom_script": {
      // Only when the proposal names one. An evaluator that derives its cases
      // from the shard index is the common shape and stages nothing; requiring
      // a file here would mean inventing a dataset to fill a field.
      const files = proposal.datasetPath
        ? [{ cas: await deps.store({ path: proposal.datasetPath }), name: basename(proposal.datasetPath) }]
        : [];
      return {
        ...(files.length ? { datasetFiles: files } : {}),
        kind: "custom_script", scriptCas: scoringCas, split, timeoutSeconds: 180,
      };
    }
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
    if (kind === "search_finished" && typeof event.bestTestScore === "number") {
      bestTestScore = event.bestTestScore;
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
    tokens: run.tokens ?? 0,
  };
}
