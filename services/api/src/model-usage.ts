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
  GlobalModelUsageSummary,
  GlobalUsageModelGroup,
  GlobalUsageProjectGroup,
  GlobalUsageRunGroup,
  GlobalUsageSessionGroup,
  ModelInvocationUsage,
  ModelUsageBucket,
  SessionUsageSummary,
} from "@sciencediscovery/schema";

export function createUsageBucket(key: string, label: string): ModelUsageBucket {
  return {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    inputTokens: null,
    invocationCount: 0,
    key,
    label,
    outputTokens: null,
    reportedInvocationCount: 0,
    totalTokens: null,
    unreportedInvocationCount: 0,
  };
}

function addNullable(current: number | null, addition: number | null | undefined): number | null {
  if (addition === null || addition === undefined) return current;
  return (current ?? 0) + addition;
}

export function addUsageToBucket(bucket: ModelUsageBucket, usage: ModelInvocationUsage): void {
  bucket.invocationCount += 1;
  if (usage.usageStatus === "reported") {
    bucket.reportedInvocationCount += 1;
    bucket.inputTokens = addNullable(bucket.inputTokens, usage.inputTokens);
    bucket.outputTokens = addNullable(bucket.outputTokens, usage.outputTokens);
    bucket.totalTokens = addNullable(bucket.totalTokens, usage.totalTokens);
    bucket.cacheReadTokens = addNullable(bucket.cacheReadTokens, usage.cacheReadTokens);
    bucket.cacheWriteTokens = addNullable(bucket.cacheWriteTokens, usage.cacheWriteTokens);
    bucket.costUsd = addNullable(bucket.costUsd, usage.costUsd);
  } else {
    bucket.unreportedInvocationCount += 1;
  }
}

function addToMap(
  buckets: Map<string, ModelUsageBucket>,
  key: string,
  label: string,
  usage: ModelInvocationUsage,
): void {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = createUsageBucket(key, label);
    buckets.set(key, bucket);
  }
  addUsageToBucket(bucket, usage);
}

function sortBuckets(buckets: Iterable<ModelUsageBucket>): ModelUsageBucket[] {
  return [...buckets].toSorted((left, right) =>
    right.invocationCount - left.invocationCount
    || left.label.localeCompare(right.label)
    || left.key.localeCompare(right.key));
}

function normalizeInvocation(usage: ModelInvocationUsage): ModelInvocationUsage {
  return {
    ...usage,
    cacheReadTokens: usage.cacheReadTokens ?? null,
    cacheWriteTokens: usage.cacheWriteTokens ?? null,
  };
}

export function summarizeModelUsage(
  sessionId: string,
  records: ModelInvocationUsage[],
): SessionUsageSummary {
  const invocations = records
    .filter((usage) => usage.sessionId === sessionId)
    .map(normalizeInvocation)
    .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
  const totals = createUsageBucket(sessionId, "Session");
  const byModel = new Map<string, ModelUsageBucket>();
  const byInvocationKind = new Map<string, ModelUsageBucket>();
  const byRun = new Map<string, ModelUsageBucket>();

  for (const usage of invocations) {
    addUsageToBucket(totals, usage);
    addToMap(byModel, usage.modelProfileId, usage.modelProfileName, usage);
    addToMap(byInvocationKind, usage.invocationKind, usage.invocationKind, usage);
    if (usage.runId) addToMap(byRun, usage.runId, usage.runId, usage);
  }

  return {
    byInvocationKind: sortBuckets(byInvocationKind.values()),
    byModel: sortBuckets(byModel.values()),
    byRun: sortBuckets(byRun.values()),
    invocations: structuredClone(invocations),
    ...(invocations.at(-1) ? { latestInvocation: structuredClone(invocations.at(-1)!) } : {}),
    sessionId,
    totals,
  };
}

export interface GlobalUsageContext {
  projectNameById: Map<string, string>;
  projectIdBySessionId: Map<string, string>;
  sessionTitleById: Map<string, string>;
}

function resolveProjectId(usage: ModelInvocationUsage, context: GlobalUsageContext): string {
  return usage.projectId
    ?? context.projectIdBySessionId.get(usage.sessionId)
    ?? "unknown-project";
}

