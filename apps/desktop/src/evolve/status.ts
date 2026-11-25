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

import type { EvolveRun, EvolveRunFailureCode, EvolveRunStatus } from "@sciencediscovery/schema";

import { TEXT } from "../text.js";

/** The user-facing name of a status.
 *
 *  Terminal statuses read very differently to a person — "you stopped it",
 *  "it ran out of budget" and "it broke" need different next steps — so they
 *  are named apart rather than sharing one "finished". */
export function evolveStatusLabel(status: EvolveRunStatus): string {
  return TEXT.evolve.status[status];
}

/** The tone suffix the stylesheet colours the pill by. */
export function evolveStatusTone(status: EvolveRunStatus): string {
  switch (status) {
    case "running":
      return "live";
    case "succeeded":
      return "good";
    case "budget_exhausted":
      return "warn";
    case "failed":
      return "bad";
    default:
      return "quiet";
  }
}

/** The category to explain a failed run with.
 *
 *  Records written before `failure` existed carry only a free-text `error`.
 *  Classifying the few sentences the control plane itself wrote keeps those
 *  records useful; anything else falls back to "no reason recorded" rather
 *  than showing an untranslated sentence in a Chinese UI. */
export function evolveFailureCode(
  run: Pick<EvolveRun, "error" | "failure" | "status">,
): EvolveRunFailureCode | "unknown" {
  if (run.failure?.code) return run.failure.code;
  if (run.error) {
    if (/control plane restarted/i.test(run.error)) return "service_restart";
    if (/sidecar disconnected|no terminal event|fetch failed|ECONN|connection/i.test(run.error)) {
      return "sidecar_disconnected";
    }
    if (/authentication failed|not initialized|HTTP 5\d\d|temporarily unavailable/i.test(run.error)) {
      return "sidecar_unavailable";
    }
    return "search_failed";
  }
  return "unknown";
}

/** The localized reason shown beside `失败`, or `undefined` for any other
 *  terminal status. The persisted `message` stays on the record for diagnostics
 *  and for the agent; a card renders the translated category so an English
 *  sentence can never leak into the Chinese UI. */
export function evolveFailureLabel(
  run: Pick<EvolveRun, "error" | "failure" | "status">,
): string | undefined {
  if (run.status !== "failed") return undefined;
  const code = evolveFailureCode(run);
  // A server from a newer build could name a code this client does not know;
  // an unknown string must not render as an empty pill.
  return TEXT.evolve.failure[code] ?? TEXT.evolve.failure.unknown;
}
