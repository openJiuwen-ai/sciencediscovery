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

import type { ScientificArtifact, Session } from "@sciencediscovery/schema";

export interface ArtifactSessionGroup {
  id: string;
  items: ScientificArtifact[];
  label: string;
  sourceSessionId?: string;
}

export function upsertArtifactSession(sessions: Session[], updated: Session): Session[] {
  const existing = sessions.findIndex((session) => session.id === updated.id);
  if (existing < 0) return [updated, ...sessions];
  return sessions.map((session, index) => index === existing ? updated : session);
}

export function groupArtifactsBySession({
  artifacts,
  catalogProjectId,
  deletedSessionLabel,
  projectId,
  sessions,
}: {
  artifacts: ScientificArtifact[];
  catalogProjectId: string | undefined;
  deletedSessionLabel: string;
  projectId: string | undefined;
  sessions: Session[];
}): ArtifactSessionGroup[] {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const catalogReady = Boolean(projectId) && catalogProjectId === projectId;
  const groups = new Map<string, ArtifactSessionGroup>();

  for (const artifact of artifacts) {
    const sourceSessionIds = [...new Set(
      artifact.contributingSessionIds?.length
        ? artifact.contributingSessionIds
        : [artifact.createdInSessionId],
    )];
    for (const sourceSessionId of sourceSessionIds) {
      const liveSession = sessionsById.get(sourceSessionId);
      const confirmedDeleted = catalogReady && !liveSession;
      const id = liveSession?.id ?? (confirmedDeleted ? "deleted" : sourceSessionId);
      const group = groups.get(id) ?? {
        id,
        items: [],
        label: liveSession?.title
          ?? (confirmedDeleted ? deletedSessionLabel : artifact.createdInSessionTitle),
        sourceSessionId: confirmedDeleted ? undefined : sourceSessionId,
      };
      if (!group.items.some((item) => item.id === artifact.id)) group.items.push(artifact);
      groups.set(id, group);
    }
  }

  return [...groups.values()];
}
