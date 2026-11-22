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

import type { RemoteWorkspaceSyncDirection } from "./remote-job.js";

/** A scientific-environment change a permission request can carry. */
export type PermissionEnvironmentOperation = "create" | "delete" | "install" | "setup" | "uninstall";

/**
 * What a pending permission request is about, as fields rather than as a
 * finished sentence.
 *
 * `PermissionRequest.summary` stays the canonical English statement: it is the
 * audit record and the fallback for clients that predate this field. A client
 * that knows the `kind` composes the same statement in the language the reader
 * is using, so a persisted request replayed tomorrow is not frozen in the
 * language it was created in (#1305).
 *
 * Every text field here is displayed verbatim, not translated: an alias, an
 * account, a workspace path, a tool id. Nothing is localized server-side — the
 * API has no Session locale to translate with.
 */
export type PermissionDescription =
  | { kind: "shell"; remoteHostAlias?: string; subagentId?: string }
  | { kind: "python"; remoteHostAlias?: string; subagentId?: string }
  | { kind: "language"; language: string; remoteHostAlias?: string; subagentId?: string }
  | { kind: "file-copy"; fileCount: number }
  | { kind: "npu"; operation: "cancel" | "run"; subject: string; subagentId?: string }
  | {
    account: string;
    command: string;
    cwd: string;
    kind: "direct-host";
    runnerId: string;
    subagentId?: string;
    target: string;
    workspaceRoot: string;
  }
  | { kind: "specialist-runtime"; runtime: string; workspaceRoot: string }
  | { hosts: string[]; kind: "network"; purpose: string; runnerId: string }
  | {
    environmentId?: string;
    kind: "environment";
    language?: string;
    manager?: string;
    name?: string;
    operation: PermissionEnvironmentOperation;
    runnerId?: string;
  }
  | { direction: RemoteWorkspaceSyncDirection; kind: "workspace-sync"; paths: string[]; runnerId: string }
  | { kind: "skill-publish"; proposalCount: number; subagentId?: string }
  | { kind: "mcp-tool"; recovered?: boolean; sourceId: string; toolId: string }
  | { kind: "artifact-download"; name: string; path: string }
  | { command: string; hostAlias: string; kind: "remote-job"; mode: string }
  | { hostname?: string; kind: "web"; operation: "fetch" | "search"; query?: string }
  | {
    /**
     * The arguments being approved, verbatim (a shell command, a JSON object),
     * when the tool's own resource cannot carry them: `run_shell` approves the
     * fixed `workspace-code` resource, so the command exists nowhere else.
     */
    detail?: string;
    kind: "tool-call";
    toolName?: string;
  };

export type PermissionDescriptionKind = PermissionDescription["kind"];

/**
 * The wording for each kind, in one language. Both front ends implement this
 * table from their own catalog; `formatPermissionDescription` owns the mapping
 * from fields to arguments so neither of them can silently skip a kind.
 */
export type PermissionDescriptionRenderers = {
  [Kind in PermissionDescriptionKind]: (
    description: Extract<PermissionDescription, { kind: Kind }>,
  ) => string;
};

export function formatPermissionDescription(
  description: PermissionDescription,
  renderers: PermissionDescriptionRenderers,
): string {
  const render = renderers[description.kind] as (input: PermissionDescription) => string;
  return render(description);
}

const MAX_IDENTIFIER = 200;
const MAX_PATH = 1024;
const MAX_COMMAND = 20_000;
const MAX_HOSTS = 16;
const MAX_PATHS = 50;

function text(value: unknown, max = MAX_IDENTIFIER): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function texts(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((entry) => text(entry, MAX_PATH) ?? []).slice(0, max);
  return items.length ? items : undefined;
}

/**
 * Read a description that crossed a trust boundary: the catalog on disk, or a
 * request body from any client. Anything unrecognized is dropped whole, which
 * leaves the canonical `summary` in charge rather than a half-valid card.
 */
