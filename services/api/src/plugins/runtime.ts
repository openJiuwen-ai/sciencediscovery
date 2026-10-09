// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createPluginScope, disabledPluginIds, validatePluginSettings, negotiatePlugins, ServiceRegistry, type PluginSettingsMap, type PluginDefinition } from "@sciencediscovery/plugin-sdk";
import { installedPlugins } from "./catalog.js";
import { planPlugin } from "@sciencediscovery/plan/plugin";
import { skillPlugin } from "@sciencediscovery/skill/plugin";
import { mcpPlugin } from "@sciencediscovery/mcp/plugin";
import { schedulerPlugin } from "@sciencediscovery/scheduler/plugin";
import type { RuntimeContribution } from "@sciencediscovery/plugin-sdk/runtime";
import type { WorkspaceAgentOptions } from "@sciencediscovery/workspace";
import type { PlanStore } from "@sciencediscovery/plan";
import { createEvolveTools, type EvolveToolRuntime } from "@sciencediscovery/evolve";
import type { AgentScope, DurableContextStore } from "@sciencediscovery/context";
import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

/** Build-time installation. Providers receive only their own domain ports. */
export function runtimePluginDefinitions<M extends RuntimeMessage>(options: {
  scope: AgentScope;
  workspace: WorkspaceAgentOptions;
  durable: DurableContextStore;
  planStore?: PlanStore;
  evolve?: EvolveToolRuntime;
}): PluginDefinition<RuntimeContribution<M>>[] {
  return [
    skillPlugin<M>({ skills: options.workspace.skills ?? [], createSkill: options.workspace.createSkill,
      proposeSkillLibraryUpdate: options.workspace.proposeSkillLibraryUpdate,
      publishSkillLibraryUpdate: options.workspace.publishSkillLibraryUpdate,
      toolPolicy: options.workspace.toolPolicy, durable: options.durable, scope: options.scope }),
    mcpPlugin<M>({ mcpTools: options.workspace.mcpTools, toolPolicy: options.workspace.toolPolicy }),
    schedulerPlugin<M>({ runSubagent: options.workspace.runSubagent, specialists: options.workspace.specialists, toolPolicy: options.workspace.toolPolicy, listArtifacts: options.workspace.listArtifacts }),
    ...(options.planStore ? [planPlugin<M>(options.planStore, [options.scope])] : []),
    ...(options.evolve ? [{
      manifest: { id: "evolve", version: "0.1.0", apiVersion: 1 as const },
      create: () => ({ contribution: { tools: createEvolveTools(options.evolve), batchPolicies: [], contextFactories: [], stateProviders: [] } }),
    }] : []),
  ];
}

export async function createRuntimePluginScope<M extends RuntimeMessage>(options: Parameters<typeof runtimePluginDefinitions<M>>[0], disabled: readonly string[] = [], settings: PluginSettingsMap = {}) {
  const normalized = validatePluginSettings(settings, installedPlugins);
  const services = new ServiceRegistry();
  services.provide({ id: "skill.catalog", version: 1 }, options.workspace.skills ?? []);
  if (options.workspace.mcpTools) services.provide({ id: "mcp.tools", version: 1 }, options.workspace.mcpTools);
  if (options.workspace.runSubagent) services.provide({ id: "subagent.dispatch", version: 1 }, options.workspace.runSubagent);
  if (options.planStore) services.provide({ id: "plan.store", version: 1 }, options.planStore);
  const definitions = runtimePluginDefinitions<M>({ ...options, workspace: { ...options.workspace,
    skills: services.require({ id: "skill.catalog", version: 1 }),
    mcpTools: services.require({ id: "mcp.tools", version: 1, optional: true }),
    runSubagent: services.require({ id: "subagent.dispatch", version: 1, optional: true }),
  }, planStore: services.require({ id: "plan.store", version: 1, optional: true }) });
  const known = new Set([...installedPlugins.map((item) => item.id), "evolve"]);
  for (const id of disabled) if (!known.has(id)) throw new Error(`Unknown plugin: ${id}`);
  // Installed but currently unavailable plugins may still be configured/disabled.
  const statuses = negotiatePlugins([...installedPlugins.filter((item) => item.entries?.runtime),
    ...definitions.filter((item) => item.manifest.id === "evolve").map((item) => item.manifest)], { settings: normalized,
    services: services.describe(), permissions: ["runtime.contribute"] });
  const excluded = [...new Set([...disabled, ...disabledPluginIds(normalized),
    ...statuses.filter((item) => !item.available || !item.authorized).map((item) => item.id)])]
    .filter((id) => definitions.some((item) => item.manifest.id === id));
  const scope = await createPluginScope(definitions, excluded);
  let active = false;
  return {
    get manifests() { return scope.manifests; },
    get status() { return statuses.map((item) => ({...structuredClone(item),
      active:active && scope.manifests.some((manifest) => manifest.id===item.id)})); },
    contributions:scope.contributions,
    async start(signal:AbortSignal) { await scope.start(signal); active=true; },
    async dispose() { active=false; await scope.dispose(); },
  };
}
