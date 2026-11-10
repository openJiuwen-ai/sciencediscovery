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
 * Forwards one Evolve score onto the conversation's selected runner.
 *
 * The sidecar holds a run-scoped bearer for this path and nothing else. The
 * runner token and the clock offset stay in the API's RunnerClient. Cards,
 * the permission epoch, and the workspace come from the session at submission
 * time, not from the sidecar. Later status/cancel calls stay on that runner.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ExecutionOwner, PermissionEpoch, ShellExecutionRequest } from "@sciencediscovery/schema";

import { readJson } from "../http/body.js";
import { sendError, sendJson } from "../http/response.js";
import { remoteWorkspaceKey } from "../remote-runner.js";

interface RunnerGrant {
  executions: Map<string, string>;
  runId: string;
  sessionId: string;
  timeoutSeconds: number;
  token: string;
}

/** Tokens that may call the evolve-runner path. Separate from the model token. */
export class RunnerGrantRegistry {
  private readonly grants = new Map<string, RunnerGrant>();

  issue(runId: string, sessionId: string, timeoutSeconds: number): string {
    const token = randomBytes(32).toString("base64url");
    this.grants.set(runId, { executions: new Map(), runId, sessionId, timeoutSeconds, token });
    return token;
  }

  revoke(runId: string): void {
    this.grants.delete(runId);
  }

  resolve(runId: string, presented: string | undefined): RunnerGrant | undefined {
    if (!presented) return undefined;
    const grant = this.grants.get(runId);
    if (!grant) return undefined;
    const actual = Buffer.from(presented);
    const expected = Buffer.from(grant.token);
    if (expected.length !== actual.length) return undefined;
    return timingSafeEqual(expected, actual) ? grant : undefined;
  }
}

export interface EvolveRunnerSession {
  effectiveRunnerIds(sessionId: string): string[];
  getRemoteHost(hostId: string): { workspaceNamespace?: string } | undefined;
  getSession(sessionId: string): { projectId: string } | undefined;
  getSessionPermissionEpoch(sessionId: string): PermissionEpoch | undefined;
  npuDeviceSelection(runnerId: string): number[];
  workspacePath(sessionId: string): string;
}

export interface EvolveRunnerCaller {
  cancelShellExecution(id: string, owner: ExecutionOwner): Promise<unknown>;
  getShellExecution(id: string, owner: ExecutionOwner): Promise<unknown>;
  startShellExecution(request: ShellExecutionRequest): Promise<unknown>;
}

export interface EvolveRunnerDeps {
  grants: RunnerGrantRegistry;
  runnerClient(runnerId: string): EvolveRunnerCaller;
  sessions: EvolveRunnerSession;
}

/** The first selected remote runner that is connected, or why there is none. */
export function connectedRunner(
  ids: readonly string[],
  connected: (id: string) => boolean,
): { runnerId: string } | { error: string } {
  const remote = ids.filter((id) => id !== "local");
  if (!remote.length) return { error: "this conversation has no remote runner selected" };
  for (const id of remote) {
    if (connected(id)) return { runnerId: id };
  }
  return { error: "the selected runner is not connected" };
}

