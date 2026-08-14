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

import type { CasStore } from "@science-agent/cas";
import type { ChatMessage, EffectiveRuntimeSettings, ModelProfile, ModelUsageStatus, PromptManifest } from "@science-agent/schema";

export interface CreatePromptManifestOptions {
  cas: CasStore;
  error?: string;
  messages: ChatMessage[];
  model: ModelProfile;
  response?: string;
  runtimeSettings: EffectiveRuntimeSettings;
  sessionId: string;
  startedAt: string;
  systemPrompt: string;
  systemPromptVersion: string;
  skillRefs: PromptManifest["skillRefs"];
  specialistRef?: PromptManifest["specialistRef"];
  turnId: string;
  usage?: {
    costUsd?: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    usageStatus: ModelUsageStatus;
  };
}

export async function createPromptManifest(options: CreatePromptManifestOptions): Promise<PromptManifest> {
  const inputs = [];
  for (const message of options.messages) {
    inputs.push({
      ...await options.cas.put(message.content),
      messageId: message.id,
      role: message.role,
    });
  }
  const systemPrompt = await options.cas.put(options.systemPrompt);
  const response = options.response === undefined
    ? options.error === undefined ? undefined : await options.cas.put(options.error)
    : await options.cas.put(options.response);
  const endpointHost = new URL(options.model.baseUrl).host;

  return {
    costUsd: options.usage?.costUsd ?? null,
    createdAt: options.startedAt,
    endpointHost,
    finishedAt: new Date().toISOString(),
    id: randomUUID(),
    inputs,
    inputTokens: options.usage?.inputTokens ?? null,
    model: options.model.model,
    modelProfileId: options.model.id,
    modelProfileName: options.model.name,
    outputTokens: options.usage?.outputTokens ?? null,
    provider: "openai-compatible",
    redactionStatus: "not-applied",
    ...(response ? { response } : {}),
    runtimeSettings: structuredClone(options.runtimeSettings),
    sessionId: options.sessionId,
    skillRefs: options.skillRefs,
    ...(options.specialistRef ? { specialistRef: structuredClone(options.specialistRef) } : {}),
    status: options.error === undefined ? "succeeded" : "failed",
    systemPrompt: { ...systemPrompt, version: options.systemPromptVersion },
    totalTokens: options.usage?.totalTokens ?? null,
    turnId: options.turnId,
    usageStatus: options.usage?.usageStatus ?? "provider-not-reported",
  };
}
