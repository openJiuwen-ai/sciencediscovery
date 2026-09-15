// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createHash } from "node:crypto";
import { canonicalState, StateCoordinator, type AgentScope } from "@sciencediscovery/context";
import { createPlanTool, createPlanBatchPolicy, createPlanContextFactory, type PlanStore } from "./index.js";
import type { RuntimeMessage } from "@sciencediscovery/runtime-core";
import type { PluginDefinition } from "@sciencediscovery/plugin-sdk";
import type { RuntimeContribution } from "@sciencediscovery/plugin-sdk/runtime";

import { manifest } from "./manifest.js";
export { manifest } from "./manifest.js";
export function planPlugin<M extends RuntimeMessage>(store: PlanStore, scopes: readonly AgentScope[]): PluginDefinition<RuntimeContribution<M>> {
  const coordinator = new StateCoordinator();
  const coordinatedStore: PlanStore = {
    latest: store.latest.bind(store),
    update: (input, toolCallId, signal) => coordinator.command(() => store.update(input, toolCallId, signal), signal),
  };
  return {
    manifest,
    create: () => ({
      contribution: {
        tools: [createPlanTool({ store: coordinatedStore })],
        batchPolicies: [createPlanBatchPolicy()],
        contextFactories: [createPlanContextFactory<M>(scopes)],
        stateProviders: [{
          id: "plan",
          async capture(signal) {
            const captured = await coordinator.capture(async () => JSON.parse(JSON.stringify(await store.latest(signal) ?? null)) as unknown, signal);
            const { value } = captured;
            return { id: "plan", schemaVersion: 1, revision: captured.revision + ":" + createHash("sha256").update(canonicalState(value)).digest("hex"), value, fidelity: "captured" };
          },
        }],
      },
    }),
  };
}
