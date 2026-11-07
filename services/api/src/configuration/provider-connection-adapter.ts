// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { modelDiscoveryUrl } from "@sciencediscovery/model";
import { isPublicPlaintextEndpoint, MODEL_API_VARIANTS, type ConfigurationValues, type ModelProvider } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapter } from "./types.js";
import { modelDestination, type ModelDestinationAuthorizer } from "./model-destination.js";
import { canonical, ConfigurationError, digest, invalid, object } from "./validation.js";

type Connection = ReturnType<SessionStore["configurationProviderConnectionCandidate"]>;
type Source = ReturnType<SessionStore["configurationProviderConnectionSource"]>;
/** Derive the same wire paths as the normal model and discovery clients, without sending a request. */
export function providerConnectionDestination(providerId: string, candidate: Connection, source: Source, versions: Record<string, string>) {
  const previous = source.provider;
  const destinations = new Map<string, Set<string>>();
  const add = (url: string, label: string) => {
    if (url.length > 4096) invalid("A derived provider destination exceeds the supported length", "baseUrl");
    const labels = destinations.get(url) ?? new Set<string>(); labels.add(label); destinations.set(url, labels);
  };
  const primary = modelDestination({ ...candidate, model: "provider-default-preview" });
  const profiles = [{ model: "provider-default-preview", apiVariant: candidate.apiVariant }, ...source.children.map(child => ({ model: child.model,
    apiVariant: previous?.apiProtocol === candidate.apiProtocol ? child.apiVariant : candidate.apiVariant }))];
  const targets: string[] = [];
  for (const profile of profiles) {
    const destination = modelDestination({ ...candidate, ...profile });
    const wire = JSON.parse(destination.endpointTarget) as [string, string, string];
    add(wire[2], `Model requests (${wire[0]} / ${wire[1]})`); targets.push(destination.endpointTarget);
  }
  add(modelDiscoveryUrl({ baseUrl: candidate.baseUrl, discovery: candidate.modelDiscovery }), `Model discovery (${candidate.modelDiscovery})`);
  if (destinations.size > 8) throw new ConfigurationError("CONFIGURATION_BACKEND_UNSUPPORTED", "This provider has too many distinct wire destinations for one bounded acknowledgement", 409);
  return { endpointTarget: digest([providerId, candidate, [...new Set(targets)].sort(), [...destinations.keys()].sort(), versions]),
    destinations: [...destinations].sort(([left], [right]) => left.localeCompare(right)).map(([url, labels]) => ({ url, label: [...labels].sort().join("; ") })),
    host: primary.host, classification: primary.classification === "trusted_preset" ? "public_https" as const : primary.classification };
}

