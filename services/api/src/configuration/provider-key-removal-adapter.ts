// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues, ModelProvider } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapter } from "./types.js";
import { ConfigurationError, invalid, object } from "./validation.js";

export function createProviderKeyRemovalAdapter(store: SessionStore): ConfigurationAdapter {
  return {
    id: "provider.remove_credential", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
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
      return {
        fields: [{ id: "providerId", label: "Existing shared provider", kind: "enum", required: true, ...(provider ? { value: provider.id } : {}), choices: (snapshot.data.providers as ModelProvider[]).map(item => ({ id: item.id, label: `${item.name} · ${item.id}` })) }],
        changes: provider?.hasApiToken ? [{ field: "providerCredential", before: "Saved shared provider credential", after: "Removed; token-free provider declaration" }] : [],
        impact: { resourceLocation: "Shared provider encrypted credential store", effectiveScope: `This provider and ${source.children.length} child model profiles`,
          message: "Removing the shared key declares this provider token-free under the existing runtime rule. Later inheriting model calls may be unauthenticated or fail the service's authentication requirement. Child models with their own credential overrides retain them. No tool or network permission is granted. The old key is never read or recoverable through this card; no generic undo is available. Connections, proxies, token-optional compatibility metadata, model facts and defaults stay unchanged. No discovery, probe or model call is sent. Recorded task settings stay unchanged; a bound original configuration wait may continue normally." },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_run",
        disposition: !provider ? "missing_input" : provider.hasApiToken ? "change" : "no_change", ready: Boolean(provider?.hasApiToken),
      };
    },
    apply: context => {
      store.removeProviderCredentialConfigurationSync(String(context.input.providerId));
      return { summary: "Shared provider key removed without decryption. Token-free declaration applies to later inherited calls; child key overrides remain. No network request was sent." };
    },
  };
}
