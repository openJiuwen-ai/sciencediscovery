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
import type { Duplex } from "node:stream";

import ssh2 from "ssh2";

const { Client } = ssh2;

/**
 * The product speaks SSH itself rather than driving the system `ssh` binary.
 *
 * `ssh -o BatchMode=yes` can neither ask the user for a password nor ask them
 * to trust a new host key: it can only fail and tell them to go edit files
 * outside the product. Owning the client is what lets both of those be answered
 * in the settings page, with the credentials and the trusted fingerprints kept
 * in the product's own storage instead of the user's `~/.ssh`.
 */
export interface SshCredentials {
  /** Login user on the remote machine. */
  username: string;
  password?: string;
  /** OpenSSH private key material; never a path once it reaches this layer. */
  privateKey?: string;
  passphrase?: string;
}

/** A host key the user has accepted, in the form OpenSSH prints. */
export interface TrustedHostKey {
  /** Key type as announced on the wire, for example `ssh-ed25519`. */
  algorithm: string;
  /** `SHA256:<base64>` over the public key blob. */
  fingerprint: string;
}

/** What the settings page needs to offer "trust this machine and continue". */
export interface SshHostKeyChallenge extends TrustedHostKey {
  /**
   * True when this machine was already trusted under a different key. A changed
   * key is the case worth a second look, so it is reported separately rather
   * than folded into "unknown".
   */
  changed: boolean;
}

export interface SshTarget {
  credentials: SshCredentials;
  /** Alias, hostname or IP address; resolved by this client, not by ssh config. */
  destination: string;
  port?: number;
  /** Accepted key for this machine; absent means nothing is trusted yet. */
  trustedHostKey?: TrustedHostKey;
}

/** Raised instead of a generic failure so the caller can offer to trust the key. */
export class SshHostKeyUntrustedError extends Error {
  constructor(readonly challenge: SshHostKeyChallenge, destination: string) {
    super(challenge.changed
      ? `The host key of ${destination} changed. Review the new ${challenge.algorithm} fingerprint ${challenge.fingerprint} and trust it in settings before connecting again.`
      : `${destination} presented an untrusted ${challenge.algorithm} host key (${challenge.fingerprint}). Trust it in settings to connect.`);
    this.name = "SshHostKeyUntrustedError";
  }
}

export interface SshCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * Fingerprint a host key the way OpenSSH does, so what the settings page shows
 * is the same string a user can check with `ssh-keyscan` on their own.
 */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/**
 * Key type from the public key blob: SSH wire format starts with a length-
 * prefixed string naming the algorithm.
 */
export function hostKeyAlgorithm(key: Buffer): string {
  if (key.length < 4) return "unknown";
  const length = key.readUInt32BE(0);
  return length > 0 && length <= key.length - 4 ? key.subarray(4, 4 + length).toString("ascii") : "unknown";
}

function validateCredentials(credentials: SshCredentials): void {
  const username = credentials.username?.trim();
  if (!username) throw new Error("This machine needs the user name to log in with");
  if (!credentials.password && !credentials.privateKey) {
    throw new Error("This machine needs a password or a private key to log in with");
  }
}

/** Protocol diagnostics must never retain credential payloads or debug logs. */
class AuthenticationDiagnostics {
  private offered: string[] | null = null;
  private readonly attempted: string[] = [];
  private banner = "";

  constructor(private readonly target: SshTarget) {}

