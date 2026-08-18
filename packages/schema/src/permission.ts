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

import type { ApprovalMode } from "./plan.js";
import { NO_SANDBOX_NETWORK_ACCESS, type SandboxNetworkAccess, type SandboxNetworkMode } from "./sandbox-network.js";

export interface PermissionMount {
  mode: "read-only" | "read-write";
  source: "workspace";
}

export interface PermissionEpoch {
  createdAt: string;
  executeGrantScope?: "conversation" | "global" | "once" | "project" | "session";
  environmentRevisionId: string;
  id: string;
  mounts: PermissionMount[];
  memoryLostReason?: string;
  /**
   * Effective sandbox network mode for this epoch. Kept as the mode alone so
   * epochs and provenance rows recorded before sandbox network access existed
   * (always `"none"`) stay valid; the full policy lives in `networkAccess`.
   */
  networkPolicy: SandboxNetworkMode;
  /**
   * Immutable snapshot of the sandbox network access policy this epoch grants.
   * Absent on epochs created before the policy existed — read it through
   * `epochSandboxNetworkAccess` so those degrade to "no network".
   */
  networkAccess?: SandboxNetworkAccess;
  reason: string;
  secretRefs: string[];
  sessionId: string;
}

/** The epoch's policy snapshot, falling back to "no network" for old epochs. */
export function epochSandboxNetworkAccess(epoch: Pick<PermissionEpoch, "networkAccess" | "networkPolicy">): SandboxNetworkAccess {
  if (epoch.networkAccess && epoch.networkAccess.mode === epoch.networkPolicy) return epoch.networkAccess;
  return NO_SANDBOX_NETWORK_ACCESS;
}

export type PermissionAction = "artifact_download" | "code" | "connector" | "directory" | "host" | "remote_job";

export type PermissionGrantScope = "once" | "conversation" | "project" | "global" | "session";

export type PermissionDecision = "allow_matching" | "allow_once" | "deny";

export type PermissionAuthorizationSource =
  | "always_allow"
  | "existing_grant"
  | "legacy_grant"
  | "user_deny"
  | "user_grant"
  | "user_once";

export interface PermissionRequest {
  action: PermissionAction;
  authorizationConsumedAt?: string;
  createdAt: string;
  decidedAt?: string;
  decision?: "allowed" | "denied";
  decisionEpochId?: string;
  executionId?: string;
  grantId?: string;
  id: string;
  permissionAuthorizationId?: string;
  projectId?: string;
  resource: string;
  sessionId?: string;
  state: "allowed" | "cancelled" | "denied" | "pending";
  summary: string;
  toolCallId?: string;
}

export interface PermissionGrant {
  action: PermissionAction;
  createdAt: string;
  id: string;
  projectId?: string;
  resource: string;
  revokedAt?: string;
  scope: PermissionGrantScope;
  sessionId?: string;
  state: "active" | "revoked";
  usesRemaining?: number;
}

export interface PermissionAuthorization {
  action: PermissionAction;
  approvalMode: ApprovalMode;
  createdAt: string;
  executionId?: string;
  id: string;
  outcome: "allowed" | "denied";
  permissionEpochId: string;
  permissionGrantId?: string;
  permissionRequestId?: string;
  projectId: string;
  resource: string;
  sessionId: string;
  source: PermissionAuthorizationSource;
  toolCallId?: string;
}

export interface CreatePermissionRequest {
  action: PermissionAction;
  executionId?: string;
  resource: string;
  summary: string;
  toolCallId?: string;
}

export interface DecidePermissionRequest {
  decision: PermissionDecision;
}

export interface PermissionDecisionResult {
  authorization: PermissionAuthorization;
  authorizations: PermissionAuthorization[];
  grant?: PermissionGrant;
  permissionEpoch?: PermissionEpoch;
  request: PermissionRequest;
  resolvedRequests: PermissionRequest[];
}

export interface RotatePermissionEpochRequest {
  reason: string;
}
