// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ResolvedProxy } from "@sciencediscovery/schema";

export interface AgentConfig {
  apiToken?: string;
  baseUrl: string;
  dataDir: string;
  model: string;
  proxy?: ResolvedProxy;
}

export interface ModelUsage {
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