  private safe(text: string, limit = 300): string {
    for (const secret of [this.target.credentials.password, this.target.credentials.privateKey, this.target.credentials.passphrase]) {
      if (secret) {
        text = text.split(secret).join("[redacted]");
        if (secret.trim()) text = text.split(secret.trim()).join("[redacted]");
      }
    }
    return text
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted key]")
      .replace(/\b(password|passphrase|token|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
      .replace(/[A-Za-z0-9+/=_-]{48,}/g, "[redacted opaque value]")
      .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
      .slice(0, limit);
  }

  setBanner(message: string): void { this.banner = this.safe(message); }

  next(methods: string[] | null): string | false {
    if (methods !== null) this.offered = methods;
    // Discover server methods first; only try supported methods with available credentials.
    const candidates = methods === null ? ["none"] : [
      ...(this.target.credentials.password ? ["password"] : []),
      ...(this.target.credentials.privateKey ? ["publickey"] : []),
      ...(this.target.credentials.password ? ["keyboard-interactive"] : []),
    ];
    const method = candidates.find((candidate) => !this.attempted.includes(candidate)
      && (methods === null || methods.includes(candidate)));
    if (!method) return false;
    this.attempted.push(method);
    return method;
  }

  error(reason = "The server did not accept authentication. Check the credentials and the server's account/login policy.", prompt?: string): Error {
    const host = this.target.destination.includes(":") ? `[${this.target.destination}]` : this.target.destination;
    return new Error([
      `SSH authentication failed for ${this.safe(this.target.credentials.username.trim(), 128)}@${this.safe(host, 200)}:${this.target.port ?? 22}.`,
      `Server offered: ${this.offered === null ? "unknown (no method list received)" : this.safe(this.offered.join(", ")) || "none"}.`,
      `Actually tried: ${this.attempted.join(", ") || "none"} (none is method discovery).`,
      `Stored credentials: password ${this.target.credentials.password ? "yes" : "no"}; key ${this.target.credentials.privateKey ? "yes" : "no"}.`,
      reason,
      ...(this.banner ? [`Server banner: ${this.banner}`] : []),
      ...(prompt ? [`Server prompt: ${this.safe(prompt)}`] : []),
    ].join("\n"));
  }
}

/**
 * What the rest of the product needs from a live SSH connection. Naming it
 * keeps the tunnel testable: a test can supply a session instead of a server.
 */
export interface SshSession {
  close(): void;
  forwardToRemoteSocket(socketPath: string): Promise<Duplex>;
  onClose(listener: (error?: Error) => void): void;
  run(script: string, timeoutMs: number, options?: { pty?: boolean }): Promise<SshCommandResult>;
  start(script: string, onExit: (code: number | null, stderr: string) => void): Promise<void>;
}

/**
 * One live SSH connection. Commands, the deployment and the runner tunnel all
 * run over the same connection, so they cannot disagree about which credentials
 * or which trusted key were used.
 */
export class SshConnection implements SshSession {
  private failure?: Error;

  private constructor(
    private readonly client: InstanceType<typeof Client>,
    private readonly target: SshTarget,
  ) {
    // Keep a listener after authentication: an unhandled Client error would
    // otherwise terminate the control API, not just this SSH connection.
    client.on("error", (error: Error) => {
      this.failure ??= error;
      client.destroy();
    });
  }

  static async open(target: SshTarget): Promise<SshConnection> {
    validateCredentials(target.credentials);
    const client = new Client();
    const authentication = new AuthenticationDiagnostics(target);
    return await new Promise<SshConnection>((resolveOpen, reject) => {
      let untrusted: SshHostKeyChallenge | undefined;
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        client.end();
        // A refused host key surfaces as a plain connection error, so the
        // verifier's finding is what the caller is told about.
        reject(untrusted ? new SshHostKeyUntrustedError(untrusted, target.destination)
          : (error as Error & { level?: string }).level === "client-authentication" ? authentication.error() : error);
      };
      // Retain the listener for late errors after an explicit authentication rejection.
      client.on("error", fail);
      client.on("banner", (message: string) => authentication.setBanner(message));
      client.on("change password", (prompt: string) => fail(authentication.error(
        "The server requires a password change. Change it through an administrator-approved login, then update the saved credentials and retry.", prompt,
      )));
      client.on("keyboard-interactive", (_name, _instructions, _language, prompts, finish) => {
        if (!target.credentials.password || prompts.some((prompt) => prompt.echo)) {
          fail(authentication.error("The server requested an interactive challenge that cannot be answered with the saved password."));
          return;
        }
        finish(prompts.map(() => target.credentials.password!));
      });
      client.once("ready", () => {
        if (settled) { client.end(); return; }
        settled = true;
        const connection = new SshConnection(client, target);
        client.removeListener("error", fail);
        resolveOpen(connection);
      });
      client.connect({
        authHandler: (methods) => authentication.next(methods),
        tryKeyboard: Boolean(target.credentials.password),
        host: target.destination,
        ...(target.port === undefined ? {} : { port: target.port }),
        username: target.credentials.username.trim(),
        ...(target.credentials.password ? { password: target.credentials.password } : {}),
        ...(target.credentials.privateKey ? { privateKey: target.credentials.privateKey } : {}),
        ...(target.credentials.passphrase ? { passphrase: target.credentials.passphrase } : {}),
        // Only keys the user accepted in this product are allowed; there is no
        // fallback to the user's known_hosts and no "accept anything" mode.
        hostVerifier: (key: Buffer) => {
          const fingerprint = hostKeyFingerprint(key);
          const algorithm = hostKeyAlgorithm(key);
          if (target.trustedHostKey?.fingerprint === fingerprint) return true;
          untrusted = { algorithm, changed: Boolean(target.trustedHostKey), fingerprint };
          return false;
        },
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
      });
    });
  }

