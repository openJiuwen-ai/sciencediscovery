// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { Type, type TSchema } from "typebox";
import type { ConfigurationCapabilityId } from "@sciencediscovery/schema";
import { ENVIRONMENT_CONDA_SOURCE_PRESETS, ENVIRONMENT_PIP_SOURCE_PRESETS } from "@sciencediscovery/schema";
export interface ConfigurationAgentDescriptor {
  label: string;
  whenNeeded: string;
  fields: Record<string, { kind: "string" | "boolean" | "ids" | "integer"; maxLength?: number; minimum?: number; maximum?: number; choices?: readonly string[] }>;
  activation: "next_run" | "requires_restart" | "same_run_if_bound" | "next_request";
  diagnostics: readonly string[];
}
const id = { kind: "string", maxLength: 200 } as const;
const ids = { kind: "ids" } as const;
const boolean = { kind: "boolean" } as const;
/** Trusted finite descriptions. Each domain adds its fields here once; tools are generated from them. */
export const CONFIGURATION_AGENT_DESCRIPTORS: Record<ConfigurationCapabilityId, ConfigurationAgentDescriptor> = {
  "environment.sources": { label: "Choose package sources", whenNeeded: "The user explicitly requests a pip or conda package-source preset for this deployment. This changes future environment preparation or package installation, not installed packages or active environments. Omit scope. No download or installation is authorized by this proposal.", fields: {
    pipSource: { kind: "string", choices: ENVIRONMENT_PIP_SOURCE_PRESETS.map(preset => preset.id) },
    condaSource: { kind: "string", choices: ENVIRONMENT_CONDA_SOURCE_PRESETS.map(preset => preset.id) },
  }, activation: "next_run", diagnostics: [] },
  "memory.credential": { label: "Configure Neo4j password", whenNeeded: "The user explicitly replaces or clears the stored Neo4j password. Only operation is an ordinary field; the user supplies the password through the secure card after separate destination consent. Existing connection, backend and participation are unchanged. Saving does not verify authentication or runtime revocation. A bound original configuration wait may continue through the framework; activation timing and execution permissions remain separate. Omit scope; manual confirmation required.", fields: { operation: { kind: "string", choices: ["replace", "clear"] } }, activation: "requires_restart", diagnostics: [] },
  "memory.enable": { label: "Enable or disable workbench memory graph", whenNeeded: "The user explicitly requests the deployment-wide MemoryGraph participation switch. This is not every Agent memory. Enabling permits later research-memory operations to use the configured backend/credentials; disabling retains stored data and does not cancel in-flight work. No backend change, installation or readiness verification. Omit scope; A bound original configuration wait may continue through the framework; activation timing and execution permissions remain separate.", fields: { enabled: boolean }, activation: "next_request", diagnostics: [] },
  "memory.backend": { label: "Choose memory graph backend", whenNeeded: "The user explicitly selects the deployment-wide existing local or Neo4j backend. Keep the enabled flag, connection and credentials unchanged. No migration, deletion, installation, immediate activation verification. A bound original configuration wait may continue through the framework; activation timing and execution permissions remain separate. Neo4j may use its existing destination and credentials during settings self-heal/startup. Omit scope; a consistent restart remains an operator action.", fields: { backend: { kind: "string", choices: ["local", "neo4j"] } }, activation: "requires_restart", diagnostics: [] },
  "memory.connection": { label: "Configure Neo4j connection", whenNeeded: "The user explicitly changes the shared saved Neo4j root HTTP(S) origin or username. Never accept passwords here. Existing credentials/research context may later use the new recipient, so independent destination approval and manual save are required. Keep participation/backend/password unchanged; no probe, migration, restart. A bound original configuration wait may continue through the framework; activation timing and execution permissions remain separate. Omit scope.", fields: { neo4jHttp: { kind: "string", maxLength: 8192 }, neo4jUser: { kind: "string", maxLength: 512 } }, activation: "requires_restart", diagnostics: [] },
  "model.select": { label: "Choose an existing model", whenNeeded: "An explicit model choice or no usable task model. Do not replace a usable inherited default without a requirement.", fields: { modelId: id }, activation: "next_run", diagnostics: ["MODEL_NOT_SELECTED"] },
  "model.connect": { label: "Connect a model service", whenNeeded: "A new model service is needed. The user supplies credentials only in the secure card.", fields: { name: { ...id, maxLength: 200 }, baseUrl: { kind: "string", maxLength: 2048 }, model: { ...id, maxLength: 512 }, apiProtocol: { kind: "string", choices: ["openai-chat-completions", "openai-responses", "anthropic-messages"] }, apiVariant: { ...id, maxLength: 80 }, tokenOptional: boolean }, activation: "next_run", diagnostics: [] },
  "model.repair_credential": { label: "Repair a model credential", whenNeeded: "A structured authentication diagnosis identifies this exact model. A network failure, timeout or rate limit is not authentication evidence.", fields: { modelId: id }, activation: "next_run", diagnostics: ["MODEL_CREDENTIAL_MISSING", "MODEL_AUTHENTICATION_REJECTED"] },
  "connector.enable": { label: "Enable a ready connector", whenNeeded: "The current task requires an installed, ready connector missing from the effective tool set. Respect refusals and alternatives.", fields: { connectorId: { ...id, maxLength: 100 } }, activation: "same_run_if_bound", diagnostics: ["CONNECTOR_DISABLED"] },
  "skill.select": { label: "Select installed Skills and Libraries", whenNeeded: "The user requests a selection of installed Skills or Libraries. In all mode every installed Skill is already available; do not ask to enable it again.", fields: { skillSelectionMode: { kind: "string", choices: ["all", "selected"] }, enabledSkillIds: ids, enabledSkillLibraryIds: ids }, activation: "next_run", diagnostics: ["SKILL_EXCLUDED"] },
  "thinking.configure": { label: "Configure model thinking", whenNeeded: "The user explicitly requests a thinking mode or effort supported by the current model API variant. Applies to future runs, never the active frozen model.", fields: { thinkingMode: { kind: "string", choices: ["auto", "disabled", "enabled"] }, thinkingEffort: { kind: "string", choices: ["low", "medium", "high", "xhigh", "max"] } }, activation: "next_run", diagnostics: ["THINKING_REQUIREMENT"] },
  "review.configure": { label: "Configure session review", whenNeeded: "The user requests review model, semantic review, automatic review or review level for this session. The global Reviewer Specialist switch is separate and cannot be changed here.", fields: { reviewModelId: id, semanticReviewEnabled: boolean, automaticReviewEnabled: boolean, level: { kind: "string", choices: ["quick", "deep"] } }, activation: "next_run", diagnostics: ["REVIEW_REQUIREMENT"] },
  "timeouts.configure": { label: "Configure deployment timeouts", whenNeeded: "The user explicitly asks to change a deployment-wide timeout. 0 disables that one limit. Do not widen a timeout because a single run timed out. Omit scope; this is not a session setting. The new timeout applies when a later workload reads it; an original configuration task already bound to this request may continue through the normal framework, retaining its frozen task settings.", fields: {
    gatewayIdleTimeoutMs: { kind: "integer", minimum: 0 }, gatewayTurnTimeoutMs: { kind: "integer", minimum: 0 }, kernelIdleTimeoutMs: { kind: "integer", minimum: 0 },
    permissionWaitTimeoutMs: { kind: "integer", minimum: 0 }, runnerExecTimeoutMs: { kind: "integer", minimum: 0 },
  }, activation: "next_run", diagnostics: [] },
  "quotas.configure": { label: "Configure deployment quotas", whenNeeded: "The user explicitly asks to change a deployment-wide quota. 0 removes a byte cap. Concurrent subagents stay between 1 and 10. Omit scope; this does not grant a tool permission. An original configuration task already bound to this request may continue through the normal framework; it retains its frozen task settings while later workloads read the new quota.", fields: {
    maxConcurrentSubagents: { kind: "integer", minimum: 1, maximum: 10 }, runnerMaxOutputBytes: { kind: "integer", minimum: 0 }, runnerMaxWorkspaceBytes: { kind: "integer", minimum: 0 },
    uploadMaxFileBytes: { kind: "integer", minimum: 0 }, uploadMaxRequestBytes: { kind: "integer", minimum: 0 },
  }, activation: "next_run", diagnostics: [] },
  "runner.assign": { label: "Select registered Runners", whenNeeded: "The user requests Project or Session Runner allocation. Describe existing IDs first; select only usable registered Runners. Selected + [] disables all Runners, Session inherit removes its override. Registration, SSH host trust and execution permission remain separate. This never starts or migrates a job.", fields: { selectionMode: { kind: "string", choices: ["selected", "inherit"] }, runnerIds: ids }, activation: "next_run", diagnostics: [] },
  "idea_tree.configure": { label: "Configure Idea Tree limits", whenNeeded: "The user explicitly asks to change Idea Tree intensity, score direction, or a bounded token, depth, or node limit. Template and intensity determine rounds, candidates, and assessors. Omit scope; an in-progress idea-tree run keeps the settings it already read.", fields: {
    explorationIntensity: { kind: "string", choices: ["quick", "standard", "deep"] }, scoreDirection: { kind: "string", choices: ["maximize", "minimize"] },
    maxTokensPerCall: { kind: "integer", minimum: 256, maximum: 32768 }, maxDepth: { kind: "integer", minimum: 1, maximum: 20 },
    maxNodes: { kind: "integer", minimum: 2, maximum: 10000 },
  }, activation: "next_run", diagnostics: [] },
};
export const SYSTEM_CONFIGURATION_CAPABILITIES = ["timeouts.configure", "quotas.configure", "idea_tree.configure", "environment.sources"] as const satisfies readonly ConfigurationCapabilityId[];
export const DEPLOYMENT_CONFIGURATION_CAPABILITIES = [...SYSTEM_CONFIGURATION_CAPABILITIES, "memory.credential", "memory.enable", "memory.backend", "memory.connection"] as const satisfies readonly ConfigurationCapabilityId[];
export function descriptorValuesSchema(descriptor: ConfigurationAgentDescriptor): TSchema {
  return Type.Object(Object.fromEntries(Object.entries(descriptor.fields).map(([name, field]) => {
    const schema = field.kind === "ids" ? Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 500, uniqueItems: true })
      : field.kind === "boolean" ? Type.Boolean()
      : field.kind === "integer" ? Type.Integer({ minimum: field.minimum ?? 0, ...(field.maximum === undefined ? {} : { maximum: field.maximum }) })
      : field.choices ? Type.Union(field.choices.map(value => Type.Literal(value))) : Type.String({ maxLength: field.maxLength ?? 200 });
    return [name, Type.Optional(schema)];
  })), { additionalProperties: false });
}
