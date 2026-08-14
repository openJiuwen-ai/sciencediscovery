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

import type { SessionRunEvent } from "@science-agent/schema";

/** Root stream of a run's timeline; tool/subagent child streams sit beside it. */
export const MAIN_RUN_STREAM = "main";

export interface RunStreamLine {
  createdAt: string;
  event: SessionRunEvent["event"];
  sequence: number;
}

export function parseStreamLines(content: string): RunStreamLine[] {
  const records: RunStreamLine[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    let parsed: RunStreamLine;
    try {
      parsed = JSON.parse(line) as RunStreamLine;
    } catch {
      continue; // Ignore a torn tail left by a crash mid-write.
    }
    if (typeof parsed.sequence !== "number" || typeof parsed.createdAt !== "string" || !parsed.event) continue;
    records.push(parsed);
  }
  return records;
}

export function assertValidStreamId(streamId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(streamId)) throw new Error("Invalid run stream id");
}
