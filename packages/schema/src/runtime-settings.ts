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

import type { ConnectorId } from "./connectors.js";
import type { ExecutionLanguage, KernelMode, KernelSession } from "./environment.js";
import type { NpuJob } from "./npu-job.js";

export type RuntimeSettingsField =
  | "enabledConnectorIds"
  | "enabledSkillIds"
  | "modelId"
  | "reviewModelId"
  | "semanticReviewEnabled"
  | "skillSelectionMode";

export type RuntimeSettingsSource = "global" | "project" | "session" | "unset";

export const SKILL_SELECTION_MODES = ["all", "selected"] as const;

/**
 * `all` exposes every installed skill; `selected` restricts the Session to the
 * `enabledSkillIds` whitelist. Skill selection is configured from the Project
 * layer down — Global defaults never contribute to it.
 */
export type SkillSelectionMode = typeof SKILL_SELECTION_MODES[number];

export const DEFAULT_SKILL_SELECTION_MODE: SkillSelectionMode = "all";

/** Runtime settings fields that only Project and Session layers may set. */
export const SKILL_SELECTION_FIELDS: readonly RuntimeSettingsField[] = ["enabledSkillIds", "skillSelectionMode"];

export function isSkillSelectionMode(value: unknown): value is SkillSelectionMode {
  return SKILL_SELECTION_MODES.includes(value as SkillSelectionMode);
}

export interface RuntimeSettingsOverrides {
  enabledConnectorIds?: ConnectorId[];
  enabledSkillIds?: string[];
  modelId?: string;
  reviewModelId?: string;
  semanticReviewEnabled?: boolean;
  skillSelectionMode?: SkillSelectionMode;
}

export interface EffectiveRuntimeSettings {
  enabledConnectorIds: ConnectorId[];
  /** Resolved skill set: the whole catalog in `all` mode, the whitelist in `selected`. */
  enabledSkillIds: string[];
  modelId?: string;
  reviewModelId?: string;
  semanticReviewEnabled: boolean;
  skillSelectionMode: SkillSelectionMode;
}

export interface ResolvedRuntimeSettings {
  effective: EffectiveRuntimeSettings;
  sources: Record<RuntimeSettingsField, RuntimeSettingsSource>;
}

export interface RuntimeSettingsDetails extends ResolvedRuntimeSettings {
  overrides: RuntimeSettingsOverrides;
}

export const REVIEWER_SPECIALIST_LEVELS = ["quick", "deep"] as const;

export type ReviewerSpecialistLevel = typeof REVIEWER_SPECIALIST_LEVELS[number];

export const DEFAULT_REVIEWER_SPECIALIST_LEVEL: ReviewerSpecialistLevel = "quick";

const REVIEWER_SPECIALIST_LEVEL_RANK: Record<ReviewerSpecialistLevel, number> = {
  quick: 0,
  deep: 1,
};

/** Deep includes the deterministic Quick checks and semantic model review. */
export function reviewerSpecialistSupportsLevel(
  selected: ReviewerSpecialistLevel,
  required: ReviewerSpecialistLevel,
): boolean {
  return REVIEWER_SPECIALIST_LEVEL_RANK[selected] >= REVIEWER_SPECIALIST_LEVEL_RANK[required];
}

export interface ReviewerSpecialistSettings {
  enabled: boolean;
  level: ReviewerSpecialistLevel;
}

export type TimeoutKind =
  | "gateway_idle"
  | "gateway_turn"
  | "kernel_idle"
  | "permission_wait"
  | "runner_exec";

/**
 * Product-level wall-clock timeouts. A value of 0 disables that timeout.
 * Security protocol windows (for example request-signature freshness) are
 * intentionally outside this user-configurable contract.
 */

export interface SystemTimeoutSettings {
  gatewayIdleTimeoutMs: number;
  gatewayTurnTimeoutMs: number;
  kernelIdleTimeoutMs: number;
  permissionWaitTimeoutMs: number;
  runnerExecTimeoutMs: number;
}

export const DEFAULT_SYSTEM_TIMEOUT_SETTINGS: SystemTimeoutSettings = {
  gatewayIdleTimeoutMs: 240_000,
  gatewayTurnTimeoutMs: 0,
  kernelIdleTimeoutMs: 0,
  permissionWaitTimeoutMs: 0,
  runnerExecTimeoutMs: 0,
};

