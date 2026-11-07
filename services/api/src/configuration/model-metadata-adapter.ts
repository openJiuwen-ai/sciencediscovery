// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationFieldView, ConfigurationValues, ModelProfile } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapter } from "./types.js";
import { CONFIGURATION_AGENT_DESCRIPTORS } from "./agent-metadata.js";
import { canonical, ConfigurationError, digest, invalid, object } from "./validation.js";
const efforts = ["low", "medium", "high", "xhigh", "max"];
const prices = ["priceInput", "priceOutput", "priceCachedInput", "priceCacheWriteInput"];
const labels: Record<string, string> = { modelId: "Existing shared model", operation: "Model information operation", name: "Model profile name", vision: "Vision support", contextWindow: "Context window (tokens)", maxOutputTokens: "Maximum output (tokens)", thinkingSupported: "Thinking supported", thinkingEfforts: "Supported thinking efforts", priceCurrency: "Price currency", priceInput: "Input price per million tokens", priceOutput: "Output price per million tokens", priceCachedInput: "Cached input price per million tokens", priceCacheWriteInput: "Cache write price per million tokens", thinkingMode: "Normalized thinking mode", thinkingEffort: "Normalized thinking effort", facts: "All user fact overrides" };
const metadata = (profile: Pick<ModelProfile, "name" | "vision" | "facts" | "thinkingMode" | "thinkingEffort">): ConfigurationValues => ({ name: profile.name, vision: profile.vision,
  ...(profile.facts?.contextWindow === undefined ? {} : { contextWindow: profile.facts.contextWindow }), ...(profile.facts?.maxOutputTokens === undefined ? {} : { maxOutputTokens: profile.facts.maxOutputTokens }),
  ...(profile.facts?.thinkingSupported === undefined ? {} : { thinkingSupported: profile.facts.thinkingSupported }), ...(profile.facts?.thinkingEfforts === undefined ? {} : { thinkingEfforts: profile.facts.thinkingEfforts }),
  ...(profile.facts?.pricing ? { priceCurrency: profile.facts.pricing.currency, priceInput: String(profile.facts.pricing.input), priceOutput: String(profile.facts.pricing.output), ...(profile.facts.pricing.cachedInput === undefined ? {} : { priceCachedInput: String(profile.facts.pricing.cachedInput) }), ...(profile.facts.pricing.cacheWriteInput === undefined ? {} : { priceCacheWriteInput: String(profile.facts.pricing.cacheWriteInput) }) } : {}),
  ...(profile.thinkingMode === undefined ? {} : { thinkingMode: profile.thinkingMode }), ...(profile.thinkingEffort === undefined ? {} : { thinkingEffort: profile.thinkingEffort }) });
