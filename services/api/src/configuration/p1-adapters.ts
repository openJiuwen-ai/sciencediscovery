// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createHash } from "node:crypto";
import { constrainCatalogThinking, lookupModelCatalog, DEFAULT_MODEL_API_VARIANT, THINKING_CONTROL_VARIANTS, THINKING_EFFORT_VARIANTS,
  type ConfigurationCapabilityId, type ConfigurationFieldView, type ConfigurationValues, type EffectiveRuntimeSettings,
  type ModelProfile, type ModelThinkingMode, type ModelThinkingEffort, type SessionReviewerSpecialistSettings, type SkillLibrary } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapter, ConfigurationSnapshot } from "./types.js";
import { canonical, ConfigurationError, invalid, object } from "./validation.js";
import { CONFIGURATION_AGENT_DESCRIPTORS } from "./agent-metadata.js";
const modes: ModelThinkingMode[] = ["auto", "disabled", "enabled"];
const efforts: ModelThinkingEffort[] = ["low", "medium", "high", "xhigh", "max"];
const noProbe = { targets: [] as string[], actions: [] as string[], maxRequests: 0, mayCharge: false };
function normalized(id: ConfigurationCapabilityId, raw: unknown): ConfigurationValues {
  const descriptor = CONFIGURATION_AGENT_DESCRIPTORS[id];
  const input = object(raw, Object.keys(descriptor.fields), "values");
  const output: ConfigurationValues = {};
  for (const [key, value] of Object.entries(input)) {
    const field = descriptor.fields[key]!;
    if (field.kind === "ids") {
      if (!Array.isArray(value) || value.length > 500 || new Set(value).size !== value.length
        || value.some(id => typeof id !== "string" || !id || id.length > 500)) invalid("Invalid ID selection", key);
      output[key] = [...value].sort();
    } else if (field.kind === "boolean") {
      if (typeof value !== "boolean") invalid("Invalid boolean", key);
      output[key] = value;
    } else {
      if (typeof value !== "string" || !value || value.length > (field.maxLength ?? 200) || field.choices && !field.choices.includes(value)) invalid("Invalid registered setting", key);
      output[key] = value;
    }
  }
  return output;
}
const choices = (ids: readonly string[]) => ids.map(id => ({ id, label: id }));
function enumField(id: string, label: string, ids: readonly string[], value?: string): ConfigurationFieldView {
  return { id, label, kind: "enum", required: false, choices: choices(ids), ...(value && ids.includes(value) ? { value } : {}) };
}
function scalarField(id: string, label: string, value: boolean): ConfigurationFieldView { return { id, label, kind: "boolean", required: false, value }; }
function effective(snapshot: ConfigurationSnapshot): EffectiveRuntimeSettings { return snapshot.data.effective as EffectiveRuntimeSettings; }
function assertSelection(input: ConfigurationValues, key: string, allowed: string[]): void {
  if (Array.isArray(input[key]) && (input[key] as string[]).some(id => !allowed.includes(id)))
    throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "A selected resource is no longer installed or available", 409, key);
}
export function thinkingChoices(model: ModelProfile | undefined): { modes: ModelThinkingMode[]; efforts: ModelThinkingEffort[] } {
  if (!model) return { modes: [], efforts: [] };
  const catalog = lookupModelCatalog(model.model)?.thinking;
  const declared = model.facts?.thinkingEfforts;
  if (model.facts?.thinkingSupported === false || (!catalog?.supported && !declared?.length && model.facts?.thinkingSupported !== true)) return { modes: [], efforts: [] };
  const variant = model.apiVariant ?? DEFAULT_MODEL_API_VARIANT[model.apiProtocol ?? "openai-chat-completions"];
  return {
    modes: THINKING_CONTROL_VARIANTS.includes(variant) ? modes.filter(mode => constrainCatalogThinking(model.model, mode, undefined, model.facts).mode === mode) : [],
    efforts: THINKING_EFFORT_VARIANTS.includes(variant) && (declared?.length || catalog?.efforts?.length) ? efforts.filter(effort => constrainCatalogThinking(model.model, undefined, effort, model.facts).effort === effort) : [],
  };
}
/** P1 reuses formal runtime/reviewer settings; no active run or model is hot-swapped. */
export function createP1ConfigurationAdapters(store: SessionStore, nativeExecutor: () => boolean = () => true): ConfigurationAdapter[] {
  const assertBackend = () => { if (!nativeExecutor()) throw new ConfigurationError("CONFIGURATION_BACKEND_UNSUPPORTED", "These scoped settings require the verified Native executor", 409); };
  const ids = ["skill.select", "thinking.configure", "review.configure"] as const;
  return ids.map((id): ConfigurationAdapter => ({
    id, version: 1, schemaVersion: 1, scopes: id === "skill.select" ? ["session", "project"] : ["session"], persistence: "local_transaction",
    normalize: raw => normalized(id, raw), target: () => id,
    preview: (input, snapshot, scope) => {
      assertBackend();
      const settings = scope.kind === "project" ? snapshot.data.projectEffective as EffectiveRuntimeSettings : effective(snapshot);
      const fields: ConfigurationFieldView[] = [];
      let message = "Saved settings apply only to newly queued runs; the current task and already queued runs keep their frozen settings.";
      if (id === "skill.select") {
        if (!snapshot.data.skillSelectionAvailable) throw new ConfigurationError("CONFIGURATION_BACKEND_UNSUPPORTED", "This executor uses a shared Skill catalog and cannot apply per-session selections", 409);
        const installed = snapshot.data.installedSkillIds as string[];
        const libraries = (snapshot.data.skillLibraries as SkillLibrary[]).filter(item => item.headVersionId);
        assertSelection(input, "enabledSkillIds", installed); assertSelection(input, "enabledSkillLibraryIds", libraries.map(item => item.id));
        fields.push(enumField("skillSelectionMode", "Skill selection", ["all", "selected"], String(input.skillSelectionMode ?? settings.skillSelectionMode)),
          { id: "enabledSkillIds", label: "Installed Skills", kind: "multiselect", required: false,
            value: input.enabledSkillIds as string[] | undefined ?? settings.enabledSkillIds, choices: choices(installed) },
          { id: "enabledSkillLibraryIds", label: "Installed Skill Libraries", kind: "multiselect", required: false,
            value: input.enabledSkillLibraryIds as string[] | undefined ?? settings.enabledSkillLibraries.map(item => item.libraryId).filter(id => libraries.some(item => item.id === id)),
            choices: libraries.map(item => ({ id: item.id, label: `${item.name} (${settings.enabledSkillLibraries.find(selected => selected.libraryId === item.id)?.versionId ?? item.headVersionId})` })) });
        if ((input.skillSelectionMode ?? settings.skillSelectionMode) === "all" && Array.isArray(input.enabledSkillIds) && (input.enabledSkillIds.length !== installed.length || installed.some(id => !(input.enabledSkillIds as string[]).includes(id))))
          throw new ConfigurationError("SKILL_ALL_MODE", "All mode already includes every installed Skill. Choose selected mode to use a whitelist.", 400);
        message += " Only installed content is selected. New libraries pin the approved head version; existing pinned selections stay pinned.";
      } else if (id === "thinking.configure") {
        const model = snapshot.data.effectiveModel as ModelProfile | undefined;
        const supported = thinkingChoices(model);
        if (!supported.modes.length) throw new ConfigurationError("THINKING_CONTROL_UNSUPPORTED", "The selected model API variant has no real thinking control", 409);
        if (input.thinkingMode !== undefined && !supported.modes.includes(input.thinkingMode as ModelThinkingMode)) invalid("Unsupported thinking mode", "thinkingMode");
        if (input.thinkingEffort !== undefined && !supported.efforts.includes(input.thinkingEffort as ModelThinkingEffort)) invalid("Unsupported thinking effort", "thinkingEffort");
        fields.push(enumField("thinkingMode", "Thinking mode", supported.modes, String(input.thinkingMode ?? settings.thinkingMode ?? model?.thinkingMode ?? "auto")));
        if (supported.efforts.length) fields.push(enumField("thinkingEffort", "Thinking effort", supported.efforts, String(input.thinkingEffort ?? settings.thinkingEffort ?? model?.thinkingEffort ?? "high")));
        message += " More thinking can increase response time and model charges; no validation request is sent.";
      } else {
        const models = snapshot.data.models as ModelProfile[];
        const reviewer = snapshot.data.sessionReviewer as SessionReviewerSpecialistSettings;
        if (input.reviewModelId !== undefined && !models.some(model => model.id === input.reviewModelId)) throw new ConfigurationError("MODEL_NOT_AVAILABLE", "The review model is no longer registered", 409);
        fields.push({ id: "reviewModelId", label: "Review model", kind: "enum", required: false,
          ...(input.reviewModelId ?? settings.reviewModelId ?? settings.modelId ? { value: String(input.reviewModelId ?? settings.reviewModelId ?? settings.modelId) } : {}),
          choices: models.map(model => ({ id: model.id, label: model.name })) },
          scalarField("semanticReviewEnabled", "Semantic review", (input.semanticReviewEnabled ?? settings.semanticReviewEnabled) as boolean),
          scalarField("automaticReviewEnabled", "Automatic session review", (input.automaticReviewEnabled ?? reviewer.automaticReviewEnabled) as boolean),
          enumField("level", "Review level", ["quick", "deep"], String(input.level ?? reviewer.level)));
        message += " Deep semantic review may use additional model tokens. The global Reviewer Specialist switch stays unchanged.";
        if (snapshot.data.reviewerGloballyEnabled !== true) message += " The global Reviewer Specialist is currently disabled: saved automatic-review preferences remain inactive until it is separately enabled in Settings.";
      }
      const stableLibraries = (items: EffectiveRuntimeSettings["enabledSkillLibraries"]) => [...items].sort((a, b) => a.libraryId.localeCompare(b.libraryId));
      const current = (field: string): unknown => field === "enabledSkillLibraryIds" ? stableLibraries(settings.enabledSkillLibraries)
        : field === "enabledSkillIds" ? [...settings.enabledSkillIds].sort()
        : field === "automaticReviewEnabled" || field === "level" ? (snapshot.data.sessionReviewer as unknown as Record<string, unknown>)[field]
        : field === "reviewModelId" ? settings.reviewModelId ?? settings.modelId
        : field === "thinkingMode" ? settings.thinkingMode ?? (snapshot.data.effectiveModel as ModelProfile | undefined)?.thinkingMode ?? "auto"
        : field === "thinkingEffort" ? settings.thinkingEffort ?? (snapshot.data.effectiveModel as ModelProfile | undefined)?.thinkingEffort ?? "high"
        : (settings as unknown as Record<string, unknown>)[field];
      const next = (field: string, value: unknown): unknown => field === "enabledSkillLibraryIds" ? stableLibraries((value as string[]).map(id => settings.enabledSkillLibraries.find(item => item.libraryId === id)
        ?? { libraryId: id, versionId: (snapshot.data.skillLibraries as SkillLibrary[]).find(item => item.id === id)!.headVersionId! })) : value;
      const changes = Object.entries(input).filter(([field, value]) => canonical(current(field)) !== canonical(next(field, value)))
        .map(([field, value]) => ({ field, before: JSON.stringify(current(field)) ?? "Inherited default", after: JSON.stringify(next(field, value)) }));
      return { fields, changes,
        impact: { resourceLocation: scope.kind === "project" ? "Project runtime settings" : "Session runtime settings",
          effectiveScope: scope.kind === "project" ? "This project; sessions without their own override" : "This session only", message },
        verificationPlan: noProbe, activationMode: "next_run", disposition: !Object.keys(input).length ? "missing_input" : changes.length ? "change" : "no_change", ready: changes.length > 0 };
    },
    apply: context => {
      assertBackend();
      store.applyP1ConfigurationSync(context.sessionId, id, context.input, context.scope);
      return { resourceRevision: createHash("sha256").update(JSON.stringify(store.configurationSnapshot(context.sessionId, id, id).resourceVersions)).digest("hex"), summary: "Settings saved for future runs" };
    },
  }));
}
