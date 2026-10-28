// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { isAbortError } from "./client.js";
import { isAuthFailure } from "./auth.js";

/**
 * Id named by a session-miss error. An empty string means the body said
 * "Session not found" without naming which id was looked up.
 */
export function sessionMissTarget(message: string): string | undefined {
  const named = /^Session not found: (.*)$/.exec(message);
  if (named) return named[1] ?? "";
  if (message === "Session not found") return "";
  return undefined;
}

export type SessionPollMiss =
  | { kind: "unrelated" }
  | { kind: "stale" }
  | { kind: "other"; message: string }
  | { kind: "gone"; message: string };

/**
 * Decide whether a poll failure is a miss of this open session.
 * A direct session read that still succeeds means the activity (or sibling)
 * 404 was not a deletion of the page the user is looking at.
 * A 404 that names some other id is returned unchanged.
 */
export async function classifySessionPollMiss(
  client: { getSession(sessionId: string): Promise<unknown> },
  sessionId: string,
  reason: unknown,
): Promise<SessionPollMiss> {
  if (isAuthFailure(reason) || isAbortError(reason)) return { kind: "stale" };
  const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  const target = sessionMissTarget(message);
  if (target === undefined) return { kind: "unrelated" };
  if (target !== "" && target !== sessionId) return { kind: "other", message };
  try {
    await client.getSession(sessionId);
    return { kind: "stale" };
  } catch (confirm) {
    if (isAuthFailure(confirm) || isAbortError(confirm)) return { kind: "stale" };
    const confirmed = confirm instanceof Error ? sessionMissTarget(confirm.message) : undefined;
    // The follow-up read failed for some other reason. Keep the execution list
    // and show that failure instead of calling the open session missing.
    if (confirmed === undefined) {
      const message = confirm instanceof Error ? confirm.message : "Session check failed";
      return { kind: "other", message };
    }
    if (confirmed !== "" && confirmed !== sessionId) {
      return { kind: "other", message: confirm instanceof Error ? confirm.message : `Session not found: ${confirmed}` };
    }
    return { kind: "gone", message: `Session not found: ${sessionId}` };
  }
}
