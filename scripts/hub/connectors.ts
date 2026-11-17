// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createBuiltinMcpSourceRegistry } from "../../packages/mcp-sources/src/index.js";

import type { ConnectorAsset, ConnectorTool } from "./types.js";

export interface CollectedConnector {
  asset: ConnectorAsset;
  json: Uint8Array;
}

interface LaunchConfig {
  args?: string[];
  command?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  tool_call_timeout?: number;
  type?: string;
  url?: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function launchConfigs(extensionsConfig: unknown): Record<string, LaunchConfig> {
  if (!extensionsConfig || typeof extensionsConfig !== "object") return {};
  const servers = (extensionsConfig as { mcpServers?: unknown }).mcpServers;
  return servers && typeof servers === "object" ? servers as Record<string, LaunchConfig> : {};
}

function displayConfig(launch: LaunchConfig | undefined): Record<string, unknown> {
  return {
    args: launch?.args ?? [],
    authMode: "headers",
    command: launch?.command ?? "",
    cwd: "",
    // Only the key names are shown; values are environment placeholders.
    env: Object.keys(launch?.env ?? {}),
    headers: Object.keys(launch?.headers ?? {}),
    timeoutSeconds: launch?.tool_call_timeout ?? 60,
    transport: launch?.type ?? "stdio",
    url: launch?.url ?? "",
  };
}

/** The download is the launch block alone: it pastes straight into the import dialog. */
function importFile(name: string, launch: LaunchConfig | undefined): Record<string, unknown> {
  return {
    mcpServers: {
      [name]: {
        ...(launch?.env ? { env: launch.env } : {}),
        ...(launch?.args ? { args: launch.args } : {}),
        ...(launch?.command ? { command: launch.command } : {}),
        ...(launch?.headers ? { headers: launch.headers } : {}),
        ...(launch?.type ? { type: launch.type } : {}),
        ...(launch?.url ? { url: launch.url } : {}),
        timeoutSeconds: launch?.tool_call_timeout ?? 60,
      },
    },
  };
}

export async function collectConnectors(input: {
  functions: Record<string, string>;
  repoRoot: string;
}): Promise<CollectedConnector[]> {
  const extensions = JSON.parse(await readFile(path.join(input.repoRoot, "extensions_config.json"), "utf8")) as unknown;
  const launches = launchConfigs(extensions);
  const registry = createBuiltinMcpSourceRegistry();

  return registry.listManifests()
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map((manifest) => {
      const functionGroup = input.functions[manifest.id];
      if (!functionGroup) throw new Error(`Connector ${manifest.id} has no entry in scripts/hub/connector-functions.json`);
      const launch = launches[manifest.transport.mcpServerId];
      if (!launch) throw new Error(`Connector ${manifest.id} has no launch config for ${manifest.transport.mcpServerId}`);
      const tools: ConnectorTool[] = Object.values(manifest.tools)
        .toSorted((left, right) => left.id.localeCompare(right.id))
        .map((tool) => ({
          description: tool.description,
          displayName: tool.displayName,
          id: tool.id,
          kind: tool.kind,
          permission: tool.permission.action,
        }));
      const json = Buffer.from(`${JSON.stringify(importFile(manifest.displayName, launch), null, 2)}\n`, "utf8");
      const asset: ConnectorAsset = {
        author: null,
        category: { function: functionGroup },
        config: displayConfig(launch),
        description: manifest.description,
        download: { sha256: sha256(json), size: json.byteLength, url: `connectors/${manifest.id}.json` },
        governance: {
          attribution: manifest.governance.attribution,
          ...(manifest.governance.commercialUseConstraints
            ? { commercialUseConstraints: manifest.governance.commercialUseConstraints }
            : {}),
          dataClassification: manifest.governance.dataClassification,
          license: manifest.governance.license,
          maxResponseBytes: manifest.governance.maxResponseBytes,
          networkHosts: manifest.governance.networkHosts,
          termsUrl: manifest.governance.termsUrl,
        },
        id: manifest.id,
        kind: "connector",
        kinds: [...manifest.kinds],
        name: manifest.displayName,
        publisher: manifest.publisher,
        source: "builtin",
        tags: [],
        toolCount: tools.length,
        tools,
        version: manifest.version,
      };
      return { asset, json };
    });
}
