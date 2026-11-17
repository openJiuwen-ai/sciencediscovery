// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
import type { RunnerBlockedResult } from "@sciencediscovery/schema";

/** A failed pre-dispatch call, never a queued or automatically replayed job. */
export class RunnerUnavailableError extends Error {
  constructor(readonly result: RunnerBlockedResult) {
    super(JSON.stringify(result));
    this.name = "RunnerUnavailableError";
  }
}

/** Project a pre-dispatch failure without repeating the Runner's capability
 * snapshot. Keep diagnostics on real lines, like Shell stdout/stderr, so they
 * remain readable and can be paged by the shared tool-output bounder.
 * The original result stays in tool details for audit and recovery. */
export function runnerBlockedModelText(result: RunnerBlockedResult): string {
  const { runner } = result;
  const reason = runner.reason.trim();
  // `ready` on the check result is route-scoped (for a Shell call it is the
  // Shell verdict). `readyFor` carries the independent routes, so a dead
  // managed Shell must not make a usable Python channel look dead.
  const pythonReady = runner.readyFor?.python ?? runner.capability?.ready;
  const shellAvailable = runner.readyFor?.shell ?? runner.capability?.shell?.available;
  const suggestions = [...new Set(runner.suggestions.map(suggestion => {
    const text = suggestion.trim();
    // Existing readiness producers prefix repair advice with the same detail
    // already used as the reason. Remove only that exact duplicate prefix.
    if (text === reason) return "";
    return reason && text.startsWith(`${reason}. `)
      ? text.slice(reason.length + 2).trim() : text;
  }).filter(Boolean))];
  return [
    JSON.stringify({
      code: result.code,
      dispatched: result.dispatched,
      operationId: result.operationId,
      runner: {
        runnerId: runner.runnerId,
        connected: runner.connected,
        ready: runner.ready,
        ...(pythonReady !== undefined ? { pythonReady } : {}),
        ...(shellAvailable !== undefined ? { shellAvailable } : {}),
      },
    }),
    "reason:", reason,
    ...(suggestions.length ? ["suggestions:", ...suggestions.map(value => `- ${value}`)] : []),
    "No code was dispatched or queued. Python readiness is independent; python through run_shell still needs Bash. Continue other work, explain the blocker and finish, or call wait_for_runner(operation_id) if choosing to wait for user help; text alone does not wait. Respect the user's constraints. Checking or waiting executes nothing; use a new execution call after repair. Do not retry unchanged failures.",
  ].join("\n");
}
