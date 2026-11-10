// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { CustomMcpServers } from "../mcp/custom-servers.js";
import type { ConfigurationAdapter } from "./types.js";
import { ConfigurationError, invalid, object, string } from "./validation.js";
export type McpDeletionPort = Pick<CustomMcpServers, "configurationDeletion" | "submitConfigurationDeletion" | "resolveConfigurationMetadata">;
export type McpDeletionSnapshot = ReturnType<McpDeletionPort["configurationDeletion"]>;

export function createMcpDeletionAdapter(port: McpDeletionPort): ConfigurationAdapter {
  return {
    id: "mcp.delete", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "external_control",
    normalize: raw => {
      const input = object(raw, ["serverId", "confirmDelete"], "values"), result: ConfigurationValues = {};
      if (input.serverId !== undefined) {
        const id = string(input.serverId, "serverId", 100);
        if (!/^custom-[a-f0-9]{12}$/u.test(id)) invalid("Choose an existing custom MCP server", "serverId");
        result.serverId = id;
      }
      if (input.confirmDelete !== undefined) {
        if (typeof input.confirmDelete !== "boolean") invalid("Explicitly confirm the shared deletion", "confirmDelete");
        result.confirmDelete = input.confirmDelete;
      }
      return result;
    },
    target: values => String(values.serverId ?? ""),
    preview: (input, snapshot) => {
      const source = snapshot.data.mcpMetadata as McpDeletionSnapshot, current = source.current;
      if (input.serverId && !current) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "Choose an existing custom MCP server", 409);
      const ready = Boolean(current && input.confirmDelete === true);
      return {
        fields: [{ id: "serverId", label: "Existing custom MCP server", kind: "enum", required: true, ...(current ? { value: current.id } : {}), choices: source.items.map(item => ({ id: item.id, label: `${item.name} · ${item.transport} · ${item.id}` })) },
          { id: "confirmDelete", label: "Delete this shared server and its saved references", kind: "boolean", required: Boolean(current), value: input.confirmDelete === true }],
        changes: ready && current ? [{ field: "serverId", before: `${current.name} · ${current.id}`, after: "Deleted, including local OAuth state and saved references; no automatic undo" }] : [],
        impact: { resourceLocation: "Encrypted custom MCP configuration and local OAuth/reference stores", effectiveScope: "Every Global, Project, Session and Specialist reference to this custom server",
          message: "Independent manual confirmation required. Delete this custom server, its local OAuth state and saved selection references. Other servers remain. The deletion journal recovers interrupted local cleanup without replaying tools. This action has no automatic undo and does not revoke remote credentials. Saving performs no discovery, MCP/network request or process start/stop. Existing connections or already running work may continue until later ordinary catalog/reconnect cleanup; future calls cannot use this removed server. A bound original configuration wait may continue normally; no old tool/task is replayed." },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_invocation",
        disposition: ready ? "change" : "missing_input", ready, data: { expectedVersion: source.version },
      };
    },
    externalControl: {
      submit: (operation, context) => port.submitConfigurationDeletion(operation, String(context.input.serverId), String(context.plan.data?.expectedVersion)),
      resolve: operation => port.resolveConfigurationMetadata(operation),
    },
  };
}
