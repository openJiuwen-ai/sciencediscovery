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

import { connect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

import type { ResolvedProxy } from "@sciencediscovery/schema";

/**
 * The second leg of a `domain-allowlist` execution: once the egress gateway has
 * *allowed* a target, this decides how the runner actually reaches it.
 *
 * The API resolves the configured policy against the proxy registry and sends
 * the result with the execution, exactly as it does for models. `direct` and
 * `url` arrive already decided; only `environment` is left for this process,
 * because it means "use this process's proxy environment" and the process that
 * dials out for the sandbox is the runner.
 *
 * Nothing here touches the sandbox. The workload's own `HTTP_PROXY` keeps
 * pointing at the internal bridge, and a proxy URL — credentials included —
 * never leaves the runner.
 */

/** One allowed target, as the gateway knows it before dialling. */
export interface EgressTarget {
  host: string;
  port: number;
  /** `true` for a CONNECT tunnel, which the sandbox client will use for TLS. */
  tls: boolean;
}

/** Chaining is a plain HTTP proxy conversation, so only these two schemes work. */
const SUPPORTED_PROXY_PROTOCOLS = ["http:", "https:"];

export class EgressProxyUnsupportedError extends Error {
  constructor(url: URL) {
    super(
      `Sandbox network access cannot send allowed traffic through a ${url.protocol.replace(":", "")} proxy; `
      + "configure an http or https proxy server for the sandbox network egress policy",
    );
    this.name = "EgressProxyUnsupportedError";
  }
}

/**
 * The proxy URL carries userinfo that is not valid percent-encoding, so the
 * credential cannot be decoded. Raised where the URL is parsed rather than
 * where the header is written: a `decodeURIComponent` failure inside a socket
 * callback would escape as an uncaught exception and take the runner down.
 * The message names the endpoint only — never the credential.
 */
export class EgressProxyCredentialsError extends Error {
  constructor(proxy: URL, field: "username" | "password") {
    super(
      `Sandbox network access cannot read the ${field} of the egress proxy ${proxyEndpoint(proxy)}: `
      + "it is not valid percent-encoding",
    );
    this.name = "EgressProxyCredentialsError";
  }
}

function decodeUserinfo(proxy: URL, field: "username" | "password"): string {
  try {
    return decodeURIComponent(proxy[field]);
  } catch {
    throw new EgressProxyCredentialsError(proxy, field);
  }
}

/** `user:password` for a proxy URL that carries userinfo, or `undefined`. */
function proxyCredentials(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  return `${decodeUserinfo(proxy, "username")}:${decodeUserinfo(proxy, "password")}`;
}

function parseProxyUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Sandbox network access received an invalid egress proxy URL");
  }
  if (!url.hostname) throw new Error("Sandbox network access received an egress proxy URL without a host");
  if (!SUPPORTED_PROXY_PROTOCOLS.includes(url.protocol)) throw new EgressProxyUnsupportedError(url);
  // Decode the credential here, while the caller is still inside the gateway's
  // route-resolution guard. Leaving it to the point of use would put a throw in
  // a socket callback, where nothing can catch it.
  proxyCredentials(url);
  return url;
}

/**
 * Read one proxy environment slot. A present lowercase variable wins over its
 * uppercase twin even when it is empty, which is what Node and httpx do; the
 * shared resolver in `packages/data-source/src/proxy/env.ts` applies the same
 * rule. The runner keeps its own copy of this narrow slice instead of depending
 * on that package, whose outbound stack it deliberately does not carry.
 */
function environmentSlot(env: NodeJS.ProcessEnv, lower: string, upper: string): string | undefined {
  const raw = env[lower] !== undefined ? env[lower] : env[upper];
  return raw?.trim() || undefined;
}

