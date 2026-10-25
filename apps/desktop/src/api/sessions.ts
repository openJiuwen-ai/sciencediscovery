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

import type { ApiClient } from "./client.js";
import type {
  CreateSessionRequest,
  Project,
  ScientificArtifact,
  Session,
  SessionArtifactOutput,
  SessionDetail,
  SessionListState,
  SessionRun,
  UpdateSessionRequest,
  WorkspaceConflictPolicy,
  WorkspaceFile,
  WorkspaceUploadResult,
} from "./types.js";

/** Every Session belongs to a Project, and there is no Project picker in this
 *  UI, so the app keeps exactly one. `listProjects` is ordered by creation
 *  time, which makes the first entry the one to reuse. */
export function listProjects(client: ApiClient): Promise<Project[]> {
  return client.request<Project[]>("/api/projects");
}

/**
 * Create a Project and adopt the first Session the server makes with it.
 *
 * `POST /api/projects` always creates one untitled Session alongside the
 * Project. Returning it means the caller does not have to immediately create
 * a second one — but the caller is free to ignore it and start from the empty
 * state instead.
 */
export async function createProject(
  client: ApiClient,
  name: string,
): Promise<{ firstSession: Session; project: Project }> {
  return client.request<{ firstSession: Session; project: Project }>("/api/projects", {
    body: JSON.stringify({ name }),
    method: "POST",
  });
}

export function listSessions(
  client: ApiClient,
  projectId: string,
  state: SessionListState = "active",
): Promise<Session[]> {
  return client.request<Session[]>(
    `/api/projects/${encodeURIComponent(projectId)}/sessions?state=${state}`,
  );
}

/**
 * `modelId` is sent whenever one is selected. That matters beyond convenience:
 * without it the Session inherits whatever the global default becomes later,
 * and the route only tolerates a missing model when neither the Session nor
 * its overrides name one. Naming it fails early and honestly instead.
 */
export function createSession(
  client: ApiClient,
  projectId: string,
  body: CreateSessionRequest,
): Promise<Session> {
  return client.request<Session>(`/api/projects/${encodeURIComponent(projectId)}/sessions`, {
    body: JSON.stringify(body),
    method: "POST",
  });
}

export function getSession(client: ApiClient, sessionId: string): Promise<SessionDetail> {
  return client.request<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

/**
 * `approvalMode` cannot travel with anything else — the route rejects a mixed
 * body — which is why this function only ever touches settings and titles.
 */
export function updateSession(
  client: ApiClient,
  sessionId: string,
  body: UpdateSessionRequest,
): Promise<Session> {
  return client.request<Session>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    body: JSON.stringify(body),
    method: "PATCH",
  });
}

/** The only place a run id is available after the fact: `POST /messages`
 *  never returns one. Ordered by `queueOrder`, so the last entry is the most
 *  recent run. */
export function listRuns(client: ApiClient, sessionId: string): Promise<SessionRun[]> {
  return client.request<SessionRun[]>(`/api/sessions/${encodeURIComponent(sessionId)}/runs`);
}

export function cancelRun(client: ApiClient, sessionId: string, runId: string): Promise<SessionRun> {
  return client.request<SessionRun>(
    `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
}

/**
 * Stop whichever run is active. Cancelling is not optional UI: a browser that
 * disconnects does not cancel its run, so closing the tab or reloading leaves
 * the model working and the account paying. Only this call stops it.
 */
export function cancelCurrentRun(client: ApiClient, sessionId: string): Promise<{ cancelled: boolean; runId?: string }> {
  return client.request<{ cancelled: boolean; runId?: string }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/runs/current/cancel`,
    { method: "POST" },
  );
}

export function listWorkspaceFiles(client: ApiClient, sessionId: string): Promise<WorkspaceFile[]> {
  return client.request<WorkspaceFile[]>(`/api/sessions/${encodeURIComponent(sessionId)}/files`);
}

