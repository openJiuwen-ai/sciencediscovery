// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { FREE_SEARCH_ORDER, PAID_SEARCH_ORDER, type ConfigurationFieldView, type ConfigurationValues, type UpdateWebSettingsRequest, type WebBackend, type WebSettingsDetails } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import { normalizeWebSettings } from "../store/settings.js";
import { CONFIGURATION_AGENT_DESCRIPTORS } from "./agent-metadata.js";
import type { ConfigurationAdapter } from "./types.js";
import { canonical, ConfigurationError, invalid, object } from "./validation.js";

const common = ["deepseekEnabled", "fetchProvider", "freeSearchEngines", "paidSearchProviders"];
const nativeOnly = ["searchCacheTtlSeconds", "fetchCacheTtlSeconds", "proxyPolicy"];

export function webConfigurationCurrent(settings: WebSettingsDetails, backend: WebBackend): ConfigurationValues {
  return {
    deepseekEnabled: settings.deepseekEnabled,
    fetchProvider: backend === "jiuwenswarm" && settings.fetchProvider !== "deepseek" ? "jina" : settings.fetchProvider,
    freeSearchEngines: FREE_SEARCH_ORDER.filter(id => settings.freeSearchEngines[id] && (backend === "native" || id !== "brave-html")),
    paidSearchProviders: PAID_SEARCH_ORDER.filter(id => settings.paidSearchProviders.includes(id) && (backend === "native" || id === "deepseek")),
    ...(backend === "native" ? { searchCacheTtlSeconds: settings.searchCacheTtlSeconds, fetchCacheTtlSeconds: settings.fetchCacheTtlSeconds, proxyPolicy: settings.proxyPolicy } : {}),
  };
}

/** Preserve Native search choices while saving a fetch source supported by the active backend. */
export function webConfigurationPatch(values: ConfigurationValues, current: WebSettingsDetails, backend: WebBackend): UpdateWebSettingsRequest {
  const patch: UpdateWebSettingsRequest = {};
  if (values.deepseekEnabled !== undefined) patch.deepseekEnabled = values.deepseekEnabled as boolean;
  if (values.fetchProvider !== undefined)
    patch.fetchProvider = values.fetchProvider as UpdateWebSettingsRequest["fetchProvider"];
  else if (backend === "jiuwenswarm" && current.fetchProvider !== "deepseek" && current.fetchProvider !== "jina")
    patch.fetchProvider = "jina";
  if (values.proxyPolicy !== undefined) patch.proxyPolicy = values.proxyPolicy as UpdateWebSettingsRequest["proxyPolicy"];
  for (const name of ["searchCacheTtlSeconds", "fetchCacheTtlSeconds"] as const) if (values[name] !== undefined) patch[name] = values[name] as number;
  if (values.freeSearchEngines !== undefined) {
    const selected = values.freeSearchEngines as string[];
    patch.freeSearchEngines = { ...current.freeSearchEngines, duckduckgo: selected.includes("duckduckgo"), bing: selected.includes("bing"),
      ...(backend === "native" ? { "brave-html": selected.includes("brave-html") } : {}) };
  }
  if (values.paidSearchProviders !== undefined) {
    const selected = values.paidSearchProviders as string[];
    patch.paidSearchProviders = PAID_SEARCH_ORDER.filter(id => backend === "jiuwenswarm" && id !== "deepseek" ? current.paidSearchProviders.includes(id) : selected.includes(id));
  }
  return patch;
}

