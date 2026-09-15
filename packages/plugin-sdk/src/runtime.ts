// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ContextContributorFactory, StateProvider } from "@sciencediscovery/context";
import type { RuntimeMessage } from "@sciencediscovery/runtime-core";
import type { AgentTool, ToolBatchPolicy, ToolRegistryOptions } from "@sciencediscovery/tools";

/** Runtime-neutral domain contributions; no API store or model client access. */
export interface RuntimeContribution<M extends RuntimeMessage> {
  tools: AgentTool[];
  batchPolicies: ToolBatchPolicy[];
  contextFactories: ContextContributorFactory<M>[];
  stateProviders: StateProvider[];
  commitResult?: ToolRegistryOptions<M>["commitResult"];
}
export function emptyRuntimeContribution<M extends RuntimeMessage>(): RuntimeContribution<M> {
  return { tools: [], batchPolicies: [], contextFactories: [], stateProviders: [] };
}
