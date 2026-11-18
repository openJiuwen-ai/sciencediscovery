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

/**
 * Which research a just-sent `/idea-tree <task>` started.
 *
 * `IdeaResearchState` carries no creation time, so a research cannot be told from
 * its own timestamp the way an Evolve run can (`run.createdAt` against the send
 * instant). The one safe rule is a baseline: the first list read that completes
 * after the command is the state the session was already in — including a read
 * that started earlier and arrives late — and only an id that shows up in a later
 * read is the research this window asked for. Without that, a slow first read
 * would hand back an older research, the panel would open it, and the research the
 * command actually created would never open by itself.
 */

export interface IdeaAwaitingStep {
  /** The ids the session had when the command was sent; kept until one appears. */
  baseline?: ReadonlySet<string>;
  /** The research this window asked for, once a later read carries it. */
  fresh?: string;
}

export function stepAwaitingIdea(baseline: ReadonlySet<string> | undefined, ids: readonly string[]): IdeaAwaitingStep {
  if (baseline === undefined) return { baseline: new Set(ids) };
  const fresh = ids.find((id) => !baseline.has(id));
  return fresh === undefined ? { baseline } : { baseline, fresh };
}