export function createWebConfigurationAdapter(store: SessionStore, backend: () => WebBackend): ConfigurationAdapter {
  const normalize = (raw: unknown): ConfigurationValues => {
    const input = object(raw, [...common, ...nativeOnly], "values");
    const output: ConfigurationValues = {};
    const swarm = backend() === "jiuwenswarm";
    for (const [name, value] of Object.entries(input)) {
      if (swarm && nativeOnly.includes(name)) invalid("This field is only supported by the Native Web backend", name);
      if (name === "deepseekEnabled") {
        if (typeof value !== "boolean") invalid("Expected a boolean", name);
        output[name] = value;
      } else if (name === "freeSearchEngines" || name === "paidSearchProviders") {
        const choices = name === "freeSearchEngines" ? FREE_SEARCH_ORDER.filter(id => !swarm || id !== "brave-html") : PAID_SEARCH_ORDER.filter(id => !swarm || id === "deepseek");
        if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !(choices as readonly string[]).includes(id)) || new Set(value).size !== value.length) invalid("Expected unique supported provider IDs", name);
        output[name] = choices.filter(id => value.includes(id));
      } else if (name === "fetchProvider") {
        if (typeof value !== "string" || !(swarm ? ["jina", "deepseek"] : ["jina", "tavily", "exa", "deepseek"]).includes(value)) invalid("Unsupported fetch provider for this backend", name);
        output[name] = value;
      } else if (name === "proxyPolicy") {
        if (typeof value !== "string" || !store.configurationWebProxyPolicies().includes(value)) invalid("Select an existing proxy policy", name);
        output[name] = value;
      } else {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2_592_000) invalid("Cache TTL must be an integer from 0 to 2592000 seconds", name);
        output[name] = value;
      }
    }
    return output;
  };
  return {
    id: "web.configure", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    normalize, target: () => "web.configure",
    preview: (input, snapshot) => {
      const mode = backend();
      const settings = snapshot.data.webSettings as WebSettingsDetails;
      const current = webConfigurationCurrent(settings, mode);
      const values = { ...current, ...input };
      // Reuse the formal validator in addition to the finite conversational contract.
      const { providers: _providers, backend: _backend, ...formal } = settings;
      const patch = webConfigurationPatch(input, settings, mode);
      normalizeWebSettings({ ...formal, ...patch });
      const fields: ConfigurationFieldView[] = Object.entries(values).map(([id, value]) => {
        const label = id === "fetchProvider" && mode === "jiuwenswarm" ? "Fetch provider saved for JiuwenSwarm" : id;
        if (Array.isArray(value)) {
          const choices = id === "freeSearchEngines" ? FREE_SEARCH_ORDER.filter(id => mode === "native" || id !== "brave-html") : PAID_SEARCH_ORDER.filter(id => mode === "native" || id === "deepseek");
          return { id, label, kind: "multiselect", required: false, value, choices: choices.map(id => ({ id, label: id })) };
        }
        if (id === "fetchProvider" || id === "proxyPolicy") {
          const choices = id === "proxyPolicy" ? [...new Set([String(value), ...snapshot.data.webProxyPolicies as string[]])].slice(0, 500) : mode === "native" ? ["jina", "tavily", "exa", "deepseek"] : ["jina", "deepseek"];
          return { id, label, kind: "enum", required: false, value, choices: choices.map(id => ({ id, label: id })) };
        }
        return { id, label, kind: typeof value === "boolean" ? "boolean" : "number", required: false, value };
      });
      const supplied = Object.keys(input).length > 0;
      const stored: ConfigurationValues = { ...current, fetchProvider: settings.fetchProvider };
      const reviewed = supplied && patch.fetchProvider !== undefined ? { ...input, fetchProvider: patch.fetchProvider } : input;
      const changes = Object.entries(reviewed)
        .filter(([field, value]) => canonical(stored[field]) !== canonical(value))
        .map(([field, value]) => ({ field, before: JSON.stringify(stored[field]), after: JSON.stringify(value) }));
      return { fields, changes, impact: { resourceLocation: "Deployment Web settings", effectiveScope: "Every session using the Web backend",
        message: `${mode === "native" ? "Native: later Web operations read the saved settings; in-flight operations keep their existing settings." : "JiuwenSwarm: saved locally only. Restart the API to attempt the existing startup synchronization; remote activation is not verified by this receipt. Native-only search choices are preserved. A legacy fetch source changes only as shown in the reviewed changes."} Paid providers can incur charges when later used and require separately configured keys. DeepSeek also requires explicit opt-in. No key is changed and no search, fetch, connection test or model call is performed.` },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: mode === "native" ? "next_run" : "requires_restart",
        disposition: !Object.keys(input).length ? "missing_input" : changes.length ? "change" : "no_change", ready: changes.length > 0, data: { backend: mode } };
    },
    apply: context => {
      if (context.plan.data?.backend !== backend()) throw new ConfigurationError("RESOURCE_VERSION_CONFLICT", "The Web backend changed; prepare a new preview", 409);
      const input = normalize(context.input);
      store.applyWebConfigurationSync(webConfigurationPatch(input, store.getWebSettings(), backend()));
      return { summary: backend() === "native" ? "Web settings saved for later operations; provider connectivity was not tested" : "Web settings saved locally; API restart and successful JiuwenSwarm startup synchronization are still required" };
    },
  };
}

export function webConfigurationFields(backend: WebBackend) {
  const fields = CONFIGURATION_AGENT_DESCRIPTORS["web.configure"].fields;
  return Object.fromEntries(Object.entries(fields).filter(([name]) => backend === "native" || !nativeOnly.includes(name)).map(([name, field]) => [name,
    name === "freeSearchEngines" ? { ...field, choices: FREE_SEARCH_ORDER.filter(id => backend === "native" || id !== "brave-html") }
      : name === "paidSearchProviders" ? { ...field, choices: PAID_SEARCH_ORDER.filter(id => backend === "native" || id === "deepseek") }
      : backend === "jiuwenswarm" && name === "fetchProvider" ? { ...field, choices: ["jina", "deepseek"] } : field]));
}
