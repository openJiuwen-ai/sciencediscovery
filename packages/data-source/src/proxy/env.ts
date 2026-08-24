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
  ProxyEnvironmentDetails,
  ProxyEnvironmentStatus,
  ProxyEnvironmentVariableDetails,
  ResolvedProxy,
} from "@sciencediscovery/schema";

export const PROXY_ENV_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

const PROXY_ENV_SLOTS = [
  ["http_proxy", "HTTP_PROXY"],
  ["https_proxy", "HTTPS_PROXY"],
  ["all_proxy", "ALL_PROXY"],
  ["no_proxy", "NO_PROXY"],
] as const;

export type ProxyEnvironment = Record<string, string | undefined>;

interface RuntimeEnvironmentVariable {
  effectiveName?: string;
  names: readonly [string, string];
  reason?: string;
  status: ProxyEnvironmentStatus;
  value?: string;
}

export interface ProxyEnvironmentSnapshot {
  reason?: string;
  status: ProxyEnvironmentStatus;
  variables: RuntimeEnvironmentVariable[];
}

function validateEnvironmentProxyUrl(name: string, value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${name} is not a valid proxy URL`;
  }
  if (!parsed.hostname || !["http:", "https:", "socks5:"].includes(parsed.protocol)) {
    return `${name} must use an http, https, or socks5 proxy URL`;
  }
  return undefined;
}

/** Resolve the lowercase-over-uppercase values used by Node and httpx 0.28.
 *  A present lowercase value wins even when it is blank or invalid; it does
 *  not silently fall back to the uppercase variant. */
export function resolveProxyEnvironment(baseEnv: ProxyEnvironment = process.env): ProxyEnvironmentSnapshot {
  const variables: RuntimeEnvironmentVariable[] = PROXY_ENV_SLOTS.map((names) => {
    const effectiveName = baseEnv[names[0]] !== undefined
      ? names[0]
      : baseEnv[names[1]] !== undefined
        ? names[1]
        : undefined;
    const value = effectiveName ? baseEnv[effectiveName]?.trim() : undefined;
    if (!value) return { effectiveName, names, status: "unconfigured" };
    if (names[0] === "no_proxy") return { effectiveName, names, status: "configured", value };
    const reason = validateEnvironmentProxyUrl(effectiveName!, value);
    return reason
      ? { effectiveName, names, reason, status: "invalid" }
      : { effectiveName, names, status: "configured", value };
  });
  const invalid = variables.find((variable) => variable.status === "invalid");
  const hasProxy = variables.slice(0, 3).some((variable) => variable.status === "configured");
  return {
    ...(invalid ? { reason: invalid.reason } : {}),
    status: invalid ? "invalid" : hasProxy ? "configured" : "unconfigured",
    variables,
  };
}

function targetBypassesProxy(target: URL, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  if (noProxy.trim() === "*") return true;
  const hostname = target.hostname.toLowerCase();
  const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  for (const rawEntry of noProxy.split(/[,\s]/)) {
    if (!rawEntry) continue;
    const match = rawEntry.match(/^(.+):(\d+)$/);
    const entryHost = (match?.[1] ?? rawEntry).replace(/^\*?\./, "").toLowerCase();
    const entryPort = match ? Number(match[2]) : 0;
    if (entryPort && entryPort !== port) continue;
    if (hostname === entryHost || hostname.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

/** Resolve an environment policy for one outbound HTTP(S) target.
 *
 * This removes consumer-specific environment fallbacks: HTTP uses HTTP_PROXY
 * then ALL_PROXY, HTTPS uses HTTPS_PROXY then ALL_PROXY, and NO_PROXY bypasses
 * both. In particular, HTTP_PROXY is not an HTTPS fallback because httpx does
 * not apply it to HTTPS targets.
 */
export function resolveProxyForUrl(
  resolved: ResolvedProxy,
  target: string | URL,
  baseEnv: ProxyEnvironment = process.env,
): Exclude<ResolvedProxy, { mode: "environment" }> {
  if (resolved.mode !== "environment") return resolved;
  const url = typeof target === "string" ? new URL(target) : target;
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Proxy target must use HTTP or HTTPS: ${url.protocol}`);
  }
  const snapshot = resolveProxyEnvironment(baseEnv);
  assertValidProxyEnvironment(snapshot);
  const noProxy = snapshot.variables[3]?.value;
  if (targetBypassesProxy(url, noProxy)) return { mode: "direct" };
  const protocolProxy = snapshot.variables[url.protocol === "https:" ? 1 : 0]?.value;
  const allProxy = snapshot.variables[2]?.value;
  const proxy = protocolProxy || allProxy;
  return proxy ? { mode: "url", url: proxy } : { mode: "direct" };
}

export function assertValidProxyEnvironment(snapshot: ProxyEnvironmentSnapshot): void {
  if (snapshot.status === "invalid") {
    throw new Error(snapshot.reason ?? "The proxy environment is invalid");
  }
}

/** Convert a runtime snapshot into the authenticated settings payload.
 *  Valid values are intentionally shown in full; invalid source strings remain
 *  omitted so validation errors cannot echo credentials. */
export function proxyEnvironmentDetails(
  snapshot: ProxyEnvironmentSnapshot = resolveProxyEnvironment(),
): ProxyEnvironmentDetails {
  const variables: ProxyEnvironmentVariableDetails[] = snapshot.variables.map((variable) => ({
    ...(variable.effectiveName ? { effectiveName: variable.effectiveName } : {}),
    ...(variable.value ? { effectiveValue: variable.value } : {}),
    names: [...variable.names],
    ...(variable.reason ? { reason: variable.reason } : {}),
    status: variable.status,
  }));
  return {
    ...(snapshot.reason ? { reason: snapshot.reason } : {}),
    status: snapshot.status,
    variables,
  };
}

/**
 * Build the environment variables that make a subprocess honour a resolved
 * proxy. Used for outbound helpers whose child processes do not inherit the
 * parent proxy environment (for example stdio MCP servers, whose SDK only
 * passes through an allowlist of variables).
 * - url: point every proxy variable at the resolved URL, keeping any NO_PROXY
 *   exclusions from the base environment.
 * - environment: forward only the effective values under canonical names, so
 *   contradictory inherited variants cannot be reinterpreted by a child.
 * - direct: nothing — spawning with no proxy variables is a direct connection.
 */
export function proxyEnvOverlay(
  resolved: ResolvedProxy,
  baseEnv: ProxyEnvironment = process.env,
): Record<string, string> {
  if (resolved.mode === "direct") return {};
  if (resolved.mode === "environment") {
    const snapshot = resolveProxyEnvironment(baseEnv);
    assertValidProxyEnvironment(snapshot);
    const overlay: Record<string, string> = {};
    const canonicalNames = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const;
    for (const [index, variable] of snapshot.variables.entries()) {
      if (variable.value) overlay[canonicalNames[index]!] = variable.value;
    }
    return overlay;
  }
  const overlay: Record<string, string> = {
    ALL_PROXY: resolved.url,
    HTTP_PROXY: resolved.url,
    HTTPS_PROXY: resolved.url,
    all_proxy: resolved.url,
    http_proxy: resolved.url,
    https_proxy: resolved.url,
  };
  for (const name of ["NO_PROXY", "no_proxy"] as const) {
    const value = baseEnv[name];
    if (value) overlay[name] = value;
  }
  return overlay;
}
