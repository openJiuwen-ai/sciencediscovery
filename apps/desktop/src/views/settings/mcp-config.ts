// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { CustomMcpServerDetails, CustomMcpServerInput } from "../../api/types.js";
import { TEXT } from "../../text.js";

/** One secret slot. A saved key keeps `originalKey` and an empty value, which
 *  the server reads as "keep the stored secret"; typing a value replaces it. */
export interface SecretRow {
  key: string;
  originalKey?: string;
  value: string;
}

interface OauthDraft {
  clientId: string;
  clientMetadataUrl: string;
  clientSecret: string;
  scope: string;
}

export interface Draft {
  args: string;
  authMode: NonNullable<CustomMcpServerInput["authMode"]>;
  command: string;
  cwd: string;
  description: string;
  enabled: boolean;
  envRows: SecretRow[];
  headerRows: SecretRow[];
  id?: string;
  name: string;
  oauth: OauthDraft;
  originalArgs?: string[];
  savedOauthSecret: boolean;
  timeoutSeconds: string;
  transport: CustomMcpServerInput["transport"];
  url: string;
}

export function emptyDraft(): Draft {
  return {
    args: "",
    authMode: "headers",
    command: "",
    cwd: "",
    description: "",
    enabled: false,
    envRows: [],
    headerRows: [],
    name: "",
    oauth: { clientId: "", clientMetadataUrl: "", clientSecret: "", scope: "" },
    savedOauthSecret: false,
    timeoutSeconds: "60",
    transport: "http",
    url: "",
  };
}

function rowsFrom(map: Record<string, null>): SecretRow[] {
  return Object.keys(map).map((key) => ({ key, originalKey: key, value: "" }));
}

export function draftOf(server: CustomMcpServerDetails): Draft {
  return {
    args: server.args.join("\n"),
    originalArgs: server.args,
    authMode: server.authMode ?? "headers",
    command: server.command,
    cwd: server.cwd,
    description: server.description,
    enabled: server.enabled,
    envRows: rowsFrom(server.env),
    headerRows: rowsFrom(server.headers),
    id: server.id,
    name: server.name,
    oauth: {
      clientId: server.oauth?.clientId ?? "",
      clientMetadataUrl: server.oauth?.clientMetadataUrl ?? "",
      clientSecret: "",
      scope: server.oauth?.scope ?? "",
    },
    savedOauthSecret: server.oauth?.clientSecret === null,
    timeoutSeconds: String(server.timeoutSeconds),
    transport: server.transport,
    url: server.url,
  };
}

/** `null` keeps a saved secret; a typed value replaces it. An unchanged key
 *  therefore never has to resend the secret it never saw. */
function secretMap(rows: SecretRow[]): Record<string, string | null> {
  return Object.fromEntries(rows.map((row) => {
    const key = row.key.trim();
    const keep = row.value === "" && row.originalKey === key;
    return [key, keep ? null : row.value];
  }));
}

/** The server rejects a renamed key without a value, and a duplicate or blank
 *  key; catching it here names the row instead of failing the whole write. */
export function secretProblem(rows: SecretRow[]): string | undefined {
  const keys = rows.map((row) => row.key.trim());
  if (keys.some((key) => key === "")) return TEXT.settings.system.mcp.secretKeyEmpty;
  if (new Set(keys).size !== keys.length) return TEXT.settings.system.mcp.secretKeyDuplicate;
  if (rows.some((row) => row.originalKey !== undefined && row.originalKey !== row.key.trim() && row.value === "")) {
    return TEXT.settings.system.mcp.secretRenameRequired;
  }
  return undefined;
}

export function inputOf(draft: Draft): CustomMcpServerInput {
  const stdio = draft.transport === "stdio";
  // Preserve legacy empty arguments when only other fields are edited.
  const args = draft.originalArgs?.join("\n") === draft.args
    ? draft.originalArgs
    : draft.args.split(/\r?\n/).filter((line) => line.length > 0);
  return {
    args,
    authMode: stdio ? "headers" : draft.authMode,
    command: draft.command.trim(),
    cwd: draft.cwd.trim(),
    description: draft.description.trim(),
    enabled: draft.enabled,
    env: stdio ? secretMap(draft.envRows) : {},
    headers: stdio ? {} : secretMap(draft.headerRows),
    name: draft.name.trim(),
    ...(stdio ? {} : {
      oauth: {
        ...draft.oauth,
        clientSecret: draft.oauth.clientSecret === "" && draft.savedOauthSecret
          ? null
          : draft.oauth.clientSecret,
      },
    }),
    timeoutSeconds: Number(draft.timeoutSeconds),
    transport: draft.transport,
    url: draft.url.trim(),
  };
}

