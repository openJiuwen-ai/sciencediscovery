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

import { lookup } from "node:dns/promises";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { resolve } from "node:path";

import {
  allowedDomainMatches,
  isIpLiteral,
  type SandboxNetworkAccess,
} from "@sciencediscovery/schema";

/**
 * Egress gateway: the single outbound exit of a `domain-allowlist` sandbox.
 *
 * It runs in the runner process, as the runner's own user, and listens on a
 * Unix domain socket that is bind-mounted into the sandbox. The sandbox has no
 * network interface of its own, so this socket is the only way out — removing
 * the injected outbound environment variables does not reveal a second path,
 * it just breaks the client.
 *
 * The gateway speaks the HTTP proxy protocol (CONNECT plus absolute-form
 * requests) because that is what ordinary HTTP client libraries can address.
 * It filters on the requested host name; it does not terminate TLS, so a
 * broadly scoped allowed domain remains a broadly scoped grant.
 */

export interface EgressGatewayDecision {
  allowed: boolean;
  /** Present when the target was rejected; safe to show inside the sandbox. */
  reason?: string;
  /** The approved address, pinned so DNS cannot change between check and connect. */
  address?: string;
}

/** RFC 1918 / loopback / link-local / unique-local and other non-public space. */
export function isPrivateAddress(address: string, family: number): boolean {
  if (family === 6) {
    const value = address.toLowerCase();
    if (value === "::1" || value === "::") return true;
    if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
    // IPv4-mapped IPv6 (::ffff:10.0.0.1) is still the IPv4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    return mapped ? isPrivateAddress(mapped[1]!, 4) : false;
  }
  const octets = address.split(".").map(Number);
  const [first, second] = octets as [number, number];
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return true;
  if (first === 10 || first === 127 || first === 0) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  return first >= 224;
}

export interface EgressGatewayLog {
  (event: "allowed" | "denied", detail: { host: string; port: number; reason?: string }): void;
}

/** Name resolution, injectable so tests can decide without touching real DNS. */
export type EgressAddressResolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

export interface EgressGatewayOptions {
  log?: EgressGatewayLog;
  resolveAddresses?: EgressAddressResolver;
}

export class EgressGateway {
  private readonly server: Server;
  private readonly log?: EgressGatewayLog;
  private readonly resolveAddresses: EgressAddressResolver;
  private closed = false;

  constructor(
    readonly access: SandboxNetworkAccess,
    readonly socketPath: string,
    options: EgressGatewayOptions = {},
  ) {
    this.log = options.log;
    this.resolveAddresses = options.resolveAddresses ?? ((host) => lookup(host, { all: true }));
    this.server = createHttpServer();
    this.server.on("connect", (request, clientSocket: Socket) => {
      void this.handleConnect(request, clientSocket);
    });
    this.server.on("request", (request, response) => {
      void this.handleRequest(request, response as Parameters<typeof this.handleRequest>[1]);
    });
    // A stalled sandbox client must not hold the runner's socket forever.
    this.server.on("clientError", (_error, socket) => socket.destroy());
  }

