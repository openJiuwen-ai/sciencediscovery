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

import type { ProvenanceRecorder } from "@sciencediscovery/provenance";
import type { RunnerClient } from "@sciencediscovery/executor";
import type { SessionStore } from "./store.js";

/** Mirror the runner's immutable environment catalog and verified snapshots into the API store. */
export async function syncScientificEnvironmentCatalog(
  store: SessionStore,
  runnerClient: RunnerClient,
  provenanceRecorder: ProvenanceRecorder,
): Promise<void> {
  const [environments, revisions] = await Promise.all([
    runnerClient.listEnvironments(),
    runnerClient.listEnvironmentRevisions(),
  ]);
  for (const revision of revisions) {
    if (await provenanceRecorder.cas.verify(revision.snapshot.hash)) continue;
    const snapshot = await runnerClient.environmentSnapshot(revision.id);
    const reference = await provenanceRecorder.cas.put(snapshot);
    if (reference.hash !== revision.snapshot.hash || reference.size !== revision.snapshot.size) {
      throw new Error(`Runner snapshot does not match Environment Revision ${revision.id}`);
    }
  }
  await store.replaceScientificEnvironmentCatalog(environments, revisions);
}