/** JSON is only a source of drafts. Persisting them uses the ordinary form. */
export function parseMcpDrafts(text: string): { drafts: Draft[]; error?: string } {
  const t = TEXT.settings.system.mcp;
  if (new TextEncoder().encode(text).byteLength > 1_500_000) return { drafts: [], error: t.importFileTooLarge };
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { return { drafts: [], error: t.importInvalidJson }; }
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(value) || !object(value.mcpServers) || Object.keys(value.mcpServers).length === 0) return { drafts: [], error: t.importNoServers };
  const entries = Object.entries(value.mcpServers);
  if (entries.length > 50) return { drafts: [], error: t.importTooMany };
  const drafts: Draft[] = [];
  for (const [name, raw] of entries) {
    if (!object(raw)) return { drafts: [], error: t.importBadEntry(name) };
    const invalid = (field: string) => ({ drafts: [], error: t.importFieldInvalid(name, field) });
    for (const key of ["description", "command", "cwd", "url"]) {
      if (raw[key] != null && (typeof raw[key] !== "string" || (raw[key] as string).includes("\0"))) return invalid(key);
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return invalid("enabled");
    const declared = raw.transport ?? raw.type ?? (raw.url ? "http" : "stdio");
    const transport = declared === "streamable_http" || declared === "streamable-http" ? "http" : declared;
    if (transport !== "http" && transport !== "sse" && transport !== "stdio") return invalid("transport");
    const authMode = transport === "stdio" ? "headers" : raw.authMode ?? "headers";
    if (authMode !== "headers" && authMode !== "oauth") return invalid("authMode");
    const args = raw.args ?? [];
    if (!Array.isArray(args) || args.length > 100 || args.some((arg) => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"))) return invalid("args");
    const timeout = raw.timeoutSeconds ?? raw.tool_call_timeout ?? 60;
    if (typeof timeout !== "number") return invalid("timeoutSeconds");
    const maps: Record<string, SecretRow[]> = {};
    for (const key of ["env", "headers"]) {
      const map = raw[key] ?? {};
      if (!object(map) || Object.keys(map).length > 100) return invalid(key);
      const rows: SecretRow[] = [];
      for (const [keyName, secret] of Object.entries(map)) {
        if (!keyName || /[\s=\0]/.test(keyName) || typeof secret !== "string" || secret.length > 16384 || secret.includes("\0") || key === "headers" && /[\r\n]/.test(secret)) return invalid(key);
        rows.push({ key: keyName, value: secret });
      }
      maps[key] = rows;
    }
    const oauth = raw.oauth ?? {};
    if (!object(oauth)) return invalid("oauth");
    for (const field of ["clientId", "clientSecret", "scope", "clientMetadataUrl"]) {
      if (oauth[field] != null && (typeof oauth[field] !== "string" || /[\0\r\n]/.test(oauth[field] as string))) return invalid(`oauth.${field}`);
    }
    drafts.push({
      ...emptyDraft(), name, transport, authMode, enabled: false,
      description: raw.description as string ?? "", command: raw.command as string ?? "", cwd: raw.cwd as string ?? "", url: raw.url as string ?? "",
      args: (args as string[]).join("\n"), originalArgs: [...args] as string[],
      timeoutSeconds: String(timeout), envRows: maps.env!, headerRows: maps.headers!,
      oauth: { clientId: oauth.clientId as string ?? "", clientSecret: oauth.clientSecret as string ?? "", scope: oauth.scope as string ?? "", clientMetadataUrl: oauth.clientMetadataUrl as string ?? "" },
    });
  }
  return { drafts };
}

/** Hidden entries in a batch need the same constraints as the visible form. */
export function draftProblem(draft: Draft): string | undefined {
  const t = TEXT.settings.system.mcp;
  if (!draft.name.trim() || draft.name.trim().length > 100) return t.nameRequired;
  const secrets = secretProblem(draft.transport === "stdio" ? draft.envRows : draft.headerRows);
  if (secrets) return secrets;
  const timeout = Number(draft.timeoutSeconds);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) return t.timeoutInvalid;
  if (draft.transport === "stdio") return draft.command.trim() ? undefined : t.commandRequired;
  try {
    const url = new URL(draft.url);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash) return undefined;
  } catch { /* Let the user correct the URL in the ordinary field. */ }
  return t.urlInvalid;
}
