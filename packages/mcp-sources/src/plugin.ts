// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createLlmWikiSource, createPublicBiomedSources, PUBLIC_BIOMED_SOURCE_DEFINITIONS } from "./index.js";
import type { PluginDefinition } from "@sciencediscovery/plugin-sdk";
import { uniprotPlugin } from "./uniprot-plugin.js";
import { connectorManifest } from "./manifest.js";
import type { McpSourceAdapter } from "@sciencediscovery/schema";

export interface ConnectorContribution {
  sources: McpSourceAdapter[];
  diagnostics?: readonly { pluginId: string; code: string }[];
}

/** Trusted installation entries; each source has its own identity and activation. */
export const builtinMcpSourcePlugins: readonly PluginDefinition<ConnectorContribution>[] = [
  uniprotPlugin,
  {
    manifest: connectorManifest("llm-wiki"),
    create() {
      try { return { contribution: { sources: [createLlmWikiSource()] } }; }
      catch {
        // Preserve optional Wiki startup isolation without leaking its configured URL.
        return { contribution: { sources: [], diagnostics: [{ pluginId: "connector.llm-wiki", code: "invalid_configuration" }] } };
      }
    },
  },
  ...PUBLIC_BIOMED_SOURCE_DEFINITIONS.map((definition): PluginDefinition<ConnectorContribution> => ({
    manifest: connectorManifest(definition.id),
    create: () => ({ contribution: { sources: createPublicBiomedSources([definition.id]) } }),
  })),
];

export const builtinMcpSourceManifests = builtinMcpSourcePlugins.map((plugin) => plugin.manifest);
export { filterEnabledMcpSources } from "./index.js";
