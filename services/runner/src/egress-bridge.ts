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

import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Egress bridge: the piece that makes `domain-allowlist` work without ever
 * giving the sandbox a network interface.
 *
 * The sandbox keeps `--unshare-all` (no `--share-net`), so its only reachable
 * network is its own empty namespace's loopback. The runner's egress gateway
 * listens on a Unix domain socket, which is a filesystem object and therefore
 * crosses the namespace boundary when bind-mounted in. HTTP client libraries
 * cannot speak to a Unix socket through the standard outbound environment
 * variables, so a small forwarder runs *inside* the sandbox: it listens on the
 * sandbox's own loopback and pipes every connection to the mounted socket,
 * then execs the real workload as its child.
 *
 * The forwarder is a stdlib-only Python script run by the host interpreter,
 * bind-mounted together with its standard library under one prefix. Mounting
 * `bin/python3` and `lib/pythonX.Y` as siblings lets the interpreter derive its
 * own prefix, so no extra environment variable leaks into the sandbox — the
 * process environment the workload sees stays exactly what the launch built.
 */

/** Sandbox-internal mount prefix for the bridge interpreter and script. */
export const EGRESS_PREFIX = "/opt/sciencediscovery-net";
export const EGRESS_BRIDGE_SCRIPT_PATH = `${EGRESS_PREFIX}/egress-bridge.py`;
export const EGRESS_INTERPRETER_PATH = `${EGRESS_PREFIX}/bin/python3`;
/** Sandbox-internal path of the bind-mounted gateway socket. */
export const EGRESS_SOCKET_PATH = "/run/sciencediscovery/egress.sock";
/** Sandbox-internal loopback port the bridge listens on. */
export const EGRESS_BRIDGE_PORT = 18_118;
export const EGRESS_PROXY_URL = `http://127.0.0.1:${EGRESS_BRIDGE_PORT}`;

/**
 * Outbound environment variables injected inside the sandbox so ordinary HTTP
 * clients find the bridge. These are a client-library compatibility detail of
 * sandbox network access, not a proxy-server product feature; they are also
 * reserved keys, so a Session env profile can never override them.
 */
export const EGRESS_ENVIRONMENT_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const;

export function egressEnvironment(): Record<string, string> {
  return Object.fromEntries(EGRESS_ENVIRONMENT_KEYS.map((key) => [key, EGRESS_PROXY_URL]));
}

const BRIDGE_SCRIPT = String.raw`
"""Sandbox egress bridge: loopback TCP inside the sandbox -> host gateway UDS.

Started as the sandbox entrypoint; execs the real workload as a child and
exits with the child's status. Never writes to stdout: the workload owns it.
"""
import os
import socket
import sys
import threading


def pump(source, target):
    try:
        while True:
            chunk = source.recv(65536)
            if not chunk:
                break
            target.sendall(chunk)
    except OSError:
        pass
    finally:
        try:
            target.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def forward(client, socket_path):
    try:
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        upstream.connect(socket_path)
    except OSError as error:
        print("egress bridge: gateway unreachable: %s" % error, file=sys.stderr)
        client.close()
        return
    threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
    pump(upstream, client)
    client.close()
    upstream.close()


def serve(listener, socket_path):
    while True:
        try:
            client, _ = listener.accept()
        except OSError:
            return
        threading.Thread(target=forward, args=(client, socket_path), daemon=True).start()


def main(argv):
    socket_path = argv[argv.index("--socket") + 1]
    port = int(argv[argv.index("--port") + 1])
    command = argv[argv.index("--") + 1:]
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", port))
    listener.listen(128)
    child = os.fork()
    if child == 0:
        # Sockets are close-on-exec by default, so the workload never inherits
        # the listener or any in-flight forwarded connection.
        os.execv(command[0], command)
    threading.Thread(target=serve, args=(listener, socket_path), daemon=True).start()
    _, status = os.waitpid(child, 0)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return os.WEXITSTATUS(status)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
`;

/** A host interpreter that can run the bridge, plus its standard library. */
export interface EgressBridge {
  interpreterPath: string;
  scriptPath: string;
  /** Host standard-library directory, mounted next to the interpreter. */
  stdlibPath: string;
}

