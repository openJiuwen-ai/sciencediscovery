// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { PluginManifest } from "@sciencediscovery/plugin-sdk";
/** Shared connector contract; each source gets its own manifest and configuration. */
export function connectorManifest(sourceId: string): PluginManifest {
  return {
    id: `connector.${sourceId}`, version: "0.1.0", apiVersion: 1,
    entries: { platform: "./plugin" },
    capabilities: ["connector", "settings"], contributes: ["connector", "settings"],
    services: { requires: [{ id: "mcp.sources", version: 1 }] },
    permissions: ["connector.register"],
    configuration: { schemaVersion: 1, scopes: ["global", "project", "session"], applies: "nextRun",
      fields: {}, defaults: {} },
  };
}
