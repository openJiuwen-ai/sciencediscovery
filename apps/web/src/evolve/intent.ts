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
 * Natural-language intent detection for program evolution.
 *
 * `/evolve-design` is a hidden slash command today: the user must already know
 * it exists to start a search. This module recognises the same intent from
 * plain language ("make this better", "帮我优化这个程序") so the composer can
 * offer the evolve picker without the user learning the command syntax.
 *
 * Pure and deterministic: keyword matching only, no LLM round-trip. The signal
 * is deliberately narrow — starting an evolution search spends real budget
 * (mutations + sandboxed evaluations), so a false positive is worse than a
 * missed suggestion. We require BOTH an improvement verb AND a target noun
 * that is something the search could actually rewrite and score (program,
 * code, algorithm, model, function, script …). Formatting/explanation targets
 * and bare "better" never match.
 *
 * English words match on word boundaries (`\b`), so a short target like `code`
 * or a negation like `ui` cannot fire inside `barcode`, `circuit`, `build` or
 * `information`. Chinese has no word boundaries, but the phrases we match are
 * specific enough that a stray substring is unlikely; the confirmation bar
 * remains the final false-positive gate either way.
 */

/** A stable command sentinel so a message that already carries the evolve
 *  command never re-triggers the picker. */
export const EVOLVE_DESIGN_COMMAND = "/evolve-design";

/** English words, matched with `\b` boundaries. */
const EN_IMPROVEMENT_VERBS = [
  "make it better",
  "make this better",
  "make the",
  "improve the",
  "improve this",
  "improve it",
  "optimize the",
  "optimise the",
  "optimize this",
  "optimise this",
  "optimize it",
  "optimise it",
];

/** Chinese improvement phrases; matched as substrings (no word boundaries). */
const ZH_IMPROVEMENT_VERBS = [
  "做得更好",
  "跑得更好",
  "变得更好",
  "优化一下",
  "优化这个",
  "优化它",
  "优化一个",
  "改进一下",
  "改进这个",
  "改进它",
  "改进一个",
  "提升",
  "提高",
];

/** English evolvable targets, matched with `\b` boundaries. */
const EN_EVOLVABLE_TARGETS = [
  "program",
  "code",
  "algorithm",
  "function",
  "model",
  "script",
  "pipeline",
  "scoring",
  "evaluator",
  "implementation",
  "simulation",
  "analysis",
  "result",
  "artifact",
];

/** Chinese evolvable targets; matched as substrings. */
const ZH_EVOLVABLE_TARGETS = [
  "程序",
  "代码",
  "算法",
  "函数",
  "模型",
  "脚本",
  "流程",
  "方案",
  "结果",
  "实现",
  "分析",
  "产物",
];

/** English negation targets, matched with `\b` boundaries so `ui` cannot hit
 *  `building`/`circuit` and `format` cannot hit `information`. */
const EN_NEGATION_TARGETS = [
  "description",
  "explanation",
  "format",
  "layout",
  "interface",
  "ui",
  "workflow steps",
];

/** Chinese negation targets; matched as substrings. */
const ZH_NEGATION_TARGETS = [
  "说明",
  "描述",
  "格式",
  "排版",
  "布局",
  "界面",
  "步骤",
];

/**
 * Deficiency signals: a complaint that something is not good enough, in any
 * wording. These are not "improve" verbs but the reasons a user actually opens
 * a request — "this program is too slow", "the result is inaccurate", "make
 * it faster", "it crashes". Paired with an evolvable target and not negated,
 * they are as strong a signal as an explicit improve verb.
 */
const EN_DEFICIENCY_SIGNALS = [
  "too slow",
  "very slow",
  "so slow",
  "slow",
  "too fast",
  "inaccurate",
  "not accurate",
  "less accurate",
  "unstable",
  "crashes",
  "crashing",
  "buggy",
  "too much memory",
  "high memory",
  "inefficient",
  "faster",
  "more accurate",
  "more robust",
  "lower latency",
  "reduce memory",
  "tune",
];

/** Chinese deficiency signals; matched as substrings. */
const ZH_DEFICIENCY_SIGNALS = [
  "太慢",
  "很慢",
  "慢",
  "不准",
  "不够准",
  "不太准",
  "不稳定",
  "崩溃",
  "报错",
  "有问题",
  "效果不好",
  "性能差",
  "更快",
  "快一点",
  "更准",
  "更准确",
  "更稳定",
  "优化性能",
  "提高性能",
  "提升性能",
  "减少内存",
  "占内存",
];

/** Match a whole English word at boundaries, so short words do not fire inside
 *  longer ones (`ui` in `building`, `code` in `barcode`). */
function hasEnglishWord(words: readonly string[], text: string): boolean {
  return words.some((word) => new RegExp(`\\b${word}\\b`).test(text));
}

function hasSubstring(phrases: readonly string[], text: string): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

/**
 * Whether `message` expresses program-evolution intent in natural language.
 * Returns true for the explicit `/evolve-design` command, or for a sentence
 * that signals an evolvable target is not good enough — via an improvement
 * verb or a deficiency complaint ("too slow", "不太准") — and does not name a
 * non-evolvable target.
 */
export function detectEvolveIntent(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  if (isEvolveDesignCommand(normalized)) return true;
  const hasVerb = hasEnglishWord(EN_IMPROVEMENT_VERBS, normalized) || hasSubstring(ZH_IMPROVEMENT_VERBS, normalized);
  const hasDeficiency = hasEnglishWord(EN_DEFICIENCY_SIGNALS, normalized) || hasSubstring(ZH_DEFICIENCY_SIGNALS, normalized);
  if (!hasVerb && !hasDeficiency) return false;
  const hasTarget = hasEnglishWord(EN_EVOLVABLE_TARGETS, normalized) || hasSubstring(ZH_EVOLVABLE_TARGETS, normalized);
  if (!hasTarget) return false;
  const negated = hasEnglishWord(EN_NEGATION_TARGETS, normalized) || hasSubstring(ZH_NEGATION_TARGETS, normalized);
  return !negated;
}

/**
 * Whether `message` is an explicit `/evolve-design` command. The command is an
 * unambiguous, user-typed request, so the composer can go straight to the
 * algorithm picker; a natural-language sentence must clear the suggestion bar
 * first (it spends budget and is easy to mis-read).
 *
 * Bound at a whitespace or end-of-input after the command name, so
 * `/evolve-designXXX` is not treated as a command.
 */
export function isEvolveDesignCommand(message: string): boolean {
  return /^\/evolve-design(?:\s|$)/.test(message.trim().toLowerCase());
}