/** `NO_PROXY` bypass, matching host, `.suffix` and `host:port` entries. */
function bypassesProxy(target: EgressTarget, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  if (noProxy.trim() === "*") return true;
  const host = target.host.toLowerCase();
  for (const rawEntry of noProxy.split(/[,\s]/)) {
    if (!rawEntry) continue;
    const portMatch = /^(.+):(\d+)$/.exec(rawEntry);
    const entryHost = (portMatch?.[1] ?? rawEntry).replace(/^\*?\./, "").toLowerCase();
    if (portMatch && Number(portMatch[2]) !== target.port) continue;
    if (host === entryHost || host.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

/**
 * The proxy to chain through for this target, or `undefined` for a direct
 * connection. `HTTP_PROXY` is deliberately not an HTTPS fallback — `ALL_PROXY`
 * is the fallback for both — so this matches what the model stack does.
 */
export function egressProxyForTarget(
  proxy: ResolvedProxy | undefined,
  target: EgressTarget,
  env: NodeJS.ProcessEnv = process.env,
): URL | undefined {
  if (!proxy || proxy.mode === "direct") return undefined;
  if (proxy.mode === "url") return parseProxyUrl(proxy.url);
  if (bypassesProxy(target, environmentSlot(env, "no_proxy", "NO_PROXY"))) return undefined;
  const forProtocol = target.tls
    ? environmentSlot(env, "https_proxy", "HTTPS_PROXY")
    : environmentSlot(env, "http_proxy", "HTTP_PROXY");
  const value = forProtocol ?? environmentSlot(env, "all_proxy", "ALL_PROXY");
  return value ? parseProxyUrl(value) : undefined;
}

/** Proxy endpoint for logs and errors. Never includes the credentials. */
export function proxyEndpoint(proxy: URL): string {
  return `${proxy.protocol}//${proxy.host}`;
}

export function proxyPort(proxy: URL): number {
  return Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80);
}

/** `Proxy-Authorization` header line for a proxy URL that carries userinfo. */
export function proxyAuthorizationHeader(proxy: URL): string {
  const value = proxyAuthorizationValue(proxy);
  return value ? `Proxy-Authorization: ${value}\r\n` : "";
}

/** Header value form of the same credentials, for `http.request` options. */
export function proxyAuthorizationValue(proxy: URL): string | undefined {
  const credentials = proxyCredentials(proxy);
  return credentials ? `Basic ${Buffer.from(credentials).toString("base64")}` : undefined;
}

const PROXY_RESPONSE_HEAD_LIMIT = 64 * 1024;

/**
 * Open a tunnel to `host:port` through `proxy` and resolve the socket once the
 * proxy has confirmed it. Any bytes the proxy sent after the response head are
 * pushed back so the caller can pipe the socket without losing them.
 */
export function connectThroughProxy(proxy: URL, host: string, port: number): Promise<Socket> {
  return new Promise((resolveSocket, reject) => {
    const endpoint = { host: proxy.hostname, port: proxyPort(proxy) };
    const socket = proxy.protocol === "https:"
      ? tlsConnect({ ...endpoint, servername: proxy.hostname })
      : connect(endpoint);
    let head = Buffer.alloc(0);
    const fail = (message: string) => {
      socket.destroy();
      reject(new Error(message));
    };
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const separator = head.indexOf("\r\n\r\n");
      if (separator === -1) {
        if (head.length > PROXY_RESPONSE_HEAD_LIMIT) {
          fail(`${proxyEndpoint(proxy)} sent an oversized CONNECT response`);
        }
        return;
      }
      socket.off("data", onData);
      socket.off("error", onError);
      const statusLine = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      const status = Number(statusLine.split(" ")[1]);
      if (status !== 200) {
        fail(`${proxyEndpoint(proxy)} refused the tunnel to ${host}:${port}: ${statusLine.trim()}`);
        return;
      }
      const trailing = head.subarray(separator + 4);
      if (trailing.length) socket.unshift(trailing);
      resolveSocket(socket);
    };
    const onError = (error: Error) => fail(`${proxyEndpoint(proxy)} is unreachable: ${error.message}`);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once(proxy.protocol === "https:" ? "secureConnect" : "connect", () => {
      // Nothing outside this listener can catch a throw from it, so any failure
      // building the request has to become a rejection here.
      try {
        socket.write(
          `CONNECT ${host}:${port} HTTP/1.1\r\n`
          + `Host: ${host}:${port}\r\n`
          + proxyAuthorizationHeader(proxy)
          + "Proxy-Connection: keep-alive\r\n\r\n",
        );
      } catch (error) {
        fail(error instanceof Error ? error.message : `${proxyEndpoint(proxy)} could not be addressed`);
      }
    });
  });
}
