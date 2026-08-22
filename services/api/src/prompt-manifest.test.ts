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

import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import type { ChatMessage, EffectiveRuntimeSettings, ModelProfile } from "@sciencediscovery/schema";

import { createPromptManifest } from "./prompt-manifest.js";
import { CasStore } from "@sciencediscovery/cas";

const runtimeSettings: EffectiveRuntimeSettings = {
  enabledConnectorIds: [],
  enabledSkillIds: [],
  modelId: "model-a",
  semanticReviewEnabled: false,
  skillSelectionMode: "all",
};

const model: ModelProfile = {
  baseUrl: "https://models.example.test/v1",
  createdAt: "2026-01-01T00:00:00.000Z",
  hasApiToken: true,
  id: "model-a",
  model: "test-model",
  name: "Model A",
  proxyPolicy: "inherit",
  updatedAt: "2026-01-01T00:00:00.000Z",
  vision: false,
};

const message: ChatMessage = {
  content: "Question",
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "message-a",
  role: "user",
};

test("USG-006 prompt manifests backfill reported usage fields", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `prompt-manifest-usg-006-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));

  const manifest = await createPromptManifest({
    cas: new CasStore(dataDir),
    messages: [message],
    model,
    response: "Answer",
    runtimeSettings,
    sessionId: "session-a",
    skillRefs: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    systemPrompt: "System",
    systemPromptVersion: "test",
    turnId: "run-a",
    usage: {
      inputTokens: 21,
      outputTokens: 9,
      totalTokens: 30,
      usageStatus: "reported",
    },
  });

  assert.equal(manifest.usageStatus, "reported");
  assert.equal(manifest.inputTokens, 21);
  assert.equal(manifest.outputTokens, 9);
  assert.equal(manifest.totalTokens, 30);
  assert.equal(manifest.costUsd, null);
});
