// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentStateRef } from "@sciencediscovery/cas";

/** Events own time/order; immutable objects own potentially large contents. */
export interface JournalEvent {
  schemaVersion: 1;
  agentId: string;
  runId: string;
  requestExecutionId: string;
  sequence: number;
  recordedAt: string;
  type: string;
  turn?: number;
  responseId?: string;
  callId?: string;
  kind?: string;
  contextRef?: AgentStateRef;
  stateRef?: AgentStateRef;
  payloadRef: AgentStateRef;
}
const key = (id: string) => Buffer.from(id).toString("base64url");
const agentDirectory = (dataDir: string, agentId: string) => join(dataDir, "trajectories", key(agentId));

/** Read-only compatibility for previously recorded independent journals. */
export async function readAgentJournal(dataDir: string, agentId: string, signal: AbortSignal): Promise<{ events: JournalEvent[]; warnings: string[] }> {
  const directory = agentDirectory(dataDir, agentId), events: JournalEvent[] = [], warnings: string[] = [];
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events, warnings }; throw error; }
  for (const file of files.filter(name => /^[A-Za-z0-9_-]+\.jsonl$/.test(name)).sort()) {
    signal.throwIfAborted();
    const text = await readFile(join(directory, file), "utf8");
    const lines = text.split("\n"), tail = lines.pop();
    if (tail) warnings.push("An unfinished journal tail was ignored; refresh after the writer finishes.");
    let previous = 0, previousTime = -Infinity;
    for (const line of lines) {
      signal.throwIfAborted();
      try {
        const event = JSON.parse(line) as JournalEvent;
        if (event.schemaVersion !== 1 || event.agentId !== agentId || `${key(event.runId)}.jsonl` !== file
          || typeof event.requestExecutionId !== "string" || !event.requestExecutionId
          || !Number.isSafeInteger(event.sequence) || event.sequence <= previous || typeof event.type !== "string"
          || typeof event.recordedAt !== "string" || !Number.isFinite(Date.parse(event.recordedAt)) || !event.payloadRef) throw new Error("Invalid journal entry");
        if (event.sequence !== previous + 1) warnings.push("A journal sequence gap was detected; some events are missing.");
        if (Date.parse(event.recordedAt) < previousTime) warnings.push("A producer clock moved backwards; list order follows sequence and the axis retains recorded wall time.");
        previous = event.sequence;
        previousTime = Date.parse(event.recordedAt);
        events.push(event);
      } catch { warnings.push("An invalid journal entry was omitted; this trajectory is incomplete."); }
    }
  }
  return { events, warnings };
}
