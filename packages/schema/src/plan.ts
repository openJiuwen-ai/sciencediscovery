// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

export type ApprovalMode = "always_allow" | "ask_for_dangerous";

// --- Model-declared whole-snapshot plan (update_plan tool) ---

export type PlanItemStatus = "completed" | "in_progress" | "pending";

export interface PlanItem {
  status: PlanItemStatus;
  step: string;
}

/** Latest committed plan projection for one Agent inside one Run. */
export interface PlanSnapshot {
  agentId: string;
  explanation?: string;
  items: PlanItem[];
  toolCallId: string;
  turn: number;
  updatedAt: string;
}

/** Model-facing whole-snapshot replacement. */
export interface UpdatePlanRequest {
  explanation?: string;
  plan: PlanItem[];
}

// --- Approval-gated session plan lifecycle (propose_plan / revise_plan +
// human decision log). Coexists with the snapshot plan above: the snapshot
// tracks model-declared progress, the lifecycle gates execution. ---

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
