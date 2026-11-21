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
import { listArtifactOutputs } from "../api/sessions.js";
import type { SessionArtifactOutput } from "../api/types.js";
import { TEXT } from "../text.js";

export interface OpenSearchArtifactOptions {
  artifactId: string;
  client: ApiClient;
  /** The result's own `artifact:<id>` id, parsed, and the Session it names. */
  onError: (reason: unknown) => void;
  onMissing: () => void;
  onOpen: (output: SessionArtifactOutput) => Promise<void> | void;
  sessionId: string;
}

/**
 * Turn a workbench search result into the `SessionArtifactOutput` the artifact
 * dialog opens from.
 *
 * The search result carries `artifact:<artifactId>` and a Session id, while
 * `openArtifact`/`ArtifactDialog` resolve through
 * `listArtifactOutputs(client, sessionId)` and match `artifact.id`. This runs
 * that same read — so the dialog lands on the document it would have found —
 * and reports both a vanished artifact and a failed read instead of doing
 * nothing.
 */
export async function openSearchArtifact(options: OpenSearchArtifactOptions): Promise<void> {
  try {
    const outputs = await listArtifactOutputs(options.client, options.sessionId);
    const output = outputs.find((candidate) => candidate.artifact.id === options.artifactId);
    if (output === undefined) {
      options.onMissing();
      return;
    }
    await options.onOpen(output);
  } catch (reason) {
    options.onError(reason);
  }
}

export interface ArtifactResultActionOptions {
  artifactId: string;
  client: ApiClient;
  /** The workspace's own error sentence, so this module stays free of its
   *  toast vocabulary. */
  describeError: (reason: unknown) => string;
  onOpen: (output: SessionArtifactOutput) => Promise<void> | void;
  sessionId: string;
  toast: (message: string, tone: "error") => void;
}

/**
 * The production wiring of `openSearchArtifact`: the two failures become the
 * visible toast messages the reader sees. Kept here so a test can assert the
 * user-visible text without mounting the whole workspace hook.
 */
export async function openArtifactResultAction(options: ArtifactResultActionOptions): Promise<void> {
  await openSearchArtifact({
    artifactId: options.artifactId,
    client: options.client,
    onError: (reason) => options.toast(options.describeError(reason), "error"),
    onMissing: () => options.toast(TEXT.search.artifactUnavailable, "error"),
    onOpen: options.onOpen,
    sessionId: options.sessionId,
  });
}
