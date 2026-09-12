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

export type ApprovalMode = "always_allow" | "ask_for_dangerous";

export type PlanConfidence = "high" | "low" | "medium";

export interface PlanStep {
  description: string;
  id: string;
  status: "blocked" | "completed" | "in_progress" | "pending";
}

export interface SessionPlan {
  abandonmentReason?: string;
  caveats: string[];
  createdAt: string;
  feasibilityConfidence: PlanConfidence;
  id: string;
  mode: "recorded";
  runId?: string;
  scope: string;
  sessionId: string;
  /**
   * awaiting_user (V3-C2): proposed under an approval-gated session and
   * paused for a human decision. recorded = active (approved, or proposed
   * under always_allow). Decisions bind (planId, version) — a substantive
   * revision re-enters awaiting_user under ask_for_dangerous.
   */
  state: "abandoned" | "awaiting_user" | "completed" | "recorded";
  steps: PlanStep[];
  updatedAt: string;
  version: number;
}

export interface ProposePlanRequest {
  caveats?: string[];
  feasibilityConfidence: PlanConfidence;
  scope: string;
  steps: string[];
}

export interface RevisePlanRequest extends ProposePlanRequest {
  expectedVersion: number;
}

/**
 * Plan approval decision log entry (V3-C2, Pharos-style constraint-level
 * approval): every decision — human or automatic — is recorded with the
 * exact plan version it binds, the session's approval mode at decision
 * time, and the actor. Approving version N never approves version N+1.
 */
export interface PlanApprovalDecision {
  actor: "auto" | "user";
  approvalMode: ApprovalMode;
  createdAt: string;
  decision: "approved" | "rejected";
  id: string;
  planId: string;
  planVersion: number;
  reason?: string;
  runId?: string;
  sessionId: string;
}

export interface DecidePlanApprovalRequest {
  decision: "approve" | "reject";
  /** Constraint-level binding (V3-C2): when present, the decision applies
   *  ONLY if the plan is still at this version — a stale click after an
   *  edit/agent revision fails 409 instead of approving the wrong version. */
  expectedVersion?: number;
  reason?: string;
}
