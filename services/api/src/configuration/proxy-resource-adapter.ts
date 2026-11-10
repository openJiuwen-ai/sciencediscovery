// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationFieldView, ConfigurationValues, ProxyServer } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import { cleanLabel } from "@sciencediscovery/governance";
import type { ConfigurationAdapter } from "./types.js";
import { ConfigurationError, digest, invalid, object, string } from "./validation.js";

/** Rename existing metadata only. Never read, collect or change a proxy URL or route. */
export function createProxyResourceAdapter(store: SessionStore): ConfigurationAdapter {
  const normalize = (raw: unknown): ConfigurationValues => {
    const input = object(raw, ["operation", "proxyId", "name", "kind", "replaceUrl"], "values");
    if (input.operation !== undefined && input.operation !== "update") invalid("Only renaming an existing proxy is supported", "operation");
    const current = store.configurationProxyResources().find(item => item.id === input.proxyId);
    if (input.kind !== undefined && input.kind !== current?.kind) invalid("Proxy type changes are not supported", "kind");
    if (input.replaceUrl !== undefined && input.replaceUrl !== false) invalid("Proxy URL changes are not supported", "replaceUrl");
    const values: ConfigurationValues = { operation: "update" };
    if (input.proxyId !== undefined) values.proxyId = string(input.proxyId, "proxyId", 200).trim();
    if (input.name !== undefined) values.name = cleanLabel(string(input.name, "name", 200).trim(), "");
    return values;
  };
  const target = (input: ConfigurationValues) => digest(["proxy.resources", "rename", input.proxyId ?? ""]);
  return {
    id: "proxy.resources", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    normalize, target,
    preview: (input, snapshot) => {
      const directory = snapshot.data.proxyResources as ProxyServer[];
      const current = directory.find(item => item.id === input.proxyId);
      if (input.proxyId && !current) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "The proxy resource is unavailable", 409, "proxyId");
      const name = String(input.name ?? current?.name ?? "");
      // Keep the existing new-UI metadata projection; these fixed values are not editable inputs.
      const fields: ConfigurationFieldView[] = [
        { id: "operation", label: "Operation", kind: "enum", required: true, value: "update", choices: [{ id: "update", label: "Rename" }] },
        { id: "proxyId", label: "Existing proxy resource", kind: "enum", required: true, ...(current ? { value: current.id } : {}), choices: directory.map(item => ({ id: item.id, label: item.name.slice(0, 180) })) },
        { id: "name", label: "Proxy name", kind: "text", required: true, value: name },
        { id: "kind", label: "Proxy type", kind: "enum", required: true, value: current?.kind ?? "system", choices: [{ id: current?.kind ?? "system", label: current?.kind ?? "system" }] },
        ...(current?.kind === "custom_url" ? [{ id: "replaceUrl", label: "Replace stored proxy URL", kind: "boolean" as const, required: false, value: false }] : []),
      ];
      const changes = current && input.name !== undefined && name && name !== current.name ? [{ field: "name", before: current.name, after: name }] : [];
      return { fields, changes, ready: changes.length > 0,
        disposition: !current || input.name === undefined ? "missing_input" : changes.length ? "change" : "no_change",
        impact: { resourceLocation: "Shared proxy registry", effectiveScope: "Proxy display name",
          message: "Manual confirmation required. Only the display name changes. Proxy type, stored URL, routing, permissions and existing connections stay unchanged. No connection is tested." },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_connection" };
    },
    apply: context => {
      // Revalidate persisted requests as well: older CRUD/credential proposals cannot execute.
      const input = normalize(context.input);
      if (!input.proxyId || !input.name) invalid("Choose an existing proxy and a new name");
      store.renameProxyResourceConfigurationSync(String(input.proxyId), String(input.name));
      return { resourceRevision: digest(store.configurationSnapshot(context.sessionId, "proxy.resources", target(input)).resourceVersions),
        summary: "Proxy display name saved; stored URL, routing and permissions are unchanged" };
    },
  };
}
