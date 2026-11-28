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

import { createHash } from "node:crypto";
import { epochSandboxNetworkAccess, formatAllowedDomain, normalizeAllowedDomains, parseAllowedDomain,
  type PermissionEpoch, type PermissionAuthorizationSource, type SandboxNetworkPermissionResult, type ScientificExecutionResult } from "@sciencediscovery/schema";
import type { AgentPermissionRuntime } from "@sciencediscovery/governance";
import type { SessionStore } from "../store.js";
import { sandboxNetworkAccess } from "../store/sandbox-network.js";

const RETRY = "No code was executed by this decision. For a previous execution, reconcile files and remote side effects first. Then explicitly issue a safe NEW run_shell call with network_authorization_id. Never replay a running or unknown execution. Report required retrieval as blocked until it succeeds; do not silently substitute web_search success.";

export interface SandboxNetworkCommandScope {
  code: string;
  /** Workspace-relative cwd the blocked execution ran in; empty means the workspace root. */
  cwd: string;
}

/**
 * The shell decision that actually ran the blocked execution. Reuse is only
 * allowed for a decision the user made or a standing/user grant, never for an
 * Always Allow auto-authorization that would survive a switch to Ask mode.
 */
const reusableShellSource = (source?: PermissionAuthorizationSource) =>
  source !== undefined && source !== "always_allow";

