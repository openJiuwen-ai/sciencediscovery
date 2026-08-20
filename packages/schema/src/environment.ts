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

import { externalUrl, externalUrlList } from "@science-agent/external-urls";

import type { ScientificArtifactKind } from "./artifact-provenance.js";
import type { NpuBrokerCapability } from "./npu-job.js";
import type { PermissionEpoch } from "./permission.js";
import type { SandboxNetworkMode } from "./sandbox-network.js";
import type { CasObjectRef } from "./provenance.js";

export type ScientificLanguage = "python" | "r";

export const DEFAULT_ENVIRONMENT_REVISION_ID = "system-python3-bwrap-v1";

export type ExecutionLanguage = ScientificLanguage | "shell";

export type EnvironmentKind = "starter" | "task";

export type KernelMode = "ephemeral" | "persistent";

export interface Environment {
  createdAt: string;
  currentRevisionId: string;
  id: string;
  kind: EnvironmentKind;
  language: ScientificLanguage;
  name: string;
  updatedAt: string;
}

export interface EnvironmentRevision {
  channels: string[];
  createdAt: string;
  environmentId: string;
  id: string;
  language: ExecutionLanguage;
  languageVersion: string;
  /** Local wheel inputs retained by content hash for revision-level audit. */
  localWheels?: EnvironmentLocalWheel[];
  packages: string[];
  packageSpecHash: string;
  platform: string;
  provisioner: string;
  runnerVersion: string;
  snapshot: CasObjectRef;
}

export interface EnvironmentLocalWheel {
  content: CasObjectRef;
  distribution?: string;
  filename: string;
  manager: "pip";
  sourcePath: string;
  version?: string;
}

export interface KernelSession {
  /** Stable Agent identity within the owning Session (`main` or `subagent:<id>`). */
  agentId: string;
  createdAt: string;
  environmentRevisionId: string;
  /** Omitted while the kernel idle timeout is unlimited. */
  expiresAt?: string;
  id: string;
  kernelMode: "persistent";
  /** `shell` sessions are persistent shell workers; python/r are language kernels. */
  language: ExecutionLanguage;
  lastUsedAt: string;
  memoryLostReason?: string;
  permissionEpochId: string;
  sessionId: string;
  status: "running" | "stopped";
}

export interface ScientificExecutionRequest {
  /** Stable Agent identity within the Session; assigned by the trusted API binding. */
  agentId: string;
  code: string;
  environmentRevisionId?: string;
  /** Per-run product timeout snapshot; 0 disables the timeout. */
  executionTimeoutMs?: number;
  executionId: string;
  /** Product idle timeout for a persistent kernel; 0 disables it. */
  kernelIdleTimeoutMs?: number;
  kernelMode?: KernelMode;
  language?: ScientificLanguage;
  /** Per-run retained stdout+stderr budget; 0 disables truncation. */
  maxOutputBytes?: number;
  /** Per-run workspace total quota; 0 disables the quota. */
  maxWorkspaceBytes?: number;
  permissionEpoch: PermissionEpoch;
  /** Optional parent workspace mounted read-only for isolated subagents. */
  readOnlyWorkspaceRoot?: string;
  workspaceRoot: string;
}

/** One artifact a scientific execution produced, surfaced back to the LLM. */
export interface ProducedArtifactInfo {
  /** The logical ScientificArtifact id (the graph's Artifact node key). */
  artifactId: string;
  kind: ScientificArtifactKind;
  path: string;
  version: number;
  /** Artifact versions this Code run read as inputs, carried to memory graph
   * `input` edges as composite artifact/version keys. */
  inputArtifactVersions?: Array<{ artifactId: string; version: number }>;
}

export interface ScientificExecutionResult {
  /** Always `none`: isolation is bubblewrap + seccomp; no resource quotas are applied. */
  cgroupMode: "none" | "direct-v2";
  createdFiles: string[];
  environmentRevisionId: string;
  /**
   * Effective process environment of this execution. Ephemeral runs report the
   * exact variables injected after `--clearenv`; persistent kernels and shell
   * sessions report the environment observed inside the sandbox after the
   * evaluation finished.
   */
  environmentVariables: Record<string, string>;
  executionId: string;
  exitCode: number;
  finishedAt: string;
  kernelId: string;
  kernelMode: KernelMode;
  language: ScientificLanguage;
  memoryStateLost?: string;
  modifiedFiles: string[];
  /** Sandbox network mode this execution actually ran under. */
  networkPolicy: SandboxNetworkMode;
  /** Revision of the sandbox network policy snapshot this execution ran under. */
  networkAccessRevision?: string;
  /**
   * Artifacts the provenance recorder registered for this execution. Lets
   * the LLM pass an `artifact_id` to `declare_claim` (the report Artifact that
   * presents the Claim) without a separate lookup. Absent on runner results
   * that predate the backflow and on failures that wrote no artifacts.
   */
  producedArtifacts?: ProducedArtifactInfo[];
  runnerVersion: string;
  sandbox: "bubblewrap";
  startedAt: string;
  stderr: string;
  stdout: string;
  /**
   * Sandbox-internal working directory of this execution (e.g. `/workspace` or
   * `/workspace/subdir`). Ephemeral runs report the launch directory; persistent
   * shell sessions report the directory in effect after the evaluation.
   */
  workingDirectory: string;
}