  /** Read this machine's key without logging in, so it can be offered for trust. */
  static async readHostKey(target: SshTarget): Promise<SshHostKeyChallenge> {
    const client = new Client();
    return await new Promise<SshHostKeyChallenge>((resolveKey, reject) => {
      let seen: SshHostKeyChallenge | undefined;
      client.once("error", (error: Error) => {
        client.end();
        if (seen) resolveKey(seen);
        else reject(error);
      });
      client.once("ready", () => {
        client.end();
        if (seen) resolveKey(seen);
        else reject(new Error(`${target.destination} did not present a host key`));
      });
      client.connect({
        host: target.destination,
        ...(target.port === undefined ? {} : { port: target.port }),
        username: target.credentials.username?.trim() || "sciencediscovery",
        // Authentication is irrelevant here: the key arrives before it, and the
        // handshake is abandoned as soon as it has been recorded.
        hostVerifier: (key: Buffer) => {
          seen = {
            algorithm: hostKeyAlgorithm(key),
            changed: target.trustedHostKey !== undefined
              && target.trustedHostKey.fingerprint !== hostKeyFingerprint(key),
            fingerprint: hostKeyFingerprint(key),
          };
          return false;
        },
        readyTimeout: 20_000,
      });
    });
  }

  /**
   * Run a script through `sh -s`. A pseudo-terminal is requested for long-lived
   * commands so the remote process is hung up when this connection ends, rather
   * than being left behind on the user's machine.
   */
  run(script: string, timeoutMs: number, options: { pty?: boolean } = {}): Promise<SshCommandResult> {
    return new Promise<SshCommandResult>((resolveRun, reject) => {
      let settled = false;
      const fail = (error: Error): void => {
        clearTimeout(timer);
        this.client.removeListener("close", onClose);
        if (settled) return;
        settled = true;
        reject(error);
      };
      const onClose = (): void => fail(this.failure ?? new Error("The SSH connection closed during the command"));
      const timer = setTimeout(() => {
        if (settled) return;
        fail(new Error(`SSH command timed out after ${timeoutMs} ms`));
        this.close();
      }, timeoutMs);
      this.client.once("close", onClose);
      this.client.exec("sh -s", { pty: options.pty === true }, (error, stream) => {
        if (error) {
          fail(error);
          return;
        }
        stream.on("error", fail);
        stream.stderr.on("error", fail);
        let stdout: Buffer = Buffer.alloc(0);
        let stderr: Buffer = Buffer.alloc(0);
        const append = (current: Buffer, chunk: Buffer): Buffer => {
          const next = Buffer.concat([current, chunk]);
          if (next.length > MAX_COMMAND_OUTPUT_BYTES) throw new Error("SSH command output exceeded 2 MB");
          return next;
        };
        stream.on("data", (chunk: Buffer) => {
          try { stdout = append(stdout, chunk); } catch (overflow) {
            fail(overflow as Error);
            stream.close();
          }
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          try { stderr = append(stderr, chunk); } catch (overflow) {
            fail(overflow as Error);
            stream.close();
          }
        });
        stream.once("close", (code: number | null) => {
          clearTimeout(timer);
          this.client.removeListener("close", onClose);
          if (settled) return;
          if (this.failure) { fail(this.failure); return; }
          settled = true;
          resolveRun({ exitCode: code ?? 255, stderr: stderr.toString("utf8"), stdout: stdout.toString("utf8") });
        });
        stream.end(script);
      });
    });
  }

  /**
   * Start a long-running command and keep its stream open. Used for the runner:
   * the process must stay alive for as long as this connection does.
   */
  start(script: string, onExit: (code: number | null, stderr: string) => void): Promise<void> {
    return new Promise<void>((resolveStart, reject) => {
      const onClose = (): void => reject(this.failure ?? new Error("The SSH connection closed while starting the command"));
      this.client.once("close", onClose);
      this.client.exec("sh -s", { pty: true }, (error, stream) => {
        this.client.removeListener("close", onClose);
        if (error) {
          reject(error);
          return;
        }
        let stderr = "";
        let exited = false;
        const finish = (code: number | null, message: string): void => {
          if (exited) return;
          exited = true;
          onExit(code, message);
        };
        const fail = (error: Error): void => {
          finish(null, error.message);
          stream.close();
        };
        stream.on("error", fail);
        stream.stderr.on("error", fail);
        stream.stderr.on("data", (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
        });
        // The runner's own stdout is not read by anyone; draining it keeps the
        // channel window from filling and stalling the process.
        stream.on("data", () => undefined);
        stream.once("close", (code: number | null) => finish(code, this.failure?.message ?? stderr));
        stream.end(script);
        resolveStart();
      });
    });
  }

  /** Open a stream to a Unix socket on the remote machine. */
  forwardToRemoteSocket(socketPath: string): Promise<Duplex> {
    return new Promise<Duplex>((resolveStream, reject) => {
      this.client.openssh_forwardOutStreamLocal(socketPath, (error, stream) => {
        if (error) reject(error);
        else resolveStream(stream as unknown as Duplex);
      });
    });
  }

  onClose(listener: (error?: Error) => void): void {
    this.client.once("close", () => listener(this.failure));
  }

  close(): void {
    this.client.end();
  }
}
