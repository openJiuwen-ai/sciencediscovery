// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { CustomMcpServers } from "../mcp/custom-servers.js";
import type { ConfigurationAdapter } from "./types.js";
import { ConfigurationError, integer, invalid, object, string } from "./validation.js";
export type McpTimeoutPort = Pick<CustomMcpServers, "configurationTimeout" | "submitConfigurationTimeout" | "resolveConfigurationMetadata">;
export type McpTimeoutSnapshot = ReturnType<McpTimeoutPort["configurationTimeout"]>;

/** Finite per-call policy; no connection, discovery, process or permission change. */
export function createMcpTimeoutAdapter(port: McpTimeoutPort): ConfigurationAdapter {
  return {
    id: "mcp.timeout", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "external_control",
    normalize: raw => {
      const input = object(raw, ["serverId", "timeoutSeconds"], "values"), result: ConfigurationValues = {};
      if (input.serverId !== undefined) {
        const id = string(input.serverId, "serverId", 100);
        if (!/^custom-[a-f0-9]{12}$/.test(id)) invalid("Choose an existing custom MCP server", "serverId");
        result.serverId = id;
      }
      if (input.timeoutSeconds !== undefined) {
        const seconds = integer(input.timeoutSeconds, "timeoutSeconds", 1);
        if (seconds > 600) invalid("Timeout must be between 1 and 600 seconds", "timeoutSeconds");
        result.timeoutSeconds = seconds;
      }
      return result;
    },
    target: values => String(values.serverId ?? ""),
    preview: (input, snapshot) => {
      const source = snapshot.data.mcpMetadata as McpTimeoutSnapshot, current = source.current;
      if (input.serverId && !current) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "Choose an existing custom MCP server", 409);
      const supplied = input.timeoutSeconds !== undefined, candidate = Number(input.timeoutSeconds ?? current?.timeoutSeconds ?? 60);
      const changed = Boolean(current && supplied && current.timeoutSeconds !== candidate);
      return {
        fields: [{ id: "serverId", label: "Existing custom MCP server", kind: "enum", required: true, ...(current ? { value: current.id } : {}), choices: source.items.map(item => ({ id: item.id, label: `${item.name} · ${item.id}` })) },
          { id: "timeoutSeconds", label: "Call timeout (seconds)", kind: "number", required: true, description: "Integer seconds, from 1 to 600", ...(current ? { value: candidate } : {}) }],
        changes: changed && current ? [{ field: "timeoutSeconds", before: String(current.timeoutSeconds), after: String(candidate) }] : [],
        impact: { resourceLocation: "Encrypted custom MCP configuration", effectiveScope: "This shared custom MCP server's subsequent calls",
          message: "Save a 1–600 second call timeout for this shared MCP server. Subsequent MCP invocations read this cap; calls already admitted retain limits they already read, and an earlier broker limit may remain stricter. This does not change a whole Run's frozen settings. Existing connections and in-flight requests are retained. No catalog refresh, discovery, network request, STDIO process, OAuth flow, retry or permission grant starts. A bound original configuration wait may continue normally; this is not proof of new runtime tools." },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_invocation",
        disposition: !current || !supplied ? "missing_input" : changed ? "change" : "no_change", ready: changed,
        data: { expectedVersion: source.version },
      };
    },
    externalControl: {
      submit: (operation, context) => port.submitConfigurationTimeout(operation, String(context.input.serverId), String(context.plan.data?.expectedVersion), { timeoutSeconds: context.input.timeoutSeconds }),
      resolve: operation => port.resolveConfigurationMetadata(operation),
    },
  };
}
