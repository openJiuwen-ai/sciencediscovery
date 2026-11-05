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
  defaultModelId?: string;
}

/** Restore the saved default without choosing or persisting another profile. */
export function resolveCatalog(
  profiles: ModelProfile[],
  overrides: RuntimeSettingsOverrides,
  hasHistory = false,
): CatalogDecision {
  const first = profiles[0];
  if (first === undefined) return { boot: hasHistory ? "ready" : "setup" };
  const configured = overrides.modelId;
  const known = configured !== undefined && profiles.some((profile) => profile.id === configured);
  return { boot: "ready", ...(known ? { defaultModelId: configured } : {}) };
}
