// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { Subagent } from "@sciencediscovery/schema";

const FAILURE_STATUSES = new Set<Subagent["status"]>(["cancelled", "failed", "timed_out"]);

/** Written when a child is closed on startup because the API exited mid-task. */
export const SUBAGENT_RESTART_PLACEHOLDER_ERROR =
  "API process exited before this child finished; committed context retained, unfinished commands are not replayed";

/** Written when the store loads a record the dead API left `running`. */
export const SUBAGENT_RESTART_LOAD_PLACEHOLDER_ERROR = "Subagent interrupted by API restart before completion";

/** Both messages say the same thing: the task was cut off, not concluded. */
export const INTERRUPTION_PLACEHOLDER_ERRORS: ReadonlySet<string> = new Set([
  SUBAGENT_RESTART_PLACEHOLDER_ERROR,
  SUBAGENT_RESTART_LOAD_PLACEHOLDER_ERROR,
]);

/**
 * Reopen a finished child for a wake turn. Only the status moves: the record
 * keeps when and how the delegated task ended, so a turn that merely reads a
 * late notice cannot erase that history before it has even run.
 *
 * An interruption placeholder is the exception. It records that the API exited,
 * not how the task ended, and this turn resumes that unfinished task from the
 * committed context — so the placeholder is dropped and the turn writes the
 * outcome.
 */
export function reopenSubagentForContinuation(previous: Subagent): Subagent {
  if (!previous.interruptedByRestart) return { ...previous, status: "running" };
  const { error: _placeholderError, finishedAt: _placeholderFinishedAt, interruptedByRestart: _placeholder, ...task } = previous;
  return { ...task, status: "running" };
}

/**
 * Close a wake turn. The turn reports on work the child already finished; it
 * never rewrites how that work ended. A recorded failure therefore outranks a
 * wake turn that closed normally, while a failure inside the wake turn itself
 * is still recorded as the newest outcome.
 *
 * A child that was interrupted by an API exit has no recorded outcome to
 * protect: the continuation ran the delegated task to a conclusion, so that
 * conclusion stands on its own.
 */
export function settleSubagentContinuation(previous: Subagent, current: Subagent): Subagent {
  if (previous.interruptedByRestart) return current;
  if (!FAILURE_STATUSES.has(previous.status) || current.status !== "completed") return current;
  return { ...current, status: previous.status, ...(previous.error ? { error: previous.error } : {}) };
}
