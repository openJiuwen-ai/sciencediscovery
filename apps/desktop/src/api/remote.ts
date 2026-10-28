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

/**
 * Registering and managing an execution machine.
 *
 * The three older Runner routes — `listRunners`, `probeRunner`,
 * `setRunnerConnected` — stay in `settings.ts`, where they already were; this
 * module carries the ones that act on a machine's *record* rather than on its
 * connection: registration, login credentials, host keys and deletion. The
 * distinction shows up in the signatures: a failed probe still stores the
 * machine and returns its record, while a failed connect throws.
 *
 * Two rules the whole surface is built around, both from the API side:
 *
 * - Credential material never travels *to* the browser. A password or passphrase
 *   may be sent once and is then write-only; a private key is named by a path
 *   this API host can read, or generated here, and is never submitted as text.
 * - An untrusted or changed host key is a question, not a failure. It arrives as
 *   409 with `SSH_HOST_KEY_UNTRUSTED` / `SSH_HOST_KEY_CHANGED` and the
 *   fingerprint to show — see `hostKeyFromError` in `app/remote-format.ts`.
 */

import type { ApiClient } from "./client.js";
import type {
  GeneratedRemoteHostKey,
  RegisterRemoteHostRequest,
  RemoteConnectLog,
  RemoteHostTarget,
  SshConfigHostImport,
  SshKeyFileListing,
  TrustedRemoteHostKey,
} from "./types.js";

/** Credentials are write-only: sending `null` forgets a stored value, and an
 *  absent key keeps whatever is stored. Nothing here can read one back. */
export type SshCredentialsRequest = Pick<
  RegisterRemoteHostRequest,
  "passphrase" | "password" | "privateKeyPath" | "username"
>;

/** Only the two fields of a trusted key are ever sent back: `trustedAt` is the
 *  server's own record of when it accepted one. */
export type RemoteHostKeyInfo = Pick<TrustedRemoteHostKey, "algorithm" | "fingerprint">;

/** Create or update one machine. Passing `id` updates a machine already
 *  registered, which is how the trust retry addresses it. */
export function registerRemoteHost(
  client: ApiClient,
  body: RegisterRemoteHostRequest,
): Promise<RemoteHostTarget> {
  return client.request<RemoteHostTarget>("/api/remote-hosts", {
    body: JSON.stringify(body),
    method: "POST",
  });
}

/** Replace the login credentials of an SSH machine and probe with them. The
 *  response is that probe, so a save that works shows as working. */
export function updateRemoteHostCredentials(
  client: ApiClient,
  hostId: string,
  body: SshCredentialsRequest,
): Promise<RemoteHostTarget> {
  return client.request<RemoteHostTarget>(
    `/api/remote-hosts/${encodeURIComponent(hostId)}/credentials`,
    { body: JSON.stringify(body), method: "PUT" },
  );
}

/** Accept a fingerprint and probe again in one call — "trust and continue". */
export function trustRemoteHostKey(
  client: ApiClient,
  hostId: string,
  hostKey: RemoteHostKeyInfo,
): Promise<RemoteHostTarget> {
  return client.request<RemoteHostTarget>(
    `/api/remote-hosts/${encodeURIComponent(hostId)}/trust-host-key`,
    { body: JSON.stringify(hostKey), method: "POST" },
  );
}

/** Removes the machine record and whatever connection it had. */
export function deleteRemoteHost(client: ApiClient, hostId: string): Promise<{ deleted: string }> {
  return client.request<{ deleted: string }>(
    `/api/remote-hosts/${encodeURIComponent(hostId)}`,
    { method: "DELETE" },
  );
}

/** `POST /api/remote-hosts/generate-key`. The private half is staged in the
 *  API's data directory and consumed once a machine stores it, so the returned
 *  path is single-use and short-lived. */
export function generateRemoteHostKey(client: ApiClient): Promise<GeneratedRemoteHostKey> {
  return client.request<GeneratedRemoteHostKey>("/api/remote-hosts/generate-key", {
    method: "POST",
  });
}

/**
 * The story of the last connect attempt for one machine.
 *
 * A connect can take minutes — it may deploy the Runner bundle first — so this
 * is polled while the request is in flight rather than read once. Lines are
 * operator-facing diagnostics in English, like the errors beside them.
 */
export function runnerConnectLog(client: ApiClient, runnerId: string): Promise<RemoteConnectLog> {
  return client.request<RemoteConnectLog>(
    `/api/runners/${encodeURIComponent(runnerId)}/connect-log`,
  );
}

/**
 * Prefilling a registration from the user's own `ssh_config`.
 *
 * Without an alias the route lists what could be imported, so the form can
 * offer a choice instead of asking someone to recall a host name. Neither form
 * carries key material — only where an entry points.
 */
export function listSshConfigHosts(client: ApiClient): Promise<SshConfigHostImport[]> {
  return client.request<SshConfigHostImport[]>("/api/remote-hosts/ssh-config");
}

/**
 * One entry, resolved.
 *
 * The list deliberately leaves out `identityFile`, so this is the only call
 * that answers which key the entry names — and whether this API host can read
 * it. The product does not go through `ssh_config` after an import, so what
 * comes back is copied into the form's own fields.
 */
export function resolveSshConfigHost(
  client: ApiClient,
  alias: string,
): Promise<SshConfigHostImport> {
  return client.request<SshConfigHostImport>(
    `/api/remote-hosts/ssh-config?alias=${encodeURIComponent(alias)}`,
  );
}

/**
 * Browse the machine the API runs on for a private key.
 *
 * Not the browser's filesystem and not the SSH target's: an SSH key has to be
 * readable exactly where the product runs. Metadata only — nothing here reads
 * or validates key contents.
 */
export function browseSshKeyFiles(
  client: ApiClient,
  path?: string,
  offset = 0,
): Promise<SshKeyFileListing> {
  const query = new URLSearchParams();
  if (path) query.set("path", path);
  query.set("offset", String(offset));
  return client.request<SshKeyFileListing>(`/api/remote-hosts/key-files?${query.toString()}`);
}
