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
 * What has to be true before a search is allowed to start.
 *
 * The engine will not stop any of this for you. It warns on an empty reply and
 * moves on — and an empty reply becomes a failed node, which is
 * **indistinguishable from a candidate that genuinely would not run**. So every
 * check here exists because its failure mode is silent, expensive, or both: a
 * run that cannot possibly accept anything still costs a full budget of model
 * calls before anyone notices.
 *
 * Refusals happen at creation, not at the first expansion. A user who has
 * watched a progress bar for a minute has already paid for the mistake.
 */

import type { EvolveGoal, ModelProfile } from "@sciencediscovery/schema";

import { casHash, needsData, validateSplit } from "./dataset.js";
import { hasBlockingIssue, validateScorecard } from "./scorecard.js";
import type { EvolveSandboxCapability } from "./sandbox.js";

export interface PreflightIssue {
  code: string;
  /** What the user should change. A refusal without one is a dead end. */
  fix: string;
  message: string;
}

export interface PreflightInput {
  /** Whether a content hash is in the store. Absent skips the dataset checks —
   *  a caller with no content store cannot answer, and guessing "missing" would
   *  refuse every run. */
  casHas?: (hash: string) => Promise<boolean>;
  goal: EvolveGoal;
  model: ModelProfile | undefined;
  sandbox: EvolveSandboxCapability;
}

/**
 * Floor for one mutation call, which depends on the *thinking* setting far more
 * than on the algorithm.
 *
 * Measured, not guessed, on GLM5.2 rewriting a small program:
 *
 * * thinking on, 16k ceiling: 16001 output tokens, **no content at all**, six
 *   expansions in a row — every one recorded as a candidate that would not run.
 * * thinking on, 64k ceiling: 11k–64k per call, and **two of eight still hit
 *   the cap**. So 64k is not comfortable either.
 * * thinking off: ~1.2k per call.
 *
 * Hence the two columns. With thinking on the budget must hold the reasoning
 * *and* the program, and the observed spread says six figures; with it off, a
 * few thousand is plenty and demanding more would refuse runs that work.
 */
const MIN_TOKENS_PER_CALL: Record<string, { thinking: number; quiet: number }> = {
  era: { quiet: 8_000, thinking: 96_000 },
  // OpenEvolve rewrites the whole genome rather than editing it.
  openevolve: { quiet: 16_000, thinking: 128_000 },
};

/** Below this the held-out set is too small for the acceptance gate to say
 *  anything: four shards is the floor the split design settles on. */
const MIN_GATE_SHARDS = 4;