export function createModelMetadataAdapter(store: SessionStore): ConfigurationAdapter {
  return {
    id: "model.metadata", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    normalize: raw => {
      const fields = CONFIGURATION_AGENT_DESCRIPTORS["model.metadata"].fields, input = object(raw, Object.keys(fields), "values"), output: ConfigurationValues = {};
      for (const [key, value] of Object.entries(input)) {
        const field = fields[key]!;
        if (key === "thinkingEfforts") {
          if (!Array.isArray(value) || value.length > 5 || new Set(value).size !== value.length || value.some(value => typeof value !== "string" || !efforts.includes(value))) {
            invalid("Choose supported thinking efforts from the finite list", key);
          }
          output[key] = [...value].sort();
        } else if (field.kind === "integer") {
          if (!Number.isSafeInteger(value) || Number(value) < 1) invalid("Token limits must be positive safe whole numbers", key);
          output[key] = Number(value);
        } else if (field.kind === "boolean") {
          if (typeof value !== "boolean") invalid("Choose a boolean value", key);
          output[key] = value;
        } else {
          if (typeof value !== "string" || !value.trim() || value.length > (field.maxLength ?? 200) || field.choices && !field.choices.includes(value)) invalid("Choose a valid model information value", key);
          if (prices.includes(key) && (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))) invalid("Prices must be non-negative decimal strings per million tokens", key);
          output[key] = value.trim();
        }
      }
      return output;
    },
    target: input => String(input.modelId ?? ""),
    preview: (input, snapshot) => {
      const profile = snapshot.data.model as ModelProfile | undefined, operation = String(input.operation ?? "update");
      if (input.modelId !== undefined && !profile) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "The selected model is no longer available", 409, "modelId");
      let candidate: ReturnType<SessionStore["configurationModelMetadataCandidate"]> | undefined;
      if (profile) {
        try { candidate = store.configurationModelMetadataCandidate(profile, { ...input, operation }); }
        catch { invalid("The model fact candidate is invalid; token limits must be positive and a price needs currency, input and output", "modelId"); }
      }
      const fields: ConfigurationFieldView[] = [{ id: "modelId", label: labels.modelId!, kind: "enum", required: true,
        ...(profile ? { value: profile.id } : {}), choices: (snapshot.data.models as ModelProfile[]).map(model => ({ id: model.id, label: `${model.name} · ${model.model}` })) },
        { id: "operation", label: labels.operation!, kind: "enum", required: true, value: operation, choices: [{ id: "update", label: "Update explicitly supplied information" }, { id: "clear_facts", label: "Clear all user fact overrides" }] }];
      const before = profile ? metadata(profile) : {}, after = candidate ? metadata(candidate) : {};
      if (profile && operation === "update") {
        for (const [id, descriptor] of Object.entries(CONFIGURATION_AGENT_DESCRIPTORS["model.metadata"].fields)) {
          if (["modelId", "operation"].includes(id)) continue;
          const value = input[id] ?? before[id];
          if (id === "thinkingEfforts") fields.push({ id, label: labels[id]!, kind: "multiselect", required: false, ...(Array.isArray(value) ? { value } : {}), choices: efforts.map(id => ({ id, label: id })) });
          else fields.push({ id, label: labels[id]!, kind: descriptor.kind === "boolean" ? "boolean" : descriptor.kind === "integer" ? "number" : descriptor.choices ? "enum" : "text", required: false,
            ...(value === undefined || Array.isArray(value) ? {} : { value }), ...(descriptor.choices ? { choices: descriptor.choices.map(id => ({ id, label: id })) } : {}),
            ...(id === "thinkingSupported" && value === undefined ? { description: "Not declared: the provider/catalog still answers. Toggle only to state an explicit override; clearing facts restores inheritance." } : {}) });
        }
      }
      const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(field => canonical(before[field]) !== canonical(after[field])).map(field => ({ field, before: before[field] === undefined ? "No user override" : String(before[field]), after: after[field] === undefined ? "No user override" : String(after[field]) }));
      const stated = operation === "clear_facts" || Object.keys(input).some(field => !["modelId", "operation"].includes(field));
      return { fields, changes,
        impact: { resourceLocation: "Shared model profile information", effectiveScope: profile ? `${profile.name} · ${profile.id}` : "Choose an existing model profile",
          message: "All future tasks using this profile may read these user-stated capabilities, limits and cost estimates. Prices are per million tokens, not verified billing or access authorization. Normalized thinking changes are included in the preview. clear_facts removes all user fact overrides and preserves name/vision. The provider/catalog may then answer unknown or different values. Existing queued/frozen tasks keep their snapshots. Endpoints, API model identifiers, protocols, keys, proxy routes and task-model selection stay unchanged. The settings writer performs no remote listing, capability test, model request or restart. A bound original configuration wait may continue through the framework; activation timing and execution permissions remain separate." },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_run",
        disposition: !profile || !stated ? "missing_input" : changes.length ? "change" : "no_change", ready: Boolean(profile && stated && changes.length),
      };
    },
    apply: context => {
      store.applyModelMetadataConfigurationSync(String(context.input.modelId), context.input);
      return { resourceRevision: digest(store.configurationSnapshot(context.sessionId, "model.metadata", String(context.input.modelId)).resourceVersions), summary: "Shared model information saved; capabilities and rates remain user-stated and unverified" };
    },
  };
}
