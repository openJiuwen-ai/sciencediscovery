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
 * Stable failure classes for an agent run.
 *
 * Callers (UI, logs, retry policy) need a code they can branch on without
 * pattern-matching provider prose. The classification is derived from the
 * error, never a replacement for it: the original message — including the
 * provider's own response text — is preserved and surfaced alongside the code,
 * so a failing run stays diagnosable.
 */

import type { RunFailureCode } from "@science-agent/schema";

/** Classify a run error into a stable code. The message is never consumed. */
export function classifyRunFailure(error: unknown): RunFailureCode {
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  // The idle-stall wording ("Agent run stalled: no ... progress for N ms")
  // carries no "timeout" substring, so match the stall phrasing explicitly.
  if (["timed out", "timeout", "stalled", "no gateway progress"].some((marker) => message.includes(marker))) {
    return "timeout";
  }
  if (message.includes("401") || message.includes("403") || message.includes("unauthor") || message.includes("forbidden")) {
    return "unauthorized";
  }
  if (message.includes("429") || message.includes("rate limit") || message.includes("too many requests")) {
    return "rate-limited";
  }
  if (["500", "502", "503", "504", "server error", "service unavailable"].some((marker) => message.includes(marker))) {
    return "server-error";
  }
  if (["econnrefused", "econnreset", "enotfound", "socket hang up", "network", "transport", "is unavailable", "broken pipe"]
    .some((marker) => message.includes(marker))) {
    return "transport-error";
  }
  return "semantic-error";
}

/** The original failure text, preserved verbatim for the user and the record. */
export function runFailureMessage(error: unknown): string {
  // Never stringify an Error: `String(new Error(""))` is the useless "Error".
  if (error instanceof Error) return error.message.trim() || "Agent run failed";
  const text = String(error ?? "").trim();
  return text || "Agent run failed";
}
