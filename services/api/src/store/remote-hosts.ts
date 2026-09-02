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

import { isIP } from "node:net";

import type { RemoteHostEndpoint, RemoteHostTarget } from "@sciencediscovery/schema";

/**
 * The SSH port a machine was registered with. `null`/absent means the user left
 * it blank, which is how they ask for the destination to be resolved by their
 * SSH configuration instead.
 */
export function normalizeSshPort(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("The SSH port must be a whole number between 1 and 65535");
  }
  return value;
}

/**
 * Where a self-deployed runner listens. Only an address and a port are
 * accepted: a full URL would let a path or credentials ride along into every
 * later request, and the runner's HTTP contract is rooted at `/`.
 */
export function normalizeRemoteHostEndpoint(input: Partial<RemoteHostEndpoint> | undefined): RemoteHostEndpoint {
  const host = input?.host?.trim() ?? "";
  if (!host || host.length > 255) throw new Error("A self-deployed runner needs an IP address or hostname");
  if (!isIP(host) && !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(host)) {
    throw new Error("The runner address must be an IP address or a hostname");
  }
  const port = Number(input?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The runner port must be a whole number between 1 and 65535");
  }
  const protocol = input?.protocol ?? "http";
  if (protocol !== "http" && protocol !== "https") throw new Error("The runner protocol must be http or https");
  return { host, port, protocol };
}

/**
 * Why this machine cannot be a Session's execution target, or `undefined` when
 * it can. An SSH machine qualifies when it already carries the runner or can
 * receive the deployed one; a self-deployed runner qualifies when the product
 * knows where it listens and holds its token.
 */
export function remoteRunnerUnusableReason(host: RemoteHostTarget): string | undefined {
  if (host.status !== "ready" || !host.capabilities) return "it has not been probed successfully";
  if (host.capabilities.platform !== "Linux") return "remote runners are supported on Linux only";
  if (host.connectionKind === "direct") {
    if (!host.endpoint) return "it has no address";
    return host.hasToken ? undefined : "no connection token is stored for it";
  }
  if (!host.capabilities.runnerCommandAvailable && !host.capabilities.nodeVersion) {
    return `neither ${host.runnerCommand} nor Node.js 22 or newer was found, so no runner can be deployed there`;
  }
  return undefined;
}

/**
 * Bring a persisted host up to the current shape. Hosts registered before the
 * product could connect to a self-deployed runner carry no connection kind and
 * are SSH targets by definition.
 */
export function normalizePersistedRemoteHost(saved: RemoteHostTarget): RemoteHostTarget {
  const connectionKind = saved.connectionKind === "direct" ? "direct" : "ssh";
  let endpoint: RemoteHostEndpoint | undefined;
  if (connectionKind === "direct") {
    try {
      endpoint = normalizeRemoteHostEndpoint(saved.endpoint);
    } catch {
      endpoint = undefined;
    }
  }
  return {
    ...saved,
    ...(saved.capabilities
      ? {
        capabilities: {
          ...saved.capabilities,
          nodeVersion: typeof saved.capabilities.nodeVersion === "string" ? saved.capabilities.nodeVersion : null,
          platform: typeof saved.capabilities.platform === "string" ? saved.capabilities.platform : null,
          runnerCommandAvailable: saved.capabilities.runnerCommandAvailable === true,
        },
      }
      : { capabilities: undefined }),
    connectionKind,
    ...(endpoint ? { endpoint } : {}),
    ...(connectionKind === "ssh" && Number.isInteger(saved.port) ? { port: saved.port } : {}),
    runnerCommand: typeof saved.runnerCommand === "string" && saved.runnerCommand.trim()
      ? saved.runnerCommand.trim()
      : "sciencediscovery-runner",
  };
}

/**
 * A persisted Session's allowed remote machines. Sessions saved under the
 * earlier model carried one `remoteRunnerHostId` that pinned every execution to
 * that machine; the machine stays allowed, but the Session is no longer locked
 * out of local execution.
 */
export function normalizePersistedSessionRemoteRunners(
  saved: { remoteRunnerHostId?: unknown; remoteRunnerHostIds?: unknown },
): { remoteRunnerHostIds?: string[] } {
  if (Array.isArray(saved.remoteRunnerHostIds)) {
    return { remoteRunnerHostIds: saved.remoteRunnerHostIds.filter((id): id is string => typeof id === "string") };
  }
  return typeof saved.remoteRunnerHostId === "string" && saved.remoteRunnerHostId
    ? { remoteRunnerHostIds: [saved.remoteRunnerHostId] }
    : {};
}
