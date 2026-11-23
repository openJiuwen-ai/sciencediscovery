// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ChatMessage, SessionRun } from "../api/types.js";
import { emptyRunStream, isTerminalRunStatus, type RunStreamState } from "../run-stream/model.js";
import { hasReplayContent, replayRun, type RunReplay } from "../run-stream/replay.js";
import type { TurnArtifacts } from "./turn-artifacts.js";

/** AR-3: recover only an eligible run's missing anchor, never invent an answer. */
export function artifactAnchors(
  sessionId: string | undefined,
  terminalRuns: readonly SessionRun[],
  replays: readonly RunReplay[],
  messages: readonly ChatMessage[],
  artifacts: ReadonlyMap<string, TurnArtifacts>,
  current: RunStreamState,
) {
  const stored = new Map<string, string>();
  const storedRuns = new Set<string>();
  const byRun = new Map(replays.map(replay => [replay.runId, replay]));
  const assistantIds = new Set(messages.filter(message => message.role === "assistant"
    && (!message.kind || message.kind === "message")).map(message => message.id));
  for (const row of terminalRuns) {
    if (row.sessionId !== sessionId || !isTerminalRunStatus(row.status)
      || !artifacts.get(row.id)?.visible.length) continue;
    if (current.runId === row.id && !current.terminal) continue;
    let replay = byRun.get(row.id);
    if (!replay && current.runId === row.id && current.terminal && hasReplayContent(current)) {
      replay = replayRun(row, current);
      if (replay) byRun.set(row.id, replay);
    }
    // A replay that can replace its saved answer owns the strip already.
    if (replay?.messageId && assistantIds.has(replay.messageId)) continue;
    if (row.assistantMessageId && assistantIds.has(row.assistantMessageId)) {
      stored.set(row.assistantMessageId, row.id);
      storedRuns.add(row.id);
      continue;
    }
    if (replay || (current.runId === row.id && !current.terminal)) continue;
    byRun.set(row.id, {
      runId: row.id,
      userMessageId: row.userMessageId,
      state: {
        ...emptyRunStream(), runId: row.id, status: row.status, terminal: true,
        error: row.error ? { message: row.error } : undefined,
        startedAt: row.startedAt ? Date.parse(row.startedAt) : undefined,
        finishedAt: row.finishedAt ? Date.parse(row.finishedAt) : undefined,
      },
    });
  }
  const order = new Map(terminalRuns.map((row, index) => [row.id, index]));
  return {
    stored, storedRuns,
    replays: [...byRun.values()].sort((a, b) => (order.get(a.runId) ?? Infinity) - (order.get(b.runId) ?? Infinity)),
  };
}
