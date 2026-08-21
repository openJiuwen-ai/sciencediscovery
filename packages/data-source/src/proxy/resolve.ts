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

import type { ProxyDefaultPolicy, ProxyPolicy, ProxyServerKind, ResolvedProxy } from "@sciencediscovery/schema";

import { assertValidProxyEnvironment, resolveProxyEnvironment, type ProxyEnvironment } from "./env.js";
import { resolveSystemProxy } from "./system.js";

/** The minimal registry surface the resolver needs; the store implements it
 *  so the resolver itself stays free of persistence and crypto concerns. */
export interface ProxyRegistryView {
  defaultPolicy: ProxyDefaultPolicy;
  getServerKind(serverId: string): ProxyServerKind | undefined;
  /** Decrypted URL of a custom_url entry. */
  getServerUrl(serverId: string): string | undefined;
}

/**
 * Resolve a module's proxy policy into a transport-agnostic instruction.
 * An undefined policy behaves like "inherit" so callers can pass optional
 * settings fields straight through.
 */
export function resolveProxyPolicy(
  policy: ProxyPolicy | undefined,
  registry: ProxyRegistryView,
  environment: ProxyEnvironment = process.env,
): ResolvedProxy {
  const effective: ProxyDefaultPolicy = policy === undefined || policy === "inherit" ? registry.defaultPolicy : policy;
  if (effective === "none") return { mode: "direct" };
  const serverId = effective.slice("proxy:".length);
  const kind = registry.getServerKind(serverId);
  if (!kind) throw new Error(`The proxy policy references an unknown proxy server: ${serverId}`);
  if (kind === "environment") {
    assertValidProxyEnvironment(resolveProxyEnvironment(environment));
    return { mode: "environment" };
  }
  if (kind === "system") return resolveSystemProxy();
  const url = registry.getServerUrl(serverId);
  if (!url) throw new Error(`The proxy server ${serverId} has no saved URL`);
  return { mode: "url", url };
}
