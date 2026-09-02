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
import { lookup } from "node:dns/promises";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";
import { resolve } from "node:path";

import {
  allowedDomainMatches,
  isIpLiteral,
  type ResolvedProxy,
  type SandboxNetworkAccess,
} from "@sciencediscovery/schema";

import {
  EgressProxyError,
  connectThroughProxy,
  egressProxyForTarget,
  proxyAuthorizationValue,
  proxyEndpoint,
  proxyPort,
} from "./egress-proxy.js";

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

/**
 * Usable bytes in `sockaddr_un.sun_path`, excluding the NUL terminator: Linux
 * declares `char sun_path[108]`, macOS and the BSDs `char sun_path[104]`.
 *
 * libuv does not report an overlong path — it truncates silently. `listen()`
 * then succeeds against a *different* path than the caller asked for, so the
 * `chmod` that follows fails with ENOENT on the requested path, and the next
 * attempt finds the truncated leftover and fails with EADDRINUSE. Neither
 * error names the real problem, so every path is measured before libuv sees it.
 */
export const MAX_UNIX_SOCKET_PATH_BYTES = process.platform === "darwin" ? 103 : 107;

/**
 * Directory holding the gateway sockets, relative to the runner data directory.
 * Two characters on purpose: every byte of this path is charged against
 * `sun_path`, and the sockets are runtime state nothing else reads.
 */
const EGRESS_SOCKET_DIRECTORY = "eg";

/** Hex characters of the revision digest used as the socket file name. */
const EGRESS_SOCKET_NAME_LENGTH = 16;

/** Bytes a socket path costs beyond the data directory: `/eg/` plus the name. */
export const EGRESS_SOCKET_RELATIVE_BYTES =
  EGRESS_SOCKET_DIRECTORY.length + EGRESS_SOCKET_NAME_LENGTH + 2;

/**
 * The socket path does not fit in `sun_path`. `domain-allowlist` fails closed
 * with an actionable message instead of running against a truncated path.
 */
export class EgressSocketPathTooLongError extends Error {
  constructor(readonly socketPath: string, readonly limit: number) {
    const bytes = Buffer.byteLength(socketPath);
    super(
      `Sandbox network access (domain-allowlist) is unavailable: the egress socket path is ${bytes} bytes, `
      + `over this platform's ${limit}-byte Unix socket path limit — ${socketPath}. `
      + "The socket has to stay inside the runner data directory, so shorten that directory by at least "
      + `${bytes - limit} byte(s) (SCIENCE_DISCOVERY_DATA_DIR); it must leave `
      + `${EGRESS_SOCKET_RELATIVE_BYTES} bytes for the socket itself.`,
    );
    this.name = "EgressSocketPathTooLongError";
  }
}

/** Reject an overlong socket path before libuv can truncate it. */
export function assertUnixSocketPathFits(socketPath: string): void {
  if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new EgressSocketPathTooLongError(socketPath, MAX_UNIX_SOCKET_PATH_BYTES);
  }
}

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
  (
    event: "allowed" | "denied",
    /** `proxy` is the endpoint only; a proxy credential is never logged. */
    detail: { host: string; port: number; proxy?: string; reason?: string },
  ): void;
}

/** Name resolution, injectable so tests can decide without touching real DNS. */
export type EgressAddressResolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

export interface EgressGatewayOptions {
  log?: EgressGatewayLog;
  /** Where an allowed connection leaves from. Absent means a direct connection. */
  proxy?: ResolvedProxy;
  resolveAddresses?: EgressAddressResolver;
  /** Listen on host loopback rather than a Unix socket (macOS Seatbelt). */
  tcpHost?: string;
}

export class EgressGateway {
  private readonly server: Server;
  private readonly log?: EgressGatewayLog;
  private readonly resolveAddresses: EgressAddressResolver;
  private readonly tcpHost?: string;
  private tcpPort?: number;
  private closed = false;
  /**
   * Outbound route for traffic the allowlist already accepted. Mutable because
   * one gateway serves a policy revision for as long as that revision is in
   * use, while the registry entry it resolves to can be edited underneath it.
   */
  private proxy: ResolvedProxy;

