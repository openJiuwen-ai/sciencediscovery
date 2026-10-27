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

import type { ArtifactReviewRun } from "@sciencediscovery/schema";

import type { SessionStore } from "../store.js";

/**
 * One review answers for exactly one Artifact version. Once that Artifact has a
 * newer version, the stored verdict still belongs to the history and must not be
 * read as the current conclusion. The marker is computed on read and never
 * persisted, so a later version renders the same review as history without
 * rewriting what the Reviewer actually decided.
 */
export function annotateReviewStaleness(
  store: Pick<SessionStore, "listArtifactVersions">,
  sessionId: string,
  reviews: readonly ArtifactReviewRun[],
): ArtifactReviewRun[] {
  const latestVersionByArtifactId = new Map<string, string>();
  for (const review of reviews) {
    if (latestVersionByArtifactId.has(review.artifactId)) continue;
    const versions = store.listArtifactVersions(sessionId, review.artifactId)
      .filter((candidate) => candidate.sessionId === sessionId)
      .toSorted((left, right) => left.version - right.version);
    const latest = versions.at(-1);
    if (latest) latestVersionByArtifactId.set(review.artifactId, latest.id);
  }
  return reviews.map((review) => {
    const latestVersionId = latestVersionByArtifactId.get(review.artifactId);
    if (!latestVersionId || latestVersionId === review.artifactVersionId) return review;
    return { ...review, stale: true, staleSinceVersionId: latestVersionId };
  });
}
