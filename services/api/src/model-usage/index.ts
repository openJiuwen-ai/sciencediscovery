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
  ModelInvocationUsage,
  ModelUsageStatus,
  PromptManifest,
} from "@science-agent/schema";

import { SessionStore } from "../store.js";

export interface CapturedModelUsage {
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  usageStatus: ModelUsageStatus;
}

export function unreportedModelUsage(): CapturedModelUsage {
  return {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    usageStatus: "provider-not-reported",
  };
}

export function capturedModelUsage(event: {
  usage?: {
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    inputTokens: number;
    outputTokens: number;
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
    runId?: string;
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
    outputTokens: options.usage.outputTokens,
    promptManifestId: options.manifest.id,
    ...(session?.projectId ? { projectId: session.projectId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    sessionId: options.manifest.sessionId,
    startedAt: options.manifest.createdAt,
    totalTokens: options.usage.totalTokens,
    usageStatus: options.usage.usageStatus,
  };
  await store.appendModelInvocationUsage(record);
  return record;
}
