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

import type { HealthReport } from "../api/models.js";
import type {
  ModelProfile,
  RuntimeSettingsOverrides,
} from "../api/types.js";

/** `degraded` is not a fault: it is how the service reports a subsystem the
 *  user switched off, and it must not read as a connection problem. */
export function resolveConnection(health: HealthReport): "degraded" | "online" {
  return health.status === "ok" && health.memoryGraph !== "degraded" ? "online" : "degraded";
}

export interface CatalogDecision {
  /** "setup" means there is no model at all, which is the first-run condition. */
  boot: "ready" | "setup";
  /** The profile the global default should be pointed at, or undefined when the
   *  stored selection is already valid and must be left alone. */
  adopt?: string;
  defaultModelId?: string;
}

/**
 * Decide what to do with the model catalog at startup.
 *
 * Two rules, both about not writing when writing would lose something:
 *
 *  - An empty catalog is the wizard's gate. Nothing can be sent without a
 *    model, so this is not a degraded workspace to be tolerated.
 *  - An existing global selection is never overwritten. It is read back through
 *    the live catalog first, because a `modelId` naming a profile that no longer
 *    exists would be silently dropped by `PUT /api/settings` — writing it back
 *    would look like a successful no-op forever.
 *
 * Pulled out of the hook because these are the two decisions a wrong answer
 * would be expensive to notice: a spurious write rewrites the whole settings
 * object, and a missed wizard leaves a composer that cannot send.
 */
export function resolveCatalog(
  profiles: ModelProfile[],
  overrides: RuntimeSettingsOverrides,
): CatalogDecision {
  const first = profiles[0];
  if (first === undefined) return { boot: "setup" };
  const configured = overrides.modelId;
  const known = configured !== undefined && profiles.some((profile) => profile.id === configured);
  // `PUT /api/settings` replaces the whole object, so this goes through the
  // read-merge-write helper in `api/models.ts`.
  return known
    ? { boot: "ready", defaultModelId: configured }
    : { adopt: first.id, boot: "ready", defaultModelId: first.id };
}
