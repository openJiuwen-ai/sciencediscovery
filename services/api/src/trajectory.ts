// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { openSessionTrajectory, type RecordedEvent } from "@sciencediscovery/trajectory/server";
import { object, redact, type TrajectoryAgent, type TrajectoryDetail } from "@sciencediscovery/trajectory";
import type { SessionStore } from "./store.js";
import { readPackageTrajectory } from "./research-package-trajectory.js";

/**
 * How many recorded Run events this view may hold while it is built.
 *
 * The builder below appends every event of every Run, of every agent stream and
 * every `tool-<id>` stream, and hands the whole array to `openSessionTrajectory`,
 * which keeps it for the life of the request (#1063, one layer above the
 * whole-stream reads #1061 fixed). A long research session therefore became one
 * unbounded array. It is bounded now: past the budget the oldest events are
 * dropped as newer ones arrive, and the trajectory index carries a warning
 * naming how many were left out, so the view is honest about being a tail
 * instead of pretending the session was shorter.
 *
 * What the index is built from — committed steps, event segments, journals and
 * contexts — is read from CAS, not from this array, so the newest work stays
 * complete and the warning is the only visible difference.
 */
export const TRAJECTORY_MAX_EVENTS_ENV = "SCIENCE_AGENT_TRAJECTORY_MAX_EVENTS";
export const DEFAULT_TRAJECTORY_MAX_EVENTS = 120_000;
export const MIN_TRAJECTORY_MAX_EVENTS = 1_000;
export const MAX_TRAJECTORY_MAX_EVENTS = 5_000_000;

/** Trim in blocks: a per-event `splice` would make appending quadratic. */
const TRAJECTORY_TRIM_BLOCK = 4_096;

export function trajectoryMaxEvents(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TRAJECTORY_MAX_EVENTS_ENV]?.trim();
  if (!raw) return DEFAULT_TRAJECTORY_MAX_EVENTS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_TRAJECTORY_MAX_EVENTS || value > MAX_TRAJECTORY_MAX_EVENTS) {
    throw new Error(`${TRAJECTORY_MAX_EVENTS_ENV} must be an integer between ${MIN_TRAJECTORY_MAX_EVENTS} and ${MAX_TRAJECTORY_MAX_EVENTS}, received "${raw}"`);
  }
  return value;
}

