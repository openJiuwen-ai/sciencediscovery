// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { WEB_KEY_PROVIDERS, type ConfigurationValues, type WebKeyProvider, type WebProviderState } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import { normalizeApiToken } from "../store/secrets.js";
import type { ConfigurationCredentialBridge } from "./credential-bridge.js";
import type { ConfigurationAdapter, ConfigurationAdapterContext } from "./types.js";
import { ConfigurationError, digest, invalid, object } from "./validation.js";

/** The same finite provider sets as the Web settings page. */
export const webCredentialProviders = (native: boolean): readonly WebKeyProvider[] => native
  ? ["jina", "tavily", "exa", "brave", "deepseek"] : ["bocha", "perplexity", "serper", "jina", "deepseek"];

export function createWebCredentialAdapter(store: SessionStore, credentials: ConfigurationCredentialBridge, native: () => boolean): ConfigurationAdapter {
  const backend = () => native() ? "native" : "jiuwenswarm";
  const target = (values: ConfigurationValues) => digest(["web.credential", values.webProvider ?? "", values.operation ?? "replace", backend()]);
  const assertCurrent = (context: ConfigurationAdapterContext) => {
    const provider = WEB_KEY_PROVIDERS.find(provider => provider === context.input.webProvider);
    if (context.plan.data?.credentialTarget !== target(context.input)
      || !provider || !webCredentialProviders(native()).includes(provider))
      throw new ConfigurationError("CONFIGURATION_BACKEND_CHANGED", "The Web backend changed. Refresh its supported provider and credential preview", 409);
    return provider;
  };
  const binding = (context: ConfigurationAdapterContext) => ({ sessionId: context.sessionId, requestId: context.requestId,
    revision: context.revision, target: String(context.plan.data?.credentialTarget), fieldId: "apiToken" });
  return {
    id: "web.credential", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    fieldPolicy: { credentialFields: ["apiToken"] },
    normalize: raw => {
      const input = object(raw, ["webProvider", "operation"], "values");
      const provider = WEB_KEY_PROVIDERS.find(provider => provider === input.webProvider);
      if (input.webProvider !== undefined && !provider) invalid("Choose a registered Web provider", "webProvider");
      if (input.operation !== undefined && (typeof input.operation !== "string" || !["replace", "clear"].includes(input.operation))) invalid("Choose replace or clear", "operation");
      return { ...(provider ? { webProvider: provider } : {}),
        ...(input.operation !== undefined ? { operation: input.operation } : {}) };
    },
    target,
    preview: (input, snapshot) => {
      const providers = webCredentialProviders(native()), provider = WEB_KEY_PROVIDERS.find(provider => provider === input.webProvider);
      if (provider && !providers.includes(provider)) throw new ConfigurationError("CONFIGURATION_BACKEND_UNSUPPORTED", "This Web provider is not used by the current backend", 409, "webProvider");
      const operation = input.operation === "clear" ? "clear" : "replace";
      const current = (snapshot.data.webProviders as WebProviderState[]).find(item => item.provider === provider);
      const change = Boolean(provider) && (operation === "replace" || current?.hasApiKey === true);
      return { fields: [
        { id: "webProvider", label: "Web service provider", kind: "enum", required: true, ...(provider ? { value: provider } : {}), choices: providers.map(id => ({ id, label: id })) },
        { id: "operation", label: "Credential operation", kind: "enum", required: true, value: operation, choices: [{ id: "replace", label: "Replace key" }, { id: "clear", label: "Clear stored key" }] },
        ...(operation === "replace" && provider ? [{ id: "apiToken", label: "Web service API key", kind: "credential" as const, required: true, status: "missing" as const }] : []),
      ], changes: change ? [{ field: "apiToken", before: current?.hasApiKey ? "Configured (write-only)" : "Not configured", after: operation === "clear" ? "Clear stored key" : "Replace through secure user input; authentication unverified" }] : [],
      impact: { resourceLocation: "Shared encrypted Web provider store", effectiveScope: "Every session using this Web provider",
        message: `${backend()}. Manual confirmation required. Changing a key can enable or disable an already-selected paid provider; provider selections, proxy routing and permissions are unchanged. No authentication request is sent. ${native() ? "Subsequent provider requests read the saved key; an in-flight request is not repeated." : "The JiuwenSwarm credential mirror requires a restart; saving does not claim the remote key changed."} Jina anonymous success would not validate a key.` },
      verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false },
      activationMode: native() ? "next_request" : "requires_restart", disposition: !provider ? "missing_input" : change ? "change" : "no_change", ready: change,
      data: { credentialTarget: target(input), backend: backend() } };
    },
    verify: async context => {
      assertCurrent(context);
      if (context.input.operation === "clear") return { ok: true };
      if (!context.credentialHandle) return { ok: false, code: "CONFIGURATION_CREDENTIAL_REQUIRED", field: "apiToken", message: "Enter the Web key through the secure user field" };
      return credentials.withLease(context.credentialHandle, binding(context), async secret => {
        normalizeApiToken(secret); return { ok: true };
      });
    },
    apply: context => {
      const provider = assertCurrent(context);
      let key: string | null = null;
      if (context.input.operation !== "clear") {
        if (!context.credentialHandle) throw new ConfigurationError("CONFIGURATION_CREDENTIAL_REQUIRED", "The secure Web key draft is missing", 409, "apiToken");
        const normalized = normalizeApiToken(credentials.read(context.credentialHandle, binding(context)));
        if (!normalized) throw new ConfigurationError("CONFIGURATION_CREDENTIAL_REQUIRED", "Enter a Web key", 400, "apiToken");
        key = normalized;
      }
      store.applyWebCredentialConfigurationSync(provider, key);
      return { resourceRevision: digest(store.configurationSnapshot(context.sessionId, "web.credential", target(context.input)).resourceVersions),
        summary: "Web credential saved; provider authentication remains unverified" };
    },
  };
}
