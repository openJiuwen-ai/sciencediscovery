// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues, ModelProvider } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationCredentialBridge } from "./credential-bridge.js";
import type { ModelDestinationAuthorizer } from "./model-destination.js";
import { providerConnectionDestination } from "./provider-connection-adapter.js";
import type { ConfigurationAdapter } from "./types.js";
import { ConfigurationError, invalid, object } from "./validation.js";

export function createProviderCredentialAdapter(store: SessionStore, credentials: ConfigurationCredentialBridge, authorizer: ModelDestinationAuthorizer): ConfigurationAdapter {
  return {
    id: "provider.credential", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    fieldPolicy: { credentialFields: ["apiToken"] },
    normalize: (raw): ConfigurationValues => {
      const input = object(raw, ["providerId"], "values");
      if (input.providerId === undefined) return {};
      if (typeof input.providerId !== "string" || !input.providerId.trim() || input.providerId.length > 200 || /[\u0000-\u001f\u007f]/u.test(input.providerId)) invalid("Choose an existing provider", "providerId");
      return { providerId: input.providerId.trim() };
    },
    target: input => String(input.providerId ?? ""),
    preview: (input, snapshot) => {
      const source = snapshot.data.providerConnection as ReturnType<SessionStore["configurationProviderConnectionSource"]>, provider = source.provider;
      if (input.providerId && !provider) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "Choose an existing shared provider", 409);
      const destination = provider ? providerConnectionDestination(provider.id, store.configurationProviderConnectionCandidate(provider, {}), source, snapshot.resourceVersions) : undefined;
      return {
        fields: [{ id: "providerId", label: "Existing shared provider", kind: "enum", required: true, ...(provider ? { value: provider.id } : {}), choices: (snapshot.data.providers as ModelProvider[]).map(item => ({ id: item.id, label: `${item.name} · ${item.id}` })) },
          { id: "apiToken", label: "Replacement provider API key", kind: "credential", required: true, status: "missing" }],
        changes: provider ? [{ field: "providerCredential", before: provider.hasApiToken ? "Saved provider credential" : "Missing provider credential", after: "Unverified replacement provider credential" }] : [],
        impact: { resourceLocation: "Shared provider encrypted credential store", effectiveScope: `This provider and ${source.children.length} child model profiles`,
          message: "Independently approve every listed model/discovery recipient, supply the replacement in the secure field, then manually save. Only the shared provider key changes. Child credential overrides, token-optional policy, connections, proxies, facts and defaults stay unchanged. The old key is never read; no discovery, probe or model call is sent. Authentication and readiness remain unverified. Later resource reads use the new key; recorded task settings stay unchanged and a bound original configuration wait may continue normally. No generic undo or old-key recovery is available." },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_run",
        disposition: provider ? "change" : "missing_input", ready: Boolean(provider), data: { credentialTarget: String(input.providerId ?? "") },
        ...(destination ? { endpointAuthorization: destination } : {}),
      };
    },
    apply: context => {
      const id = String(context.input.providerId), source = store.configurationProviderConnectionSource(id);
      if (!source.provider) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "The provider is unavailable", 409);
      const expected = providerConnectionDestination(id, store.configurationProviderConnectionCandidate(source.provider, {}), source, context.snapshot.resourceVersions);
      if (context.plan.endpointAuthorization?.endpointTarget !== expected.endpointTarget) throw new ConfigurationError("STALE_ENDPOINT_CONSENT", "Review the current provider recipients before replacing the key", 409);
      authorizer.assertForContext(context, "provider.credential", true);
      if (!context.credentialHandle) throw new ConfigurationError("INVALID_CONFIGURATION_CREDENTIAL", "Supply the replacement in the secure field", 400, "apiToken");
      const token = credentials.read(context.credentialHandle, { sessionId: context.sessionId, requestId: context.requestId, revision: context.revision, target: id, fieldId: "apiToken" });
      store.applyProviderCredentialConfigurationSync(id, token);
      return { summary: "Shared provider credential replaced. Child credential overrides were preserved; no network request was sent and authentication remains unverified." };
    },
  };
}
