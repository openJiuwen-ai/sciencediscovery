// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createSubagentTools, type WorkspaceToolOptions } from "@sciencediscovery/workspace";
import type { PluginDefinition } from "@sciencediscovery/plugin-sdk";
import { emptyRuntimeContribution, type RuntimeContribution } from "@sciencediscovery/plugin-sdk/runtime";
import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

import { manifest } from "./manifest.js";
export { manifest } from "./manifest.js";
export type SubagentExecutionPort = NonNullable<WorkspaceToolOptions["runSubagent"]>;
export interface SchedulingPolicy { dispatch: SubagentExecutionPort }
/** Policies choose dispatch; execution, permission checks and child budgets remain with the port. */
export function schedulerPlugin<M extends RuntimeMessage>(ports: Pick<WorkspaceToolOptions, "runSubagent" | "specialists" | "toolPolicy" | "listArtifacts">, policy?: SchedulingPolicy): PluginDefinition<RuntimeContribution<M>> {
  return { manifest, create: () => ({ contribution: {
    ...emptyRuntimeContribution<M>(),
    tools: createSubagentTools({ ...ports, runSubagent: ports.runSubagent ? policy?.dispatch ?? ports.runSubagent : undefined }),
  } }) };
}
