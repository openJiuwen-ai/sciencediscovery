// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues, SandboxNetworkSettings } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import { normalizeSandboxNetworkSettings } from "../store/sandbox-network.js";
import type { ConfigurationAdapter } from "./types.js";
import { canonical, ConfigurationError, digest, invalid, object } from "./validation.js";

export function securityNetworkValues(settings: SandboxNetworkSettings): ConfigurationValues {
  return { mode: settings.mode, allowedDomainsText: settings.allowedDomains.join(", "), allowPrivateNetwork: settings.allowPrivateNetwork, egressProxyPolicy: settings.egressProxyPolicy };
}
function settings(values: ConfigurationValues, current: SandboxNetworkSettings): SandboxNetworkSettings {
  const { allowedDomainsText, ...patch } = values;
  try { return normalizeSandboxNetworkSettings({ ...current, ...patch,
    ...(allowedDomainsText !== undefined ? { allowedDomains: String(allowedDomainsText).split(/[,\n]/u).map(value => value.trim()).filter(Boolean) } : {}) }); }
  catch { throw new ConfigurationError("INVALID_CONFIGURATION_INPUT", "Use a valid network mode and domain names without URLs or paths; open mode requires an empty domain list", 400); }
}
export function createSecurityNetworkAdapter(store: SessionStore, cleanupAvailable: () => boolean): ConfigurationAdapter {
  return {
    id: "security.network", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    normalize: (raw): ConfigurationValues => {
      const input = object(raw, ["mode", "allowedDomainsText", "allowPrivateNetwork", "egressProxyPolicy"], "values");
      const output: ConfigurationValues = {};
      for (const [name, value] of Object.entries(input)) {
        if (name === "allowPrivateNetwork") { if (typeof value !== "boolean") invalid("Expected a boolean", name); }
        else if (typeof value !== "string" || value.length > (name === "allowedDomainsText" ? 4096 : 200) || /[\u0000-\u0009\u000b-\u000c\u000e-\u001f]/u.test(value)) invalid("Invalid registered security field", name);
        if (name === "mode" && !["none", "domain-allowlist", "open"].includes(String(value))) invalid("Select a registered network mode", name);
        output[name] = value as string | boolean;
      }
      return output;
    },
    target: () => "security.network",
    preview: (input, snapshot, scope) => {
      if (!cleanupAvailable()) throw new ConfigurationError("CONFIGURATION_BACKEND_UNSUPPORTED", "No bounded retired-kernel cleanup adapter is installed", 409);
      const source = snapshot.data.securityNetwork as ReturnType<SessionStore["configurationSecurityNetwork"]>;
      const next = settings(input, source.settings);
      if (!source.proxyPolicies.includes(next.egressProxyPolicy)) invalid("Choose an existing egress proxy policy", "egressProxyPolicy");
      const current = securityNetworkValues(source.settings), values = securityNetworkValues(next);
      const display = (value: unknown) => { const text = JSON.stringify(value); return text.length <= 1800 ? text : `Domain list ${digest(value)}; the complete proposed list appears in the editable Allowed domains field.`; };
      const changes = Object.keys(input).filter(field => canonical(current[field]) !== canonical(values[field])).map(field => ({ field, before: display(current[field]), after: display(values[field]) }));
      const statement = `This is an independent human security decision affecting ${source.writableSessionCount} writable sessions. Network access, private-network access and egress routes can widen. Permission Epochs may rotate and persistent kernel/shell memory may be lost. Tool Always allow and ordinary configuration confirmation are not this authorization.`;
      return { fields: [
        { id: "mode", label: "Sandbox network mode", kind: "enum", required: false, value: next.mode, choices: ["none", "domain-allowlist", "open"].map(id => ({ id, label: id })) },
        { id: "allowedDomainsText", label: "Allowed domains (comma or newline separated)", kind: "text", required: false, value: String(values.allowedDomainsText) },
        { id: "allowPrivateNetwork", label: "Allow private-network destinations", kind: "boolean", required: false, value: next.allowPrivateNetwork },
        { id: "egressProxyPolicy", label: "Sandbox egress proxy policy", kind: "enum", required: false, value: next.egressProxyPolicy, choices: source.proxyPolicies.map(id => ({ id, label: id })) },
      ], changes, impact: { resourceLocation: "Deployment sandbox network policy", effectiveScope: `All ${source.writableSessionCount} writable sessions in this deployment`,
        message: `${statement} Saving rotates affected epochs immediately; later executions cannot reuse old-epoch kernels. In-flight work can retain its startup policy. Only old-epoch kernels reported by the configured local Runner are retired; no unreported remote process cleanup or real network connectivity is certified. Approval mode, execution grants and automatic configuration authorization stay unchanged.` },
        securityConsent: { targetDigest: digest([next, scope, snapshot.resourceVersions]), statement },
        verificationPlan: { targets: [], actions: ["Each explicit attempt after commit: one configured-Runner kernel listing and at most eight exact old-epoch kernel retirements. Failed cleanup requires the user's Continue action; background polling and repeated Apply do not retry it. No connectivity test or model call."], maxRequests: 9, mayCharge: false },
        activationMode: "next_execution", disposition: !Object.keys(input).length ? "missing_input" : changes.length ? "change" : "no_change", ready: changes.length > 0,
        data: { settings: next } };
    },
    apply: context => {
      if (!cleanupAvailable()) throw new ConfigurationError("CONFIGURATION_BACKEND_UNSUPPORTED", "The retired-kernel cleanup adapter is no longer available", 409);
      const result = store.applySecurityNetworkConfigurationSync(context.plan.data?.settings);
      return { retiredPermissionEpochIds: result.retiredPermissionEpochIds,
        summary: `Sandbox policy saved; ${result.rotatedSessionIds.length} Permission Epochs rotated. Runtime cleanup and real network connectivity are separate.` };
    },
  };
}
