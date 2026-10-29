// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { Type, type TSchema } from "typebox";
import type { ConfigurationCapabilityId } from "@sciencediscovery/schema";
export interface ConfigurationAgentDescriptor {
  label: string;
  whenNeeded: string;
  fields: Record<string, { kind: "string" | "boolean" | "ids" | "integer"; maxLength?: number; minimum?: number; maximum?: number; choices?: readonly string[] }>;
  activation: "next_run" | "same_run_if_bound";
  diagnostics: readonly string[];
}
const id = { kind: "string", maxLength: 200 } as const;
const ids = { kind: "ids" } as const;
const boolean = { kind: "boolean" } as const;
/** Trusted finite descriptions. Each domain adds its fields here once; tools are generated from them. */
export const CONFIGURATION_AGENT_DESCRIPTORS: Record<ConfigurationCapabilityId, ConfigurationAgentDescriptor> = {
  "model.select": { label: "Choose an existing model", whenNeeded: "An explicit model choice or no usable task model. Do not replace a usable inherited default without a requirement.", fields: { modelId: id }, activation: "next_run", diagnostics: ["MODEL_NOT_SELECTED"] },
  "model.connect": { label: "Connect a model service", whenNeeded: "A new model service is needed. The user supplies credentials only in the secure card.", fields: { name: { ...id, maxLength: 200 }, baseUrl: { kind: "string", maxLength: 2048 }, model: { ...id, maxLength: 512 }, apiProtocol: { kind: "string", choices: ["openai-chat-completions", "openai-responses", "anthropic-messages"] }, apiVariant: { ...id, maxLength: 80 }, tokenOptional: boolean }, activation: "next_run", diagnostics: [] },
  "model.repair_credential": { label: "Repair a model credential", whenNeeded: "A structured authentication diagnosis identifies this exact model. A network failure, timeout or rate limit is not authentication evidence.", fields: { modelId: id }, activation: "next_run", diagnostics: ["MODEL_CREDENTIAL_MISSING", "MODEL_AUTHENTICATION_REJECTED"] },
  "connector.enable": { label: "Enable a ready connector", whenNeeded: "The current task requires an installed, ready connector missing from the effective tool set. Respect refusals and alternatives.", fields: { connectorId: { ...id, maxLength: 100 } }, activation: "same_run_if_bound", diagnostics: ["CONNECTOR_DISABLED"] },
  "skill.select": { label: "Select installed Skills and Libraries", whenNeeded: "The user requests a selection of installed Skills or Libraries. In all mode every installed Skill is already available; do not ask to enable it again.", fields: { skillSelectionMode: { kind: "string", choices: ["all", "selected"] }, enabledSkillIds: ids, enabledSkillLibraryIds: ids }, activation: "next_run", diagnostics: ["SKILL_EXCLUDED"] },
  "thinking.configure": { label: "Configure model thinking", whenNeeded: "The user explicitly requests a thinking mode or effort supported by the current model API variant. Applies to future runs, never the active frozen model.", fields: { thinkingMode: { kind: "string", choices: ["auto", "disabled", "enabled"] }, thinkingEffort: { kind: "string", choices: ["low", "medium", "high", "xhigh", "max"] } }, activation: "next_run", diagnostics: ["THINKING_REQUIREMENT"] },
  "review.configure": { label: "Configure session review", whenNeeded: "The user requests review model, semantic review, automatic review or review level for this session. The global Reviewer Specialist switch is separate and cannot be changed here.", fields: { reviewModelId: id, semanticReviewEnabled: boolean, automaticReviewEnabled: boolean, level: { kind: "string", choices: ["quick", "deep"] } }, activation: "next_run", diagnostics: ["REVIEW_REQUIREMENT"] },
  "timeouts.configure": { label: "Configure deployment timeouts", whenNeeded: "The user explicitly asks to change a deployment-wide timeout. 0 disables that one limit. Do not widen a timeout because a single run timed out. Omit scope; this is not a session setting and does not resume the active run.", fields: {
    gatewayIdleTimeoutMs: { kind: "integer", minimum: 0 }, gatewayTurnTimeoutMs: { kind: "integer", minimum: 0 }, kernelIdleTimeoutMs: { kind: "integer", minimum: 0 },
    permissionWaitTimeoutMs: { kind: "integer", minimum: 0 }, runnerExecTimeoutMs: { kind: "integer", minimum: 0 },
  }, activation: "next_run", diagnostics: [] },
  "quotas.configure": { label: "Configure deployment quotas", whenNeeded: "The user explicitly asks to change a deployment-wide quota. 0 removes a byte cap. Concurrent subagents stay between 1 and 10. Omit scope; this does not resume the active run or inherit a tool permission.", fields: {
    maxConcurrentSubagents: { kind: "integer", minimum: 1, maximum: 10 }, runnerMaxOutputBytes: { kind: "integer", minimum: 0 }, runnerMaxWorkspaceBytes: { kind: "integer", minimum: 0 },
    uploadMaxFileBytes: { kind: "integer", minimum: 0 }, uploadMaxRequestBytes: { kind: "integer", minimum: 0 },
  }, activation: "next_run", diagnostics: [] },
  "idea_tree.configure": { label: "Configure Idea Tree limits", whenNeeded: "The user explicitly asks to change Idea Tree intensity, score direction, or a bounded token, depth, or node limit. Template and intensity determine rounds, candidates, and assessors. Omit scope; an in-progress idea-tree run keeps the settings it already read.", fields: {
    explorationIntensity: { kind: "string", choices: ["quick", "standard", "deep"] }, scoreDirection: { kind: "string", choices: ["maximize", "minimize"] },
    maxTokensPerCall: { kind: "integer", minimum: 256, maximum: 32768 }, maxDepth: { kind: "integer", minimum: 1, maximum: 20 },
    maxNodes: { kind: "integer", minimum: 2, maximum: 10000 },
  }, activation: "next_run", diagnostics: [] },
};
export const SYSTEM_CONFIGURATION_CAPABILITIES = ["timeouts.configure", "quotas.configure", "idea_tree.configure"] as const satisfies readonly ConfigurationCapabilityId[];
export function descriptorValuesSchema(descriptor: ConfigurationAgentDescriptor): TSchema {
  return Type.Object(Object.fromEntries(Object.entries(descriptor.fields).map(([name, field]) => {
    const schema = field.kind === "ids" ? Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 500, uniqueItems: true })
      : field.kind === "boolean" ? Type.Boolean()
      : field.kind === "integer" ? Type.Integer({ minimum: field.minimum ?? 0, ...(field.maximum === undefined ? {} : { maximum: field.maximum }) })
      : field.choices ? Type.Union(field.choices.map(value => Type.Literal(value))) : Type.String({ maxLength: field.maxLength ?? 200 });
    return [name, Type.Optional(schema)];
  })), { additionalProperties: false });
}
