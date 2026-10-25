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
 * Renderings of an execution machine, kept pure.
 *
 * The settings page that uses these cannot be rendered in this repository — it
 * has no browser environment — so everything that decides *what a machine is
 * said to be* lives here, away from the components, where it can be tested
 * directly. That includes the one judgement the page makes on its own: whether
 * a machine is usable at all.
 */

import { ApiRequestError } from "../api/client.js";
import type { RemoteHostKeyState, RemoteHostTarget, TrustedRemoteHostKey } from "../api/types.js";
import { TEXT } from "../text.js";

/** The two error codes by which an untrusted or changed host key arrives. */
export const SSH_HOST_KEY_UNTRUSTED_CODE = "SSH_HOST_KEY_UNTRUSTED";
export const SSH_HOST_KEY_CHANGED_CODE = "SSH_HOST_KEY_CHANGED";

export interface HostKeyPrompt {
  /** True when this machine was trusted before, under a different key. */
  changed: boolean;
  hostKey: Pick<RemoteHostKeyState, "algorithm" | "fingerprint">;
  /** Present when the failure named the machine record; absent in the add form,
   *  where the record is the one the same request just created. */
  hostId?: string;
  /** What the user is looking at, for the text of the question. */
  target: string;
}

/**
 * Turn a 409 host-key failure into the question it is.
 *
 * Anything else — including an `ApiRequestError` of another code — is not a
 * host-key question, and the caller shows it as an ordinary failure. The
 * fingerprint is required for the prompt to be worth showing: asking someone to
 * accept a key without telling them which one is asking for a blind yes.
 */
export function hostKeyFromError(reason: unknown, target: string): HostKeyPrompt | undefined {
  if (!(reason instanceof ApiRequestError)) return undefined;
  if (reason.code !== SSH_HOST_KEY_UNTRUSTED_CODE && reason.code !== SSH_HOST_KEY_CHANGED_CODE) {
    return undefined;
  }
  const hostKey = reason.details?.hostKey as RemoteHostKeyState | undefined;
  if (!hostKey?.fingerprint) return undefined;
  const hostId = reason.details?.hostId;
  return {
    changed: reason.code === SSH_HOST_KEY_CHANGED_CODE,
    hostKey,
    ...(typeof hostId === "string" ? { hostId } : {}),
    target,
  };
}

/**
 * Whether a Session can execute on this machine.
 *
 * Not the same question as "is it connected". The local machine is always
 * usable; a remote one has to be reachable *and* have the two things Runner
 * execution needs — for `direct` an endpoint and a stored token, for `ssh` a
 * Linux platform, since the deployed bundle targets Linux.
 */
export function runnerUsable(host: RemoteHostTarget): boolean {
  if (host.id === "local") return true;
  if (host.status !== "ready") return false;
  if (host.connectionKind === "direct") return Boolean(host.endpoint && host.hasToken);
  return host.capabilities?.platform === "Linux";
}

/** `host:port` as `ssh` would be given it: an IPv6 literal is bracketed so the
 *  colons inside it cannot be read as the port separator. */
export function hostDestination(host: RemoteHostTarget): string | undefined {
  const address = host.connectionKind === "direct" ? host.endpoint?.host : host.hostName ?? host.alias;
  if (!address) return undefined;
  const port = host.connectionKind === "direct" ? host.endpoint?.port : host.port ?? 22;
  const bracketed = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  return port === undefined ? bracketed : `${bracketed}:${port}`;
}

/** How this machine is reached. `local` is neither of the two remote kinds. */
export function hostKindLabel(host: RemoteHostTarget): string {
  const kind = TEXT.settings.runtime.runner.kind;
  if (host.id === "local") return kind.local;
  return host.connectionKind === "ssh" ? kind.ssh : kind.direct;
}

/** `ssh-ed25519 · SHA256:…`, the form OpenSSH prints and the user compares. */
export function hostKeyLine(key: Pick<TrustedRemoteHostKey, "algorithm" | "fingerprint">): string {
  return [key.algorithm, key.fingerprint].filter((part) => part !== "").join(" · ");
}

/**
 * Whether a presented key replaces one this machine was already trusted under.
 *
 * A probe response carries the challenge the connection failed with, and the
 * challenge's `changed` flag rides along even though the schema's
 * `RemoteHostKeyState` does not declare it. So it is read as the extra field it
 * is: assuming it away would describe a machine that changed its key as merely
 * new, which is the more alarming of the two cases.
 */
export function hostKeyChanged(key: RemoteHostKeyState): boolean {
  return (key as RemoteHostKeyState & { changed?: unknown }).changed === true;
}

/**
 * The machine's own answer, which is a different question from the Runner's.
 *
 * A disconnected Runner says nothing about the machine, so this is what the
 * page shows while nothing is connected. Unknown states are shown as they
 * arrived rather than guessed at.
 */
export function reachabilityLabel(state: string | undefined): string | undefined {
  if (!state) return undefined;
  return TEXT.settings.runtime.runner.reachability[state] ?? state;
}

export function reachabilityHelp(state: string | undefined): string | undefined {
  if (!state) return undefined;
  return TEXT.settings.runtime.runner.reachability[`${state}Help`];
}

export function reachabilityTone(state: string | undefined): "ok" | "warn" {
  return state === "online" ? "ok" : "warn";
}

/** Which stored credentials a machine has. Never what they are. */
export function storedCredentialLabels(host: RemoteHostTarget): string[] {
  return [
    host.hasPassword ? TEXT.settings.runtime.runner.secretStored : "",
    host.hasPrivateKey ? TEXT.settings.runtime.runner.keyStored : "",
  ].filter((label) => label !== "");
}

/**
 * The machines 设置 › 远程 manages: every Runner except the local one.
 *
 * The local entry is synthesized by the server and always exists. It needs no
 * registration, cannot be deleted or re-addressed, and is never what this page
 * is for — so it is dropped here, once, rather than guarded at every row and
 * every checkbox.
 */
export function remoteHosts<T extends { id: string }>(hosts: readonly T[]): T[] {
  return hosts.filter((host) => host.id !== "local");
}

/**
 * The machines that go on the allowlist.
 *
 * An unusable machine is left out for the same reason the API refuses it: a
 * checkbox for it would only produce a run that fails at the last step. The
 * machine still shows in the Runner list above, where the reason it is unusable
 * is visible.
 */
export function allowlistHosts(hosts: RemoteHostTarget[]): RemoteHostTarget[] {
  return hosts.filter(runnerUsable);
}

/** The runner ids currently allowed, which may be a legacy `remoteRunnerHostIds`
 *  list: those always included the local machine implicitly. */
export function projectRunnerIds(project: {
  remoteRunnerHostIds?: string[];
  runnerIds?: string[];
}): string[] {
  return project.runnerIds ? [...project.runnerIds] : ["local", ...(project.remoteRunnerHostIds ?? [])];
}

/**
 * The allowlist with one machine toggled.
 *
 * Always sent whole, and never left in a shape the API rejects: it refuses an
 * empty string or a blank entry, so nothing is added that is not a usable id.
 */
export function toggleRunnerId(ids: string[], id: string): string[] {
  if (!id.trim()) return ids;
  return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id];
}
