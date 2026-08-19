// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type {
  ModelApiProtocol,
  ModelApiVariant,
  ModelThinkingEffort,
  ModelThinkingMode,
  ResolvedProxy,
} from "@sciencediscovery/schema";

export interface AgentConfig {
  apiToken?: string;
  apiProtocol?: ModelApiProtocol;
  apiVariant?: ModelApiVariant;
  baseUrl: string;
  dataDir: string;
  model: string;
  proxy?: ResolvedProxy;
  thinkingEffort?: ModelThinkingEffort;
  thinkingMode?: ModelThinkingMode;
}

export interface ModelUsage {
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
