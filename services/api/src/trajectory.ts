// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { openSessionTrajectory, type RecordedEvent } from "@sciencediscovery/trajectory/server";
import { object, type TrajectoryAgent } from "@sciencediscovery/trajectory";
import type { SessionStore } from "./store.js";

/** The authenticated API host resolves ownership. The component never imports SessionStore. */
export async function sessionTrajectory(store: SessionStore, sessionId: string, signal: AbortSignal) {
  const mainId = `main:${sessionId}`, children = store.listSubagents(sessionId);
  const agents: TrajectoryAgent[] = [{ id: mainId, label: "Main Agent" }, ...children.map(child => ({
    id: `subagent:${child.id}`, label: child.input.description || child.id, parentId: mainId, parentRunId: child.parentTurnId,
  }))];
  const events: RecordedEvent[] = [];
  const recordedSteps = new Set<string>();
  for (const run of await store.listSessionRuns(sessionId)) {
    signal.throwIfAborted();
    const streams = [{ id: "main", agentId: mainId }, ...children.map(child => ({ id: `subagent-${child.id}`, agentId: `subagent:${child.id}` }))];
    const tools = new Map<string, string>();
    for (const stream of streams) {
      for (const record of await store.listRunStreamEvents(sessionId, run.id, stream.id)) {
        const event = object(record.event), trace = object(event.trace), step = object(event.step);
        if (typeof step.id === "string") recordedSteps.add(`${stream.agentId}:${step.id}`);
        const toolId = trace.id ?? trace.toolCallId ?? step.toolCallId;
        if (typeof toolId === "string") tools.set(toolId, stream.agentId);
        events.push({ id: `${run.id}:${stream.id}:${record.sequence}`, agentId: stream.agentId, streamId: stream.id, sequence: record.sequence, createdAt: record.createdAt, runId: run.id, event });
      }
    }
    for (const [id, agentId] of tools) {
      for (const record of await store.listRunStreamEvents(sessionId, run.id, `tool-${id}`)) {
        events.push({ id: `${run.id}:tool-${id}:${record.sequence}`, agentId, streamId: `tool-${id}`, sequence: record.sequence, createdAt: record.createdAt, runId: run.id, event: record.event });
      }
    }
  }
  for (const child of children) {
    for (const step of child.steps) {
      const agentId = `subagent:${child.id}`;
      if (recordedSteps.has(`${agentId}:${step.id}`)) continue;
      events.push({ id: `subagent-step:${child.id}:${step.id}`, agentId, createdAt: step.createdAt, runId: child.parentTurnId,
        event: { type: "subagent.step", subagentId: child.id, step } });
    }
  }
  for (const invocation of await store.listMcpInvocations(sessionId)) {
    const owners = children.filter(item => item.parentTurnId === invocation.turnId && item.steps.some(step => step.toolCallId === invocation.toolCallId));
    const child = owners.length === 1 ? owners[0] : undefined;
    events.push({ id: `mcp:${invocation.id}`, agentId: child ? `subagent:${child.id}` : mainId,
      createdAt: invocation.startedAt, runId: invocation.turnId, event: { type: "mcp.invocation", ...invocation } });
  }
  return openSessionTrajectory(store.dataDir, { sessionId, agents, events }, signal);
}
