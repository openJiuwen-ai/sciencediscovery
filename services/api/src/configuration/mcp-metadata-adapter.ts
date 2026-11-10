// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { CustomMcpServers } from "../mcp/custom-servers.js";
import type { ConfigurationAdapter } from "./types.js";
import { ConfigurationError, object, invalid } from "./validation.js";
export type McpMetadataPort = Pick<CustomMcpServers, "configurationMetadata" | "submitConfigurationMetadata" | "resolveConfigurationMetadata">;
export type McpMetadataSnapshot = ReturnType<McpMetadataPort["configurationMetadata"]>;

/** Metadata only. No transport, permission, credential, process or connection operation. */
export function createMcpMetadataAdapter(port: McpMetadataPort): ConfigurationAdapter {
  return {
    id: "mcp.metadata", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "external_control",
    normalize: raw => {
      const input = object(raw, ["serverId", "name", "description"], "values"), result: ConfigurationValues = {};
      for (const [field, value] of Object.entries(input)) {
        if (typeof value !== "string" || value.length > (field === "description" ? 2000 : 100) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) invalid("Use a valid registered MCP metadata field", field);
        if (field !== "description" && !value.trim()) invalid("Choose an existing server and a non-empty name", field);
        if (field === "serverId" && !/^custom-[a-f0-9]{12}$/.test(value)) invalid("Choose an existing custom MCP server", field);
        result[field] = value.trim();
      }
      return result;
    },
    target: values => String(values.serverId ?? ""),
    preview: (input, snapshot) => {
      const source = snapshot.data.mcpMetadata as McpMetadataSnapshot, current = source.current;
      if (input.serverId && !current) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "Choose an existing custom MCP server", 409);
      const candidate = current ? { name: String(input.name ?? current.name), description: String(input.description ?? current.description) } : undefined;
      const supplied = input.name !== undefined || input.description !== undefined;
      const changes = current && candidate ? (["name", "description"] as const).filter(field => current[field] !== candidate[field]).map(field => ({ field, before: current[field], after: candidate[field] })) : [];
      return {
        fields: [{ id: "serverId", label: "Existing custom MCP server", kind: "enum", required: true, ...(current ? { value: current.id } : {}), choices: source.items.map(item => ({ id: item.id, label: `${item.name} · ${item.id}` })) },
          { id: "name", label: "MCP server name", kind: "text", required: Boolean(current), ...(candidate ? { value: candidate.name } : {}) },
          { id: "description", label: "MCP server description", kind: "text", required: false, ...(candidate ? { value: candidate.description } : {}) }], changes,
        impact: { resourceLocation: "Encrypted custom MCP configuration", effectiveScope: "This shared custom MCP server's catalog metadata",
          message: "Only the display name and description are saved, with a durable external operation receipt. Transport, enabled state, URL, commands, arguments, environment, headers, timeouts, credentials and OAuth remain unchanged. Existing discovered tools are retained. No catalog refresh, STDIO process, OAuth flow or network request is started. Later catalog/resource reads use the metadata; recorded task settings stay unchanged and a bound original configuration wait may continue normally. This does not verify connectivity or grant tool permissions." },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_run",
        disposition: !current || !supplied ? "missing_input" : changes.length ? "change" : "no_change", ready: Boolean(current && supplied && changes.length),
        data: { expectedVersion: source.version },
      };
    },
    externalControl: {
      submit: (operation, context) => port.submitConfigurationMetadata(operation, String(context.input.serverId), String(context.plan.data?.expectedVersion),
        Object.fromEntries(Object.entries(context.input).filter(([field]) => ["name", "description"].includes(field)))),
      resolve: operation => port.resolveConfigurationMetadata(operation),
    },
  };
}
