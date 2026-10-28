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

import type { RunStreamEvent, Subagent, SubagentStep, SubagentUsage } from "../api/types.js";

export type SubagentEvent = Extract<
  RunStreamEvent,
  { type: "subagent.step" | "subagent.updated" | "subagent.usage" }
>;

/**
 * The delegated task in one sentence.
 *
 * The coordinator's own `description` is what it told the child to do, and it
 * is what the transcript's line shows. Older records can ship it empty, and
 * the prompt's first line is then the only account of the task there is.
 */
export function subagentTask(subagent: Subagent): string {
  const description = subagent.input.description.trim();
  if (description !== "") return description;
  return subagent.input.prompt
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";
}

/**
 * The steps that make up the child's closing message — its answer.
 *
 * A reply is not always one step. The runtime ends a step every time it
 * records an event in the middle of one, so a single message can arrive as two
 * adjacent assistant steps that read as one sentence. Taking only the last of
 * them cut the answer in half: its opening stayed in the timeline while its
 * tail was shown as the result. The trailing run is joined, exactly as the
 * server joins it when it hands the child's text to result validation. A final
 * message with no text is not an answer, so an earlier run is still the best
 * account of what the child concluded.
 */
export function finalSteps(steps: readonly SubagentStep[]): SubagentStep[] {
  let last = -1;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (step.kind === "assistant" && step.content.trim() !== "") {
      last = index;
      break;
    }
  }
  if (last < 0) return [];
  let first = last;
  while (first > 0 && steps[first - 1]!.kind === "assistant") first -= 1;
  return steps.slice(first, last + 1);
}

/**
 * Fold one snapshot's steps onto the ones already shown.
 *
 * A step keeps the position it first appeared in: the coordinator emits a
 * running row and then replaces that same id with the completed one, and a
 * timeline that re-appended it would show every tool call twice. New ids go to
 * the end, which is the order they happened in.
 */
export function mergeSubagentSteps(current: SubagentStep[], incoming: SubagentStep[]): SubagentStep[] {
  if (incoming.length === 0) return current;
  const byId = new Map(incoming.map((step) => [step.id, step]));
  let changed = false;
  const merged = current.map((step) => {
    const next = byId.get(step.id);
    if (next === undefined || next === step) return step;
    // The wire is plain JSON, so structural equality is enough to keep an
    // unchanged step's identity and avoid a needless re-render.
    if (JSON.stringify(next) === JSON.stringify(step)) return step;
    changed = true;
    return next;
  });
  const known = new Set(current.map((step) => step.id));
  for (const step of incoming) {
    if (known.has(step.id)) continue;
    merged.push(step);
    changed = true;
  }
  return changed ? merged : current;
}

/** Merge a full snapshot onto the copy already held.
 *
 *  The newer snapshot owns the status, including a `running` one: the server
 *  resumes an interrupted child and reports that resume on the same id, so
 *  refusing the transition would leave the line finished while the work went
 *  on. Steps and usage are accumulated rather than replaced, because a
 *  snapshot may describe only part of them. */
export function mergeSubagentSnapshot(current: Subagent, incoming: Subagent): Subagent {
  const steps = mergeSubagentSteps(current.steps, incoming.steps);
  const usage = incoming.usage ?? current.usage;
  return {
    ...current,
    ...incoming,
    steps,
    turnCount: Math.max(current.turnCount, incoming.turnCount),
    ...(usage ? { usage } : {}),
  };
}

function sameUsage(left: SubagentUsage | undefined, right: SubagentUsage | undefined): boolean {
  return left === right || Boolean(left && right
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
    && left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.totalTokens === right.totalTokens);
}

/**
 * Apply one SubAgent event to the copy already held, or return `undefined`
 * when there is nothing to update.
 *
 * `subagent.step` and `subagent.usage` only refine a snapshot that has already
 * arrived; the server always announces the child first. A step that overtakes
 * its snapshot is therefore dropped rather than turned into a half-populated
 * line that would never learn the task description.
 */
export function applySubagentEvent(current: Subagent | undefined, event: SubagentEvent): Subagent | undefined {
  if (event.type === "subagent.updated") {
    return current === undefined ? event.subagent : mergeSubagentSnapshot(current, event.subagent);
  }
  if (current === undefined) return undefined;
  if (event.type === "subagent.step") {
    const steps = mergeSubagentSteps(current.steps, [event.step]);
    return steps === current.steps ? current : { ...current, steps };
  }
  if (sameUsage(current.usage, event.usage)) return current;
  return { ...current, usage: event.usage };
}
