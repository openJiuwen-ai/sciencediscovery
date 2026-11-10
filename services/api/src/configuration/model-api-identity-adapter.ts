// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { isPublicPlaintextEndpoint, MODEL_API_VARIANTS, type ConfigurationValues, type ModelProfile } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapter } from "./types.js";
import { modelDestination, type ModelDestinationAuthorizer } from "./model-destination.js";
import { canonical, ConfigurationError, invalid, object } from "./validation.js";

export function createModelApiIdentityAdapter(store: SessionStore, destinations: ModelDestinationAuthorizer): ConfigurationAdapter {
  return {
    id: "model.api_identity", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    normalize: raw => {
      const input = object(raw, ["modelId", "apiModel", "apiVariant"], "values"), output: ConfigurationValues = {};
      for (const [field, value] of Object.entries(input)) {
        if (typeof value !== "string" || !value.trim() || value.length > (field === "apiModel" ? 512 : 200) || /[\u0000-\u001f\u007f]/u.test(value)) invalid("Use a non-empty registered model field", field);
        output[field] = value.trim();
      }
      return output;
    },
    target: input => String(input.modelId ?? ""),
    preview: (input, snapshot) => {
      const profile = snapshot.data.model as ModelProfile | undefined;
      if (input.modelId && !profile) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "Choose an existing model profile", 409);
      let candidate: ReturnType<SessionStore["configurationModelApiIdentityCandidate"]> | undefined;
      if (profile) {
        try { candidate = store.configurationModelApiIdentityCandidate(profile, input); }
        catch { throw new ConfigurationError("INVALID_CONFIGURATION_INPUT", "Use a valid API model identifier and a variant registered for this model's current protocol", 400); }
      }
      const destination = candidate ? modelDestination(candidate) : undefined;
      const changes = profile && candidate ? (["model", "apiVariant", "thinkingMode", "thinkingEffort"] as const)
        .filter(field => canonical(profile[field]) !== canonical(candidate[field]))
        .map(field => ({ field: field === "model" ? "apiModel" : field, before: String(profile[field] ?? "model_default"), after: String(candidate[field] ?? "model_default") })) : [];
      if (changes.length && isPublicPlaintextEndpoint(destination?.classification)) {
        throw new ConfigurationError("CONFIGURATION_ENDPOINT_INSECURE", "Conversational API identity changes require HTTPS or a local/private endpoint. Edit the endpoint in Model Settings first.", 400);
      }
      return {
        fields: [
          { id: "modelId", label: "Existing model profile", kind: "enum", required: true, ...(input.modelId ? { value: String(input.modelId) } : {}), choices: (snapshot.data.models as ModelProfile[]).map(item => ({ id: item.id, label: `${item.name} · ${item.id}` })) },
          { id: "apiModel", label: "API model identifier", kind: "text", required: Boolean(profile), ...(candidate ? { value: candidate.model } : {}) },
          { id: "apiVariant", label: "API variant under the existing protocol", kind: "enum", required: Boolean(profile), ...(candidate ? { value: candidate.apiVariant } : {}),
            choices: profile ? MODEL_API_VARIANTS[profile.apiProtocol ?? "openai-chat-completions"].map(id => ({ id, label: id })) : [] },
        ], changes, impact: { resourceLocation: "Shared model profile API identity", effectiveScope: "Every later task that reads this model profile",
          message: "The API model identifier and registered protocol variant change. Formal catalog normalization may also constrain the displayed default thinking mode/effort. The existing endpoint, protocol family, provider, key, proxy route, display name, fact/price overrides and model selection stay unchanged. The exact wire destination must be reviewed before reusing the stored key. No key is read and no connectivity/model request is sent. Later tasks can have different capability or cost; this preview does not certify them. Frozen task settings stay frozen; a bound original configuration wait may continue through the existing framework." },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_run",
        ...(destination ? { endpointAuthorization: destination } : {}),
        ready: Boolean(candidate && changes.length && (input.apiModel !== undefined || input.apiVariant !== undefined)),
        disposition: !candidate || input.apiModel === undefined && input.apiVariant === undefined ? "missing_input" : changes.length ? "change" : "no_change",
      };
    },
    apply: context => {
      const profile = store.getModel(String(context.input.modelId));
      if (!profile) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "The selected model is unavailable", 409);
      const candidate = store.configurationModelApiIdentityCandidate(profile, context.input);
      destinations.assertContext(context, "model.api_identity", candidate as ModelProfile, profile.hasApiToken);
      store.applyModelApiIdentityConfigurationSync(profile.id, context.input);
      return { summary: "Shared model API identity saved for subsequent model reads. Existing credentials were preserved without decryption; no request was sent." };
    },
  };
}
