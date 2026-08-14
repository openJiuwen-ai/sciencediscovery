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

import type { TimeoutKind } from "@science-agent/schema";

export function timeoutFailure(error: unknown): { kind: TimeoutKind; reason: string; timeoutMs: number } | undefined {
  const reason = error instanceof Error ? error.message : String(error);
  const patterns: Array<[TimeoutKind, RegExp]> = [
    ["gateway_idle", /no gateway progress for (\d+) ms/i],
    ["gateway_turn", /gateway turn exceeded (\d+) ms/i],
    ["permission_wait", /permission wait timed out after (\d+) ms/i],
    ["runner_exec", /(?:execution|evaluation) timed out after (\d+) ms/i],
    ["kernel_idle", /kernel idle timeout after (\d+) ms/i],
  ];
  for (const [kind, pattern] of patterns) {
    const match = reason.match(pattern);
    if (match) return { kind, reason, timeoutMs: Number(match[1]) };
  }
  return undefined;
}

export function timeoutMessage(timeout: { kind: TimeoutKind; reason: string; timeoutMs: number }): string {
  const labels: Record<TimeoutKind, string> = {
    gateway_idle: "Agent idle",
    gateway_turn: "Agent turn",
    kernel_idle: "Kernel idle",
    permission_wait: "Permission wait",
    runner_exec: "Runner execution",
  };
  const duration = timeout.timeoutMs % 1000 === 0
    ? `${timeout.timeoutMs / 1000} seconds`
    : `${timeout.timeoutMs} milliseconds`;
  return `Request stopped because the ${labels[timeout.kind]} timeout was reached after ${duration}. ${timeout.reason}`;
}
