// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// Child process for CFG-T31: SIGKILL after a real domain/receipt commit and before activation.
import { createPublicBiomedSources } from "@sciencediscovery/mcp-sources";
import type { McpTransportClient } from "@sciencediscovery/data-source";
import type { McpCatalog } from "@sciencediscovery/schema";
import type { ServerConfig } from "../bootstrap/config.js";
import { createApiServer } from "../http/index.js";
import { ConversationalConfigurationFramework } from "./framework.js";
import { runLog } from "../logging.js";

process.once("message", async (message: { type: "start"; config: ServerConfig; pauseActivation: boolean }) => {
  if (message.type !== "start") throw new Error("Invalid runtime crash fixture start");
  runLog.warn = (event, fields) => { process.send?.({ type: "diagnostic", event, fields }); };
  const actualSettle = ConversationalConfigurationFramework.prototype.settle;
  ConversationalConfigurationFramework.prototype.settle = async function(sessionId, requestId) {
    const record = this.service.getRecord(sessionId, requestId);
    const receipt = this.repository.getReceipt(requestId, record.view.revision);
    if (message.pauseActivation && record.view.choiceReceipt?.kind === "run_overlay" && record.view.state === "applied" && receipt) {
      process.send?.({ type: "committed", requestId: record.view.id, receiptId: receipt.id });
      await new Promise<void>(() => {});
    }
    const result = await actualSettle.call(this, sessionId, requestId);
    if (result.activation.state === "suppressed" || result.activation.state === "failed") {
      const current = this.store.configurationSnapshot(sessionId, record.view.capabilityId, record.target);
      process.send?.({ type: "diagnostic", event: "configuration_recovery_phase", fields: {
        activation: result.activation.state, resumption: result.resumption.state, errorCode: result.error?.code,
        changedResources: Object.keys(current.resourceVersions).filter(key => current.resourceVersions[key] !== receipt?.resourceVersions[key]),
        stopGenerationMatches: current.stopGeneration === record.stopGeneration,
      } });
    }
    return result;
  };
  const manifest = createPublicBiomedSources(["pubmed"])[0]!.manifest;
  const catalog = { loadedAt: "2026-10-19T00:00:00.000Z", revision: "configuration-agent-offline-pubmed",
    servers: [{ enabled: true, id: manifest.transport.mcpServerId, transport: "stdio", tools: Object.values(manifest.tools)
      .map(tool => ({ name: tool.mcpToolName ?? tool.id, description: tool.description, schemaHash: `fixture-${tool.id}`, inputSchema: tool.inputSchema })) }] } as unknown as McpCatalog;
  const mcpTransport: McpTransportClient = { catalog: async () => catalog, reload: async () => catalog,
    invoke: async request => {
      if (request.toolName !== "pubmed_search") throw new Error("Unexpected crash fixture MCP call");
      process.send?.({ type: "invocation", toolCallId: request.context.toolCallId });
      return { requestId: request.requestId, serverId: request.serverId, toolName: request.toolName, durationMs: 1, isError: false, attempts: [],
        content: [{ type: "json", value: { attribution: "Offline fixture", license: "Fixture data", records: [], retrievedAt: "2026-10-19T00:00:00.000Z", sourceId: "pubmed", toolId: "search", untrusted: true, warnings: [] } }] };
    } };
  const server = createApiServer(message.config, { mcpTransport });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Runtime crash fixture requires a TCP address");
    process.send?.({ type: "ready", origin: `http://127.0.0.1:${address.port}` });
  });
});
