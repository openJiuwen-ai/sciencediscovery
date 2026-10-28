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

import type { SessionDetail } from "../api/types.js";
import type { RunStreamState } from "../run-stream/model.js";
import type { RunReplay } from "../run-stream/replay.js";
import type { PendingMessage } from "./use-workspace.js";

/** The three ways into a new session, one pill each on the welcome page. The
 *  key is also the icon's name in `assets/landing/`. */
export type LandingCategory = "research" | "experiment" | "analysis";

export const LANDING_CATEGORIES: readonly LandingCategory[] = ["research", "experiment", "analysis"];

export interface LandingSeed {
  /** Bumped on every choice, so picking the same topic twice still lands. */
  nonce: number;
  text: string;
}

/** Everything the transcript is drawn from. */
export interface TranscriptSnapshot {
  detail?: SessionDetail;
  pending?: PendingMessage;
  replays: readonly RunReplay[];
  run: RunStreamState;
}

/**
 * True when the open session has nothing to show yet: no persisted turn, no
 * message waiting to be sent, and no run — neither a replay nor the one still
 * streaming.
 *
 * The welcome page and the transcript both ask this. It is the same question
 * the transcript used to answer inline; keeping it here is what lets App decide
 * whether the composer belongs centred on the page or pinned under the
 * transcript.
 */
export function isEmptyTranscript({ detail, pending, replays, run }: TranscriptSnapshot): boolean {
  if (pending !== undefined || replays.length > 0) return false;
  if (run.turns.length > 0 || run.finalContent !== undefined) return false;
  return (detail?.messages.length ?? 0) === 0;
}

/** What the welcome page is keyed by.
 *
 *  The page holds the category it was last given, so that a chip stays with the
 *  turn it was chosen for. That state belongs to one session: React's key is
 *  what ends it, and it has to end even when nothing is drawn between the two
 *  sessions. An existing session is named by its id. A draft has none — 新增会话
 *  clears the open session and creates the next one without a blank page in
 *  between — so each draft is named by its epoch instead; two drafts in a row
 *  (a create that failed, then another click) are still two pages. */
export function landingKey(session: { draftEpoch: number; sessionId?: string }): string {
  return session.sessionId ?? `draft-${session.draftEpoch}`;
}
