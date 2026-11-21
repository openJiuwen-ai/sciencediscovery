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

import type { ApiClient } from "../api/client.js";
import { listArtifactOutputs, listSessions } from "../api/sessions.js";
import type { Session, SessionArtifactOutput, WorkbenchSearchResult } from "../api/types.js";

/**
 * What the server's search cannot return for the inbox.
 *
 * `searchWorkbench` skips `INBOX_PROJECT_KIND` entirely
 * (`services/api/src/workbench/index.ts`), so neither the inbox's Sessions nor
 * their artifacts are in its answer — yet the desktop's 会话 list *is* the
 * inbox and the field promises to search 会话, 项目 and 产物. The client
 * therefore reads the inbox once per search session: every Session with
 * `state=all` (archived ones included) and each Session's artifact outputs.
 *
 * The snapshot is query-independent so typing another character filters it
 * locally instead of spending N more requests.
 */
export interface InboxSearchSnapshot {
  artifacts: InboxSearchResult[];
  /** True when at least one Session's artifacts could not be read. The
   *  snapshot is still usable; the panel says the search may be incomplete. */
  failed: boolean;
  sessions: InboxSearchResult[];
}

/** A result plus the text the server's matcher would have looked at. The extra
 *  field never leaves this module: the panel only reads the schema shape. */
type InboxSearchResult = WorkbenchSearchResult & { searchText: string };

function sessionResult(session: Session): InboxSearchResult {
  return {
    detail: "Session",
    id: `session:${session.id}`,
    kind: "session",
    label: session.title,
    projectId: session.projectId,
    searchText: `${session.title}\n${session.id}`,
    sessionId: session.id,
    ...(session.archivedAt !== undefined ? { archived: true } : {}),
  };
}

function artifactResult(output: SessionArtifactOutput, session: Session): InboxSearchResult {
  const artifact = output.artifact;
  const sessionTitle = artifact.createdInSessionTitle || session.title;
  return {
    detail: `Session / ${artifact.origin}`,
    id: `artifact:${artifact.id}`,
    kind: "artifact",
    label: artifact.name,
    origin: artifact.origin,
    path: artifact.name,
    projectId: artifact.projectId || session.projectId,
    searchText: `${artifact.name}\n${artifact.title ?? ""}\n${sessionTitle}\n${artifact.id}`,
    // The dialog reads the output through the Session that wrote it, so the
    // identity is the artifact's own `createdInSessionId` even when the
    // Session row it came from was the one listed.
    sessionId: artifact.createdInSessionId || session.id,
    sessionTitle,
  };
}

/** The loaded 会话 rows as a snapshot, used before (or instead of) the inbox
 *  read. It has no artifacts: only the per-Session outputs route has those. */
export function fallbackInboxSnapshot(sessions: readonly Session[]): InboxSearchSnapshot {
  return { artifacts: [], failed: false, sessions: sessions.map(sessionResult) };
}

/**
 * Read the inbox's Sessions and their artifact outputs once for a search
 * session. A failed artifact read for one Session leaves the rest of the
 * snapshot intact and sets `failed`; a failed Session list rejects so the
 * caller can fall back to the loaded 会话 rows.
 */
export async function loadInboxSearch(
  client: ApiClient,
  inboxProjectId: string,
  signal?: AbortSignal,
): Promise<InboxSearchSnapshot> {
  const init: RequestInit = signal === undefined ? {} : { signal };
  const sessions = await listSessions(client, inboxProjectId, "all", init);
  const outputs = await Promise.allSettled(
    sessions.map((session) => listArtifactOutputs(client, session.id, init)),
  );
  const artifacts: InboxSearchResult[] = [];
  let failed = false;
  outputs.forEach((read, index) => {
    const session = sessions[index];
    if (session === undefined) return;
    if (read.status === "rejected") {
      failed = true;
      return;
    }
    for (const output of read.value) {
      if (output.artifact.deletedAt !== undefined) continue;
      artifacts.push(artifactResult(output, session));
    }
  });
  return { artifacts, failed, sessions: sessions.map(sessionResult) };
}

function matches(result: InboxSearchResult, needle: string): boolean {
  return result.searchText.toLocaleLowerCase().includes(needle);
}

/**
 * The snapshot's rows that match `query`, minus anything the server already
 * returned. Matching mirrors the server's fields: an artifact's name, title
 * and creating Session's title; a Session's title and id. The inbox Project
 * has no displayed name to match.
 */
export function filterInboxSnapshot(
  snapshot: InboxSearchSnapshot,
  query: string,
  known: ReadonlySet<string> = new Set(),
): WorkbenchSearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [];
  return [...snapshot.sessions, ...snapshot.artifacts]
    .filter((result) => !known.has(result.id) && matches(result, needle));
}
