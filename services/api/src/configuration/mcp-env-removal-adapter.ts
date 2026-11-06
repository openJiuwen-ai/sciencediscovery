// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { CustomMcpServers } from "../mcp/custom-servers.js";
import { canonicalMcpEnvironmentName } from "../mcp/runtime-environment.js";
import type { ConfigurationAdapter } from "./types.js";
import { ConfigurationError, invalid, object, string } from "./validation.js";
export type McpEnvironmentRemovalPort = Pick<CustomMcpServers, "configurationEnvironmentRemoval" | "submitConfigurationEnvironmentRemoval" | "resolveConfigurationMetadata">;
export type McpEnvironmentRemovalSnapshot = ReturnType<McpEnvironmentRemovalPort["configurationEnvironmentRemoval"]>;

export function createMcpEnvironmentRemovalAdapter(port: McpEnvironmentRemovalPort): ConfigurationAdapter {
  return {
    id: "mcp.remove_env", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "external_control",
    normalize: raw => {
      const input = object(raw, ["serverId", "envName"], "values"), result: ConfigurationValues = {};
      if (input.serverId !== undefined) {
        const id = string(input.serverId, "serverId", 100);
        if (!/^custom-[a-f0-9]{12}$/.test(id)) invalid("Choose an existing STDIO custom MCP server", "serverId");
        result.serverId = id;
      }
      if (input.envName !== undefined) {
        const name = string(input.envName, "envName", 256);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) invalid("Choose an existing standard environment variable name", "envName");
        result.envName = canonicalMcpEnvironmentName(name);
      }
      return result;
    },
    target: values => JSON.stringify([String(values.serverId ?? ""), canonicalMcpEnvironmentName(String(values.envName ?? ""))]),
    preview: (input, snapshot) => {
      const source = snapshot.data.mcpMetadata as McpEnvironmentRemovalSnapshot, current = source.current, variable = source.variable;
      if (input.serverId && (!current || !current.variables.length) || input.envName && !variable) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "Choose an existing stored standard variable on a STDIO custom MCP server", 409);
      const effect = variable?.effect === "launcher_default" ? "This name may inherit a launcher default after removal; absence is not guaranteed"
        : variable?.effect === "proxy_policy" ? "Proxy routing remains governed by separate proxy-policy overlays"
        : "The launcher does not inherit this name by default";
      return {
        fields: [{ id: "serverId", label: "Existing STDIO custom MCP server", kind: "enum", required: true, ...(current ? { value: current.id } : {}), choices: source.items.filter(item => item.variables.length).map(item => ({ id: item.id, label: `${item.name} · ${item.transport} · ${item.id}` })) },
          { id: "envName", label: "Saved environment override to remove", kind: "enum", required: Boolean(current), ...(variable ? { value: variable.name } : {}), choices: (current?.variables ?? []).map(item => ({ id: item.name, label: `${item.name} · ${item.aliases} stored name(s)` })) }],
        changes: variable ? [{ field: "envName", before: `${variable.name} · ${variable.aliases} configured name(s); values hidden`, after: "Stored override removed; no replacement value" }] : [],
        impact: { resourceLocation: "Encrypted custom MCP configuration", effectiveScope: `This shared STDIO server's saved override · ${source.caseSensitive ? "case-sensitive POSIX names" : "case-insensitive Windows names"}`,
          message: `Remove only this existing standard variable override, including its Windows case aliases when applicable. ${effect}. Old values are never shown or sent. Command, arguments, working directory, other environment overrides, timeout, enabled state and Session/tool/network permissions stay unchanged. Saving starts, restarts and stops no process and performs no discovery or network request. Existing child processes keep their launch environment. Later ordinary testing/reconnect may replace the process and interrupt old work. Old discovery/tools are invalidated, not certified usable. This is not external secret revocation. A bound original configuration wait may continue normally; no old tool/task is replayed.` },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_invocation",
        disposition: variable ? "change" : "missing_input", ready: Boolean(variable), data: { expectedVersion: source.version },
      };
    },
    externalControl: {
      submit: (operation, context) => port.submitConfigurationEnvironmentRemoval(operation, JSON.stringify([context.input.serverId, context.input.envName]), String(context.plan.data?.expectedVersion)),
      resolve: operation => port.resolveConfigurationMetadata(operation),
    },
  };
}
