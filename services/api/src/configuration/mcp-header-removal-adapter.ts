// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { CustomMcpServers } from "../mcp/custom-servers.js";
import type { ConfigurationAdapter } from "./types.js";
import { ConfigurationError, invalid, object, string } from "./validation.js";
export type McpHeaderRemovalPort = Pick<CustomMcpServers, "configurationHeaderRemoval" | "submitConfigurationHeaderRemoval" | "resolveConfigurationMetadata">;
export type McpHeaderRemovalSnapshot = ReturnType<McpHeaderRemovalPort["configurationHeaderRemoval"]>;

/** Remove a selected existing name group without exposing or transmitting any credential value. */
export function createMcpHeaderRemovalAdapter(port: McpHeaderRemovalPort): ConfigurationAdapter {
  return {
    id: "mcp.remove_header", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "external_control",
    normalize: raw => {
      const input = object(raw, ["serverId", "headerName"], "values"), result: ConfigurationValues = {};
      if (input.serverId !== undefined) {
        const id = string(input.serverId, "serverId", 100);
        if (!/^custom-[a-f0-9]{12}$/.test(id)) invalid("Choose an existing HTTP/SSE custom MCP server", "serverId");
        result.serverId = id;
      }
      if (input.headerName !== undefined) {
        const name = string(input.headerName, "headerName", 256);
        if (/[\u0000-\u001f\u007f]/u.test(name) || name !== name.trim()) invalid("Choose an existing saved header name", "headerName");
        result.headerName = name.toLowerCase();
      }
      return result;
    },
    target: values => JSON.stringify([String(values.serverId ?? ""), String(values.headerName ?? "").toLowerCase()]),
    preview: (input, snapshot) => {
      const source = snapshot.data.mcpMetadata as McpHeaderRemovalSnapshot, current = source.current, header = source.header;
      if (input.serverId && (!current || !current.headers.length) || input.headerName && !header) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "Choose an existing header on an HTTP/SSE custom MCP server", 409);
      return {
        fields: [{ id: "serverId", label: "Existing HTTP/SSE custom MCP server", kind: "enum", required: true, ...(current ? { value: current.id } : {}), choices: source.items.filter(item => item.headers.length).map(item => ({ id: item.id, label: `${item.name} · ${item.transport} · ${item.id}` })) },
          { id: "headerName", label: "Saved header name to remove", kind: "enum", required: true, ...(header ? { value: header.name } : {}), choices: (current?.headers ?? []).map(item => ({ id: item.name, label: `${item.name} · ${item.aliases} stored name(s)` })) }],
        changes: header ? [{ field: "headerName", before: `${header.name} · ${header.aliases} configured name(s); values hidden`, after: "All case aliases removed; no replacement value" }] : [],
        impact: { resourceLocation: "Encrypted custom MCP configuration", effectiveScope: "This shared HTTP/SSE server's saved header-name group",
          message: "Remove every stored case alias of this one existing header name. Old values are never shown or sent, and no empty replacement credential is stored. Other headers, OAuth credentials, transport, enabled state, timeout and Session/tool/network permissions remain separate. Saving starts no network request or discovery. Old discovery/tools are invalidated, not certified usable with the changed credentials. Later calls may be unauthenticated or fail; a changed connection may interrupt old in-flight work. Reconnect/testing is a separate action. A bound original configuration wait may continue normally; no old tool/task is replayed." },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_invocation",
        disposition: header ? "change" : "missing_input", ready: Boolean(header), data: { expectedVersion: source.version },
      };
    },
    externalControl: {
      submit: (operation, context) => port.submitConfigurationHeaderRemoval(operation, JSON.stringify([context.input.serverId, context.input.headerName]), String(context.plan.data?.expectedVersion)),
      resolve: operation => port.resolveConfigurationMetadata(operation),
    },
  };
}
