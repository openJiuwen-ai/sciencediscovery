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

import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

import type { ResolvedProxy } from "@sciencediscovery/schema";

import { resolveProxyForUrl } from "./env.js";

const dispatcherCache = new Map<string, Dispatcher>();

/**
 * The fetch implementation that accepts the dispatchers built here.
 *
 * Node's global `fetch` is bound to the runtime's own bundled undici copy,
 * whose request handlers are a different generation from this workspace's
 * `undici` package. Handing it a `ProxyAgent` from here fails at request
 * construction ("invalid onRequestStart method"), so every proxied call would
 * reject with `TypeError: fetch failed` while direct calls kept working.
 * Outbound code that pins a dispatcher must therefore fetch through undici.
 */
export const proxyFetch = undiciFetch as unknown as typeof fetch;

/**
 * Map a resolved proxy onto an undici dispatcher for Node-side fetch calls.
 * Environment policies are first reduced for the concrete target URL, keeping
 * protocol and NO_PROXY semantics identical to the shared resolver.
 *
 * Settings accept http, https and socks5 proxy URLs (`normalizeProxyUrl`), and
 * one `ProxyAgent` covers all three: undici hands a socks5:// or socks:// URI
 * to its own SOCKS agent, which opens the TCP tunnel, resolves the target
 * hostname at the proxy, and adds TLS on top for HTTPS targets. Do not add a
 * scheme branch here; `services/api/src/mcp/pdb-proxy.test.ts` pins the SOCKS5
 * path against a real loopback proxy.
 */
export function proxyDispatcher(resolved: ResolvedProxy, target: string | URL): Dispatcher | undefined {
  const effective = resolveProxyForUrl(resolved, target);
  if (effective.mode === "direct") return undefined;
  const key = `url:${effective.url}`;
  let dispatcher = dispatcherCache.get(key);
  if (!dispatcher) {
    dispatcher = new ProxyAgent(effective.url);
    dispatcherCache.set(key, dispatcher);
  }
  return dispatcher;
}