  async listen(): Promise<void> {
    await mkdir(resolve(this.socketPath, ".."), { recursive: true });
    await rm(this.socketPath, { force: true });
    await new Promise<void>((resolveListen, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject);
        resolveListen();
      });
    });
    await chmod(this.socketPath, 0o600);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.server.closeAllConnections();
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
    await rm(this.socketPath, { force: true });
  }

  /** Decide one target: allowlist first, then the resolved address class. */
  async decide(host: string, port: number): Promise<EgressGatewayDecision> {
    if (this.access.mode !== "domain-allowlist") {
      return { allowed: false, reason: "sandbox network access is disabled for this execution" };
    }
    if (isIpLiteral(host)) {
      return { allowed: false, reason: `${host} is an IP address; sandbox network access allows domain names only` };
    }
    if (!allowedDomainMatches(this.access.allowedDomains, host, port)) {
      return { allowed: false, reason: `${host}:${port} is not in the sandbox network allowed domains` };
    }
    let addresses;
    try {
      addresses = await this.resolveAddresses(host);
    } catch (error) {
      return { allowed: false, reason: `${host} could not be resolved: ${error instanceof Error ? error.message : "lookup failed"}` };
    }
    const usable = this.access.allowPrivateNetwork
      ? addresses
      : addresses.filter((entry) => !isPrivateAddress(entry.address, entry.family));
    const approved = usable[0]?.address;
    if (!approved) {
      return {
        allowed: false,
        reason: `${host} resolves only to private or loopback addresses; enable private network access to allow it`,
      };
    }
    return { address: approved, allowed: true };
  }

  private note(allowed: boolean, host: string, port: number, reason?: string): void {
    this.log?.(allowed ? "allowed" : "denied", { host, port, ...(reason ? { reason } : {}) });
  }

  private async handleConnect(request: IncomingMessage, clientSocket: Socket): Promise<void> {
    const [host, portText] = splitAuthority(request.url ?? "");
    // An omitted port means 443; a present but empty or out-of-range one is a
    // malformed request, not port 0 — reject it here rather than letting the
    // connect attempt fail later as a misleading bad gateway.
    const port = portText === undefined ? 443 : Number(portText);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const decision = await this.decide(host, port);
    this.note(decision.allowed, host, port, decision.reason);
    if (!decision.allowed) {
      clientSocket.end(`HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nX-Sandbox-Network: ${decision.reason}\r\n\r\n`);
      return;
    }
    const upstream = connect({ host: decision.address!, port }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", (error) => {
      if (!clientSocket.writableEnded) {
        clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nX-Sandbox-Network: ${error.message}\r\n\r\n`);
      }
      clientSocket.destroy();
    });
    clientSocket.on("error", () => upstream.destroy());
  }

  private async handleRequest(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    let target: URL;
    try {
      // Proxy clients send the absolute form; anything else is not for us.
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("Sandbox network access expects absolute-form proxy requests\n");
      return;
    }
    if (target.protocol !== "http:") {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end(`Sandbox network access cannot forward ${target.protocol} without CONNECT\n`);
      return;
    }
    const port = Number(target.port || 80);
    const decision = await this.decide(target.hostname, port);
    this.note(decision.allowed, target.hostname, port, decision.reason);
    if (!decision.allowed) {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end(`${decision.reason}\n`);
      return;
    }
    const upstream = httpRequest({
      headers: { ...request.headers, host: request.headers.host ?? target.host },
      host: decision.address,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      port,
      setHost: false,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end(`Sandbox network access could not reach ${target.hostname}: ${error.message}\n`);
    });
    request.pipe(upstream);
  }
}

function splitAuthority(authority: string): [string | undefined, string | undefined] {
  const separator = authority.lastIndexOf(":");
  if (separator === -1) return [authority || undefined, undefined];
  return [authority.slice(0, separator) || undefined, authority.slice(separator + 1)];
}

/**
 * One gateway per policy revision. The socket path *is* the policy identity:
 * a sandbox that can reach a given socket was granted exactly that policy, so
 * no per-connection authentication is needed inside the sandbox.
 */
export class EgressGatewayRegistry {
  private readonly gateways = new Map<string, Promise<EgressGateway>>();

  constructor(
    private readonly dataDir: string,
    private readonly log?: EgressGatewayLog,
  ) {}

  socketPath(revision: string): string {
    return resolve(this.dataDir, "runner-runtime", "egress", `${revision}.sock`);
  }

  /** Start (or reuse) the gateway serving this policy and return its socket. */
  acquire(access: SandboxNetworkAccess): Promise<EgressGateway> {
    if (access.mode !== "domain-allowlist") {
      throw new Error("Only domain-allowlist policies need an egress gateway");
    }
    let gateway = this.gateways.get(access.revision);
    if (!gateway) {
      gateway = (async () => {
        const started = new EgressGateway(access, this.socketPath(access.revision), { log: this.log });
        await started.listen();
        return started;
      })();
      this.gateways.set(access.revision, gateway);
      void gateway.catch(() => this.gateways.delete(access.revision));
    }
    return gateway;
  }

  async close(): Promise<void> {
    const gateways = [...this.gateways.values()];
    this.gateways.clear();
    await Promise.all(gateways.map(async (gateway) => {
      await gateway.then((started) => started.close()).catch(() => undefined);
    }));
  }
}