  constructor(
    readonly access: SandboxNetworkAccess,
    readonly socketPath: string,
    options: EgressGatewayOptions = {},
  ) {
    this.log = options.log;
    this.proxy = options.proxy ?? { mode: "direct" };
    this.tcpHost = options.tcpHost;
    this.resolveAddresses = options.resolveAddresses ?? ((host) => lookup(host, { all: true }));
    this.server = createHttpServer();
    this.server.on("connect", (request, clientSocket: Socket, head: Buffer) => {
      void this.handleConnect(request, clientSocket, head);
    });
    this.server.on("request", (request, response) => {
      void this.handleRequest(request, response as Parameters<typeof this.handleRequest>[1]);
    });
    // A stalled sandbox client must not hold the runner's socket forever.
    this.server.on("clientError", (_error, socket) => socket.destroy());
  }

  async listen(): Promise<void> {
    if (this.tcpHost) {
      await new Promise<void>((resolveListen, reject) => {
        this.server.once("error", reject);
        this.server.listen(0, this.tcpHost, () => {
          this.server.off("error", reject);
          const address = this.server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Egress gateway did not receive a TCP port"));
            return;
          }
          this.tcpPort = address.port;
          resolveListen();
        });
      });
      return;
    }
    // Before anything touches the filesystem: a truncated bind would leave a
    // socket behind at a path this gateway will never chmod, rm or hand out.
    assertUnixSocketPathFits(this.socketPath);
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
    if (!this.tcpHost) await rm(this.socketPath, { force: true });
  }

  /**
   * Point subsequent connections at a freshly resolved outbound route.
   * Connections already established keep the route they were opened with.
   */
  setProxy(proxy: ResolvedProxy | undefined): void {
    this.proxy = proxy ?? { mode: "direct" };
  }

  /** Loopback proxy URL for a TCP gateway. Only valid after `listen()`. */
  proxyUrl(): string {
    if (!this.tcpHost || this.tcpPort === undefined) {
      throw new Error("This egress gateway is not listening on TCP");
    }
    return `http://${this.tcpHost}:${this.tcpPort}`;
  }

  /** Port allowed by the matching Seatbelt profile. */
  proxyPort(): number {
    if (this.tcpPort === undefined) throw new Error("TCP egress gateway is not listening");
    return this.tcpPort;
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

  private note(allowed: boolean, host: string, port: number, detail: { proxy?: string; reason?: string } = {}): void {
    this.log?.(allowed ? "allowed" : "denied", {
      host,
      port,
      ...(detail.proxy ? { proxy: detail.proxy } : {}),
      ...(detail.reason ? { reason: detail.reason } : {}),
    });
  }

  private async handleConnect(request: IncomingMessage, clientSocket: Socket, head: Buffer): Promise<void> {
    const [host, portText] = splitAuthority(request.url ?? "");
    // An omitted port means 443; a present but empty or out-of-range one is a
    // malformed request, not port 0 — reject it here rather than letting the
    // connect attempt fail later as a misleading bad gateway.
    const port = portText === undefined ? 443 : Number(portText);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    // The allowlist decision comes first and is unconditional: a refused target
    // is answered here, so no proxy ever learns the sandbox wanted to reach it.
    const decision = await this.decide(host, port);
    if (!decision.allowed) {
      this.note(false, host, port, { reason: decision.reason });
      clientSocket.end(`HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nX-Sandbox-Network: ${decision.reason}\r\n\r\n`);
      return;
    }
    let proxy: URL | undefined;
    try {
      proxy = egressProxyForTarget(this.proxy, { host, port, tls: true });
    } catch (error) {
      const reasons = failureReasons(error, { proxied: true, target: `${host}:${port}` });
      this.note(false, host, port, { reason: reasons.logged });
      clientSocket.end(
        `HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nX-Sandbox-Network: ${reasons.sandbox}\r\n\r\n`,
      );
      return;
    }
    this.note(true, host, port, { ...(proxy ? { proxy: proxyEndpoint(proxy) } : {}) });

    const fail = (error: unknown) => {
      const reasons = failureReasons(error, { proxied: proxy !== undefined, target: `${host}:${port}` });
      this.log?.("denied", {
        host,
        port,
        ...(proxy ? { proxy: proxyEndpoint(proxy) } : {}),
        reason: reasons.logged,
      });
      if (!clientSocket.writableEnded) {
        clientSocket.end(
          `HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nX-Sandbox-Network: ${reasons.sandbox}\r\n\r\n`,
        );
      }
      clientSocket.destroy();
    };
    const tunnel = (upstream: Socket) => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      // Bytes the client pipelined behind the CONNECT were already read off the
      // socket by the HTTP parser; without this they would be silently dropped.
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      upstream.on("error", (error: Error) => fail(error));
      clientSocket.on("error", () => upstream.destroy());
    };
    if (proxy) {
      // The proxy resolves the name itself, so the pinned address is not used
      // here; the allowlist and private-address checks above still ran against
      // this runner's own resolution.
      try {
        tunnel(await connectThroughProxy(proxy, host, port));
      } catch (error) {
        fail(error);
      }
      return;
    }
    const upstream = connect({ host: decision.address!, port }, () => tunnel(upstream));
    upstream.once("error", (error) => fail(error));
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
    if (!decision.allowed) {
      this.note(false, target.hostname, port, { reason: decision.reason });
      response.writeHead(403, { "content-type": "text/plain" });
      response.end(`${decision.reason}\n`);
      return;
    }
    let proxy: URL | undefined;
    let authorization: string | undefined;
    try {
      proxy = egressProxyForTarget(this.proxy, { host: target.hostname, port, tls: false });
      // Inside the same guard as the route itself: reading the credential can
      // fail on a malformed URL, and this handler is called without a catch.
      authorization = proxy ? proxyAuthorizationValue(proxy) : undefined;
    } catch (error) {
      const reasons = failureReasons(error, { proxied: true, target: target.hostname });
      this.note(false, target.hostname, port, { reason: reasons.logged });
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(`${reasons.sandbox}\n`);
      return;
    }
    this.note(true, target.hostname, port, { ...(proxy ? { proxy: proxyEndpoint(proxy) } : {}) });
    // Through a proxy the request keeps its absolute form and goes to the proxy
    // endpoint; direct, it is the origin form against the pinned address.
    const send = proxy?.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = send({
      headers: {
        ...request.headers,
        host: request.headers.host ?? target.host,
        ...(authorization ? { "proxy-authorization": authorization } : {}),
      },
      host: proxy ? proxy.hostname : decision.address,
      method: request.method,
      path: proxy ? target.href : `${target.pathname}${target.search}`,
      port: proxy ? proxyPort(proxy) : port,
      setHost: false,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      const reasons = failureReasons(error, { proxied: proxy !== undefined, target: target.hostname });
      this.log?.("denied", {
        host: target.hostname,
        port,
        ...(proxy ? { proxy: proxyEndpoint(proxy) } : {}),
        reason: reasons.logged,
      });
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end(
        proxy ? `${reasons.sandbox}\n` : `Sandbox network access could not reach ${target.hostname}: ${reasons.sandbox}\n`,
      );
    });
    request.pipe(upstream);
  }
}

