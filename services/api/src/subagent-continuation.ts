// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { Subagent } from "@sciencediscovery/schema";

const FAILURE_STATUSES = new Set<Subagent["status"]>(["cancelled", "failed", "timed_out"]);

/**
 * Reopen a finished child for a wake turn. Only the status moves: the record
 * keeps when and how the delegated task ended, so a turn that merely reads a
 * late notice cannot erase that history before it has even run.
 */
export function reopenSubagentForContinuation(previous: Subagent): Subagent {
  return { ...previous, status: "running" };
}

/**
 * Close a wake turn. The turn reports on work the child already finished; it
 * never rewrites how that work ended. A recorded failure therefore outranks a
 * wake turn that closed normally, while a failure inside the wake turn itself
 * is still recorded as the newest outcome.
 */
export function settleSubagentContinuation(previous: Subagent, current: Subagent): Subagent {
  if (!FAILURE_STATUSES.has(previous.status) || current.status !== "completed") return current;
  return { ...current, status: previous.status, ...(previous.error ? { error: previous.error } : {}) };
}