export const SYSTEM_SHELL_ENVIRONMENT_REVISION_ID = "system-shell-bwrap-v1";

export interface ShellExecutionRequest {
  /** Stable Agent identity within the Session; assigned by the trusted API binding. */
  agentId: string;
  code: string;
  /** Per-run product timeout snapshot; 0 disables the timeout. */
  executionTimeoutMs?: number;
  executionId: string;
  /** Product idle timeout for a persistent shell session; 0 disables it. */
  kernelIdleTimeoutMs?: number;
  /** `persistent` reuses one shell session per Session-Agent (cwd/exports survive). */
  kernelMode?: KernelMode;
  /** Per-run retained stdout+stderr budget; 0 disables truncation. */
  maxOutputBytes?: number;
  /** Per-run workspace total quota; 0 disables the quota. */
  maxWorkspaceBytes?: number;
  permissionEpoch: PermissionEpoch;
  /** Optional parent workspace mounted read-only for isolated subagents. */
  readOnlyWorkspaceRoot?: string;
  workspaceRoot: string;
}

export interface ShellExecutionResult extends Omit<ScientificExecutionResult, "environmentRevisionId" | "language"> {
  environmentRevisionId: typeof SYSTEM_SHELL_ENVIRONMENT_REVISION_ID;
  language: "shell";
}

/** Compatibility aliases for callers that only support the original Python tool. */

export type PythonExecutionRequest = ScientificExecutionRequest;

export type PythonExecutionResult = ScientificExecutionResult;

export interface CreateEnvironmentRequest {
  baseEnvironmentId?: string;
  language: ScientificLanguage;
  name: string;
}

export interface InstallEnvironmentRequest {
  channels?: string[];
  /** HTTPS pip package index for this installation. Valid only with manager=pip. */
  indexUrl?: string;
  manager?: EnvironmentPackageManager;
  packages: string[];
}

export interface UninstallEnvironmentRequest {
  packages: string[];
}

export type EnvironmentPackageManager = "bioconductor" | "conda" | "cran" | "pip";

export const ENVIRONMENT_PACKAGE_SOURCE_PRESETS = [
  {
    condaChannels: ["conda-forge"],
    id: "upstream",
    label: "Official upstream",
    pipIndexUrl: externalUrl("package_indexes.pypi_simple"),
  },
  {
    condaChannels: [...externalUrlList("package_source_presets.tsinghua.conda_channels")],
    id: "tsinghua",
    label: "Tsinghua TUNA",
    pipIndexUrl: externalUrl("package_source_presets.tsinghua.pip_index"),
  },
  {
    condaChannels: [...externalUrlList("package_source_presets.ustc.conda_channels")],
    id: "ustc",
    label: "USTC",
    pipIndexUrl: externalUrl("package_source_presets.ustc.pip_index"),
  },
  {
    condaChannels: [...externalUrlList("package_source_presets.huawei.conda_channels")],
    id: "huawei",
    label: "Huawei Cloud",
    pipIndexUrl: externalUrl("package_source_presets.huawei.pip_index"),
  },
] as const;

export type EnvironmentPackageSourceId = typeof ENVIRONMENT_PACKAGE_SOURCE_PRESETS[number]["id"];

export type EnvironmentPipSourceId = EnvironmentPackageSourceId;

export type EnvironmentCondaSourceId = Exclude<EnvironmentPackageSourceId, "huawei">;

type EnvironmentPackageSourcePresetEntry = typeof ENVIRONMENT_PACKAGE_SOURCE_PRESETS[number];

export const ENVIRONMENT_PIP_SOURCE_PRESETS = ENVIRONMENT_PACKAGE_SOURCE_PRESETS;

export const ENVIRONMENT_CONDA_SOURCE_PRESETS = ENVIRONMENT_PACKAGE_SOURCE_PRESETS.filter(
  (preset): preset is Exclude<EnvironmentPackageSourcePresetEntry, { id: "huawei" }> => preset.id !== "huawei",
);

export interface EnvironmentPackageSourcePreset {
  condaChannels: readonly string[];
  id: EnvironmentPackageSourceId;
  label: string;
  pipIndexUrl: string;
}

export interface EnvironmentSourceSettings {
  condaSource: EnvironmentCondaSourceId;
  pipSource: EnvironmentPipSourceId;
}