export class EgressBridgeUnavailableError extends Error {
  constructor(reason: string) {
    super(`Sandbox network access (domain-allowlist) is unavailable: ${reason}`);
    this.name = "EgressBridgeUnavailableError";
  }
}

async function probeInterpreter(candidate: string): Promise<{ interpreterPath: string; stdlibPath: string }> {
  const probe = await execFileAsync(candidate, [
    "-c",
    "import sys, sysconfig; print(sys.executable); print(sysconfig.get_paths()['stdlib'])",
  ], { encoding: "utf8" });
  const [executable, stdlib] = probe.stdout.trim().split("\n");
  if (!executable || !stdlib) throw new Error(`${candidate} did not report its interpreter layout`);
  return { interpreterPath: await realpath(executable), stdlibPath: await realpath(stdlib) };
}

export type EgressBridgeInterpreter = Omit<EgressBridge, "scriptPath">;

let interpreterProbe: Promise<EgressBridgeInterpreter> | undefined;

/**
 * The host interpreter alone, probed at most once per runner process.
 *
 * `/health` reports whether `domain-allowlist` is servable, and every agent run
 * starts by reading runner health, so this must not spawn a process per call —
 * and must not write anything. Only `resolveEgressBridge` touches the disk.
 */
export function resolveEgressInterpreter(
  env: NodeJS.ProcessEnv = process.env,
): Promise<EgressBridgeInterpreter> {
  interpreterProbe ??= (async () => {
    const candidates = [env.SCIENCE_AGENT_EGRESS_PYTHON?.trim(), "python3", "python"].filter(Boolean) as string[];
    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        return await probeInterpreter(candidate);
      } catch (error) {
        failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new EgressBridgeUnavailableError(
      `no usable Python 3 interpreter was found on the host for the egress bridge (${failures.join("; ")}). `
      + "Install python3 or set SCIENCE_AGENT_EGRESS_PYTHON.",
    );
  })();
  // A failed probe must not be cached: the admin can install python3 and retry.
  void interpreterProbe.catch(() => { interpreterProbe = undefined; });
  return interpreterProbe;
}

/**
 * The interpreter plus the bridge script staged under this data directory,
 * resolved once per data directory. Failure is terminal for `domain-allowlist`
 * executions on purpose: falling back to "no bridge" would mean either no
 * network at all with a confusing error, or — far worse — a silently
 * unfiltered path.
 */
const bridges = new Map<string, Promise<EgressBridge>>();

export function resolveEgressBridge(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EgressBridge> {
  const cached = bridges.get(dataDir);
  if (cached) return cached;
  const resolved = (async () => {
    const interpreter = await resolveEgressInterpreter(env);
    const scriptPath = resolve(dataDir, "runner-runtime", "egress-bridge.py");
    await mkdir(resolve(dataDir, "runner-runtime"), { recursive: true });
    await writeFile(scriptPath, BRIDGE_SCRIPT, { mode: 0o600 });
    return { ...interpreter, scriptPath };
  })();
  bridges.set(dataDir, resolved);
  void resolved.catch(() => bridges.delete(dataDir));
  return resolved;
}

/** bwrap binds that expose the bridge and the gateway socket to the sandbox. */
export function egressBridgeBindArguments(bridge: EgressBridge, gatewaySocketPath: string): string[] {
  return [
    "--ro-bind", bridge.interpreterPath, EGRESS_INTERPRETER_PATH,
    "--ro-bind", bridge.stdlibPath, `${EGRESS_PREFIX}/lib/${basename(bridge.stdlibPath)}`,
    "--ro-bind", bridge.scriptPath, EGRESS_BRIDGE_SCRIPT_PATH,
    "--bind", gatewaySocketPath, EGRESS_SOCKET_PATH,
  ];
}

/** Command prefix that starts the bridge and then runs the real argv. */
export function egressBridgeCommandPrefix(): string[] {
  return [
    EGRESS_INTERPRETER_PATH,
    EGRESS_BRIDGE_SCRIPT_PATH,
    "--socket", EGRESS_SOCKET_PATH,
    "--port", String(EGRESS_BRIDGE_PORT),
    "--",
  ];
}
