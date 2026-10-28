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
 * The artifact list shows every Session's artifacts, with the open Session's
 * at the top.
 *
 * An Artifact is a Project's, not a Session's: a later Session can write a new
 * version of a file an earlier one made. The group is therefore the Session
 * that *created* the Artifact — where it came from stays put even when a later
 * turn rewrites it — and the row shows the newest version from whichever
 * Session wrote it.
 *
 * Kept pure so the ordering and the dedupe can be tested without a DOM.
 */

import type { Session, SessionArtifactOutput } from "../api/types.js";
import { latestOutputs } from "./artifact-labels.js";

/** One Session's artifacts, one row per Artifact. */
export interface ArtifactGroup {
  /** One output per artifact: the newest version, from any Session. */
  outputs: SessionArtifactOutput[];
  /** Every version the Session lists, in the order it arrived, for the picker
   *  behind an open document — `versionsOf` does the ordering.
   *  `outputs` is this with the older versions folded away. */
  versions: SessionArtifactOutput[];
  /** The Session the artifacts belong to; empty for output that predates the
   *  field, which is the open Session's group. */
  sessionId: string;
  /** The open Session, whose group the list draws first. */
  isCurrent: boolean;
  /** The Session's title, live if the app has it, else what it was at creation. */
  title: string;
}

/** The Session an output belongs to: the one that created the artifact, or —
 *  for output older than that field — the one whose version it is. */
export function outputSessionId(output: SessionArtifactOutput): string {
  return output.artifact.createdInSessionId
    || output.artifact.sessionId
    || output.version.sessionId
    || "";
}

/**
 * Split every Session's output into the groups the list draws.
 *
 * The open Session is pinned first; the rest follow the order the sidebar lists
 * them, so an artifact from last week does not float above one from this
 * morning. Nothing is dropped: an artifact outlives the Session that made it,
 * and a heading the sidebar no longer shows is still better than a file the
 * reader cannot reach.
 */
export function artifactGroups(
  outputs: readonly SessionArtifactOutput[],
  sessions: readonly Session[],
  currentSessionId: string | undefined,
  untitled: string,
): ArtifactGroup[] {
  const current = currentSessionId ?? "";
  const order = new Map(sessions.map((session, index) => [session.id, index]));
  const buckets = new Map<string, SessionArtifactOutput[]>();
  for (const output of outputs) {
    // The open Session is kept even when the listing has not caught up with it.
    const sessionId = outputSessionId(output) || current;
    const held = buckets.get(sessionId);
    if (held === undefined) buckets.set(sessionId, [output]);
    else held.push(output);
  }
  return [...buckets]
    .map(([sessionId, versions]): ArtifactGroup => ({
      isCurrent: sessionId === current,
      outputs: latestOutputs(versions),
      sessionId,
      title: titleOf(sessionId, versions, sessions, untitled),
      versions,
    }))
    .sort((left, right) => {
      if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
      // A Session the sidebar does not list sorts after the ones it does; the
      // sort is stable, so those keep the order their rows arrived in.
      return (order.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER)
        - (order.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER);
    });
}

function titleOf(
  sessionId: string,
  versions: readonly SessionArtifactOutput[],
  sessions: readonly Session[],
  untitled: string,
): string {
  // The live title first: a Session renamed since it wrote the artifact should
  // not keep heading its files under the old name.
  const live = sessions.find((session) => session.id === sessionId)?.title;
  return live || versions[0]?.artifact.createdInSessionTitle || untitled;
}
