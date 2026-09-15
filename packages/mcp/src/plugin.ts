// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createMcpTools, type WorkspaceToolOptions } from "@sciencediscovery/workspace";
import type { PluginDefinition } from "@sciencediscovery/plugin-sdk";
import { emptyRuntimeContribution, type RuntimeContribution } from "@sciencediscovery/plugin-sdk/runtime";
import type { RuntimeMessage } from "@sciencediscovery/runtime-core";
import { manifest } from "./manifest.js";
export { manifest } from "./manifest.js";
export function mcpPlugin<M extends RuntimeMessage>(ports: Pick<WorkspaceToolOptions, "mcpTools" | "toolPolicy">): PluginDefinition<RuntimeContribution<M>> {
  return { manifest, create: () => ({ contribution: { ...emptyRuntimeContribution<M>(), tools: createMcpTools(ports) } }) };
}
