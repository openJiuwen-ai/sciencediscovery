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

import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_SYSTEM_QUOTA_SETTINGS, DEFAULT_SYSTEM_TIMEOUT_SETTINGS } from "@sciencediscovery/schema";

import {
  DEFAULT_AGENT_IDLE_TIMEOUT_MS as DEFAULT_GATEWAY_IDLE_TIMEOUT_MS,
  DEFAULT_AGENT_TURN_TIMEOUT_MS as DEFAULT_GATEWAY_TURN_TIMEOUT_MS,
} from "../native-agent/index.js";
import {
  AUTH_TOKEN_FILE,
  resolveBootstrapToken,
  type BootstrapTokenSource,
} from "../http/bootstrap-tokens.js";
import {
  DEFAULT_WORKSPACE_MAX_BYTES,
  DEFAULT_WORKSPACE_UPLOAD_MAX_FILE_BYTES,
  DEFAULT_WORKSPACE_UPLOAD_MAX_REQUEST_BYTES,
  type WorkspaceUploadLimits,
} from "../workspace-upload.js";

export interface ServerConfig {
  authToken: string;
  /** How `authToken` was obtained; startup output only echoes a managed token. */
  authTokenSource?: BootstrapTokenSource;
  dataDir: string;
  host: string;
  paperPythonPath: string;
  paperWorkerPath: string;
  port: number;
  runnerToken: string;
  runnerUrl: string;
  sshConfigPath: string;
  staticDir: string;
  /**
   * Agent-loop timeouts. The `gateway` prefix is the settled name of the
   * environment variables and persisted settings, kept for compatibility; the
   * loop they bound runs inside this process.
   */
  /** Maximum time without model-stream progress before the run is stalled. */
  gatewayIdleTimeoutMs: number;
  /** Hard upper bound for a complete agent turn. */
  gatewayTurnTimeoutMs: number;
  /** Initial Runner execution timeout; persisted settings override after first load. */
  runnerExecTimeoutMs: number;
  /** Initial persistent-kernel idle timeout. */
  kernelIdleTimeoutMs: number;
  /** Initial permission-decision wait timeout. */
  permissionWaitTimeoutMs: number;
  /** Initial runner workspace total quota; persisted settings override after first load. */
  runnerMaxWorkspaceBytes: number;
  /** Initial runner output retain budget; persisted settings override after first load. */
  runnerMaxOutputBytes: number;
  /** URL the gateway's proxy tools call back into to run Node tool handlers. */
  /** Multipart upload and Session workspace quotas. */
  workspaceUpload: WorkspaceUploadLimits;
  /** Memory-graph sidecar (services/memory-graph, Python FastAPI, loopback).
   *  The on/off switch lives in the store (System Settings → Memory graph),
   *  not in env, so there is no `enabled` here. `neo4jPassword` is read from
   *  `.env` only as a one-time first-boot seed for the encrypted store; the
   *  runtime reads the store (set via the UI). */
  memoryGraph: {
    url: string;
    internalToken: string;
    neo4jPassword?: string;
  };
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(moduleDirectory, "../../../..");

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // Keep the single-user control plane local unless deployment explicitly opts in.
  const host = env.SCIENCE_AGENT_HOST?.trim() || "127.0.0.1";
  const rawPort = env.SCIENCE_AGENT_PORT?.trim() || "4310";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("SCIENCE_AGENT_PORT must be an integer between 0 and 65535");
  }
  const parseTimeoutMilliseconds = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer number of milliseconds`);
    }
    return value;
  };
  const gatewayIdleTimeoutMs = parseTimeoutMilliseconds(
    "SCIENCE_AGENT_GATEWAY_IDLE_TIMEOUT_MS",
    DEFAULT_GATEWAY_IDLE_TIMEOUT_MS,
  );
  const gatewayTurnTimeoutMs = parseTimeoutMilliseconds(
    "SCIENCE_AGENT_GATEWAY_TURN_TIMEOUT_MS",
    DEFAULT_GATEWAY_TURN_TIMEOUT_MS,
  );
  if (gatewayTurnTimeoutMs > 0 && gatewayIdleTimeoutMs > 0 && gatewayTurnTimeoutMs < gatewayIdleTimeoutMs) {
    throw new Error(
      "SCIENCE_AGENT_GATEWAY_TURN_TIMEOUT_MS must be greater than or equal to "
      + "SCIENCE_AGENT_GATEWAY_IDLE_TIMEOUT_MS when both timeouts are finite",
    );
  }
  const runnerExecTimeoutMs = parseTimeoutMilliseconds(
    "SCIENCE_AGENT_EXEC_TIMEOUT_MS",
    DEFAULT_SYSTEM_TIMEOUT_SETTINGS.runnerExecTimeoutMs,
  );
  const kernelIdleTimeoutMs = parseTimeoutMilliseconds(
    "SCIENCE_AGENT_KERNEL_IDLE_MS",
    DEFAULT_SYSTEM_TIMEOUT_SETTINGS.kernelIdleTimeoutMs,
  );
  const permissionWaitTimeoutMs = parseTimeoutMilliseconds(
    "SCIENCE_AGENT_PERMISSION_WAIT_TIMEOUT_MS",
    DEFAULT_SYSTEM_TIMEOUT_SETTINGS.permissionWaitTimeoutMs,
  );
  const parseByteLimit = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer number of bytes`);
    }
    return value;
  };
  const runnerMaxWorkspaceBytes = parseByteLimit(
    "SCIENCE_AGENT_MAX_WORKSPACE_BYTES",
    DEFAULT_SYSTEM_QUOTA_SETTINGS.runnerMaxWorkspaceBytes,
  );
  const runnerMaxOutputBytes = parseByteLimit(
    "SCIENCE_AGENT_MAX_OUTPUT_BYTES",
    DEFAULT_SYSTEM_QUOTA_SETTINGS.runnerMaxOutputBytes,
  );
  const dataDir = resolve(repositoryRoot, env.SCIENCE_AGENT_DATA_DIR?.trim() || ".sciencediscovery-data");
  // No fixed default credentials: an unset variable means "use the token this
  // installation generated on its first start", never a value an attacker could
  // guess from the source tree.
  const authToken = resolveBootstrapToken(dataDir, AUTH_TOKEN_FILE, env.SCIENCE_AGENT_AUTH_TOKEN);
  return {
    authToken: authToken.token,
    authTokenSource: authToken.source,
    dataDir,
    gatewayIdleTimeoutMs,
    gatewayTurnTimeoutMs,
    host,
    kernelIdleTimeoutMs,
    paperPythonPath: env.SCIENCE_AGENT_PAPER_PYTHON_PATH?.trim()
      ? resolve(repositoryRoot, env.SCIENCE_AGENT_PAPER_PYTHON_PATH.trim())
      : resolve(dataDir, "envs/paper/bin/python"),
    paperWorkerPath: resolve(repositoryRoot, env.SCIENCE_AGENT_PAPER_WORKER_PATH?.trim() || "services/paper/paper_worker.py"),
    port,
    permissionWaitTimeoutMs,
    runnerExecTimeoutMs,
    runnerMaxOutputBytes,
    runnerMaxWorkspaceBytes,
    runnerToken: env.SCIENCE_AGENT_RUNNER_TOKEN?.trim() || "sciencediscovery-runner-local",
    runnerUrl: env.SCIENCE_AGENT_RUNNER_URL?.trim().replace(/\/$/, "") || "http://127.0.0.1:4311",
    sshConfigPath: resolve(env.SCIENCE_AGENT_SSH_CONFIG_PATH?.trim() || resolve(homedir(), ".ssh/config")),
    staticDir: resolve(repositoryRoot, env.SCIENCE_AGENT_WEB_DIR?.trim() || "apps/web/dist"),
    workspaceUpload: {
      maxFileBytes: parseByteLimit(
        "SCIENCE_AGENT_WORKSPACE_UPLOAD_MAX_FILE_BYTES",
        DEFAULT_WORKSPACE_UPLOAD_MAX_FILE_BYTES,
      ),
      maxRequestBytes: parseByteLimit(
        "SCIENCE_AGENT_WORKSPACE_UPLOAD_MAX_REQUEST_BYTES",
        DEFAULT_WORKSPACE_UPLOAD_MAX_REQUEST_BYTES,
      ),
      maxWorkspaceBytes: parseByteLimit(
        "SCIENCE_AGENT_WORKSPACE_MAX_BYTES",
        DEFAULT_WORKSPACE_MAX_BYTES,
      ),
    },
    memoryGraph: {
      url: env.SCIENCE_AGENT_MEMORY_GRAPH_URL?.trim().replace(/\/$/, "") || "http://127.0.0.1:17674",
      internalToken: env.SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN?.trim() || "sciencediscovery-memory-graph-local",
      neo4jPassword: env.SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_PASSWORD?.trim() || undefined,
    },
  };
}
