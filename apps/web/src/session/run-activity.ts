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

import type {
  ArtifactCandidate,
  ArtifactJob,
  ArtifactPlan,
  McpInvocation,
  PermissionRequest,
  RemoteJob,
  RunStreamEvent,
  SessionPlan,
  SessionRun,
  Subagent,
  WorkspaceFile,
} from "@science-agent/schema";

export interface GovernedDownloadCandidate {
  candidate: ArtifactCandidate;
  invocationId: string;
}

/**
 * The activity cards a run produced while it was streaming: plans it proposed,
 * subagents it spawned, remote jobs and permission requests it raised, and the
 * workspace files eligible for the result preview.
 */
export interface RunActivityItems {
  downloadCandidates: GovernedDownloadCandidate[];
  downloadJobs: ArtifactJob[];
  downloadPlans: ArtifactPlan[];
  permissionRequests: PermissionRequest[];
  plans: SessionPlan[];
  previewFiles: WorkspaceFile[];
  remoteJobs: RemoteJob[];
  subagents: Subagent[];
}

/**
 * The cards of one run, plus the message after which they belong on the
 * timeline. A group without `runId`/`anchorMessageId` holds items that could
 * not be attributed to any started run; it is rendered as a fallback at the
 * end of the message flow.
 */
export interface RunActivityGroup extends RunActivityItems {
  anchorMessageId?: string;
  runId?: string;
}

/** Expansion state of every activity card in the message flow, keyed by card id. */
export type ActivityCardExpansion = Readonly<Record<string, boolean>>;

/** Panels receive the expansion map and report toggles through these props. */
export interface ActivityCardDisclosure {
  expandedCards: ActivityCardExpansion;
  onToggleCard: (id: string, expanded: boolean) => void;
}

/** Keep the expansion keys consistent across the card panels. */
export function activityCardId(
  kind: "artifacts" | "governed-downloads" | "permission" | "plan" | "remote-job" | "subagent",
  id: string,
): string {
  return `${kind}:${id}`;
}

/**
 * Toggle one card. Mirrors the RunTimeline `setTimelineEntryExpanded` pattern:
 * the state lives above the cards (in App), so a card group moving between a
 * conversation block and the tail of the flow never remount-resets it.
 *
 * The no-op guard must tell "not recorded" (`undefined`) apart from
 * "recorded as false": cards whose default is `true` (remote jobs awaiting
 * approval) rely on an explicit `false` actually landing in the map, which a
 * `Boolean(expansion[id]) === expanded` guard would swallow on first click.
 */
export function setActivityCardExpanded(
  expansion: ActivityCardExpansion,
  id: string,
  expanded: boolean,
): ActivityCardExpansion {
  if (id in expansion && expansion[id] === expanded) return expansion;
  return { ...expansion, [id]: expanded };
}

function isEmpty(items: RunActivityItems): boolean {
  return !items.downloadCandidates.length
    && !items.downloadJobs.length
    && !items.downloadPlans.length
    && !items.plans.length
    && !items.subagents.length
    && !items.remoteJobs.length
    && !items.permissionRequests.length
    && !items.previewFiles.length;
}

/** Union of the workspace paths a run's persisted events report as changed. */
export function collectRunChangedPaths(events: RunStreamEvent[]): string[] {
  const paths = new Set<string>();
  for (const event of events) {
    if (event.type === "workspace.changed") {
      for (const path of event.changedPaths) paths.add(path);
    }
  }
  return [...paths];
}

/**
 * Attribute every activity item to the run that produced it.
 *
 * Runs of a Session execute serially, and every item carries a backend
 * timestamp (`createdAt`; `modifiedAt` for files), so an item belongs to the
 * latest run that had already started when the item was created. Runs that
 * never started (cancelled while queued) cannot have produced anything and are
 * not attribution targets. Items older than the first started run — or whose
 * run cannot be determined — fall into the trailing unattributed group, which
 * the caller renders at the end of the message flow as the documented
 * degradation for anchor-less historical data.
 *
 * The result is deterministic across reloads because it depends only on
 * persisted backend timestamps, so card order survives page refreshes and
 * Session switches unchanged.
 *
 * Clock assumption: `createdAt` is written by the API process and
 * `modifiedAt` comes from the filesystem mtime of the workspace the same API
 * host writes to, so both share one clock. A deployment whose workspace sits
 * on a different clock (e.g. a network filesystem on another host) could
 * misattribute files across run boundaries.
 *
 * Preview files additionally honor `runChangedPaths` (runId → workspace paths
 * the run reported as changed via `workspace.changed` events): a file changed
 * by several runs appears in each of those runs' groups, so a report rewritten
 * every round keeps a card on every round that touched it. Files no run
 * reported fall back to the `modifiedAt` bucket (e.g. runs recorded before
 * workspace change events existed).
 */