export type UpdateEnvironmentSourceSettingsRequest = Partial<EnvironmentSourceSettings>;

export const DEFAULT_ENVIRONMENT_SOURCE_SETTINGS: EnvironmentSourceSettings = {
  condaSource: "upstream",
  pipSource: "upstream",
};

export function environmentPackageSourcePreset(id: EnvironmentPackageSourceId): EnvironmentPackageSourcePreset {
  return ENVIRONMENT_PACKAGE_SOURCE_PRESETS.find((preset) => preset.id === id)!;
}

/**
 * Normalize a pip index passed as one argv value. Credentials and URL suffixes
 * are rejected so error output and revision metadata do not retain secrets.
 */
export function normalizePipIndexUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("pip indexUrl cannot be empty");
  if (raw.length > 2_048) throw new Error("pip indexUrl is too long");
  if (/\s|[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new Error("pip indexUrl cannot contain whitespace or control characters");
  }
  type ParsedUrl = {
    hash: string;
    hostname: string;
    password: string;
    protocol: string;
    search: string;
    toString(): string;
    username: string;
  };
  const UrlConstructor = (globalThis as unknown as {
    URL: new (input: string) => ParsedUrl;
  }).URL;
  let parsed: ParsedUrl;
  try {
    parsed = new UrlConstructor(raw);
  } catch {
    throw new Error("pip indexUrl must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new Error("pip indexUrl must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("pip indexUrl cannot contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("pip indexUrl cannot contain a query or fragment");
  }
  return parsed.toString().replace(/\/$/u, "");
}

export interface EnvironmentInstallStatus {
  environment: Environment;
  revision: EnvironmentRevision;
  status: "succeeded";
}

export type ScientificEnvironmentSetupState = "disabled" | "failed" | "installing" | "not-configured" | "ready";

export type ScientificEnvironmentSetupPhase =
  | "checking"
  | "complete"
  | "creating-python-base"
  | "disabled"
  | "downloading-provisioner"
  | "failed"
  | "pending"
  | "verifying-python-base";

export interface ScientificEnvironmentSetup {
  allowedChannels: string[];
  completedAt: string | null;
  error: string | null;
  /** Compatibility alias for clients that predate the structured progress fields. */
  lastError?: string;
  managedProvisioner: boolean;
  message: string;
  networkPolicy: "allowed-channels" | "offline-cache";
  phase: ScientificEnvironmentSetupPhase;
  provisioner: string | null;
  provisionerVersion: string | null;
  startedAt: string | null;
  starterPackages: Record<ScientificLanguage, string[]>;
  state: ScientificEnvironmentSetupState;
  updatedAt: string;
}

export interface SetupScientificEnvironmentsRequest {
  confirmed: boolean;
}

export interface ScientificEnvsCapability {
  available: boolean;
  enabled: boolean;
  languages: ScientificLanguage[];
  provisioner: string | null;
  startersReady: boolean;
  unavailableReason?: string;
}

/**
 * Runner-side readiness of sandbox network access. `domain-allowlist` needs an
 * egress bridge interpreter on the host; when it is missing the runner reports
 * why here and fails such executions instead of running them unfiltered.
 */
export interface SandboxNetworkCapability {
  available: boolean;
  modes: SandboxNetworkMode[];
  unavailableReason?: string;
}

export interface RunnerHealth {
  /** Always false: the runner no longer manages a cgroup v2 subtree. */
  cgroupDelegated: false;
  cgroupMode: "none";
  /** Empty: no cgroup root is used. */
  cgroupRoot: string;
  executionAuth: "bearer+hmac-sha256";
  executionUser: string;
  /** Wall-clock limit applied to every execution. */
  executionTimeoutMs: number;
  /**
   * Per-file execution quota. Always `0` because there is no per-file limit.
   * Upload limits live on API `/health.workspace.maxFileBytes`.
   */
  maxFileBytes: number;
  /** Retained stdout+stderr budget for executions; `0` disables truncation. */
  maxOutputBytes: number;
  /** Workspace total quota; `0` means unlimited. */
  maxWorkspaceBytes: number;
  /**
   * Default sandbox network mode: an execution only leaves this mode when its
   * Permission Epoch carries a `domain-allowlist` policy snapshot.
   */
  networkPolicy: "none";
  noNewPrivileges: true;
  npuBroker: NpuBrokerCapability;
  runnerVersion: string;
  sandbox: "bubblewrap";
  /** Whether this runner can serve `domain-allowlist` executions at all. */
  sandboxNetwork: SandboxNetworkCapability;
  scientificEnvs: ScientificEnvsCapability;
  seccompBaseline: "multiarch-v1-profile-aware";
  status: "ok";
  /** `null` means no global cap; positive numbers are retained for older Runner compatibility. */
  workerConcurrency: number | null;
}
