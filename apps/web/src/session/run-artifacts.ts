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

import type { SessionArtifactOutput, SessionRun, Subagent } from "@sciencediscovery/schema";

import { isTerminalRunStatus } from "../run-stream/model.js";

/**
 * Attribute declared Artifact versions to the top-level conversation Run that
 * produced them. Main-agent versions use `run.id` directly; subagent versions
 * use their subagent id and walk `parentTurnId` until they reach that Run.
 *
 * Versions with an unknown or cyclic execution lineage are deliberately left
 * out. Guessing from timestamps would turn project history into incorrect chat
 * history; those versions remain reachable from the project Artifact catalog.
 */
export function groupArtifactOutputsByRun(
  outputs: readonly SessionArtifactOutput[],
  runs: readonly SessionRun[],
  subagents: readonly Subagent[],
): ReadonlyMap<string, readonly SessionArtifactOutput[]> {
  const runIds = new Set(runs.map((run) => run.id));
  const parentTurnBySubagentId = new Map(subagents.map((subagent) => [subagent.id, subagent.parentTurnId]));
  const byRunAndArtifact = new Map<string, Map<string, SessionArtifactOutput>>();

  function rootRunId(turnId: string | undefined): string | undefined {
    const visited = new Set<string>();
    let current = turnId;
    while (current && !visited.has(current)) {
      if (runIds.has(current)) return current;
      visited.add(current);
      current = parentTurnBySubagentId.get(current);
    }
    return undefined;
  }

  for (const output of outputs) {
    const runId = rootRunId(output.version.turnId);
    if (!runId) continue;
    const byArtifact = byRunAndArtifact.get(runId) ?? new Map<string, SessionArtifactOutput>();
    const existing = byArtifact.get(output.artifact.id);
    if (!existing
      || output.version.version > existing.version.version
      || (output.version.version === existing.version.version
        && output.version.createdAt > existing.version.createdAt)) {
      byArtifact.set(output.artifact.id, output);
    }
    byRunAndArtifact.set(runId, byArtifact);
  }

  return new Map([...byRunAndArtifact].map(([runId, byArtifact]) => [
    runId,
    [...byArtifact.values()].toSorted((left, right) =>
      left.version.createdAt.localeCompare(right.version.createdAt)
      || left.version.version - right.version.version
      || left.artifact.name.localeCompare(right.artifact.name),
    ),
  ]));
}

export interface ArtifactOutputAnchors {
  activeTimeline: readonly SessionArtifactOutput[];
  byMessage: ReadonlyMap<string, readonly SessionArtifactOutput[]>;
  byReplayTimeline: ReadonlyMap<string, readonly SessionArtifactOutput[]>;
}

/**
 * Choose exactly one visible anchor for each terminal Run's Artifact outputs.
 * The live Timeline owns its active Run even after that Run reaches a terminal
 * state: its assistant message is intentionally folded into the Timeline until
 * the Session refresh turns it into a replay Timeline. Keeping that Run in the
 * live footer prevents a blank interval after completion, cancellation, or
 * failure.
 */
export function anchorArtifactOutputs(
  outputsByRun: ReadonlyMap<string, readonly SessionArtifactOutput[]>,
  runs: readonly SessionRun[],
  options: {
    activeTimelineRunId?: string;
    displayedMessageIds: ReadonlySet<string>;
    replayedRunIds: ReadonlySet<string>;
  },
): ArtifactOutputAnchors {
  const byMessage = new Map<string, readonly SessionArtifactOutput[]>();
  const byReplayTimeline = new Map<string, readonly SessionArtifactOutput[]>();
  let activeTimeline: readonly SessionArtifactOutput[] = [];

  for (const run of runs) {
    if (!isTerminalRunStatus(run.status)) continue;
    const outputs = outputsByRun.get(run.id);
    if (!outputs?.length) continue;
    if (run.id === options.activeTimelineRunId) {
      activeTimeline = outputs;
      continue;
    }
    if (options.replayedRunIds.has(run.id)) {
      byReplayTimeline.set(run.id, outputs);
      continue;
    }
    const messageId = run.assistantMessageId ?? run.userMessageId;
    if (messageId && options.displayedMessageIds.has(messageId)) byMessage.set(messageId, outputs);
  }

  return { activeTimeline, byMessage, byReplayTimeline };
}
