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

import type { RuntimeSettingsOverrides } from "./runtime-settings.js";
import type { Session } from "./session.js";

export interface Project {
  createdAt: string;
  id: string;
  name: string;
  settingsOverrides: RuntimeSettingsOverrides;
}

export interface CreateProjectRequest {
  name: string;
  settingsOverrides?: RuntimeSettingsOverrides;
}

/**
 * `POST /api/projects` keeps the Project fields at the response root for older
 * clients while exposing the canonical nested Project and its implicit Session.
 */
export interface CreateProjectResponse extends Project {
  firstSession: Session;
  project: Project;
}

export interface UpdateProjectRequest {
  name: string;
}

export type SessionListState = "active" | "all" | "archived";

export interface DeleteResourceRequest {
  confirmationId: string;
}

export interface DeletionImpact {
  activeSessionCount: number;
  archivedSessionCount: number;
  dataCategories: string[];
  sessionIds: string[];
  targetId: string;
  targetType: "project" | "session";
  totalSessionCount: number;
}