function buildRunGroups(records: ModelInvocationUsage[]): GlobalUsageRunGroup[] {
  const groups = new Map<string, GlobalUsageRunGroup>();
  for (const usage of records) {
    const runId = usage.runId ?? null;
    const key = runId ?? `invocation:${usage.id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        bucket: createUsageBucket(key, runId ?? usage.invocationId),
        invocations: [],
        runId,
      };
      groups.set(key, group);
    }
    addUsageToBucket(group.bucket, usage);
    group.invocations.push(structuredClone(usage));
  }
  return [...groups.values()].toSorted((left, right) =>
    right.bucket.invocationCount - left.bucket.invocationCount
    || (left.runId ?? "").localeCompare(right.runId ?? ""));
}

function buildSessionGroups(
  records: ModelInvocationUsage[],
  context: GlobalUsageContext,
): GlobalUsageSessionGroup[] {
  const groups = new Map<string, { records: ModelInvocationUsage[]; sessionId: string }>();
  for (const usage of records) {
    let group = groups.get(usage.sessionId);
    if (!group) {
      group = { records: [], sessionId: usage.sessionId };
      groups.set(usage.sessionId, group);
    }
    group.records.push(usage);
  }
  return [...groups.values()].map((group) => {
    const bucket = createUsageBucket(group.sessionId, context.sessionTitleById.get(group.sessionId) ?? group.sessionId);
    for (const usage of group.records) addUsageToBucket(bucket, usage);
    return {
      bucket,
      runs: buildRunGroups(group.records),
      sessionId: group.sessionId,
      sessionTitle: context.sessionTitleById.get(group.sessionId) ?? group.sessionId,
    };
  }).toSorted((left, right) =>
    right.bucket.invocationCount - left.bucket.invocationCount
    || left.sessionTitle.localeCompare(right.sessionTitle));
}

function buildProjectGroups(
  records: ModelInvocationUsage[],
  context: GlobalUsageContext,
): GlobalUsageProjectGroup[] {
  const groups = new Map<string, { projectId: string; records: ModelInvocationUsage[] }>();
  for (const usage of records) {
    const projectId = resolveProjectId(usage, context);
    let group = groups.get(projectId);
    if (!group) {
      group = { projectId, records: [] };
      groups.set(projectId, group);
    }
    group.records.push(usage);
  }
  return [...groups.values()].map((group) => {
    const projectName = context.projectNameById.get(group.projectId) ?? group.projectId;
    const bucket = createUsageBucket(group.projectId, projectName);
    for (const usage of group.records) addUsageToBucket(bucket, usage);
    return {
      bucket,
      projectId: group.projectId,
      projectName,
      sessions: buildSessionGroups(group.records, context),
    };
  }).toSorted((left, right) =>
    right.bucket.invocationCount - left.bucket.invocationCount
    || left.projectName.localeCompare(right.projectName));
}

export function summarizeGlobalModelUsage(
  records: ModelInvocationUsage[],
  context: GlobalUsageContext,
): GlobalModelUsageSummary {
  const normalized = records.map(normalizeInvocation)
    .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
  const totals = createUsageBucket("global", "All models");
  const byModel = new Map<string, { modelProfileId: string; modelProfileName: string; model: string; records: ModelInvocationUsage[] }>();

  for (const usage of normalized) {
    addUsageToBucket(totals, usage);
    let group = byModel.get(usage.modelProfileId);
    if (!group) {
      group = {
        model: usage.model,
        modelProfileId: usage.modelProfileId,
        modelProfileName: usage.modelProfileName,
        records: [],
      };
      byModel.set(usage.modelProfileId, group);
    }
    group.records.push(usage);
  }

  const modelGroups: GlobalUsageModelGroup[] = [...byModel.values()].map((group) => {
    const bucket = createUsageBucket(group.modelProfileId, group.modelProfileName);
    for (const usage of group.records) addUsageToBucket(bucket, usage);
    return {
      bucket,
      model: group.model,
      modelProfileId: group.modelProfileId,
      modelProfileName: group.modelProfileName,
      projects: buildProjectGroups(group.records, context),
    };
  }).toSorted((left, right) =>
    right.bucket.invocationCount - left.bucket.invocationCount
    || left.modelProfileName.localeCompare(right.modelProfileName));

  return { byModel: modelGroups, totals };
}
