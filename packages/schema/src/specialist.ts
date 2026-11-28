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

/** Runtime metadata is credential-free; omitted runtime means native. */
export type ExternalSpecialistRuntimeKind = "codex" | "claude-code" | "acp";
/**
 * How a Specialist's capability lists relate to the Session's own:
 * - `all` inherits the Session's skills and connectors and may add its own.
 * - `specific` replaces them, so only the listed sources are available.
 *
 * Records written before this field existed infer it from the lists: a
 * non-empty list is `specific`, two empty lists are `all`.
 */
export type SpecialistCapabilityAccess = "all" | "specific";
export type SpecialistRuntime = { kind: "native" } | { [K in ExternalSpecialistRuntimeKind]: { kind: K; model?: string; fallback?: boolean; execution?: "sandbox" | "direct"; timeoutSeconds?: number; reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" } }[ExternalSpecialistRuntimeKind];

export interface Specialist {
  runtime?: SpecialistRuntime;
  /** Optional one-line summary shown in settings and the task tool's specialist enum. */
  description: string;
  /** Built-in specialists are seeded by the application, read-only, and cannot be deleted. */
  builtIn?: boolean;
  /**
   * Whether the lists below replace the Session's capabilities (`specific`)
   * or extend them (`all`). Omitted legacy records are interpreted by
   * {@link specialistCapabilityAccess}.
   */
  capabilityAccess?: SpecialistCapabilityAccess;
  connectorIds: ConnectorId[];
  createdAt: string;
  /**
   * Whether the specialist is active. Omitted/undefined means enabled (the
   * default). Disabled specialists drop out of the task tool's specialistId
   * enum so the leader will not dispatch them. Applies to built-in and custom roles.
   */
  enabled?: boolean;
  enabledSkillIds: string[];
  id: string;
  instructions: string;
  name: string;
  updatedAt: string;
}

export interface CreateSpecialistRequest {
  capabilityAccess?: SpecialistCapabilityAccess;
  runtime?: SpecialistRuntime;
  connectorIds?: ConnectorId[];
  description: string;
  enabledSkillIds?: string[];
  instructions: string;
  name: string;
}

export interface UpdateSpecialistRequest extends Partial<CreateSpecialistRequest> {
  /** Toggle a built-in or custom specialist on/off. */
  enabled?: boolean;
}


/** Resolve the stored mode, inferring it for records written before it existed. */
export function specialistCapabilityAccess(
  specialist: Pick<Specialist, "capabilityAccess" | "connectorIds" | "enabledSkillIds"> | undefined,
): SpecialistCapabilityAccess {
  if (!specialist) return "all";
  if (specialist.capabilityAccess === "specific") return "specific";
  if (specialist.capabilityAccess === "all") return "all";
  return specialist.connectorIds.length === 0 && specialist.enabledSkillIds.length === 0 ? "all" : "specific";
}
