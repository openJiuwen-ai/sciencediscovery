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

import type {
  IdeaTreeArtifactVersionSnapshot,
  IdeaTreeExecutorDescriptor,
  IdeaTreePhase,
  IdeaTreeVerifiedResult,
} from "@sciencediscovery/schema";
import type { IssueVerifiedResultInput } from "./runtime.js";

export interface IdeaTreeClock {
  now(): string;
}

export interface IdeaTreePhaseEventSink {
  emit(phase: IdeaTreePhase, detail?: { nodeId?: string; treeId?: string }): Promise<void> | void;
}

/** Exact, Session-bound Artifact access implemented by the API/CAS adapter. */
export interface IdeaTreeArtifactResolver {
  resolve(input: {
    artifactId: string;
    executor: IdeaTreeExecutorDescriptor;
    role: string;
    sessionId: string;
    versionId: string;
  }): Promise<{ bytes: Uint8Array; mediaType: string; snapshot: IdeaTreeArtifactVersionSnapshot }>;
}

/** Minimal server-only surface available to a Result Authority. */
export interface IdeaTreeAuthorityRuntime {
  issueVerifiedResult(input: IssueVerifiedResultInput): Promise<IdeaTreeVerifiedResult>;
}