export function normalizePermissionDescription(value: unknown): PermissionDescription | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  switch (raw.kind) {
    case "shell":
    case "python": {
      const remoteHostAlias = text(raw.remoteHostAlias);
      const subagentId = text(raw.subagentId);
      return { kind: raw.kind, ...(remoteHostAlias ? { remoteHostAlias } : {}), ...(subagentId ? { subagentId } : {}) };
    }
    case "language": {
      const language = text(raw.language);
      if (!language) return undefined;
      const remoteHostAlias = text(raw.remoteHostAlias);
      const subagentId = text(raw.subagentId);
      return { kind: "language", language, ...(remoteHostAlias ? { remoteHostAlias } : {}), ...(subagentId ? { subagentId } : {}) };
    }
    case "file-copy": {
      const fileCount = count(raw.fileCount);
      return fileCount === undefined ? undefined : { kind: "file-copy", fileCount };
    }
    case "npu": {
      const subject = text(raw.subject);
      if (!subject || (raw.operation !== "cancel" && raw.operation !== "run")) return undefined;
      const subagentId = text(raw.subagentId);
      return { kind: "npu", operation: raw.operation, subject, ...(subagentId ? { subagentId } : {}) };
    }
    case "direct-host": {
      const runnerId = text(raw.runnerId);
      const command = text(raw.command, MAX_COMMAND);
      if (!runnerId || !command) return undefined;
      const subagentId = text(raw.subagentId);
      return {
        account: text(raw.account) ?? "",
        command,
        cwd: text(raw.cwd, MAX_PATH) ?? "",
        kind: "direct-host",
        runnerId,
        ...(subagentId ? { subagentId } : {}),
        target: text(raw.target) ?? "",
        workspaceRoot: text(raw.workspaceRoot, MAX_PATH) ?? "",
      };
    }
    case "specialist-runtime": {
      const runtime = text(raw.runtime);
      const workspaceRoot = text(raw.workspaceRoot, MAX_PATH);
      return runtime && workspaceRoot ? { kind: "specialist-runtime", runtime, workspaceRoot } : undefined;
    }
    case "network": {
      const runnerId = text(raw.runnerId);
      const hosts = texts(raw.hosts, MAX_HOSTS);
      const purpose = text(raw.purpose);
      return runnerId && hosts && purpose ? { hosts, kind: "network", purpose, runnerId } : undefined;
    }
    case "environment": {
      if (!["create", "delete", "install", "setup", "uninstall"].includes(String(raw.operation))) return undefined;
      const operation = raw.operation as PermissionEnvironmentOperation;
      const environmentId = text(raw.environmentId);
      const language = text(raw.language);
      const manager = text(raw.manager);
      const name = text(raw.name);
      const runnerId = text(raw.runnerId);
      return {
        ...(environmentId ? { environmentId } : {}),
        kind: "environment",
        ...(language ? { language } : {}),
        ...(manager ? { manager } : {}),
        ...(name ? { name } : {}),
        operation,
        ...(runnerId ? { runnerId } : {}),
      };
    }
    case "workspace-sync": {
      const runnerId = text(raw.runnerId);
      const paths = texts(raw.paths, MAX_PATHS);
      if (!runnerId || !paths || (raw.direction !== "pull" && raw.direction !== "push")) return undefined;
      return { direction: raw.direction, kind: "workspace-sync", paths, runnerId };
    }
    case "skill-publish": {
      const proposalCount = count(raw.proposalCount);
      if (proposalCount === undefined) return undefined;
      const subagentId = text(raw.subagentId);
      return { kind: "skill-publish", proposalCount, ...(subagentId ? { subagentId } : {}) };
    }
    case "mcp-tool": {
      const sourceId = text(raw.sourceId);
      const toolId = text(raw.toolId);
      if (!sourceId || !toolId) return undefined;
      return { kind: "mcp-tool", ...(raw.recovered === true ? { recovered: true } : {}), sourceId, toolId };
    }
    case "artifact-download": {
      const name = text(raw.name);
      const path = text(raw.path, MAX_PATH);
      return name && path ? { kind: "artifact-download", name, path } : undefined;
    }
    case "remote-job": {
      const mode = text(raw.mode, 32);
      const hostAlias = text(raw.hostAlias);
      const command = text(raw.command, MAX_COMMAND);
      return mode && hostAlias && command ? { command, hostAlias, kind: "remote-job", mode } : undefined;
    }
    case "web": {
      if (raw.operation !== "search" && raw.operation !== "fetch") return undefined;
      const query = text(raw.query);
      const hostname = text(raw.hostname);
      if (raw.operation === "search" ? !query : !hostname) return undefined;
      return { ...(hostname ? { hostname } : {}), kind: "web", operation: raw.operation, ...(query ? { query } : {}) };
    }
    case "tool-call": {
      const toolName = text(raw.toolName);
      const detail = text(raw.detail, MAX_COMMAND);
      return { kind: "tool-call", ...(detail ? { detail } : {}), ...(toolName ? { toolName } : {}) };
    }
    default:
      return undefined;
  }
}