export async function preflight(input: PreflightInput): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = [];
  const { budget } = input.goal;

  // --- the model can actually be called -------------------------------------

  if (!input.model) {
    issues.push({
      code: "model_missing",
      fix: "在向导里选一个已配置的模型",
      message: "这次搜索指定的模型不存在",
    });
  } else if (!input.model.hasApiToken) {
    issues.push({
      code: "model_no_token",
      fix: `在模型设置里给 ${input.model.name} 存一个 API token`,
      message: `模型 ${input.model.name} 没有 API token，变异调用会全部失败`,
    });
  }

  const floors = MIN_TOKENS_PER_CALL[input.goal.algorithm] ?? MIN_TOKENS_PER_CALL.era!;
  const quiet = input.goal.thinking === "disabled";
  const floor = quiet ? floors.quiet : floors.thinking;
  if (budget.maxTokensPerCall < floor) {
    issues.push({
      code: "max_tokens_too_low",
      fix: quiet
        ? `把单次调用上限提到 ${floor} 以上`
        : `把单次调用上限提到 ${floor} 以上，或把思考关掉（下限降到 ${floors.quiet}）`,
      // The failure is silent: the reply comes back empty, the node is recorded
      // as failed, and the run looks like a search that could not find anything.
      message: `单次调用上限 ${budget.maxTokensPerCall} 低于${quiet ? "" : "开着思考时"}`
        + `${input.goal.algorithm} 的下限 ${floor}；`
        + "模型会把预算花在隐藏思考上并返回空回复，而空回复会被记成失败候选",
    });
  }

  // --- the budget describes a search that can actually run -------------------

  if (budget.workers < 1) {
    issues.push({ code: "workers_invalid", fix: "worker 数至少为 1", message: "worker 数必须是正整数" });
  } else if (budget.expansions % budget.workers !== 0) {
    issues.push({
      code: "expansions_not_divisible",
      fix: `把扩展次数改成 ${budget.workers} 的倍数`,
      message: `扩展次数 ${budget.expansions} 不能被 worker 数 ${budget.workers} 整除；`
        + "引擎按波次派发（一波选 worker 个父节点，下一波才看得到这一波的结果），"
        + "余数会让最后一波跑不满",
    });
  }
  if (budget.expansions < 1) {
    issues.push({ code: "expansions_invalid", fix: "扩展次数至少为 1", message: "扩展次数必须是正整数" });
  }

  // --- the isolation exists -------------------------------------------------

  // A judged scorecard executes nothing — the candidate is text and a model
  // reads it — so requiring isolation there would refuse a run that never runs
  // anything, which is the opposite of what the refusal is for.
  const executes = input.goal.scorecard.criteria.some(
    (criterion) => criterion.measure.kind !== "llm_judge",
  );
  if (executes && !input.sandbox.backend) {
    issues.push({
      code: "sandbox_unavailable",
      fix: "Linux 上安装 bubblewrap（bwrap）；macOS 自带 sandbox-exec",
      // Not a portability concession: a candidate is model-written Python that
      // gets executed, and running it unconfined is not a fallback.
      message: "没有可用的候选隔离后端，候选是模型写的代码，不会在无隔离的情况下执行",
    });
  }

  // --- the scorecard can decide anything ------------------------------------

  const scorecardIssues = validateScorecard(input.goal.scorecard);
  for (const issue of scorecardIssues) {
    if (issue.severity !== "error") continue;
    issues.push({
      code: `scorecard_${issue.code}`,
      fix: "修正评分卡后重试",
      message: issue.message,
    });
  }

  for (const criterion of input.goal.scorecard.criteria) {
    const measure = criterion.measure;
    if (measure.kind !== "dataset_metric" && measure.kind !== "custom_script" && measure.kind !== "llm_judge") continue;
    if (measure.split.gateShards >= MIN_GATE_SHARDS) continue;
    issues.push({
      code: "gate_shards_too_few",
      fix: `把留出门分片数提到 ${MIN_GATE_SHARDS} 以上`,
      message: `判据「${criterion.name}」的留出门只有 ${measure.split.gateShards} 个分片；`
        + "接受门读的就是它，太少则无法判断一次提升是不是噪声",
    });
  }

  // --- a judged scorecard's own five requirements ----------------------------

  for (const criterion of input.goal.scorecard.criteria) {
    if (criterion.measure.kind !== "llm_judge") continue;
    const measure = criterion.measure;

    if (!measure.judgeModelId) {
      issues.push({
        code: "judge_model_missing",
        fix: "选一个用来评审的模型",
        message: `判据「${criterion.name}」要用模型评审，但没有指定评审模型`,
      });
    }
    if (!measure.rubricCas) {
      issues.push({
        code: "rubric_missing",
        fix: "写一份评分细则并保存",
        message: `判据「${criterion.name}」没有评分细则，评审模型无从打分`,
      });
    }
    if (input.goal.scorecard.solvedThreshold >= 0.999) {
      // At the default a graded scorer never counts as solved, so every rollout
      // asks for a proposal and the run reports `below-threshold` — which reads
      // as the reflector failing when nothing was ever counted as done.
      issues.push({
        code: "solved_threshold_too_high",
        fix: "模型评审的解决阈值建议 0.85",
        message: "分级评分几乎到不了 0.999，用默认阈值会让每次 rollout 都请求提案",
      });
    }
    if (!input.goal.frozen.includes(measure.rubricCas)) {
      // A search that can rewrite its own marking scheme learns to do that
      // instead of getting better.
      issues.push({
        code: "rubric_not_frozen",
        fix: "把评分细则加进 frozen",
        message: "评分细则必须冻结，否则搜索可以改判卷标准而不是把内容做好",
      });
    }
  }

  // --- a scripted scorecard's own two requirements ---------------------------

  for (const criterion of input.goal.scorecard.criteria) {
    if (criterion.measure.kind !== "custom_script") continue;
    const measure = criterion.measure;

    if (!measure.scriptCas) {
      issues.push({
        code: "script_missing",
        fix: "让模型写一份评测脚本，或者换一种打分方式",
        message: `判据「${criterion.name}」说要用评测脚本打分，但没有脚本`,
      });
    } else if (!input.goal.frozen.includes(measure.scriptCas)) {
      // Same rule as the rubric, for the same reason: a candidate is executed,
      // and a search that can rewrite what measures it learns to do that
      // instead of getting better.
      issues.push({
        code: "script_not_frozen",
        fix: "把评测脚本加进 frozen",
        message: "评测脚本必须冻结，否则搜索可以改评测而不是把东西做好",
      });
    }
  }

  // --- a test-gated scorecard's own requirements -----------------------------

  for (const criterion of input.goal.scorecard.criteria) {
    if (criterion.measure.kind !== "test_gate") continue;
    const measure = criterion.measure;

    if (!measure.testCmd.length) {
      issues.push({
        code: "test_cmd_missing",
        fix: "给一条能跑这个项目测试的命令",
        message: `判据「${criterion.name}」没有测试命令，无从判分`,
      });
    }
    if (!measure.frozen.length) {
      // Upstream's own note: without it the shortest path to a high score is to
      // weaken the thing measuring it.
      issues.push({
        code: "tests_not_frozen",
        fix: "把测试路径写进 frozen，例如 tests/**",
        message: "测试判分必须冻结测试文件，否则候选最短的提分路径是改测试",
      });
    }
    if (measure.caseSplit.gateGroups < 4) {
      issues.push({
        code: "gate_groups_too_few",
        fix: "留出组提到 4 以上",
        message: `留出只有 ${measure.caseSplit.gateGroups} 组，判不出一次提升是不是噪声`,
      });
    }
    if (measure.caseSplit.rolloutGroups < 1) {
      issues.push({
        code: "rollout_groups_too_few",
        fix: "至少要有 1 个 rollout 组",
        message: "没有 rollout 组，搜索没有可以排名的分数",
      });
    }
  }

  // --- the data the scorecard names actually exists --------------------------

  for (const criterion of input.goal.scorecard.criteria) {
    if (!needsData(criterion)) continue;
    const measure = criterion.measure as Extract<typeof criterion.measure, { kind: "dataset_metric" }>;
    if (measure.datasetCas.length === 0) {
      issues.push({
        code: "dataset_missing",
        fix: "给这个判据指一份数据集：dataset_metric 要一个 datasetPath",
        message: `判据「${criterion.name}」没有指定数据集，无从测量`,
      });
      continue;
    }
    if (input.casHas) {
      for (const ref of measure.datasetCas) {
        if (await input.casHas(casHash(ref))) continue;
        issues.push({
          code: "dataset_not_in_store",
          fix: "重新上传数据集，或改用一份还在库里的",
          message: `判据「${criterion.name}」引用的数据集 ${ref} 不在内容库里`,
        });
      }
    }
    if (!measure.target) {
      issues.push({
        code: "target_column_missing",
        fix: "指明候选要预测哪一列",
        message: `判据「${criterion.name}」没有说要预测哪一列`,
      });
    }
    // The arithmetic, without the data. Whether *this* dataset has enough rows
    // needs the dataset, and that check stays at staging where the rows are.
    const impossible = validateSplit(measure.split);
    if (impossible) {
      issues.push({
        code: "split_impossible",
        fix: "调整分片数与每片行数",
        message: `判据「${criterion.name}」的切分方式不成立：${impossible}`,
      });
    }
  }

  return issues;
}

/** Whether the scorecard's own structural checks passed. Exposed so the wizard
 *  can show them before the run request is even built. */
export { hasBlockingIssue };
