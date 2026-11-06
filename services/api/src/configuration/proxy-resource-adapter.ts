// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationFieldView, ConfigurationValues, ProxyServer, UpdateProxyServerRequest } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import { cleanLabel } from "@sciencediscovery/governance";
import { normalizeProxyUrl } from "../store/settings.js";
import type { ConfigurationCredentialBridge } from "./credential-bridge.js";
import type { ConfigurationAdapter, ConfigurationAdapterContext } from "./types.js";
import { ConfigurationError, digest, invalid, object, string } from "./validation.js";

const operations = ["create", "update", "delete"] as const;
const kinds = ["custom_url", "environment", "system"] as const;
const enumField = (id: string, label: string, choices: readonly string[], value?: string): ConfigurationFieldView => ({
  id, label, kind: "enum", required: true, choices: choices.map(id => ({ id, label: id })), ...(value ? { value } : {}),
});

/** Resource metadata and URL syntax only. Never probes a proxy or decrypts an existing URL. */
export function createProxyResourceAdapter(store: SessionStore, credentials: ConfigurationCredentialBridge): ConfigurationAdapter {
  const target = (input: ConfigurationValues) => digest(["proxy.resources", input.operation ?? "create", input.proxyId ?? "",
    input.kind ?? (input.operation === "update" ? store.configurationProxyResources().find(item => item.id === input.proxyId)?.kind : "custom_url"), input.replaceUrl === true]);
  const binding = (context: ConfigurationAdapterContext) => ({ sessionId: context.sessionId, requestId: context.requestId,
    revision: context.revision, target: String(context.plan.data?.credentialTarget), fieldId: "proxyUrl" });
  const secret = (context: ConfigurationAdapterContext) => {
    if (context.plan.data?.needsUrl !== true) return undefined;
    if (!context.credentialHandle) throw new ConfigurationError("CONFIGURATION_CREDENTIAL_REQUIRED", "Enter the proxy URL in the secure field", 400, "proxyUrl");
    return credentials.read(context.credentialHandle, binding(context));
  };
  return {
    id: "proxy.resources", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    fieldPolicy: { credentialFields: ["proxyUrl"] },
    normalize: raw => {
      const input = object(raw, ["operation", "proxyId", "name", "kind", "replaceUrl"], "values");
      const values: ConfigurationValues = {};
      for (const [key, value] of Object.entries(input)) {
        if (key === "replaceUrl") {
          if (typeof value !== "boolean") invalid("Invalid URL replacement flag", key);
          values[key] = value;
        } else {
          const item = value === "" ? "" : string(value, key, 200).trim();
          if (key === "operation" && !operations.includes(item as typeof operations[number])
            || key === "kind" && !kinds.includes(item as typeof kinds[number])) invalid("Unknown proxy operation or type", key);
          values[key] = key === "name" ? cleanLabel(item, "") : item;
        }
      }
      if ((values.operation ?? "create") === "create") { delete values.proxyId; delete values.replaceUrl; }
      if (values.operation === "delete") { delete values.name; delete values.kind; delete values.replaceUrl; }
      return values;
    },
    target,
    preview: (input, snapshot) => {
      const operation = (input.operation ?? "create") as typeof operations[number];
      const directory = snapshot.data.proxyResources as ProxyServer[];
      const current = directory.find(item => item.id === input.proxyId);
      if (input.proxyId && !current) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "The proxy resource is unavailable", 409, "proxyId");
      const kind = (input.kind ?? current?.kind ?? "custom_url") as ProxyServer["kind"];
      const name = String(input.name ?? (operation === "update" ? current?.name ?? "" : ""));
      const needsUrl = operation !== "delete" && kind === "custom_url" && (operation === "create" || current?.kind !== "custom_url" || !current.hasUrl || input.replaceUrl === true);
      if (input.replaceUrl === true && kind !== "custom_url" && operation !== "delete") invalid("Only a custom URL proxy accepts URL replacement", "replaceUrl");
      const fields: ConfigurationFieldView[] = [enumField("operation", "Operation", operations, operation)];
      if (operation !== "create") fields.push({ id: "proxyId", label: "Existing proxy resource", kind: "enum", required: true,
        ...(current ? { value: current.id } : {}), choices: directory.map(item => ({ id: item.id, label: item.name.slice(0, 180) })) });
      const changes: Array<{ field: string; before?: string; after: string }> = [];
      if (operation !== "delete") {
        fields.push({ id: "name", label: "Proxy name", kind: "text", required: true, value: name }, enumField("kind", "Proxy type", kinds, kind));
        if (operation === "update" && kind === "custom_url") fields.push({ id: "replaceUrl", label: "Replace stored proxy URL", kind: "boolean", required: false, value: input.replaceUrl === true });
        if (needsUrl) fields.push({ id: "proxyUrl", label: "Proxy URL (may contain credentials)", kind: "credential", required: true, status: "missing" });
        if (operation === "create" && name) changes.push({ field: "operation", after: "Create shared proxy resource; routing stays unchanged" });
        if (name && (operation === "create" || name !== current?.name)) changes.push({ field: "name", ...(current ? { before: current.name } : {}), after: name });
        if (operation === "create" || kind !== current?.kind) changes.push({ field: "kind", ...(current ? { before: current.kind } : {}), after: kind });
        if (needsUrl) changes.push({ field: "proxyUrl", after: "New secure URL; syntax checked only" });
      } else if (current) changes.push({ field: "operation", before: current.name, after: "Delete resource and its stored URL; blocked while referenced" });
      const ready = operation === "create" ? Boolean(name) : Boolean(current) && (operation === "delete" || Boolean(name));
      return { fields, changes, ready: ready && changes.length > 0,
        disposition: !ready || operation === "update" && !["name", "kind", "replaceUrl"].some(key => key in input) ? "missing_input" : changes.length ? "change" : "no_change",
        impact: { resourceLocation: "Shared proxy registry", effectiveScope: "Every session using this proxy",
          message: "Manual confirmation required. Creating a proxy does not select a route. Editing a used proxy affects later connections, possibly within an active run. Existing connections are not rebound. URL syntax is checked without connecting; reachability and proxy authentication remain unverified." },
        verificationPlan: { targets: [], actions: needsUrl ? ["Validate secure URL syntax without a connection"] : [], maxRequests: 0, mayCharge: false },
        activationMode: "next_connection", data: { operation, needsUrl, credentialTarget: target(input) } };
    },
    verify: async context => {
      if (context.plan.data?.needsUrl !== true) return { ok: true };
      if (!context.credentialHandle) return { ok: false, code: "CONFIGURATION_CREDENTIAL_REQUIRED", field: "proxyUrl", message: "Enter the proxy URL in the secure field" };
      return credentials.withLease(context.credentialHandle, binding(context), async url => {
        try { normalizeProxyUrl(url); return { ok: true }; }
        catch { return { ok: false, code: "INVALID_PROXY_URL", field: "proxyUrl", message: "Use a valid HTTP, HTTPS or SOCKS5 proxy URL without a fragment", retryable: true }; }
      });
    },
    apply: context => {
      const operation = context.plan.data?.operation as typeof operations[number];
      const patch: UpdateProxyServerRequest = {};
      if (operation !== "delete") {
        if (context.input.name !== undefined) patch.name = String(context.input.name);
        const kind = context.input.kind;
        if (kind !== undefined) {
          if (kind !== "custom_url" && kind !== "environment" && kind !== "system") invalid("Choose a registered proxy type", "kind");
          patch.kind = kind;
        }
        else if (operation === "create") patch.kind = "custom_url";
        const url = secret(context);
        if (url !== undefined) patch.url = url;
      }
      try { store.applyProxyResourceConfigurationSync(operation, context.input.proxyId ? String(context.input.proxyId) : undefined, patch); }
      catch (error) {
        if (error instanceof ConfigurationError && error.code === "PROXY_RESOURCE_IN_USE") throw error;
        throw new ConfigurationError("PROXY_RESOURCE_CHANGE_REJECTED", "The proxy change could not be saved. Check the resource and its references in proxy settings", 409);
      }
      return { resourceRevision: digest(store.configurationSnapshot(context.sessionId, "proxy.resources", target(context.input)).resourceVersions),
        summary: "Proxy resource saved; routing is not selected by creation and reachability remains unverified" };
    },
  };
}
