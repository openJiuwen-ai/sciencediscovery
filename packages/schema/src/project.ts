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
  /** Default remote hosts for inheriting Sessions; not a ceiling on Session overrides. */
  remoteRunnerHostIds: string[];
  /** Unified selection, including local. Absent preserves legacy defaults. */
  runnerIds?: string[];
  settingsOverrides: RuntimeSettingsOverrides;
}

export interface CreateProjectRequest {
  name: string;
  remoteRunnerHostIds?: string[];
  runnerIds?: string[];
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
  name?: string;
  remoteRunnerHostIds?: string[];
  runnerIds?: string[];
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

/** Legacy remote-only lists always included the built-in Runner implicitly. */
export function effectiveRunnerIds(project: Pick<Project, "runnerIds" | "remoteRunnerHostIds">,
  session?: Pick<Session, "runnerIds" | "remoteRunnerHostIds">): string[] {
  if (session?.runnerIds !== undefined) return [...session.runnerIds];
  if (session?.remoteRunnerHostIds !== undefined) return ["local", ...session.remoteRunnerHostIds];
  return project.runnerIds ? [...project.runnerIds] : ["local", ...project.remoteRunnerHostIds];
}