export function groupRunActivity(
  runs: SessionRun[],
  items: RunActivityItems,
  runChangedPaths: Readonly<Record<string, readonly string[]>> = {},
  mcpInvocations: McpInvocation[] = [],
): RunActivityGroup[] {
  const startedRuns = runs
    .filter((run) => run.startedAt)
    .toSorted((left, right) => left.startedAt!.localeCompare(right.startedAt!));

  const byRun = new Map<string, RunActivityItems>();
  const unattributed: RunActivityItems = {
    downloadCandidates: [],
    downloadJobs: [],
    downloadPlans: [],
    permissionRequests: [],
    plans: [],
    previewFiles: [],
    remoteJobs: [],
    subagents: [],
  };

  function bucketForRun(runId: string): RunActivityItems {
    let bucketItems = byRun.get(runId);
    if (!bucketItems) {
      bucketItems = {
        downloadCandidates: [],
        downloadJobs: [],
        downloadPlans: [],
        permissionRequests: [],
        plans: [],
        previewFiles: [],
        remoteJobs: [],
        subagents: [],
      };
      byRun.set(runId, bucketItems);
    }
    return bucketItems;
  }

  function bucket(timestamp: string): RunActivityItems {
    for (let index = startedRuns.length - 1; index >= 0; index -= 1) {
      const run = startedRuns[index]!;
      if (run.startedAt! <= timestamp) return bucketForRun(run.id);
    }
    return unattributed;
  }

  const invocationById = new Map(mcpInvocations.map((invocation) => [invocation.id, invocation]));
  const downloadPlanById = new Map(items.downloadPlans.map((plan) => [plan.id, plan]));
  const subagentParentById = new Map(items.subagents.map((subagent) => [subagent.id, subagent.parentTurnId]));
  const startedRunIds = new Set(startedRuns.map((run) => run.id));

  function rootRunId(turnId: string | undefined): string | undefined {
    const visited = new Set<string>();
    let current = turnId;
    while (current && !visited.has(current)) {
      if (startedRunIds.has(current)) return current;
      visited.add(current);
      current = subagentParentById.get(current);
    }
    return undefined;
  }

  function downloadBucket(invocationId: string | undefined, fallbackTimestamp?: string): RunActivityItems {
    const runId = rootRunId(invocationId ? invocationById.get(invocationId)?.turnId : undefined);
    if (runId) return bucketForRun(runId);
    return fallbackTimestamp ? bucket(fallbackTimestamp) : unattributed;
  }

  for (const item of items.downloadCandidates) {
    downloadBucket(item.invocationId).downloadCandidates.push(item);
  }
  for (const plan of items.downloadPlans) {
    downloadBucket(plan.mcpInvocationId, plan.createdAt).downloadPlans.push(plan);
  }
  for (const job of items.downloadJobs) {
    const plan = downloadPlanById.get(job.planId);
    downloadBucket(plan?.mcpInvocationId, job.createdAt).downloadJobs.push(job);
  }

  for (const plan of items.plans) bucket(plan.createdAt).plans.push(plan);
  for (const subagent of items.subagents) bucket(subagent.createdAt).subagents.push(subagent);
  for (const job of items.remoteJobs) bucket(job.createdAt).remoteJobs.push(job);
  for (const request of items.permissionRequests) bucket(request.createdAt).permissionRequests.push(request);
  for (const file of items.previewFiles) {
    // Exact attribution first: every run that reported the path as changed
    // gets the card; untouched files fall back to the modifiedAt bucket.
    const changedBy = startedRuns.filter((run) => (runChangedPaths[run.id] ?? []).includes(file.path));
    if (changedBy.length) {
      for (const run of changedBy) bucketForRun(run.id).previewFiles.push(file);
    } else {
      bucket(file.modifiedAt).previewFiles.push(file);
    }
  }

  const groups: RunActivityGroup[] = [];
  for (const run of startedRuns) {
    const runItems = byRun.get(run.id);
    if (!runItems || isEmpty(runItems)) continue;
    groups.push({
      ...runItems,
      anchorMessageId: run.assistantMessageId ?? run.userMessageId,
      runId: run.id,
    });
  }
  if (!isEmpty(unattributed)) groups.push({ ...unattributed });
  return groups;
}
