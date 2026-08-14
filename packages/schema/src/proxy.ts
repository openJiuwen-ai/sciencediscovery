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

export type ProxyServerKind = "custom_url" | "environment" | "system";

/**
 * Proxy selection policy shared by every outbound module.
 * - "inherit": follow the global default policy.
 * - "none": connect directly, ignoring any configured proxy.
 * - "proxy:<id>": use one specific registry entry.
 */
export type ProxyPolicy = "inherit" | "none" | `proxy:${string}`;

export const PROXY_POLICY_INHERIT: ProxyPolicy = "inherit";
export const PROXY_POLICY_NONE: ProxyPolicy = "none";

export function proxyPolicyForServer(serverId: string): ProxyPolicy {
  return `proxy:${serverId}`;
}

export function proxyServerIdFromPolicy(policy: ProxyPolicy): string | undefined {
  return policy.startsWith("proxy:") ? policy.slice("proxy:".length) : undefined;
}

export type ProxyEnvironmentStatus = "configured" | "unconfigured" | "invalid";

/** An authenticated-settings view of one effective proxy environment slot.
 *  `names` lists the lowercase/uppercase candidates in runtime precedence
 *  order; `effectiveName` identifies the candidate the process actually read.
 *  Valid effective values are intentionally returned in full on this surface. */
export interface ProxyEnvironmentVariableDetails {
  effectiveName?: string;
  effectiveValue?: string;
  names: string[];
  reason?: string;
  status: ProxyEnvironmentStatus;
}

/** Runtime-derived, read-only state for an environment proxy registry entry. */
export interface ProxyEnvironmentDetails {
  reason?: string;
  status: ProxyEnvironmentStatus;
  variables: ProxyEnvironmentVariableDetails[];
}

export interface ProxyServer {
  createdAt: string;
  /** Present only in authenticated settings responses for environment entries. */
  environment?: ProxyEnvironmentDetails;
  /** Whether a custom_url entry has an encrypted URL in persistent storage. */
  hasUrl: boolean;
  id: string;
  kind: ProxyServerKind;
  name: string;
  updatedAt: string;
  /** Complete normalized URL, populated only in authenticated proxy settings responses. */
  url?: string;
}

export interface CreateProxyServerRequest {
  kind: ProxyServerKind;
  name: string;
  /** Required when kind is custom_url. */
  url?: string;
}

export interface UpdateProxyServerRequest {
  kind?: ProxyServerKind;
  name?: string;
  /** Sending a URL replaces the saved one.
   *  custom_url entries always keep a URL, so there is no removal state. */
  url?: string;
}

/**
 * The global default applied when a module policy is "inherit".
 * "inherit" itself is not a valid default; the default resolves the chain.
 */
export type ProxyDefaultPolicy = Exclude<ProxyPolicy, "inherit">;

export interface UpdateProxySettingsRequest {
  defaultPolicy: ProxyDefaultPolicy;
}

export interface ProxySettingsDetails {
  defaultPolicy: ProxyDefaultPolicy;
  servers: ProxyServer[];
}

/**
 * The outcome of resolving a policy against the registry. Consumers apply it
 * to their own transport (undici dispatcher, httpx client, subprocess env).
 * - "direct": bypass proxies entirely.
 * - "environment": trust the process proxy environment variables.
 * - "url": route through one explicit proxy URL.
 */
export type ResolvedProxy =
  | { mode: "direct" }
  | { mode: "environment" }
  | { mode: "url"; url: string };

/** Per MCP server proxy policies keyed by gateway server id. */
export type McpProxyPolicies = Record<string, ProxyPolicy>;

export interface UpdateMcpProxyPoliciesRequest {
  policies: McpProxyPolicies;
}
