// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { CustomMcpServers } from "../mcp/custom-servers.js";
import { isMcpCredentialHeader, isMcpHeaderCredentialValue } from "../mcp/header-credential-policy.js";
import type { ConfigurationCredentialBridge } from "./credential-bridge.js";
import type { ConfigurationAdapter, ConfigurationAdapterContext } from "./types.js";
import { ConfigurationError, invalid, object, string } from "./validation.js";
export type McpHeaderCredentialPort = Pick<CustomMcpServers, "configurationHeaderCredential" | "submitConfigurationHeaderCredential" | "resolveConfigurationMetadata">;
export type McpHeaderCredentialSnapshot = ReturnType<McpHeaderCredentialPort["configurationHeaderCredential"]>;
export function createMcpHeaderCredentialAdapter(port: McpHeaderCredentialPort, credentials: ConfigurationCredentialBridge,
  assertConsent: (context: ConfigurationAdapterContext) => void): ConfigurationAdapter {
  const pair = (input: ConfigurationValues) => JSON.stringify([input.serverId ?? "", input.headerName ?? ""]);
  const target = (input: ConfigurationValues) => port.configurationHeaderCredential(pair(input)).target;
  const binding = (context: ConfigurationAdapterContext) => ({ sessionId: context.sessionId, requestId: context.requestId, revision: context.revision,
    target: String(context.plan.data?.credentialTarget), fieldId: "apiToken", normalization: "exact" as const });
  const current = (context: ConfigurationAdapterContext) => {
    const source = port.configurationHeaderCredential(pair(context.input));
    if (!source.destination || source.target !== context.plan.data?.credentialTarget || source.destination.endpointTarget !== context.plan.endpointAuthorization?.endpointTarget) {
      throw new ConfigurationError("STALE_ENDPOINT_CONSENT", "The saved MCP recipient changed; review it and enter the replacement again", 409, "serverId");
    }
    assertConsent(context); return source;
  };
  return {
    id: "mcp.header_credential", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "external_control",
    fieldPolicy: { credentialFields: ["apiToken"], credentialNormalization: "exact" },
    normalize: raw => {
      const input = object(raw, ["serverId", "headerName"], "values"), result: ConfigurationValues = {};
      if (input.serverId !== undefined) { const id = string(input.serverId, "serverId", 100); if (!/^custom-[a-f0-9]{12}$/u.test(id)) { invalid("Choose an existing HTTP/SSE custom MCP server", "serverId"); } result.serverId = id; }
      if (input.headerName !== undefined) { const name = string(input.headerName, "headerName", 256); if (!isMcpCredentialHeader(name)) { invalid("Choose an existing non-transport header", "headerName"); } result.headerName = name.toLowerCase(); }
      return result;
    }, target,
    preview: (input, snapshot) => {
      const source = snapshot.data.mcpMetadata as McpHeaderCredentialSnapshot, selected = source.current, header = source.header, destination = source.destination;
      if (input.serverId && !selected || input.headerName && !header) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "Choose an existing non-OAuth HTTP/SSE credential header", 409);
      return {
        fields: [{ id: "serverId", label: "Existing HTTP/SSE custom MCP server", kind: "enum", required: true, ...(selected ? { value: selected.id } : {}), choices: source.items.map(item => ({ id: item.id, label: `${item.name} · ${item.transport} · ${item.id}` })) },
          { id: "headerName", label: "Existing credential header", kind: "enum", required: Boolean(selected), ...(header ? { value: header.name } : {}), choices: (selected?.headers ?? []).map(item => ({ id: item.name, label: `${item.name} · ${item.aliases} stored name(s)` })) },
          ...(header ? [{ id: "apiToken", label: "Replacement header value", kind: "credential" as const, required: true, status: "missing" as const, description: "Printable ASCII only, no outer spaces, controls or leading $ environment reference. Use removal to delete a header." }] : [])],
        changes: header ? [{ field: "headerName", before: `${header.name} · ${header.aliases} stored name(s); values hidden`, after: "Replace via secure input; authentication unverified" }] : [],
        impact: { resourceLocation: "Encrypted custom MCP configuration", effectiveScope: "This shared server's saved credential header",
          message: `Independent manual confirmation and separate recipient approval are required. Recipient: ${destination?.origin ?? "select a saved server/header"}. The saved path/query may contain secrets and is hidden but bound to this approval; review it in the formal editor first. Replace all case aliases with one header. Other headers, OAuth, URL, transport, enabled state, timeout, proxy and Session/tool/network permissions remain. Saving performs no probe, RPC, network request or process operation. Old discovery is invalidated; later ordinary connection/testing uses the replacement and may interrupt old work. Existing connections may retain the old value until reconnect. This is not remote credential revocation or verified authentication. A bound original configuration wait may continue normally; no old tool/task is replayed.` },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_invocation",
        disposition: header && destination ? "change" : "missing_input", ready: Boolean(header && destination), data: { expectedVersion: source.version, credentialTarget: source.target },
        ...(destination ? { endpointAuthorization: { endpointTarget: destination.endpointTarget, host: destination.host, classification: destination.classification } } : {}),
      };
    },
    verify: async context => {
      current(context); if (!context.credentialHandle) { return { ok: false, code: "CONFIGURATION_CREDENTIAL_REQUIRED", field: "apiToken", message: "Enter the replacement in the secure user field" }; }
      return credentials.withLease(context.credentialHandle, binding(context), async secret => {
        if (!isMcpHeaderCredentialValue(secret)) { invalid("Use printable ASCII without outer spaces, controls or a leading $", "apiToken"); } return { ok: true };
      });
    },
    externalControl: {
      submit: async (operation, context) => {
        current(context); if (!context.credentialHandle) { throw new ConfigurationError("CONFIGURATION_CREDENTIAL_REQUIRED", "Enter the replacement in the secure user field", 409, "apiToken"); }
        return credentials.withLease(context.credentialHandle, binding(context), secret => port.submitConfigurationHeaderCredential(operation, String(context.plan.data?.credentialTarget), String(context.plan.data?.expectedVersion), secret));
      }, resolve: operation => port.resolveConfigurationMetadata(operation),
    },
  };
}
