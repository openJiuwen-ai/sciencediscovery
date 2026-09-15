// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { ContextSectionContributor, DurableSkillStateContributor, type DurableContextStore, type AgentScope } from "@sciencediscovery/context";
import { createSkillTools, buildSkillSystemSection, type RuntimeSkill, type WorkspaceToolOptions } from "@sciencediscovery/workspace";
import type { PluginDefinition } from "@sciencediscovery/plugin-sdk";
import { emptyRuntimeContribution, type RuntimeContribution } from "@sciencediscovery/plugin-sdk/runtime";
import type { RuntimeMessage } from "@sciencediscovery/runtime-core";
import { manifest } from "./manifest.js";
export { manifest } from "./manifest.js";

export function skillPlugin<M extends RuntimeMessage>(ports: {
  skills: RuntimeSkill[];
  createSkill?: WorkspaceToolOptions["createSkill"];
  proposeSkillLibraryUpdate?: WorkspaceToolOptions["proposeSkillLibraryUpdate"];
  publishSkillLibraryUpdate?: WorkspaceToolOptions["publishSkillLibraryUpdate"];
  toolPolicy?: WorkspaceToolOptions["toolPolicy"];
  durable: DurableContextStore;
  scope: AgentScope;
}): PluginDefinition<RuntimeContribution<M>> {
  return {
    manifest,
    create() {
      const tools = createSkillTools(ports);
      const selected = tools.some((tool) => tool.name === "read_skill") ? ports.skills : [];
      const register = (skill: RuntimeSkill) => ports.durable.registerSkill({
        id: skill.id, hash: skill.hash, revision: skill.revision, version: skill.version, description: skill.description,
      });
      const active = new Set(ports.durable.snapshot().skills.map((skill) => skill.id));
      for (const skill of selected) if (active.has(skill.id)) register(skill);
      return { contribution: {
        ...emptyRuntimeContribution<M>(),
        tools,
        contextFactories: selected.length ? [{
          id: "skills",
          create: () => [
            new ContextSectionContributor<M>({
              id: "skills.catalog", scopes: [ports.scope], stateReads: [],
              async contribute() { return { systemSections: [{
                content: buildSkillSystemSection(selected), id: "skills.catalog", order: 50, slot: "capabilities",
              }] }; },
            }),
            new DurableSkillStateContributor<M>(ports.durable, [ports.scope]),
          ],
        }] : [],
        async commitResult({ call, isError }) {
          if (call.name !== "read_skill" || isError) return;
          const skill = selected.find((item) => item.id === call.args.skillId);
          if (skill) register(skill);
        },
      } };
    },
  };
}
