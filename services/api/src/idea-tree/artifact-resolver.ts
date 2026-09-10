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

import type { CasStore } from "@sciencediscovery/cas";
import {
  IdeaTreeRuntimeError,
  type IdeaTreeArtifactResolver,
} from "@sciencediscovery/idea-tree";

import type { SessionStore } from "../store.js";

export function createIdeaTreeArtifactResolver(store: SessionStore, cas: CasStore): IdeaTreeArtifactResolver {
  return {
    async resolve(input) {
      const artifact = store.getArtifact(input.sessionId, input.artifactId);
      const version = store.getArtifactVersion(input.sessionId, input.versionId);
      if (!artifact || artifact.projectId !== store.getSession(input.sessionId)?.projectId
        || !version || version.artifactId !== artifact.id || version.sessionId !== input.sessionId) {
        throw new IdeaTreeRuntimeError(
          "ARTIFACT_VERSION_INVALID",
          `Artifact ${input.artifactId} version ${input.versionId} is not an exact version from this Session`,
        );
      }
      if (!version.turnId) {
        throw new IdeaTreeRuntimeError("ARTIFACT_PRODUCER_INVALID", `Artifact version ${version.id} has no Specialist producer`);
      }
      const producer = store.listSubagents(input.sessionId).find((candidate) => candidate.id === version.turnId);
      if (!producer || producer.status !== "completed" || !producer.specialistId || !producer.specialistConfigHash) {
        throw new IdeaTreeRuntimeError(
          "ARTIFACT_PRODUCER_INVALID",
          `Artifact version ${version.id} was not produced by a completed Specialist execution`,
        );
      }
      const producerRun = await store.getSessionRun(input.sessionId, producer.parentTurnId);
      if (producerRun?.settingsSnapshot.ideaTreeExecutor?.fingerprint !== input.executor.fingerprint) {
        throw new IdeaTreeRuntimeError(
          "ARTIFACT_EXECUTOR_MISMATCH",
          `Artifact version ${version.id} was produced under a different Idea Tree executor snapshot`,
        );
      }
      const bytes = await cas.read(version.content.hash);
      if (cas.hash(bytes) !== version.content.hash) {
        throw new IdeaTreeRuntimeError(
          "ARTIFACT_CONTENT_INVALID",
          `Artifact version ${version.id} failed content-hash verification`,
        );
      }
      return {
        bytes,
        mediaType: version.mediaType,
        snapshot: {
          artifactId: artifact.id,
          contentHash: version.content.hash,
          producerExecutionId: producer.id,
          producerSpecialistConfigHash: producer.specialistConfigHash,
          producerSpecialistId: producer.specialistId,
          role: input.role,
          versionId: version.id,
        },
      };
    },
  };
}
