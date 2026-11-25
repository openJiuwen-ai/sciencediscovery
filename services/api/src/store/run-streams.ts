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

import type { SessionRunEvent } from "@sciencediscovery/schema";

/** Root stream of a run's timeline; tool/subagent child streams sit beside it. */
export const MAIN_RUN_STREAM = "main";

export interface RunStreamLine {
  createdAt: string;
  event: SessionRunEvent["event"];
  sequence: number;
}

/** Parse one JSONL record, or undefined when the line is blank or torn. */
export function parseStreamLine(line: string): RunStreamLine | undefined {
  if (!line) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined; // Ignore a torn tail left by a crash mid-write.
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { sequence, createdAt, event } = parsed as Record<string, unknown>;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0 || typeof createdAt !== "string") return undefined;
  if (!event || typeof event !== "object" || Array.isArray(event) || !("type" in event) || typeof event.type !== "string") return undefined;
  return { sequence, createdAt, event: event as RunStreamLine["event"] };
}

export function parseStreamLines(content: string): RunStreamLine[] {
  const records: RunStreamLine[] = [];
  for (const line of content.split("\n")) {
    const parsed = parseStreamLine(line);
    if (parsed) records.push(parsed);
  }
  return records;
}

export function assertValidStreamId(streamId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(streamId)) throw new Error("Invalid run stream id");
}