/**
 * Split one failure into what the runner logs and what the sandbox is told.
 *
 * The sandbox must never learn where this deployment's egress goes, and an
 * arbitrary socket error raised while talking to a proxy carries that address
 * in its text. So anything that happened on a proxied connection collapses to a
 * fixed sentence naming only the target the sandbox itself asked for; a direct
 * connection's error refers to that same target and is passed through.
 */
function failureReasons(
  error: unknown,
  context: { proxied: boolean; target: string },
): { logged: string; sandbox: string } {
  const logged = error instanceof Error ? error.message : `${context.target} could not be reached`;
  if (error instanceof EgressProxyError) return { logged, sandbox: error.sandboxReason };
  if (context.proxied) {
    return {
      logged,
      sandbox: `Sandbox network access could not reach ${context.target} through this deployment's outbound route`,
    };
  }
  return { logged, sandbox: logged };
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
  private readonly tcpGateways = new Map<string, Promise<EgressGateway>>();

  constructor(
    private readonly dataDir: string,
    private readonly log?: EgressGatewayLog,
    private readonly resolveAddresses?: EgressAddressResolver,
  ) {}

  /**
   * Where the gateway for this policy listens. The layout is as short as the
   * data directory allows — `<dataDir>/eg/<16 hex>`, no `runner-runtime/`
   * prefix and no `.sock` suffix — because the whole absolute path has to fit
   * in `sun_path`; the previous layout cost 44 bytes and truncated inside an
   * ordinary worktree data directory.
   *
   * The name is a digest of the revision rather than the revision itself, so a
   * revision of any length or shape produces a fixed-length name that cannot
   * escape the directory. Distinct revisions still get distinct sockets, which
   * is what makes the socket the policy identity.
   */
  socketPath(revision: string): string {
    const name = createHash("sha256").update(revision).digest("hex").slice(0, EGRESS_SOCKET_NAME_LENGTH);
    return resolve(this.dataDir, EGRESS_SOCKET_DIRECTORY, name);
  }

  /**
   * Start (or reuse) the gateway serving this policy and return its socket.
   *
   * `proxy` is the outbound route the API resolved for this execution. It is
   * re-applied on every acquire rather than frozen at creation, so editing the
   * proxy registry entry a policy points at takes effect on the next execution
   * instead of waiting for the revision — and the gateway — to be replaced.
   */
  async acquire(access: SandboxNetworkAccess, proxy?: ResolvedProxy): Promise<EgressGateway> {
    if (access.mode !== "domain-allowlist") {
      throw new Error("Only domain-allowlist policies need an egress gateway");
    }
    let gateway = this.gateways.get(access.revision);
    if (!gateway) {
      gateway = (async () => {
        const started = new EgressGateway(access, this.socketPath(access.revision), {
          log: this.log,
          ...(proxy ? { proxy } : {}),
          resolveAddresses: this.resolveAddresses,
        });
        await started.listen();
        return started;
      })();
      this.gateways.set(access.revision, gateway);
      void gateway.catch(() => this.gateways.delete(access.revision));
      return await gateway;
    }
    const started = await gateway;
    started.setProxy(proxy);
    return started;
  }

  /** Start (or reuse) a runner-owned loopback proxy for macOS Seatbelt. */
  async acquireTcp(access: SandboxNetworkAccess, proxy?: ResolvedProxy): Promise<EgressGateway> {
    if (access.mode !== "domain-allowlist") {
      throw new Error("Only domain-allowlist policies need an egress gateway");
    }
    let gateway = this.tcpGateways.get(access.revision);
    if (!gateway) {
      gateway = (async () => {
        const started = new EgressGateway(access, "", {
          log: this.log,
          ...(proxy ? { proxy } : {}),
          resolveAddresses: this.resolveAddresses,
          tcpHost: "127.0.0.1",
        });
        await started.listen();
        return started;
      })();
      this.tcpGateways.set(access.revision, gateway);
      void gateway.catch(() => this.tcpGateways.delete(access.revision));
      return await gateway;
    }
    const started = await gateway;
    started.setProxy(proxy);
    return started;
  }

  async close(): Promise<void> {
    const gateways = [...this.gateways.values(), ...this.tcpGateways.values()];
    this.gateways.clear();
    this.tcpGateways.clear();
    await Promise.all(gateways.map(async (gateway) => {
      await gateway.then((started) => started.close()).catch(() => undefined);
    }));
  }
}