/** Owned by one binding, never the shared root permission cell or Session epoch. */
export function createSandboxNetworkConsent(options: {
  sessionId: string; agentId: string; executionId: string; rootRunId?: string;
  store: SessionStore; permission: AgentPermissionRuntime;
  assertRunner(runnerId: string): void;
}) {
  const tickets = new Map<string, { runnerId: string; hosts: string[]; grantId?: string; scope?: SandboxNetworkCommandScope;
    shellApprovalSource?: PermissionAuthorizationSource }>();
  const active = async (runnerId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    options.store.assertSessionWritable(options.sessionId);
    options.assertRunner(runnerId);
    if (!options.rootRunId) throw new Error("Sandbox network consent requires an owning run");
    const run = await options.store.getSessionRun(options.sessionId, options.rootRunId);
    if (!run || !["running", "blocked"].includes(run.status)) throw new Error("Sandbox network consent ended with its run");
  };
  const grantActive = (grantId?: string) => !grantId || options.store.getPermissionGrant(grantId)?.state === "active";
  const ticketFor = async (id: string, runnerId: string, signal?: AbortSignal) => {
    await active(runnerId, signal);
    const ticket = tickets.get(id);
    if (!ticket || ticket.runnerId !== runnerId) throw new Error("Unknown, consumed or foreign sandbox network authorization");
    return ticket;
  };
  const request = async (input: { hosts: string[]; purpose: string; runnerId?: string }, signal?: AbortSignal, toolCallId?: string,
    scope?: SandboxNetworkCommandScope, shellApprovalSource?: PermissionAuthorizationSource): Promise<SandboxNetworkPermissionResult> => {
    const runnerId = input.runnerId?.trim() || "local";
    await active(runnerId, signal);
    if (!Array.isArray(input.hosts) || !input.hosts.length || input.hosts.length > 16) throw new Error("Declare 1–16 exact hosts");
    const hosts = normalizeAllowedDomains(input.hosts);
    if (hosts.some(host => parseAllowedDomain(host).wildcard) || hosts.join(", ").length > 4200) throw new Error("Declare exact hosts, at most 4200 characters in total; no wildcards");
    const purpose = input.purpose.trim().replace(/\s+/g, " ");
    if (!purpose || purpose.length > 100) throw new Error("Network purpose must be 1–100 characters");
    const resource = "sandbox-network:" + createHash("sha256").update(JSON.stringify({ session: options.sessionId,
      agent: options.agentId, run: options.executionId, root: options.rootRunId, runnerId, hosts })).digest("hex");
    let authorization;
    try {
      authorization = await options.permission.requirePrivilege({ action: "sandbox_network", executionId: options.executionId,
        resource, signal, toolCallId, summary: `Sandbox network on ${runnerId} for this Agent run: ${hosts.join(", ")}. Purpose: ${purpose}.`,
        description: { hosts, kind: "network", purpose, runnerId } });
    } catch (error) {
      signal?.throwIfAborted();
      // A denial/dismissal is a visible result, not a successful retrieval.
      return { state: "blocked", hosts, instruction: `Sandbox egress remains blocked: ${error instanceof Error ? error.message : "permission unavailable"}. Required retrieval is incomplete; disclose the skip/blocker. Do not silently fall back to web_search success.` };
    }
    await active(runnerId, signal);
    if (authorization.action !== "sandbox_network" || authorization.outcome !== "allowed" || authorization.resource !== resource) throw new Error("Sandbox network authorization scope mismatch");
    if (tickets.size >= 128) throw new Error("Too many unused network approvals; consume existing tokens first");
    tickets.set(authorization.id, { runnerId, hosts, grantId: authorization.permissionGrantId,
      ...(scope ? { scope } : {}), ...(scope && shellApprovalSource ? { shellApprovalSource } : {}) });
    return { state: "allowed", hosts, authorizationId: authorization.id, instruction: RETRY };
  };
  return {
    request,
    /**
     * The shell approval a matching token re-run may reuse, or undefined when
     * it must ask again. Reuse requires the exact command/cwd/Runner scope, an
     * active ticket grant, and a shell decision that was not an Always Allow
     * auto-authorization. The token is only peeked at here; `consume` below
     * still enforces its one-use and revocation rules before dispatch. A token
     * from an explicit preflight request has no command scope and never reuses
     * an approval it never had. Unknown, consumed or foreign tokens throw here,
     * so a stale token is rejected before another shell card is opened.
     */
    async reusableShellApproval(id: string | undefined, runnerId: string, scope: SandboxNetworkCommandScope,
      signal?: AbortSignal): Promise<{ source: PermissionAuthorizationSource } | undefined> {
      if (!id) return undefined;
      const ticket = await ticketFor(id, runnerId, signal);
      if (!ticket.scope || !ticket.shellApprovalSource || !grantActive(ticket.grantId)) return undefined;
      if (!reusableShellSource(ticket.shellApprovalSource)) return undefined;
      return ticket.scope.code === scope.code && ticket.scope.cwd === scope.cwd
        ? { source: ticket.shellApprovalSource } : undefined;
    },
    async consume(id: string | undefined, runnerId: string, signal?: AbortSignal): Promise<PermissionEpoch> {
      const epoch = options.permission.getEpoch();
      if (!id) return epoch;
      await active(runnerId, signal);
      const ticket = tickets.get(id);
      if (!ticket || ticket.runnerId !== runnerId) throw new Error("Unknown, consumed or foreign sandbox network authorization");
      if (ticket.grantId && options.store.getPermissionGrant(ticket.grantId)?.state !== "active") throw new Error("Sandbox network grant was revoked");
      tickets.delete(id); // Consume before dispatch, including uncertain transport outcomes.
      const base = epochSandboxNetworkAccess(epoch);
      const { revision: _revision, ...settings } = base;
      // Configured capability is already authorized. Only the extra hosts
      // come from this run/Agent/Runner-bound token; none still starts empty.
      const access = base.mode === "open" ? base : sandboxNetworkAccess({ ...settings, mode: "domain-allowlist",
        allowedDomains: [...(base.mode === "domain-allowlist" ? base.allowedDomains : []), ...ticket.hosts] });
      // Unique epoch prevents a persistent kernel from retaining a broader prior policy.
      return { ...epoch, id: `${epoch.id}:network:${id}`, networkPolicy: access.mode, networkAccess: access };
    },
    async observe<T extends Pick<ScientificExecutionResult, "networkDeniedHosts" | "networkPermission">>(result: T, runnerId: string, signal?: AbortSignal,
      scope?: SandboxNetworkCommandScope, shellApprovalSource?: PermissionAuthorizationSource): Promise<T & { networkPermission?: SandboxNetworkPermissionResult }> {
      if (!result.networkDeniedHosts?.length) return result;
      // One unsupported target must not suppress consent for other valid hosts.
      const hosts: string[] = [];
      const blockedHosts: Array<{ host: string; reason: string }> = [];
      for (const host of result.networkDeniedHosts) {
        try {
          const entry = parseAllowedDomain(host);
          if (entry.wildcard) throw new Error("Observed targets must be exact hosts, not wildcards");
          hosts.push(formatAllowedDomain(entry));
        } catch (error) {
          blockedHosts.push({ host, reason: error instanceof Error ? error.message : "Unsupported sandbox host" });
        }
      }
      const feedback = blockedHosts.length ? {
        blockedHosts,
        instruction: `These targets remain blocked and are not authorized by this consent: ${blockedHosts.map(entry => `${entry.host} (${entry.reason})`).join("; ")}. Required retrieval involving them remains incomplete.`,
      } : undefined;
      if (!hosts.length) return { ...result, networkPermission: { state: "blocked", hosts, ...feedback,
        instruction: feedback!.instruction } };
      // The execution has already ended. Consent never revives that execution.
      try {
        const permission = await request({ hosts, purpose: "Continue the sandbox retrieval blocked by this execution", runnerId }, signal, undefined, scope, shellApprovalSource);
        const networkPermission = feedback ? { ...permission, blockedHosts,
          instruction: `${permission.instruction} ${feedback.instruction}` } : permission;
        return { ...result, networkPermission };
      } catch (error) {
        // Never turn a known terminal execution into an unknown outcome just
        // because its run ended or consent became unavailable after execution.
        return { ...result, networkPermission: { state: "blocked", hosts, ...(feedback ? { blockedHosts } : {}),
          instruction: `Required sandbox retrieval remains blocked. ${error instanceof Error ? error.message : "Consent unavailable"}. Reconcile the recorded execution before any retry; do not silently substitute web_search success.` } };
      }
    },
  };
}
