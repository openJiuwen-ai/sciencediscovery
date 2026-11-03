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

import type { EvolveRunStatus } from "@sciencediscovery/schema";

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
