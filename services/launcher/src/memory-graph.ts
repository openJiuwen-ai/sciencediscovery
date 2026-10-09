// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ServeContext } from "./serve.js";
import type { ServiceDefinition } from "./supervisor.js";

/** External services remain operator-owned; old payloads keep working without a sidecar. */
export function planMemoryGraph(context: ServeContext): {
  apiEnv: NodeJS.ProcessEnv;
  service?: ServiceDefinition;
} {
  const { baseEnv, manifest, payloadRoot, settings } = context;
  const disabled = baseEnv.SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE?.trim() === "0";
  const externalUrl = baseEnv.SCIENCE_AGENT_MEMORY_GRAPH_URL?.trim();
  if (disabled || (!externalUrl && !manifest.memoryGraph)) {
    return { apiEnv: { SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0" } };
  }
  if (externalUrl) {
    return { apiEnv: { SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "1" } };
  }
  const port = Number(baseEnv.SCIENCE_AGENT_MEMORY_GRAPH_PORT?.trim() || "17674");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SCIENCE_AGENT_MEMORY_GRAPH_PORT must be an integer between 1 and 65535");
  }
  const token = baseEnv.SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN?.trim() || randomBytes(32).toString("hex");
  const url = `http://127.0.0.1:${port}`;
  const apiEnv = {
    SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "1",
    SCIENCE_AGENT_MEMORY_GRAPH_URL: url,
    SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN: token,
  };
  return {
    apiEnv,
    service: {
      name: "memory graph",
      command: join(payloadRoot, manifest.python.path),
      args: ["-m", "sciencediscovery_memory_graph.server"],
      cwd: join(payloadRoot, manifest.app.root),
      env: {
        ...baseEnv,
        ...apiEnv,
        PYTHONPATH: join(payloadRoot, manifest.memoryGraph!.sitePackages),
        PYTHONNOUSERSITE: "1",
        SCIENCE_AGENT_DATA_DIR: settings.dataDir,
        SCIENCE_AGENT_MEMORY_GRAPH_DATA_DIR: baseEnv.SCIENCE_AGENT_MEMORY_GRAPH_DATA_DIR?.trim()
          || join(settings.dataDir, "memory-graph"),
        SCIENCE_AGENT_MEMORY_GRAPH_HOST: "127.0.0.1",
        SCIENCE_AGENT_MEMORY_GRAPH_PORT: String(port),
        SCIENCE_AGENT_MEMORY_GRAPH_BACKEND: baseEnv.SCIENCE_AGENT_MEMORY_GRAPH_BACKEND?.trim() || "local",
      },
      healthUrl: `${url}/health`,
    },
  };
}

/** Optional sidecar failure must not prevent the conversation services from starting. */
export async function startMemoryGraph(
  supervisor: { start(services: readonly ServiceDefinition[]): Promise<void>; stop(): Promise<void> },
  service: ServiceDefinition,
  apiService: ServiceDefinition,
  log: (message: string) => void,
): Promise<boolean> {
  try {
    await supervisor.start([service]);
    return true;
  } catch (error) {
    await supervisor.stop();
    apiService.env.SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE = "0";
    log(`Memory graph unavailable: ${error instanceof Error ? error.message : String(error)}. `
      + "Continuing without it; fix the sidecar configuration and restart to retry.");
    return false;
  }
}