/** Shell that runs the fixed Python program. The candidate is already bound in the source. */
export function shellForFixedProgram(pythonSource: string): string {
  const encoded = Buffer.from(pythonSource, "utf8").toString("base64");
  return `python3 -c 'import base64; exec(base64.b64decode("${encoded}"))'\n`;
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

function ownerOf(grant: RunnerGrant, search: URLSearchParams): ExecutionOwner | { error: string } {
  const sessionId = search.get("sessionId") ?? grant.sessionId;
  const agentId = search.get("agentId") ?? "evolve";
  if (sessionId !== grant.sessionId || agentId !== "evolve") {
    return { error: "this token does not belong to that session" };
  }
  return { agentId, sessionId };
}

function placement(deps: EvolveRunnerDeps, grant: RunnerGrant): {
  cards: number[];
  epoch: PermissionEpoch;
  runnerId: string;
  workspaceKey: string;
  workspaceRoot: string;
} | { error: string } {
  const session = deps.sessions.getSession(grant.sessionId);
  if (!session) return { error: "this conversation no longer exists" };
  const picked = connectedRunner(deps.sessions.effectiveRunnerIds(grant.sessionId), (id) => {
    try {
      deps.runnerClient(id);
      return true;
    } catch {
      return false;
    }
  });
  if ("error" in picked) return picked;
  const host = deps.sessions.getRemoteHost(picked.runnerId);
  if (!host) return { error: "the selected runner is not connected" };
  const cards = deps.sessions.npuDeviceSelection(picked.runnerId);
  if (!cards.length) return { error: "tick at least one NPU card on the selected runner" };
  const epoch = deps.sessions.getSessionPermissionEpoch(grant.sessionId);
  if (!epoch) return { error: "this conversation has no permission epoch" };
  return {
    cards,
    epoch,
    runnerId: picked.runnerId,
    workspaceKey: remoteWorkspaceKey(session.projectId, grant.sessionId, host.workspaceNamespace),
    workspaceRoot: deps.sessions.workspacePath(grant.sessionId),
  };
}

/**
 * Handle `/internal/evolve-runner/{runId}/shell-executions...`.
 * Returns false when the path is not this proxy.
 */
export async function handleEvolveRunner(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: EvolveRunnerDeps,
): Promise<boolean> {
  const match = url.pathname.match(
    /^\/internal\/evolve-runner\/([^/]+)\/shell-executions(?:\/([^/]+)(?:\/(cancel))?)?$/,
  );
  if (!match) return false;
  const runId = decodeURIComponent(match[1]!);
  const executionId = match[2] ? decodeURIComponent(match[2]) : undefined;
  const cancel = match[3] === "cancel";
  const grant = deps.grants.resolve(runId, bearer(request));
  if (!grant) {
    sendError(response, 401, "Unauthorized");
    return true;
  }
  const owner = ownerOf(grant, url.searchParams);
  if ("error" in owner) {
    sendError(response, 403, owner.error);
    return true;
  }
  try {
    if (!executionId && request.method === "POST") {
      const body = await readJson<{ code?: unknown; executionId?: unknown }>(request);
      if (typeof body.code !== "string" || !body.code.trim() || typeof body.executionId !== "string" || !body.executionId) {
        sendError(response, 400, "an NPU execution needs code and a new execution id");
        return true;
      }
      if (grant.executions.has(body.executionId)) {
        sendError(response, 409, "this execution id was already submitted");
        return true;
      }
      const where = placement(deps, grant);
      if ("error" in where) {
        sendError(response, 409, where.error);
        return true;
      }
      const caller = deps.runnerClient(where.runnerId);
      // Bind before sending: a lost response does not prove the runner never
      // accepted the job. Keep its status/cancel route even after an error.
      grant.executions.set(body.executionId, where.runnerId);
      const submitted = await caller.startShellExecution({
        agentId: "evolve",
        code: shellForFixedProgram(body.code),
        executionId: body.executionId,
        executionTimeoutMs: Math.max(1, grant.timeoutSeconds) * 1000,
        kernelMode: "ephemeral",
        npuDevices: where.cards,
        permissionEpoch: where.epoch,
        runnerWorkspaceKey: where.workspaceKey,
        workspaceRoot: where.workspaceRoot,
      });
      sendJson(response, 202, submitted);
      return true;
    }
    if (executionId && ((!cancel && request.method === "GET") || (cancel && request.method === "POST"))) {
      const runnerId = grant.executions.get(executionId);
      if (!runnerId) {
        sendError(response, 404, "this execution does not belong to this run");
        return true;
      }
      const caller = deps.runnerClient(runnerId);
      if (cancel) sendJson(response, 202, await caller.cancelShellExecution(executionId, owner));
      else sendJson(response, 200, await caller.getShellExecution(executionId, owner));
      return true;
    }
    sendError(response, 404, "Not found");
  } catch (error) {
    sendError(response, 502, error instanceof Error ? error.message : "the runner call failed");
  }
  return true;
}
