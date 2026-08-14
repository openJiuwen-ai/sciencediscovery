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
  caveats: string[];
  createdAt: string;
  feasibilityConfidence: PlanConfidence;
  id: string;
  mode: "recorded";
  scope: string;
  sessionId: string;
  state: "completed" | "recorded";
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
