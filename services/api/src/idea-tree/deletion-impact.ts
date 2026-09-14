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

import type { SkillDeletionReference } from "@sciencediscovery/schema";

import type { SessionStore } from "../store.js";

/** Durable Workflow references that must survive catalog edits and restarts. */
export async function ideaTreeSkillDeletionReferences(
  store: SessionStore,
  skillId: string,
): Promise<SkillDeletionReference[]> {
  const references: SkillDeletionReference[] = [];
  for (const project of store.listProjects()) {
    for (const session of store.listSessions(project.id, "all")) {
      const queuedOrHistorical = (await store.listSessionRuns(session.id)).some(
        (run) => run.settingsSnapshot.ideaTreeExecutor?.workflowSkill.id === skillId,
      );
      if (queuedOrHistorical) {
        references.push({ id: session.id, label: `${session.title} (Idea Tree workflow)`, scope: "session" });
      }
    }
  }
  return references;
}
