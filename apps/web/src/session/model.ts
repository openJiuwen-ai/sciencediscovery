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

import type {
  ChatMessage,
  Project,
  Session,
  SessionRun,
} from "@science-agent/schema";

export function messageForSessionTitle(content: string): string {
  const prefix = "/web-refresh ";
  return content.startsWith(prefix) ? content.slice(prefix.length).trim() : content;
}

const SESSION_TITLE_REFRESH_OFFSETS_MS = [0, 500, 1_500, 4_000, 10_000, 30_000, 32_000] as const;

export async function followSessionTitleRefinement(options: {
  loadSession: (sessionId: string) => Promise<Session>;
  now?: () => number;
  offsetsMs?: readonly number[];
  onUpdate: (session: Session) => void;
  provisionalTitle: string;
  sessionId: string;
  startedAt: number;
  wait?: (delayMs: number) => Promise<void>;
}): Promise<Session | undefined> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((delayMs: number) =>
    new Promise<void>((resolveDelay) => window.setTimeout(resolveDelay, delayMs)));
  let checkedImmediately = false;
  for (const offsetMs of options.offsetsMs ?? SESSION_TITLE_REFRESH_OFFSETS_MS) {
    const delayMs = options.startedAt + offsetMs - now();
    if (checkedImmediately && delayMs <= 0) continue;
    checkedImmediately = true;
    if (delayMs > 0) await wait(delayMs);
    let current: Session;
    try {
      current = await options.loadSession(options.sessionId);
    } catch {
      continue;
    }
    if (current.title !== options.provisionalTitle) {
      options.onUpdate(current);
      return current;
    }
    if (current.archivedAt) return current;
  }
  return undefined;
}

export function getVisibleProjects(
  projects: Project[],
  activeProjectId: string | undefined,
  expanded: boolean,
): Project[] {
  return expanded ? projects : projects.filter((project) => project.id === activeProjectId);
}

export type ConversationBlock =
  | { kind: "message"; message: ChatMessage }
  | { kind: "run-timeline"; runId: string };

/**
 * Interleave finished-run timelines into the conversation: each run's step
 * cards render right after the user message that started it, and the run's
 * final assistant message is skipped because the timeline replays the answer
 * in place. Messages without a replayed run (notices, legacy runs) render
 * unchanged.
 */
export function buildConversationBlocks(
  messages: ChatMessage[],
  runs: SessionRun[],
  replayedRunIds: ReadonlySet<string>,
): ConversationBlock[] {
  const runByUserMessage = new Map<string, SessionRun>();
  const consumedAnswers = new Set<string>();
  for (const run of runs) {
    if (!replayedRunIds.has(run.id) || !run.userMessageId) continue;
    runByUserMessage.set(run.userMessageId, run);
    if (run.assistantMessageId) consumedAnswers.add(run.assistantMessageId);
  }
  const blocks: ConversationBlock[] = [];
  for (const message of messages) {
    const run = message.role === "user" ? runByUserMessage.get(message.id) : undefined;
    if (run) {
      blocks.push({ kind: "message", message }, { kind: "run-timeline", runId: run.id });
      continue;
    }
    if (message.role === "assistant" && consumedAnswers.has(message.id)) continue;
    blocks.push({ kind: "message", message });
  }
  return blocks;
}

/** Drop one Session's entry from a per-Session record, leaving the rest untouched. */
export function forgetSession<T>(bySession: Readonly<Record<string, T>>, sessionId: string): Readonly<Record<string, T>> {
  if (!(sessionId in bySession)) return bySession;
  const { [sessionId]: _removed, ...rest } = bySession;
  return rest;
}

export function sortSessionRuns(runs: SessionRun[]): SessionRun[] {
  return runs.toSorted((left, right) => left.queueOrder - right.queueOrder || left.createdAt.localeCompare(right.createdAt));
}
