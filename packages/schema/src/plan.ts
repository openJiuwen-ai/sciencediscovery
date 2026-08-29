// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

export type ApprovalMode = "always_allow" | "ask_for_dangerous";

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
