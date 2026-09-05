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

/** Shared by capability presentation, authorization and SSH deployment. */
export function supportsRemoteRunnerNode(version: string | null | undefined): boolean {
  const major = Number(/^v(\d+)\./.exec(version ?? "")?.[1]);
  return Number.isSafeInteger(major) && major >= 22;
}

export interface RemoteHostCapabilities {
  conda: boolean;
  containerRuntimes: string[];
  cpuCores: number | null;
  cuda: string | null;
  gpu: string | null;
  memoryBytes: number | null;
  modules: boolean;
  /** Informational only: automatic SEA deployment brings its own Node runtime. */
  nodeVersion: string | null;
  architecture?: string | null;
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

/** A host key the user accepted, in the form OpenSSH prints. */
export interface TrustedRemoteHostKey {
  /** Key type as announced on the wire, for example `ssh-ed25519`. */
  algorithm: string;
  /** `SHA256:<base64>` over the public key blob. */
  fingerprint: string;
  trustedAt: string;
}

/**
 * A host key as the settings page sees it: the one currently trusted, or the
 * one a machine just presented while it is not trusted yet.
 */
export interface RemoteHostKeyState {
  algorithm: string;
  fingerprint: string;
  trusted?: boolean;
}

/** What the settings page needs to offer "trust this machine and continue". */
export interface RemoteHostKeyChallenge {
  algorithm: string;
  /** True when this machine was already trusted under a different key. */
  changed: boolean;
  fingerprint: string;
}

export interface RemoteHostEndpoint {
  /** IP address or hostname of a self-deployed runner. */
  host: string;
  port: number;
  protocol: "http" | "https";
}

export interface RemoteHostTarget {
  /** Stable execution environment name and purpose, independent of its SSH address. */
  runnerName?: string;
  description?: string;
  /** New environments isolate their workspace by runner ID; older ones retain their paths. */
  workspaceNamespace?: string;
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
   * Address actually connected to, when it differs from the name the user typed.
   * Set by importing an `ssh_config` entry whose `HostName` is not the Host name.
   */
  hostName?: string;
  /** SSH port; absent means the default 22. */
  port?: number;
  /** Whether a login password is stored for this machine; the value never leaves the API. */
  hasPassword?: boolean;
  /** Whether a private key is stored for this machine; the key never leaves the API. */
  hasPrivateKey?: boolean;
  /**
   * One-line OpenSSH public key of the stored private key, for the user to
   * install on the remote machine. Only ever the public half.
   */
  publicKey?: string;
  /**
   * Host key the user accepted for this machine, kept in the product's own data
   * rather than the user's `known_hosts`. Without it no connection is made.
   */
  trustedHostKey?: TrustedRemoteHostKey;
  /**
   * Response-only view of this machine's key: the trusted one, or the key it
   * just presented with `trusted: false` when it is not accepted yet.
   */
  hostKey?: RemoteHostKeyState;
  /** Login user for `ssh` machines. */
  username?: string;
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
  /** Existing runner ID for an explicit update; absent creates a named environment. */
  id?: string;
  runnerName?: string;
  description?: string;
  /** SSH alias, hostname or IP address; or the display label of a self-deployed runner. */
  alias: string;
  connectionKind?: RemoteHostConnectionKind;
  /** Required for `direct`: where the self-deployed runner listens. */
  endpoint?: Partial<RemoteHostEndpoint>;
  /** Optional SSH port; omit for the default 22. */
  port?: number | null;
  runnerCommand?: string;
  /** Required for `direct`: the runner's `SCIENCE_AGENT_RUNNER_TOKEN`. Stored encrypted, never returned. */
  token?: string;
  /** Login user for `ssh` machines. */
  username?: string;
  /** Login password; stored encrypted and never returned. Send `null` to forget it. */
  password?: string | null;
  /** Passphrase for an encrypted private key; stored encrypted and never returned. */
  passphrase?: string | null;
  /**
   * Read this private key file on the API host and store its contents.
   *
   * Key material is never submitted through the browser: either the user points
   * at a key file this host can read, or the product generates a pair for the
   * machine. Send `null` to forget the stored key.
   */
  privateKeyPath?: string | null;
  /** Accept this host key as part of the same call, so "trust and continue" is one retry. */
  trustHostKey?: { algorithm: string; fingerprint: string };
}

/** What an `ssh_config` `Host` entry offers to prefill a registration with. */
export interface SshConfigHostImport {
  alias: string;
  hostName?: string;
  identityFile?: string;
  /** Whether the API could read `identityFile`; otherwise choose another key file. */
  identityKeyReadable: boolean;
  port?: number;
  username?: string;
}

/** Metadata only: browsing never returns or validates private key contents. */
export interface SshKeyFileListing {
  directory: string;
  parentDirectory: string | null;
  entries: Array<{ name: string; path: string; kind: "directory" | "file" | "unavailable" }>;
  nextOffset: number | null;
}

export type RemoteRunnerConnectionState = "connecting" | "disconnected" | "error" | "ready";

/** Point-in-time host readings, not workspace quotas or recursive directory sizes. */
export interface RunnerResources {
  capturedAt: string;
  cpuCores: number;
  loadAverage1m: number;
  memoryTotalBytes: number;
  memoryFreeBytes: number;
  uptimeSeconds: number;
  workspaceDisk: {
    path: string;
    totalBytes: number;
    availableBytes: number;
  } | null;
  workspaceDiskError?: string;
}

export interface RemoteRunnerStatus {
  resources?: RunnerResources;
  resourcesError?: string;
  connectedAt?: string;
  /** Set when the connection failed because the machine's key is not trusted yet. */
  hostKeyChallenge?: RemoteHostKeyChallenge;
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
  /** Owner of a child workspace, absent for the main Agent. */
  agentId?: string;
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
