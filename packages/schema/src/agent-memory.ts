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

/**
 * Agent memory (V3-C1): long-lived experiential notes the agent can propose
 * about its own working methods. Ported from DeepAnalyze's agent_memory
 * lifecycle — the machine never self-certifies: everything the agent (or the
 * background reviewer) writes lands as a candidate marked requiresReview and
 * only a human promote() turns it into a verified rule that the system
 * prompt may carry as [已核验].
 */

export type AgentMemoryCategory =
  | "tool_technique"
  | "workflow"
  | "convention"
  | "lesson_learned";

export const AGENT_MEMORY_CATEGORIES: readonly AgentMemoryCategory[] = [
  "tool_technique",
  "workflow",
  "convention",
  "lesson_learned",
];

export type AgentMemoryStatus = "active" | "archived" | "stale";

export interface AgentMemoryProvenance {
  /** manual = human wrote it; agent_proposal = agent_memory tool;
   *  background_review = offline extraction from completed runs. */
  kind: "manual" | "agent_proposal" | "background_review";
  actorId?: string;
  requiresReview?: boolean;
  /** Origin session/run for audit. */
  source?: string;
}

export interface AgentMemoryEntry {
  id: string;
  category: AgentMemoryCategory;
  content: string;
  source: string;
  relevance: number;
  useCount: number;
  status: AgentMemoryStatus;
  supersedesId: string | null;
  confidence: number;
  provenance: AgentMemoryProvenance | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Reliability label carried into the system prompt next to each injected
 *  memory (DeepAnalyze parity — labeled injection beats raw injection). */
export function agentMemoryReliabilityLabel(
  confidence: number,
  provenance: AgentMemoryProvenance | null,
): string {
  if (provenance?.requiresReview) return " [待核验]";
  if (confidence >= 0.8) return " [已核验]";
  if (confidence >= 0.5) return " [参考]";
  return " [低置信]";
}
