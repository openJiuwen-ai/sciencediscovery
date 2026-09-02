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

/**
 * What the rest of the product needs from a live SSH connection. Naming it
 * keeps the tunnel testable: a test can supply a session instead of a server.
 */
export interface SshSession {
  close(): void;
  forwardToRemoteSocket(socketPath: string): Promise<Duplex>;
  onClose(listener: () => void): void;
  run(script: string, timeoutMs: number, options?: { pty?: boolean }): Promise<SshCommandResult>;
  start(script: string, onExit: (code: number | null, stderr: string) => void): Promise<void>;
}

/**
 * One live SSH connection. Commands, the deployment and the runner tunnel all
 * run over the same connection, so they cannot disagree about which credentials
 * or which trusted key were used.
 */
export class SshConnection implements SshSession {
  private constructor(
    private readonly client: InstanceType<typeof Client>,
    private readonly target: SshTarget,
  ) {}

  static async open(target: SshTarget): Promise<SshConnection> {
    validateCredentials(target.credentials);
    const client = new Client();
    return await new Promise<SshConnection>((resolveOpen, reject) => {
      let untrusted: SshHostKeyChallenge | undefined;
      const fail = (error: Error): void => {
        client.end();
        // A refused host key surfaces as a plain connection error, so the
        // verifier's finding is what the caller is told about.
        reject(untrusted ? new SshHostKeyUntrustedError(untrusted, target.destination) : error);
      };
      client.once("error", fail);
      client.once("ready", () => {
        client.removeListener("error", fail);
        resolveOpen(new SshConnection(client, target));
      });
      client.connect({
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
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.close();
        reject(new Error(`SSH command timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.client.exec("sh -s", { pty: options.pty === true }, (error, stream) => {
        if (error) {
          clearTimeout(timer);
          if (!settled) reject(error);
          settled = true;
          return;
        }
        let stdout: Buffer = Buffer.alloc(0);
        let stderr: Buffer = Buffer.alloc(0);
        const append = (current: Buffer, chunk: Buffer): Buffer => {
          const next = Buffer.concat([current, chunk]);
          if (next.length > MAX_COMMAND_OUTPUT_BYTES) throw new Error("SSH command output exceeded 2 MB");
          return next;
        };
        stream.on("data", (chunk: Buffer) => {
          try { stdout = append(stdout, chunk); } catch (overflow) {
            if (!settled) reject(overflow as Error);
            settled = true;
            stream.close();
          }
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          try { stderr = append(stderr, chunk); } catch (overflow) {
            if (!settled) reject(overflow as Error);
            settled = true;
            stream.close();
          }
        });
        stream.once("close", (code: number | null) => {
          clearTimeout(timer);
          if (settled) return;
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
      this.client.exec("sh -s", { pty: true }, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        let stderr = "";
        stream.stderr.on("data", (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
        });
        // The runner's own stdout is not read by anyone; draining it keeps the
        // channel window from filling and stalling the process.
        stream.on("data", () => undefined);
        stream.once("close", (code: number | null) => onExit(code, stderr));
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

  onClose(listener: () => void): void {
    this.client.once("close", listener);
  }

  close(): void {
    this.client.end();
  }
}
