// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { CustomMcpServers } from "../mcp/custom-servers.js";
import type { ConfigurationAdapter } from "./types.js";
import { ConfigurationError, invalid, object, string } from "./validation.js";
export type McpAvailabilityPort = Pick<CustomMcpServers, "configurationMetadata" | "submitConfigurationAvailability" | "resolveConfigurationMetadata">;
export type McpAvailabilitySnapshot = ReturnType<McpAvailabilityPort["configurationMetadata"]>;

/** This global availability decision never inherits a tool or automatic configuration permission. */
export function createMcpAvailabilityAdapter(port: McpAvailabilityPort): ConfigurationAdapter {
  return {
    id: "mcp.availability", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "external_control",
    normalize: raw => {
      const input = object(raw, ["serverId", "enabled"], "values"), result: ConfigurationValues = {};
      if (input.serverId !== undefined) {
        const id = string(input.serverId, "serverId", 100);
        if (!/^custom-[a-f0-9]{12}$/.test(id)) invalid("Choose an existing custom MCP server", "serverId");
        result.serverId = id;
      }
      if (input.enabled !== undefined) {
        if (typeof input.enabled !== "boolean") invalid("Availability must be a boolean", "enabled");
        result.enabled = input.enabled;
      }
      return result;
    },
    target: values => String(values.serverId ?? ""),
    preview: (input, snapshot) => {
      const source = snapshot.data.mcpMetadata as McpAvailabilitySnapshot, current = source.current;
      if (input.serverId && !current) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "Choose an existing custom MCP server", 409);
      const supplied = input.enabled !== undefined, candidate = supplied ? input.enabled === true : current?.enabled ?? false, changed = Boolean(current && supplied && current.enabled !== candidate);
      return {
        fields: [{ id: "serverId", label: "Existing custom MCP server", kind: "enum", required: true, ...(current ? { value: current.id } : {}), choices: source.items.map(item => ({ id: item.id, label: `${item.name} · ${item.transport} · ${item.id}` })) },
          { id: "enabled", label: "Available globally", kind: "boolean", required: true, ...(current ? { value: candidate } : {}) }],
        changes: changed && current ? [{ field: "enabled", before: String(current.enabled), after: String(candidate) }] : [],
        impact: { resourceLocation: "Encrypted custom MCP configuration", effectiveScope: `Shared MCP availability across all Sessions${current ? ` · ${current.transport}` : ""}`,
          message: "This shared service switch requires its own manual confirmation. It does not select the connector for a Session or grant tool, network or command permissions. Review the server's saved connection/execution settings before enabling it. Saving starts no discovery, connection, STDIO process or OAuth flow. Later ordinary discovery/use may contact its stored endpoint or launch its stored STDIO program. An untested service is not verified ready. Disabling rejects subsequent calls; it does not immediately cancel already sent work, but a later catalog refresh may close its old connection and interrupt that work. Re-enabling never replays an old task/tool. Run records stay unchanged; a bound original configuration wait may continue normally." },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_invocation",
        disposition: !current || !supplied ? "missing_input" : changed ? "change" : "no_change", ready: changed,
        data: { expectedVersion: source.version },
      };
    },
    externalControl: {
      submit: (operation, context) => port.submitConfigurationAvailability(operation, String(context.input.serverId), String(context.plan.data?.expectedVersion), { enabled: context.input.enabled }),
      resolve: operation => port.resolveConfigurationMetadata(operation),
    },
  };
}