export function createProviderConnectionAdapter(store: SessionStore, authorizer: ModelDestinationAuthorizer): ConfigurationAdapter {
  return {
    id: "provider.connection", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    normalize: raw => {
      const input = object(raw, ["providerId", "name", "baseUrl", "apiProtocol", "apiVariant", "modelDiscovery"], "values"), result: ConfigurationValues = {};
      for (const [field, value] of Object.entries(input)) {
        if (typeof value !== "string" || !value.trim() || value.length > (field === "baseUrl" ? 2048 : 200) || /[\u0000-\u001f\u007f]/u.test(value)) invalid("Use a valid registered provider field", field);
        result[field] = value.trim();
      }
      if (result.apiProtocol !== undefined && !Object.hasOwn(MODEL_API_VARIANTS, String(result.apiProtocol))) invalid("Choose a registered API protocol", "apiProtocol");
      if (result.modelDiscovery !== undefined && !["openai-models", "anthropic-models"].includes(String(result.modelDiscovery))) invalid("Choose a registered discovery strategy", "modelDiscovery");
      return result;
    },
    target: input => String(input.providerId ?? ""),
    preview: (input, snapshot) => {
      const source = snapshot.data.providerConnection as Source, provider = source.provider;
      if (input.providerId && !provider) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "Choose an existing shared provider", 409);
      let candidate: Connection | undefined;
      if (provider) {
        try { candidate = store.configurationProviderConnectionCandidate(provider, input); }
        catch { throw new ConfigurationError("INVALID_CONFIGURATION_INPUT", "Use a valid provider connection and protocol-specific variant", 400); }
      }
      const fields = ["name", "baseUrl", "apiProtocol", "apiVariant", "modelDiscovery"] as const;
      const display = (value: unknown) => { const text = String(value ?? ""); return text.length <= 1800 ? text : `Long address ${digest(text)}; review the complete proposed URL field and destination list.`; };
      const changes = provider && candidate ? fields.filter(field => canonical(provider[field]) !== canonical(candidate[field]))
        .map(field => ({ field, before: display(provider[field]), after: display(candidate[field]) })) : [];
      const protocol = candidate?.apiProtocol ?? "openai-chat-completions";
      const destination = provider && candidate ? providerConnectionDestination(provider.id, candidate, source, snapshot.resourceVersions) : undefined;
      if (changes.length && isPublicPlaintextEndpoint(destination?.classification)) {
        const destinationEdited = changes.some(change => ["baseUrl", "apiProtocol", "apiVariant", "modelDiscovery"].includes(change.field));
        throw new ConfigurationError("CONFIGURATION_ENDPOINT_INSECURE", "Conversational provider connection changes require HTTPS or a local/private endpoint. Choose a supported API base URL.", 400, destinationEdited ? "baseUrl" : undefined);
      }
      const choices = (ids: readonly string[]) => ids.map(id => ({ id, label: id }));
      return {
        fields: [
          { id: "providerId", label: "Existing shared provider", kind: "enum", required: true, ...(provider ? { value: provider.id } : {}), choices: (snapshot.data.providers as ModelProvider[]).map(item => ({ id: item.id, label: `${item.name} · ${item.id}` })) },
          { id: "name", label: "Provider display name", kind: "text", required: Boolean(provider), ...(candidate ? { value: candidate.name } : {}) },
          { id: "baseUrl", label: "Provider API base URL", kind: "url", required: Boolean(provider), ...(candidate ? { value: candidate.baseUrl } : {}) },
          { id: "apiProtocol", label: "Provider API protocol", kind: "enum", required: Boolean(provider), choices: choices(Object.keys(MODEL_API_VARIANTS)), ...(candidate ? { value: candidate.apiProtocol } : {}) },
          { id: "apiVariant", label: "Default protocol variant for new provider models", kind: "enum", required: Boolean(provider), choices: provider ? choices(MODEL_API_VARIANTS[protocol]) : [], ...(candidate ? { value: candidate.apiVariant } : {}) },
          { id: "modelDiscovery", label: "Provider model discovery format", kind: "enum", required: Boolean(provider), choices: choices(["openai-models", "anthropic-models"]), ...(candidate ? { value: candidate.modelDiscovery } : {}) },
        ], changes, impact: { resourceLocation: "Shared provider and its model profiles", effectiveScope: `This provider and ${source.children.length} existing model profiles`,
          message: `Every listed model-call and discovery destination requires independent human confirmation before the saved provider or profile override keys can be reused. The ${source.children.length} child profiles follow the saved endpoint/protocol. Changing protocol family resets their variants to the provider default; changing the default within the same family retains their existing variants. No key is read, no discovery/probe/model call is sent. Keys, token-optional policy, proxy route, model identities/metadata and default selection stay unchanged. New configuration affects later resource reads; recorded task settings stay unchanged and a bound original wait may continue normally. Readiness, capabilities and future costs remain unverified.` },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_run",
        ...(destination ? { endpointAuthorization: destination } : {}),
        disposition: !provider || !fields.some(field => input[field] !== undefined) ? "missing_input" : changes.length ? "change" : "no_change",
        ready: Boolean(provider && changes.length && fields.some(field => input[field] !== undefined)), data: { candidate },
      };
    },
    apply: context => {
      const id = String(context.input.providerId), source = store.configurationProviderConnectionSource(id);
      if (!source.provider) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "The provider is unavailable", 409);
      const candidate = store.configurationProviderConnectionCandidate(source.provider, context.input);
      const expected = providerConnectionDestination(id, candidate, source, context.snapshot.resourceVersions);
      if (context.plan.endpointAuthorization?.endpointTarget !== expected.endpointTarget) throw new ConfigurationError("STALE_ENDPOINT_CONSENT", "Review the current provider destinations before saving", 409);
      authorizer.assertForContext(context, "provider.connection", true);
      store.applyProviderConnectionConfigurationSync(id, context.input);
      return { summary: `Shared provider connection and ${source.children.length} model profiles saved. Existing credentials were preserved without decryption; no network request was sent.` };
    },
  };
}
