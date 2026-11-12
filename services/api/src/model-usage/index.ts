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

import { randomUUID } from "node:crypto";

import type {
  ModelInvocationKind,
  ModelInvocationOutcome,
  ModelInvocationUsage,
  ModelUsageStatus,
  PromptManifest,
} from "@sciencediscovery/schema";

import { SessionStore } from "../store.js";

export interface CapturedModelUsage {
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  usageStatus: ModelUsageStatus;
}

export function unreportedModelUsage(): CapturedModelUsage {
  return {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    usageStatus: "provider-not-reported",
  };
}

/**
 * Add one turn's figures to a run's running total.
 *
 * The ledger used to keep only the last turn's usage (#1109), so a row's token
 * fields described one turn while its `startedAt`/`finishedAt` described the
 * whole run. Unknown stays unknown: a turn that reported nothing leaves the
 * total as it was rather than contributing zeros, and a total that received no
 * reported turn at all stays `provider-not-reported` with null fields.
 */
export function addCapturedModelUsage(
  previous: CapturedModelUsage,
  next: CapturedModelUsage,
): CapturedModelUsage {
  if (next.usageStatus !== "reported") return previous;
  const sum = (left: number | null, right: number | null) =>
    left === null && right === null ? null : (left ?? 0) + (right ?? 0);
  if (previous.usageStatus !== "reported") return { ...next, usageStatus: "reported" };
  return {
    cacheReadTokens: sum(previous.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: sum(previous.cacheWriteTokens, next.cacheWriteTokens),
    inputTokens: sum(previous.inputTokens, next.inputTokens),
    outputTokens: sum(previous.outputTokens, next.outputTokens),
    reasoningTokens: sum(previous.reasoningTokens, next.reasoningTokens),
    totalTokens: sum(previous.totalTokens, next.totalTokens),
    usageStatus: "reported",
  };
}

export function capturedModelUsage(event: {
  usage?: {
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number | null;
    totalTokens: number;
  };
  usageReported: boolean;
}): CapturedModelUsage {
  if (!event.usageReported || !event.usage) return unreportedModelUsage();
  return {
    cacheReadTokens: event.usage.cacheReadTokens ?? null,
    cacheWriteTokens: event.usage.cacheWriteTokens ?? null,
    inputTokens: event.usage.inputTokens,
    outputTokens: event.usage.outputTokens,
    reasoningTokens: event.usage.reasoningTokens ?? null,
    totalTokens: event.usage.totalTokens,
    usageStatus: "reported",
  };
}

export async function appendModelUsageForManifest(
  store: SessionStore,
  options: {
    attemptIndex?: number;
    invocationId: string;
    invocationKind: ModelInvocationKind;
    manifest: PromptManifest;
    outcome?: ModelInvocationOutcome;
    runId?: string;
    /** Model turns whose figures this record sums; absent when the caller has no count. */
    turnsRecorded?: number;
    usage: CapturedModelUsage;
  },
): Promise<ModelInvocationUsage> {
  const session = store.getSession(options.manifest.sessionId);
  const record: ModelInvocationUsage = {
    attemptIndex: options.attemptIndex ?? 0,
    cacheReadTokens: options.usage.cacheReadTokens,
    cacheWriteTokens: options.usage.cacheWriteTokens,
    costUsd: null,
    finishedAt: options.manifest.finishedAt,
    id: randomUUID(),
    inputTokens: options.usage.inputTokens,
    invocationId: options.invocationId,
    invocationKind: options.invocationKind,
    model: options.manifest.model,
    modelProfileId: options.manifest.modelProfileId,
    modelProfileName: options.manifest.modelProfileName,
    outcome: options.outcome ?? "completed",
    outputTokens: options.usage.outputTokens,
    reasoningTokens: options.usage.reasoningTokens,
    promptManifestId: options.manifest.id,
    ...(session?.projectId ? { projectId: session.projectId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    sessionId: options.manifest.sessionId,
    startedAt: options.manifest.createdAt,
    totalTokens: options.usage.totalTokens,
    ...(options.turnsRecorded !== undefined ? { turnsRecorded: options.turnsRecorded } : {}),
    usageStatus: options.usage.usageStatus,
  };
  await store.appendModelInvocationUsage(record);
  return record;
}

/**
 * One delegated child's spend, as its own row.
 *
 * The parent's `task` row covers the parent's turns; a child's model turns are
 * spend of the same run but a different invocation, so they get
 * `delegation-track` — the kind declared for this in
 * `packages/schema/src/model-usage.ts` and, until now, written by nobody. The
 * child's own window is used so the row's `startedAt`/`finishedAt` describe the
 * same scope as its token figures (#1109).
 */
export async function appendDelegatedModelUsage(
  store: SessionStore,
  options: {
    finishedAt: string;
    invocationId: string;
    parentRunId: string;
    promptManifest: PromptManifest;
    sessionId: string;
    startedAt: string;
    turnsRecorded?: number;
    usage: CapturedModelUsage;
  },
): Promise<ModelInvocationUsage> {
  const session = store.getSession(options.sessionId);
  const record: ModelInvocationUsage = {
    attemptIndex: 0,
    cacheReadTokens: options.usage.cacheReadTokens,
    cacheWriteTokens: options.usage.cacheWriteTokens,
    costUsd: null,
    finishedAt: options.finishedAt,
    id: randomUUID(),
    inputTokens: options.usage.inputTokens,
    invocationId: options.invocationId,
    invocationKind: "delegation-track",
    model: options.promptManifest.model,
    modelProfileId: options.promptManifest.modelProfileId,
    modelProfileName: options.promptManifest.modelProfileName,
    outcome: "completed",
    outputTokens: options.usage.outputTokens,
    promptManifestId: options.promptManifest.id,
    ...(session?.projectId ? { projectId: session.projectId } : {}),
    reasoningTokens: options.usage.reasoningTokens,
    runId: options.parentRunId,
    sessionId: options.sessionId,
    startedAt: options.startedAt,
    totalTokens: options.usage.totalTokens,
    ...(options.turnsRecorded !== undefined ? { turnsRecorded: options.turnsRecorded } : {}),
    usageStatus: options.usage.usageStatus,
  };
  await store.appendModelInvocationUsage(record);
  return record;
}