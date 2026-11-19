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

/** The one Project that holds standalone conversations. */
export const INBOX_PROJECT_KIND = "inbox";

/**
 * The Inbox's stored name. It is never shown as a Project name: each client
 * labels it in its own language, and the stored value is only what usage
 * summaries and deletion-impact reports have to print.
 */
export const INBOX_PROJECT_NAME = "Recent sessions";

export interface Project {
  createdAt: string;
  /** Optional free-form research description. */
  description?: string;
  id: string;
  /** Server-owned. The single standalone-conversation bucket: never listed as
   *  a user Project, never renamed, never deleted. */
  kind?: typeof INBOX_PROJECT_KIND;
  name: string;
  /** Legacy Project selection. Nonempty lists restrict inherited Sessions; empty with no runnerIds uses the live catalog. */
  remoteRunnerHostIds: string[];
  /** Explicit selection, including local. Absent with no legacy hosts uses the registered Runner catalog. */
  runnerIds?: string[];
  settingsOverrides: RuntimeSettingsOverrides;
}

export interface CreateProjectRequest {
  description?: string;
  name: string;
  /** Omit both selections to use every registered Runner; an explicit legacy [] keeps only local. */
  remoteRunnerHostIds?: string[];
  /** Explicit IDs, including local; [] disables execution for inheriting Sessions. */
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
  /** Omit to preserve; blank or whitespace clears the stored description. */
  description?: string;
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

/**
 * Explicit Session and Project choices take precedence, including empty lists.
 * A Project with no selection uses the live registered catalog. Legacy remote
 * selections keep the built-in Runner; an explicit empty Session legacy list
 * still means built-in only.
 * Callers must supply the catalog so clients cannot silently fall back to local only.
 */
export function effectiveRunnerIds(project: Pick<Project, "runnerIds" | "remoteRunnerHostIds">,
  session: Pick<Session, "runnerIds" | "remoteRunnerHostIds"> | undefined,
  registeredRunnerIds: readonly string[]): string[] {
  if (session?.runnerIds !== undefined) return [...session.runnerIds];
  if (session?.remoteRunnerHostIds !== undefined) return ["local", ...session.remoteRunnerHostIds];
  if (project.runnerIds !== undefined) return [...project.runnerIds];
  if (project.remoteRunnerHostIds.length) return ["local", ...project.remoteRunnerHostIds];
  return [...registeredRunnerIds];
}