/** The authenticated API host resolves ownership. The component never imports SessionStore. */
export async function sessionTrajectory(
  store: SessionStore,
  sessionId: string,
  signal: AbortSignal,
  options: { maxEvents?: number } = {},
) {
  const maxEvents = options.maxEvents ?? trajectoryMaxEvents();
  const archived = await readPackageTrajectory(store.dataDir, sessionId);
  const archivedRuns = new Set(archived?.runIds ?? []);
  const agentAliases: Record<string, string> = Object.create(null);
  const mainId = `main:${sessionId}`, children = store.listSubagents(sessionId);
  const agents: TrajectoryAgent[] = [{ id: mainId, label: "Main Agent" }, ...children.map(child => ({
    id: `subagent:${child.id}`, label: child.input.description || child.id, parentId: mainId, parentRunId: child.parentTurnId,
  }))];
  const events: RecordedEvent[] = [];
  let omittedEvents = 0;
  // Trim in blocks so appending stays amortised constant; the exact budget is
  // restored once, after the last event is collected.
  const block = Math.max(1, Math.min(TRAJECTORY_TRIM_BLOCK, maxEvents));
  const keep = (recorded: RecordedEvent) => {
    events.push(recorded);
    if (events.length > maxEvents + block) {
      const drop = events.length - maxEvents;
      events.splice(0, drop);
      omittedEvents += drop;
    }
  };
  const recordedSteps = new Set<string>();
  for (const run of await store.listSessionRuns(sessionId)) {
    if (archivedRuns.has(run.id)) continue;
    signal.throwIfAborted();
    const streams = [{ id: "main", agentId: mainId }, ...children.map(child => ({ id: `subagent-${child.id}`, agentId: `subagent:${child.id}` }))];
    const tools = new Map<string, string>();
    for (const stream of streams) {
      for (const record of await store.listRunStreamEvents(sessionId, run.id, stream.id)) {
        let event = object(record.event);
        const evidence = object(event.evidence);
        // Older packages preserved source identities inside immutable CAS records.
        // Alias only this authorized stream's owner, never scan the source Agent's refs.
        if (store.getSession(sessionId)?.researchSnapshot && typeof evidence.agentId === "string" && evidence.agentId !== stream.agentId
          && archived?.access?.agentAliases[evidence.agentId] === stream.agentId
          && archived.access.refs.includes(`${String(object(evidence.contextRef).pool)}:${String(object(evidence.contextRef).digest)}`)) {
          agentAliases[evidence.agentId] = stream.agentId;
          event = { ...event, evidence: { ...evidence, agentId: stream.agentId } };
        }
        const trace = object(event.trace), step = object(event.step);
        if (typeof step.id === "string") recordedSteps.add(`${stream.agentId}:${step.id}`);
        const toolId = trace.id ?? trace.toolCallId ?? step.toolCallId;
        if (typeof toolId === "string") tools.set(toolId, stream.agentId);
        keep({ id: `${run.id}:${stream.id}:${record.sequence}`, agentId: stream.agentId, streamId: stream.id, sequence: record.sequence, createdAt: record.createdAt, runId: run.id, event });
      }
    }
    for (const [id, agentId] of tools) {
      for (const record of await store.listRunStreamEvents(sessionId, run.id, `tool-${id}`)) {
        keep({ id: `${run.id}:tool-${id}:${record.sequence}`, agentId, streamId: `tool-${id}`, sequence: record.sequence, createdAt: record.createdAt, runId: run.id, event: record.event });
      }
    }
  }
  for (const child of children) {
    if (archivedRuns.has(child.parentTurnId)) continue;
    for (const step of child.steps) {
      const agentId = `subagent:${child.id}`;
      if (recordedSteps.has(`${agentId}:${step.id}`)) continue;
      keep({ id: `subagent-step:${child.id}:${step.id}`, agentId, createdAt: step.createdAt, runId: child.parentTurnId,
        event: { type: "subagent.step", subagentId: child.id, step } });
    }
  }
  for (const invocation of await store.listMcpInvocations(sessionId)) {
    if (archivedRuns.has(invocation.turnId)) continue;
    const owners = children.filter(item => item.parentTurnId === invocation.turnId && item.steps.some(step => step.toolCallId === invocation.toolCallId));
    const child = owners.length === 1 ? owners[0] : undefined;
    keep({ id: `mcp:${invocation.id}`, agentId: child ? `subagent:${child.id}` : mainId,
      createdAt: invocation.startedAt, runId: invocation.turnId, event: { type: "mcp.invocation", ...invocation } });
  }
  if (events.length > maxEvents) {
    const drop = events.length - maxEvents;
    events.splice(0, drop);
    omittedEvents += drop;
  }
  const live = await openSessionTrajectory(store.dataDir, { sessionId, agents, events, agentAliases }, signal);
  // The warning travels with the index, which the viewer already renders as its
  // "recording completeness" list, so a bounded view cannot be mistaken for a
  // short session.
  if (omittedEvents > 0) {
    live.index.warnings.push(`Only the newest ${maxEvents.toLocaleString("en-US")} recorded Run events are shown; ${omittedEvents.toLocaleString("en-US")} older events were left out to keep this view within its budget. Raise ${TRAJECTORY_MAX_EVENTS_ENV} to include more.`);
  }
  if (!archived) return live;
  const untimed = [...(archived.index.untimedEntries ?? archived.index.historicalEntries ?? []), ...(live.index.untimedEntries ?? [])];
  const index = { ...live.index, agents: [...new Map([...archived.index.agents, ...live.index.agents].map((agent) => [agent.id, agent])).values()],
    entries: [...archived.index.entries, ...live.index.entries], untimedEntries: untimed, historicalEntries: untimed,
    warnings: [...new Set([...archived.index.warnings, ...live.index.warnings])] };
  const saved = new Map(archived.details.map((detail) => [detail.entry.id, detail]));
  const detail = async (id: string): Promise<TrajectoryDetail | undefined> => {
    signal.throwIfAborted();
    const archivedDetail = saved.get(id);
    return archivedDetail ? redact(archivedDetail) as TrajectoryDetail : await live.detail(id);
  };
  async function* exportRecords() {
    yield JSON.stringify({ type: "trajectory", ...index }) + "\n";
    for (const entry of [...index.entries, ...untimed]) yield JSON.stringify({ type: "entry", ...await detail(entry.id) }) + "\n";
    yield JSON.stringify({ type: "complete", entries: index.entries.length + untimed.length, capturedAt: index.capturedAt }) + "\n";
  }
  return { index, detail, exportRecords };
}
