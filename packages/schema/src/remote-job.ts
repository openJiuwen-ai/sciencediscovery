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

import type { PermissionDecision } from "./permission.js";

export interface RemoteHostCapabilities {
  conda: boolean;
  containerRuntimes: string[];
  cpuCores: number | null;
  cuda: string | null;
  gpu: string | null;
  memoryBytes: number | null;
  modules: boolean;
  /**
   * Remote `node --version`, used to decide whether the product can deploy its
   * own runner bundle to this host. `null` means no usable Node was found.
   */
  nodeVersion: string | null;
  /** Remote operating system reported by `uname -s`. F1 accepts Linux only. */
  platform: string | null;
  probedAt: string;
  /** Whether the configured pre-installed runner executable is on the remote PATH. */
  runnerCommandAvailable: boolean;
  scratchPaths: string[];
  slurm: boolean;
}

/**
 * How the control plane reaches a remote runner.
 *
 * - `ssh`: the product opens an SSH session to `alias`, deploys the runner when
 *   it is missing, and forwards a loopback port to the remote listener.
 * - `direct`: the user started a runner themselves on another machine; the
 *   product connects to `endpoint` and authenticates with a stored token.
 */
export type RemoteHostConnectionKind = "direct" | "ssh";

export interface RemoteHostEndpoint {
  /** IP address or hostname of a self-deployed runner. */
  host: string;
  port: number;
  protocol: "http" | "https";
}

export interface RemoteHostTarget {
  /**
   * For `ssh` hosts this is what the user typed: an SSH config alias, a
   * hostname, or an IP address — the product does not distinguish them and
   * hands the value to `ssh` as the destination. For `direct` hosts it is the
   * user's label.
   */
  alias: string;
  capabilities?: RemoteHostCapabilities;
  connectionKind: RemoteHostConnectionKind;
  createdAt: string;
  /** Present only for `direct` hosts. */
  endpoint?: RemoteHostEndpoint;
  error?: string;
  /** Whether a connection token is stored for this host; the token itself never leaves the API. */
  hasToken?: boolean;
  id: string;
  /**
   * SSH port. Absent means the destination is resolved by the user's SSH
   * configuration, so an alias keeps whatever `HostName`/`Port` it declares.
   */
  port?: number;
  /** Pre-installed executable or absolute executable path; never a shell expression. */
  runnerCommand: string;
  /** Ephemeral connection state supplied by the API; never persisted. */
  runnerStatus?: RemoteRunnerStatus;
  status: "error" | "ready";
  updatedAt: string;
}

export interface RemoteJobResources {
  cpus: number;
  gpus: number;
  memoryMb: number;
  partition?: string;
  walltimeMinutes: number;
}

export interface RemoteJobOutputSpec {
  disposition: "pull" | "remote";
  path: string;
}

export interface RemoteJobOutputRecord extends RemoteJobOutputSpec {
  localPath?: string;
  size?: number;
  status: "available" | "missing" | "pending" | "remote";
}

export interface RemoteJobCard {
  command: string;
  inputPaths: string[];
  mode: "slurm" | "ssh";
  outputs: RemoteJobOutputSpec[];
  remoteWorkingDirectory: string;
  resources: RemoteJobResources;
  targetAlias: string;
  targetId: string;
  /** SSH port of the target host, when it was registered with an explicit one. */
  targetPort?: number;
}

export interface RemoteJob {
  approvedAt?: string;
  card: RemoteJobCard;
  createdAt: string;
  error?: string;
  finishedAt?: string;
  id: string;
  outputRecords: RemoteJobOutputRecord[];
  permissionAuthorizationId?: string;
  permissionRequestId?: string;
  remoteJobId?: string;
  scriptReference: string;
  sessionId: string;
  startedAt?: string;
  state: "approved" | "awaiting_approval" | "completed" | "denied" | "failed" | "running" | "submitted";
  stderr?: string;
  stdout?: string;
  updatedAt: string;
  version: number;
}

export interface RegisterRemoteHostRequest {
  /** SSH alias, hostname or IP address; or the display label of a self-deployed runner. */
  alias: string;
  connectionKind?: RemoteHostConnectionKind;
  /** Required for `direct`: where the self-deployed runner listens. */
  endpoint?: Partial<RemoteHostEndpoint>;
  /** Optional SSH port; omit to let the user's SSH configuration resolve the destination. */
  port?: number | null;
  runnerCommand?: string;
  /** Required for `direct`: the runner's `SCIENCE_AGENT_RUNNER_TOKEN`. Stored encrypted, never returned. */
  token?: string;
}

export type RemoteRunnerConnectionState = "connecting" | "disconnected" | "error" | "ready";

export interface RemoteRunnerStatus {
  connectedAt?: string;
  /** True when this connection deployed the runner bundle to the remote host. */
  deployed?: boolean;
  error?: string;
  hostId: string;
  localVersion?: string;
  remoteVersion?: string;
  state: RemoteRunnerConnectionState;
  versionMismatch?: boolean;
}

export type RemoteWorkspaceSyncDirection = "pull" | "push";

export interface RemoteWorkspaceSyncRequest {
  conflict?: "overwrite" | "reject";
  direction: RemoteWorkspaceSyncDirection;
  /** Session-workspace-relative files or directories. */
  paths: string[];
}

export interface RemoteWorkspaceSyncRecord {
  bytes: number;
  createdAt: string;
  direction: RemoteWorkspaceSyncDirection;
  error?: string;
  fileCount: number;
  hostId: string;
  id: string;
  paths: string[];
  sessionId: string;
  status: "completed" | "failed";
}

export interface RemoteWorkspaceFile {
  modifiedAt: string;
  path: string;
  size: number;
}

export interface CreateRemoteJobRequest {
  command: string;
  hostId: string;
  inputPaths?: string[];
  mode: "slurm" | "ssh";
  outputs?: RemoteJobOutputSpec[];
  remoteWorkingDirectory: string;
  resources: RemoteJobResources;
}

export interface DecideRemoteJobRequest {
  decision: PermissionDecision;
  expectedVersion: number;
}
