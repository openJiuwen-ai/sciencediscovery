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

export interface Specialist {
  /** Optional one-line summary shown in settings and the task tool's specialist enum. */
  description: string;
  /** Built-in specialists are seeded by the application, read-only, and cannot be deleted. */
  builtIn?: boolean;
  connectorIds: ConnectorId[];
  createdAt: string;
  /**
   * Whether the specialist is active. Omitted/undefined means enabled (the
   * default). Disabled built-ins drop out of the task tool's specialistId
   * enum so the leader will not dispatch them. User specialists are always
   * enabled (the field is only meaningful for built-ins).
   */
  enabled?: boolean;
  enabledSkillIds: string[];
  id: string;
  instructions: string;
  name: string;
  updatedAt: string;
}

export interface CreateSpecialistRequest {
  connectorIds?: ConnectorId[];
  description: string;
  enabledSkillIds?: string[];
  instructions: string;
  name: string;
}

export interface UpdateSpecialistRequest extends Partial<CreateSpecialistRequest> {
  /** Toggle a built-in specialist on/off. Only meaningful for built-ins. */
  enabled?: boolean;
}