export function listArtifacts(client: ApiClient, sessionId: string): Promise<ScientificArtifact[]> {
  return client.request<ScientificArtifact[]>(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts`);
}

/** Each Artifact paired with the version this Session produced, so the panel
 *  does not have to ask again which version is current. */
export function listArtifactOutputs(
  client: ApiClient,
  sessionId: string,
): Promise<SessionArtifactOutput[]> {
  return client.request<SessionArtifactOutput[]>(
    `/api/sessions/${encodeURIComponent(sessionId)}/artifact-outputs`,
  );
}

/** Artifact bytes, already decoded by the server: the CAS hash is not part of
 *  the URL, and the response carries the version's own media type. */
export async function readArtifactVersion(
  client: ApiClient,
  sessionId: string,
  versionId: string,
): Promise<string> {
  const response = await client.fetchStream(
    `/api/sessions/${encodeURIComponent(sessionId)}/artifact-versions/${encodeURIComponent(versionId)}/content`,
  );
  return response.text();
}

/** One workspace file's bytes, addressed by its workspace-relative path. The
 *  server resolves the path inside the session workspace and refuses escapes. */
export async function readWorkspaceFile(
  client: ApiClient,
  sessionId: string,
  path: string,
): Promise<string> {
  const response = await client.fetchStream(
    `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`,
  );
  return response.text();
}

/** The server requires the id repeated back as confirmation, so a stray call
 *  cannot delete anything a user did not name. */
export function deleteSession(client: ApiClient, sessionId: string): Promise<{ deleted: string }> {
  return client.request<{ deleted: string }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    body: JSON.stringify({ confirmationId: sessionId }),
    method: "DELETE",
  });
}

/**
 * Which execution machines a Project's Sessions may use.
 *
 * The list is the whole permission, not a hint: the API refuses a run whose
 * runner is not in the effective list (`Runner <id> is not allowed by this
 * Session`), and an empty array is meaningful — it forbids every machine. So
 * the array is always sent complete, and always including `"local"` when the
 * local machine should stay allowed, because omitting it disables local
 * execution too.
 */
export function setProjectRunnerIds(
  client: ApiClient,
  projectId: string,
  runnerIds: string[],
): Promise<Project> {
  return client.request<Project>(`/api/projects/${encodeURIComponent(projectId)}`, {
    body: JSON.stringify({ runnerIds }),
    method: "PATCH",
  });
}

/**
 * Put files into this Session's workspace, where the agent reads them.
 *
 * One multipart request for the whole batch rather than one per file: the
 * server counts the batch against the request-size quota, and a batch is also
 * what the user did — they dropped a selection.
 *
 * `rename` is the default conflict policy because the alternative silently
 * destroys the file the agent may already have read. A collision therefore
 * produces `<name> (2)` rather than an error, and the result says which path
 * each file actually landed on — the path, not the name, is what the caller
 * has to report, since that is the only one that is true.
 */
export function uploadWorkspaceFiles(
  client: ApiClient,
  sessionId: string,
  files: File[],
  conflict: WorkspaceConflictPolicy = "rename",
): Promise<WorkspaceUploadResult> {
  const body = new FormData();
  for (const file of files) body.append("files", file, file.name);
  return client.request<WorkspaceUploadResult>(
    `/api/sessions/${encodeURIComponent(sessionId)}/workspace/upload?conflict=${conflict}`,
    { body, method: "POST" },
  );
}

/**
 * The per-file ceiling the upload route enforces, read off `GET /api/health`.
 *
 * It is a quota setting rather than a constant, so it is only known once the
 * service answers — and the block is absent in a build without the environment
 * feature, hence `undefined` rather than a made-up default. The caller decides
 * what to do about not knowing; this layer does not guess.
 *
 * The other two limits `health.workspace` carries are for a whole request and
 * for the workspace, and this UI never shows either, so they are not read here.
 */
export async function getWorkspaceUploadLimit(client: ApiClient): Promise<number | undefined> {
  const health = await client.request<{ workspace?: { maxFileBytes?: number } }>("/api/health");
  return health.workspace?.maxFileBytes;
}
