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

import type {
  PermissionRequest,
  RunStreamEvent,
  SessionRun,
  SessionRunEvent,
} from "@sciencediscovery/schema";

import { mergePermissionRequestSnapshot } from "../permission-state.js";
import { reduceRunTimeline, type RunTimelineEntry } from "./RunTimeline.js";

/** Timelines of Sessions that have never streamed anything share this instance. */
export const EMPTY_TIMELINE: RunTimelineEntry[] = [];

export interface SessionRunTimeline {
  entries: RunTimelineEntry[];
  lastSequence: number;
  runId?: string;
}

export type SessionRunTimelines = Readonly<Record<string, SessionRunTimeline>>;

function eventRunId(event: RunStreamEvent): string | undefined {
  if (event.type === "run.started" || (event.type === "run.cancelled" && "runId" in event)) return event.runId;
  if (event.type === "run.queued" || event.type === "run.status") return event.run.id;
  return undefined;
}

function startsRunTimeline(event: RunStreamEvent): boolean {
  return event.type === "run.started"
    || (event.type === "run.status" && (event.status === "running" || event.status === "blocked"))
    || event.type === "agent.phase"
    || event.type === "assistant.thinking.delta"
    || event.type === "assistant.thinking.snapshot"
    || event.type === "assistant.delta"
    || event.type === "assistant.snapshot"
    || event.type === "tool.started"
    || event.type === "tool.completed"
    || event.type === "permission.required"
    || event.type === "permission.resolved";
}

/**
 * Fold one stream event into the timeline of the Session that produced it.
 *
 * A run keeps streaming while the user works in another Session, and its tool
 * and reasoning steps only exist in this buffer — the API persists the finished
 * messages, not the in-flight steps. Dropping the event because its Session is
 * off screen would leave the timeline blank when the user comes back to a run
 * that is still going.
 */
export function recordSessionTimelineEvent(
  timelines: SessionRunTimelines,
  sessionId: string,
  event: RunStreamEvent,
  options: { runId?: string; sequence?: number } = {},
): SessionRunTimelines {
  const incomingRunId = options.runId ?? eventRunId(event);
  const existing = timelines[sessionId];
  if (existing?.runId && incomingRunId && existing.runId !== incomingRunId && !startsRunTimeline(event)) {
    return timelines;
  }
  const startsNewRun = Boolean(existing?.runId && incomingRunId && existing.runId !== incomingRunId);
  const current = startsNewRun ? EMPTY_TIMELINE : existing?.entries ?? EMPTY_TIMELINE;
  const currentSequence = startsNewRun ? 0 : existing?.lastSequence ?? 0;
  if (options.sequence !== undefined && options.sequence <= currentSequence) return timelines;
  const next = reduceRunTimeline(current, event);
  const nextTimeline: SessionRunTimeline = {
    entries: next,
    lastSequence: options.sequence ?? currentSequence,
    ...(incomingRunId ?? existing?.runId ? { runId: incomingRunId ?? existing?.runId } : {}),
  };
  if (next === current
    && nextTimeline.lastSequence === existing?.lastSequence
    && nextTimeline.runId === existing?.runId) return timelines;
  return { ...timelines, [sessionId]: nextTimeline };
}

/** Start one Session's timeline over without touching what other Sessions buffered. */
export function clearSessionTimeline(timelines: SessionRunTimelines, sessionId: string): SessionRunTimelines {
  if (!timelines[sessionId]?.entries.length) return timelines;
  return { ...timelines, [sessionId]: { entries: EMPTY_TIMELINE, lastSequence: 0 } };
}

export function selectSessionReplayRun(runs: SessionRun[]): SessionRun | undefined {
  const newestFirst = runs.toSorted((left, right) =>
    right.queueOrder - left.queueOrder || right.createdAt.localeCompare(left.createdAt));
  return newestFirst.find((run) => run.status === "running" || run.status === "blocked")
    ?? newestFirst.find((run) => run.status !== "queued");
}

