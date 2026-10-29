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
  Subagent,
  UpdateSessionRequest,
  WorkspaceConflictPolicy,
  WorkspaceFile,
  WorkspaceUploadResult,
} from "./types.js";

/** The Projects the user made, oldest first. The server keeps one more Project
 *  than it lists — the inbox that holds standalone conversations — and hands it
 *  out through `ensureInbox` instead. */
export function listProjects(client: ApiClient): Promise<Project[]> {
  return client.request<Project[]>("/api/projects");
}

/**
 * The Project standalone conversations live in.
 *
 * Idempotent: the server creates it on the first call and returns the same one
 * afterwards. Its id is the only way to reach it, because it is deliberately
 * missing from `GET /api/projects`; `/api/projects/:id/sessions` then works for
 * it like for any other Project.
 */
export function ensureInbox(client: ApiClient): Promise<Project> {
  return client.request<Project>("/api/inbox", { method: "POST" });
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

/**
 * Every child this Session ever delegated, each with the steps it recorded.
 *
 * The run's own event log deliberately stores `subagent.updated` snapshots
 * without their steps (the steps live on the child's substream, which a run
 * replay does not read). This catalog is therefore the one place a finished
 * run's execution can be shown in full.
 */
export function listSubagents(client: ApiClient, sessionId: string): Promise<Subagent[]> {
  return client.request<Subagent[]>(`/api/sessions/${encodeURIComponent(sessionId)}/subagents`);
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

/** A document as it came off the wire: the bytes, and the type the server gave
 *  them. The panel decides what to do with the two together — decode the bytes
 *  as text, or hand them to a renderer as a data URL. */
export interface DocumentBytes {
  bytes: Uint8Array;
  mediaType: string;
}

/** Artifact bytes, as the CAS stored them: the hash is not part of the URL, and
 *  the response carries the version's own media type. */
export async function readArtifactVersion(
  client: ApiClient,
  sessionId: string,
  versionId: string,
): Promise<DocumentBytes> {
  const response = await client.fetchStream(
    `/api/sessions/${encodeURIComponent(sessionId)}/artifact-versions/${encodeURIComponent(versionId)}/content`,
  );
  return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType: response.headers.get("content-type") ?? "" };
}

/** One workspace file's bytes, addressed by its workspace-relative path. The
 *  server resolves the path inside the session workspace and refuses escapes. */
export async function readWorkspaceFile(
  client: ApiClient,
  sessionId: string,
  path: string,
): Promise<DocumentBytes> {
  const response = await client.fetchStream(
    `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`,
  );
  return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType: response.headers.get("content-type") ?? "" };
}

/** The server requires the id repeated back as confirmation, so a stray call
 *  cannot delete anything a user did not name. */
export function deleteSession(client: ApiClient, sessionId: string): Promise<{ deleted: string }> {
  return client.request<{ deleted: string }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    body: JSON.stringify({ confirmationId: sessionId }),
    method: "DELETE",
  });
}

/** A Project the user made goes away whole — its Sessions, their transcripts
 *  and their workspaces. The inbox is not a Project the user made: the service
 *  refuses it with a 409, so the sidebar never offers this for 最近会话. The id
 *  is repeated back as confirmation, the same gate a Session has. */
export function deleteProject(client: ApiClient, projectId: string): Promise<{ deleted: string }> {
  return client.request<{ deleted: string }>(`/api/projects/${encodeURIComponent(projectId)}`, {
    body: JSON.stringify({ confirmationId: projectId }),
    method: "DELETE",
  });
}

/** The name is the only field this sends, and the service answers with the
 *  Project as stored — which is what the row should show, not what was typed. */
export function renameProject(client: ApiClient, projectId: string, name: string): Promise<Project> {
  return client.request<Project>(`/api/projects/${encodeURIComponent(projectId)}`, {
    body: JSON.stringify({ name }),
    method: "PATCH",
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
/**
 * The name a file travels under, or nothing when it has none worth sending.
 *
 * Only the last segment may go: a directory selection, and a drop a page
 * crafted, both hand over names like `../outside.csv`, and the route stores the
 * part under the name it is given. This is also the string the answer echoes
 * back as `originalName`, so the composer's cards are matched against it rather
 * than against the file the browser held — see `mergeUpload`. Kept here, beside
 * the request that names the part, so the two cannot disagree.
 */
export function uploadFileName(name: string): string | undefined {
  const base = name.split(/[/\\]/u).at(-1);
  return base === undefined || base === "" || base === "." || base === ".." ? undefined : base;
}

export function uploadWorkspaceFiles(
  client: ApiClient,
  sessionId: string,
  files: File[],
  conflict: WorkspaceConflictPolicy = "rename",
): Promise<WorkspaceUploadResult> {
  const body = new FormData();
  for (const file of files) {
    const name = uploadFileName(file.name);
    if (name === undefined) throw new Error("Choose a file with a valid name.");
    body.append("files", file, name);
  }
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
