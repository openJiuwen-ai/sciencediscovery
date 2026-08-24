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


import type { EvolveGoal } from "@sciencediscovery/schema";

/**
 * Whether this goal predates the conversational designer.
 *
 * The agent builds a real scorecard from real data, so nothing new can be a
 * placeholder; runs created before that exist on disk and still open, and the
 * dashboard says plainly that their scorecard was never chosen by anyone.
 */
export function isPlaceholderGoal(goal: EvolveGoal): boolean {
  return goal.scorecard.hash === "sha256:placeholder";
}