export function hydrateSessionRunTimeline(
  timelines: SessionRunTimelines,
  sessionId: string,
  run: SessionRun,
  records: SessionRunEvent[],
): SessionRunTimelines {
  const ordered = records.toSorted((left, right) => left.sequence - right.sequence);
  const current = timelines[sessionId];
  if (current?.runId === run.id) {
    const pending = ordered.filter((record) => record.sequence > current.lastSequence);
    if (!pending.length) return timelines;
    const merged = pending.reduce<SessionRunTimeline>((timeline, record) => ({
      entries: reduceRunTimeline(timeline.entries, record.event),
      lastSequence: Math.max(timeline.lastSequence, record.sequence),
      runId: run.id,
    }), current);
    return { ...timelines, [sessionId]: merged };
  }
  const replay = ordered
    .reduce<SessionRunTimeline>((timeline, record) => ({
      entries: reduceRunTimeline(timeline.entries, record.event),
      lastSequence: Math.max(timeline.lastSequence, record.sequence),
      runId: run.id,
    }), { entries: [], lastSequence: 0, runId: run.id });
  return { ...timelines, [sessionId]: replay };
}

/**
 * Requests already visible as timeline cards are filtered out of the pending
 * approvals panel, whether the card arrived from the live stream or a replay.
 */
export function collectTimelinePermissionRequestIds(entries: RunTimelineEntry[]): Set<string> {
  return new Set(entries.flatMap((entry) => entry.type === "permission" ? [entry.request.id] : []));
}

/** Replaces permission snapshots without waiting for the run event stream to catch up. */
export function reconcilePermissionTimeline(
  timeline: SessionRunTimeline,
  requests: readonly PermissionRequest[],
): SessionRunTimeline {
  const byId = new Map(requests.map((request) => [request.id, request]));
  let changed = false;
  const entries = timeline.entries.map((entry) => {
    if (entry.type !== "permission") return entry;
    const request = byId.get(entry.request.id);
    if (!request || request === entry.request) return entry;
    const merged = mergePermissionRequestSnapshot(entry.request, request);
    if (merged === entry.request) return entry;
    changed = true;
    return { ...entry, request: merged };
  });
  return changed ? { ...timeline, entries } : timeline;
}

export function reconcileSessionTimelinePermissions(
  timelines: SessionRunTimelines,
  sessionId: string,
  requests: readonly PermissionRequest[],
): SessionRunTimelines {
  const timeline = timelines[sessionId];
  if (!timeline) return timelines;
  const reconciled = reconcilePermissionTimeline(timeline, requests);
  return reconciled === timeline ? timelines : { ...timelines, [sessionId]: reconciled };
}

/**
 * Rebuild the timeline of every finished run so a refreshed Session shows the
 * same step cards in the same places. Runs whose replay is already up to date
 * keep their entry objects, preserving manual disclosure state.
 */
export function hydrateTerminalRunTimelines(
  current: Readonly<Record<string, SessionRunTimeline>>,
  terminalRuns: SessionRun[],
  eventsByRun: Readonly<Record<string, SessionRunEvent[]>>,
): Record<string, SessionRunTimeline> {
  const next: Record<string, SessionRunTimeline> = {};
  for (const run of terminalRuns) {
    const records = eventsByRun[run.id];
    if (!records?.length) continue; // recorded before event persistence existed
    const ordered = records.toSorted((left, right) => left.sequence - right.sequence);
    const lastSequence = ordered.at(-1)?.sequence ?? 0;
    const existing = current[run.id];
    if (existing && existing.lastSequence >= lastSequence) {
      next[run.id] = existing;
      continue;
    }
    next[run.id] = ordered.reduce<SessionRunTimeline>((timeline, record) => ({
      entries: reduceRunTimeline(timeline.entries, record.event),
      lastSequence: Math.max(timeline.lastSequence, record.sequence),
      runId: run.id,
    }), { entries: [], lastSequence: 0, runId: run.id });
  }
  return next;
}