/**
 * Product-level volume quotas. A value of 0 disables that limit
 * (unlimited workspace / upload, or no output truncation).
 */
export interface SystemQuotaSettings {
  /** Combined stdout+stderr retain budget for one execution; 0 disables truncation. */
  runnerMaxOutputBytes: number;
  /**
   * Session workspace total quota for runner execution and upload accumulation.
   * 0 disables the quota.
   */
  runnerMaxWorkspaceBytes: number;
  /** Multipart upload per-file limit; 0 disables the per-file cap. */
  uploadMaxFileBytes: number;
  /** Multipart upload request-body limit; 0 disables the request cap. */
  uploadMaxRequestBytes: number;
}

/** Defaults: 10 GiB workspace, 1 GiB output, 1 GiB upload file, 10 GiB upload request. */
export const DEFAULT_SYSTEM_QUOTA_SETTINGS: SystemQuotaSettings = {
  runnerMaxOutputBytes: 1_073_741_824,
  runnerMaxWorkspaceBytes: 10_737_418_240,
  uploadMaxFileBytes: 1_073_741_824,
  uploadMaxRequestBytes: 10_737_418_240,
};

/**
 * Memory-graph runtime settings. The `enabled` toggle is the single switch
 * (the old `SCIENCE_AGENT_MEMORY_GRAPH_ENABLED` env capability was removed):
 * off → sink writes and reads short-circuit, but the sidecar keeps idling
 * and existing graph data is preserved. `neo4jHttp`/`neo4jUser` are the
 * connection defaults; the password is a write-only store secret (see
 * `MemoryGraphSettingsDetails.hasNeo4jPassword`), never returned in cleartext.
 */
export interface MemoryGraphSettings {
  enabled: boolean;
  neo4jHttp: string;
  neo4jUser: string;
}

export const DEFAULT_MEMORY_GRAPH_SETTINGS: MemoryGraphSettings = {
  enabled: false,
  neo4jHttp: "http://127.0.0.1:7474",
  neo4jUser: "neo4j",
};

/**
 * Memory-graph settings as returned to the UI. Carries the live sidecar
 * health (`memoryGraphStatus`, same values as `/api/health.memoryGraph`:
 * `healthy`/`degraded`/`disabled`/`needs-password`) so the settings editor's
 * status badge needs no independent polling. The password is never sent back
 * — only whether one is set.
 */
export interface MemoryGraphSettingsDetails {
  enabled: boolean;
  neo4jHttp: string;
  neo4jUser: string;
  hasNeo4jPassword: boolean;
  memoryGraphStatus: string;
}

/**
 * Memory-graph settings write payload. Each field is optional and independent
 * — saving the password does NOT flip `enabled`; the user toggles `enabled`
 * explicitly. `neo4jPassword` is write-only: a string sets/replaces it, `null`
 * removes it; omitting the key leaves the stored value untouched.
 */
export interface UpdateMemoryGraphSettingsRequest {
  enabled?: boolean;
  neo4jHttp?: string;
  neo4jUser?: string;
  neo4jPassword?: string | null;
}

export interface RuntimeSessionRun {
  lastActivityAt: string;
  projectId: string;
  runId: string;
  sessionId: string;
  startedAt: string;
  status: "blocked" | "queued" | "running";
  title: string;
}

export interface RunnerExecutionStatus {
  executionId: string;
  kernelMode: KernelMode;
  language: ExecutionLanguage;
  queuedAt: string;
  sessionId: string;
  startedAt?: string;
  status: "queued" | "running";
}

export interface RunnerRuntimeStatus {
  activeExecutions: RunnerExecutionStatus[];
  capturedAt: string;
  kernels: KernelSession[];
  npuJobs: NpuJob[];
  runnerVersion: string;
  status: "ok";
}

export interface RuntimeStatus {
  capturedAt: string;
  runner:
    | RunnerRuntimeStatus
    | {
        activeExecutions: [];
        error: string;
        kernels: [];
        status: "unavailable";
      };
  sessions: RuntimeSessionRun[];
}
