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

import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { DIAGNOSTIC_LOG_LINES, diagnosticText, type DiagnosticIds, type DiagnosticSnapshot } from "@sciencediscovery/operational-logging/diagnostics";

const TAIL_BYTES = 64 * 1024;
const ID = /^[a-zA-Z0-9_.:-]{1,96}$/;
const FIELDS = new Set(["event", "requestId", "runId", "sessionId", "status", "statusCode", "durationMs", "errorCode", "errorName"]);

export function diagnosticIds(params: URLSearchParams): DiagnosticIds | undefined {
  const ids: DiagnosticIds = {};
  for (const key of ["requestId", "runId", "sessionId"] as const) {
    const value = params.get(key);
    if (value !== null) {
      if (!ID.test(value)) return undefined;
      ids[key] = value;
    }
  }
  return ids;
}

/** Read a fixed tail only. Paths and byte/line limits cannot be selected by clients. */
async function logTail(path: string): Promise<string[]> {
  try {
    const file = await open(path, "r");
    try {
      const size = (await file.stat()).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (start) lines.shift();
      return lines;
    } finally { await file.close(); }
  } catch { return []; }
}

/** Export metadata, never arbitrary log text, prompts, tool I/O or error payloads. */
export function diagnosticLogLine(line: string, ids: DiagnosticIds): string | undefined {
  const prefix = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (DEBUG|INFO|WARN|ERROR) \[([a-z0-9-]+)\] /.exec(line);
  if (!prefix) return undefined;
  const fields: Record<string, string> = {};
  for (const match of line.slice(prefix[0].length).matchAll(/(?:^|\s)([a-zA-Z][a-zA-Z0-9]*)=("(?:\\.|[^"\\])*"|[^\s]+)/g)) {
    try {
      const value: unknown = match[2]!.startsWith('"') ? JSON.parse(match[2]!) : match[2];
      if (typeof value === "string") fields[match[1]!] = value;
    } catch { /* Partial tail records carry no usable evidence. */ }
  }
  // The most specific correlation wins: never mix a different request in the same Session.
  const key = ids.requestId ? "requestId" : ids.runId ? "runId" : ids.sessionId ? "sessionId" : undefined;
  if (!key || fields[key] !== ids[key]) return undefined;
  const metadata = Object.entries(fields).filter(([key, value]) => FIELDS.has(key) && ID.test(value));
  return diagnosticText(`${prefix[0]}${metadata.map(([key, value]) => `${key}=${value}`).join(" ")}`, 350);
}

export async function errorDiagnosticSnapshot(logPaths: string[], ids: DiagnosticIds): Promise<DiagnosticSnapshot> {
  if (!ids.requestId && !ids.runId && !ids.sessionId) return { logs: [], logStatus: "unavailable" };
  const tails = await Promise.all(logPaths.map(logTail));
  const logs = tails.flatMap(lines => lines.flatMap(line => {
    const safe = diagnosticLogLine(line, ids);
    return safe ? [safe] : [];
  })).sort().slice(-DIAGNOSTIC_LOG_LINES);
  return { logs, logStatus: logs.length ? "available" : "unavailable" };
}

export function diagnosticLogPaths(dataDir: string, apiPath: string, runPath: string): string[] {
  const logDir = apiPath ? dirname(apiPath) : resolve(dataDir, "logs");
  return [apiPath || resolve(logDir, "api.log"), runPath || resolve(logDir, "run.log"), resolve(logDir, "runner.log")];
}
