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
  /** Remote operating system reported by `uname -s`. F1 accepts Linux only. */
  platform: string | null;
  probedAt: string;
  /** Whether the configured pre-installed runner executable is on the remote PATH. */
  runnerCommandAvailable: boolean;
  scratchPaths: string[];
  slurm: boolean;
}

export interface RemoteHostTarget {
  alias: string;
  capabilities?: RemoteHostCapabilities;
  createdAt: string;
  error?: string;
  id: string;
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
  alias: string;
  runnerCommand?: string;
}

export type RemoteRunnerConnectionState = "connecting" | "disconnected" | "error" | "ready";

export interface RemoteRunnerStatus {
  connectedAt?: string;
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
