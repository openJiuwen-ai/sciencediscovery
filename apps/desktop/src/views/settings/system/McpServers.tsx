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

import { useEffect, useState } from "react";

import type { ConnectorId } from "@sciencediscovery/schema";
import { useMcpDiscoveryRefresh } from "@sciencediscovery/configuration-ui";

import type { ApiClient } from "../../../api/client.js";
import {
  cancelMcpAuthorization,
  clearMcpAuthorization,
  deleteMcpServer,
  getGlobalSettings,
  importMcpServers,
  listMcpServers,
  listMcpSources,
  putGlobalSettings,
  saveMcpServer,
  startMcpAuthorization,
  testMcpServer,
} from "../../../api/settings.js";
import type {
  CustomMcpServerDetails,
  CustomMcpServerInput,
  McpSource,
  RuntimeSettingsOverrides,
} from "../../../api/types.js";
import type { ConfirmRequest, Toast } from "../../../app/use-workspace.js";
import { useLoaded } from "../../../app/use-loaded.js";
import { writeSettingsCache } from "../../../app/settings-cache.js";
import { TEXT } from "../../../text.js";
import { SettingsModal } from "../SettingsModal.js";
import { Group, LoadGate, Row, Select, Switch, Tag } from "../rows.js";

interface Props {
  client: ApiClient;
  onConfirm: (request: ConfirmRequest) => void;
  onToast: (message: string, tone?: Toast["tone"]) => void;
}

interface Page {
  /** Built-in data sources from the server catalog. */
  builtins: McpSource[];
  /** Custom MCP servers registered on this machine. */
  custom: CustomMcpServerDetails[];
  /** Current global overrides so we can write a field-sparing update. */
  overrides: RuntimeSettingsOverrides;
  /** The effective default selection at this layer. */
  enabledConnectorIds: ConnectorId[];
}

/** One secret slot. A saved key keeps `originalKey` and an empty value, which
 *  the server reads as "keep the stored secret"; typing a value replaces it. */
interface SecretRow {
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

interface Draft {
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

function emptyDraft(): Draft {
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

function draftOf(server: CustomMcpServerDetails): Draft {
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
function secretProblem(rows: SecretRow[]): string | undefined {
  const keys = rows.map((row) => row.key.trim());
  if (keys.some((key) => key === "")) return TEXT.settings.system.mcp.secretKeyEmpty;
  if (new Set(keys).size !== keys.length) return TEXT.settings.system.mcp.secretKeyDuplicate;
  if (rows.some((row) => row.originalKey !== undefined && row.originalKey !== row.key.trim() && row.value === "")) {
    return TEXT.settings.system.mcp.secretRenameRequired;
  }
  return undefined;
}

function inputOf(draft: Draft): CustomMcpServerInput {
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

const STATUS_TONE: Record<CustomMcpServerDetails["status"], string> = {
  disabled: "off",
  error: "warn",
  ready: "ok",
  untested: "off",
};

/** One server from an import spec, as the page lists it before and after writing. */
interface ImportEntry {
  name: string;
  transport: string;
  target: string;
}

/** What one import write did: the name it came in as, and its own outcome. */
interface ImportOutcome extends ImportEntry {
  ok: boolean;
  message?: string;
}

/**
 * Read a `{ "mcpServers": { … } }` spec.
 *
 * The route accepts exactly that shape, so the page parses it here: a spec the
 * page cannot read is named before anything is written, and each entry keeps the
 * name it arrived under so the outcome list can name it.
 */
function readSpec(text: string): { entries: ImportEntry[]; error?: string } {
  const text_ = TEXT.settings.system.mcp;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { entries: [], error: text_.importInvalidJson };
  }
  const servers = (value as { mcpServers?: unknown } | null)?.mcpServers;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
    return { entries: [], error: text_.importNoServers };
  }
  const entries: ImportEntry[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { entries: [], error: text_.importBadEntry(name) };
    }
    const config = raw as { command?: unknown; transport?: unknown; type?: unknown; url?: unknown };
    // The route decides the transport as `transport ?? type ?? (url ? http : stdio)`
    // and folds the streamable-HTTP aliases onto http; the preview has to read the
    // spec the same way, or it describes a different server than the one written.
    const declared = typeof config.transport === "string"
      ? config.transport
      : typeof config.type === "string" ? config.type : undefined;
    const alias = declared === "streamable_http" || declared === "streamable-http" ? "http" : declared;
    const transport = alias ?? (typeof config.url === "string" && config.url !== "" ? "http" : "stdio");
    // The address shown is the one the resolved transport uses: a stdio entry
    // launches its command, anything else is reached at its URL.
    const command = typeof config.command === "string" ? config.command : "";
    const url = typeof config.url === "string" ? config.url : "";
    const target = transport === "stdio" ? command : url;
    entries.push({ name, target, transport });
  }
  if (entries.length === 0) return { entries: [], error: text_.importNoServers };
  return { entries };
}

/** Both the custom-server statuses and the catalog statuses are fixed
 *  vocabularies; only the ones this screen can show are translated, and an
 *  unknown value is printed rather than silently hidden. */
function statusLabel(status: string): string {
  const text = TEXT.settings.system.mcp;
  switch (status) {
    case "ready": return text.statusReady;
    case "error": return text.statusError;
    case "disabled": return text.statusDisabled;
    case "untested": return text.statusUntested;
    case "degraded": return text.statusDegraded;
    case "misconfigured": return text.statusMisconfigured;
    case "unavailable": return text.statusUnavailable;
    default: return status;
  }
}

function catalogTone(status: string): string {
  if (status === "ready") return "ok";
  if (status === "disabled") return "off";
  return "warn";
}

function initialOf(name: string): string {
  return name.slice(0, 1).toUpperCase();
}

/**
 * 数据源设置：选择会话默认使用的数据源。
 *
 * 内置来源和自定义 MCP 都通过全局 `enabledConnectorIds` 管理是否默认选用；
 * 自定义服务的连接状态仍由各自的 `enabled` 字段控制，二者相互独立。
 */
export function McpServers({ client, onConfirm, onToast }: Props) {
  const loaded = useLoaded<Page>(async () => {
    const [servers, sources, settings] = await Promise.all([
      listMcpServers(client),
      listMcpSources(client),
      getGlobalSettings(client),
    ]);
    const effective = settings.effective as { enabledConnectorIds?: ConnectorId[] } | undefined;
    return {
      builtins: sources.filter((source) => !source.manifest.id.startsWith("custom-")),
      custom: servers,
      overrides: settings.overrides,
      enabledConnectorIds: effective?.enabledConnectorIds ?? ["web"],
    };
  }, { client, key: "mcp-servers" });
  const [draft, setDraft] = useState<Draft>();
  const [openId, setOpenId] = useState<string>();
  /** The provider URL minted for the row now waiting on consent; kept so a
   *  blocked popup still leaves a way to reach the provider. */
  const [authorizingUrl, setAuthorizingUrl] = useState<{ id: string; url: string }>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [discovery, setDiscovery] = useState<{ base: Page; servers: CustomMcpServerDetails[] }>();
  const servers = discovery?.base === loaded.value ? discovery?.servers : loaded.value?.custom;

  useMcpDiscoveryRefresh(client, servers, async (isCurrent) => {
    const base = loaded.value;
    try {
      const items = await listMcpServers(client);
      if (!isCurrent() || !base) return;
      setDiscovery({ base, servers: items });
      writeSettingsCache(client, "mcp-servers", { ...base, custom: items });
    } catch (reason) {
      if (isCurrent()) setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
      throw reason;
    }
  });

  useEffect(() => setFailure(undefined), [draft]);

  /** The server just created, with what its first test found: the dialog stays
   *  open so a wrong command or URL is visible where it was typed. */
  const [created, setCreated] = useState<{ name: string; tools: string[]; error?: string }>();
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importEntries, setImportEntries] = useState<ImportEntry[]>();
  const [importError, setImportError] = useState<string>();
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>();
  const [toolsOpen, setToolsOpen] = useState<string>();

  /** A new server starts switched off, as an imported one does: it is reached by
   *  agents only once the user has read its test result and turned it on. */
  const openCreate = () => {
    setCreated(undefined);
    setFailure(undefined);
    setDraft({ ...emptyDraft(), enabled: false });
  };

  /** Edit opens the record's own form: a creation result left on screen belongs
   *  to the server that was just created, not to the row being edited. */
  const openEdit = (server: CustomMcpServerDetails) => {
    setCreated(undefined);
    setFailure(undefined);
    setDraft(draftOf(server));
  };

  const openImport = () => {
    setOutcomes(undefined);
    setImportEntries(undefined);
    setImportError(undefined);
    setImportText("");
    setImportOpen(true);
  };

  const previewImport = () => {
    const parsed = readSpec(importText);
    setImportEntries(parsed.entries);
    setImportError(parsed.error);
    setOutcomes(undefined);
  };

  /**
   * Write the spec one server per request.
   *
   * The route writes a whole spec or nothing and stops at the first name clash,
   * which would report one opaque error for a spec of several servers. Sending
   * each entry on its own gives every server its own outcome and leaves the valid
   * ones written when one is refused.
   */
  const runImport = async () => {
    const parsed = importEntries === undefined ? readSpec(importText) : { entries: importEntries, error: importError };
    if (parsed.error !== undefined || parsed.entries.length === 0) {
      setImportEntries(parsed.entries);
      setImportError(parsed.error);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(importText);
    } catch {
      setImportError(TEXT.settings.system.mcp.importInvalidJson);
      return;
    }
    const all = (value as { mcpServers: Record<string, unknown> }).mcpServers;
    setBusy(true);
    setImportError(undefined);
    const results: ImportOutcome[] = [];
    for (const entry of parsed.entries) {
      try {
        await importMcpServers(client, { mcpServers: { [entry.name]: all[entry.name] } });
        results.push({ ...entry, ok: true });
      } catch (reason) {
        results.push({
          ...entry,
          message: reason instanceof Error ? reason.message : TEXT.errors.generic,
          ok: false,
        });
      }
      setOutcomes([...results]);
    }
    setBusy(false);
    loaded.reload();
  };

  /** Open the provider's page and hand it the URL the route minted.
   *
   *  The minted URL is kept for the row as well: a blocked popup would otherwise
   *  leave an `authorizing` state the user has no way to finish, and the page it
   *  points at must not be able to navigate this window (`opener` cleared). */
  const authorize = async (server: CustomMcpServerDetails) => {
    setBusy(true);
    setFailure(undefined);
    const popup = typeof window === "undefined" || typeof window.open !== "function"
      ? null
      : window.open("about:blank", "_blank", "popup,width=620,height=760");
    if (popup !== null) popup.opener = null;
    try {
      const started = await startMcpAuthorization(client, server.id, `${window.location.origin}/api/mcp/oauth/callback`);
      if (popup !== null && !popup.closed) popup.location.replace(started.authorizationUrl);
      setAuthorizingUrl({ id: server.id, url: started.authorizationUrl });
      loaded.reload();
    } catch (reason) {
      if (popup !== null) popup.close();
      setFailure(reason instanceof Error ? reason.message : TEXT.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  const endAuthorization = async (server: CustomMcpServerDetails, operation: "cancel" | "clear") => {
    setBusy(true);
    setFailure(undefined);
    try {
      await (operation === "clear" ? clearMcpAuthorization(client, server.id) : cancelMcpAuthorization(client, server.id));
      loaded.reload();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  // Only a saved server opens the form, so there is never an empty draft: the
  // record being edited is the source of every field.
  const current = draft;
  const editing = current?.id !== undefined;
  const change = (patch: Partial<Draft>) =>
    setDraft((previous) => ({ ...(previous ?? emptyDraft()), ...patch }));

  const closeForm = () => {
    setCreated(undefined);
    setDraft(undefined);
  };

  /** Toggle whether a data source is selected by default for new sessions. */
  const toggleDefaultUse = async (id: string) => {
    const page = loaded.value;
    if (!page) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const selected = new Set(page.enabledConnectorIds);
      const next = selected.has(id)
        ? page.enabledConnectorIds.filter((value) => value !== id)
        : [...page.enabledConnectorIds, id];
      await putGlobalSettings(client, {
        ...page.overrides,
        enabledConnectorIds: next,
      });
      loaded.reload();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  /** Select or clear every visible data source. Only the default selection
   *  list changes; custom server connection settings are untouched. */
  const setAllSelected = async (next: boolean) => {
    const page = loaded.value;
    if (!page) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const ids = new Set([...page.enabledConnectorIds]);
      for (const source of page.builtins) {
        if (next) ids.add(source.manifest.id);
        else ids.delete(source.manifest.id);
      }
      for (const server of page.custom) {
        if (next) ids.add(server.id);
        else ids.delete(server.id);
      }
      await putGlobalSettings(client, {
        ...page.overrides,
        enabledConnectorIds: [...ids],
      });
      loaded.reload();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  /** A server waiting on its consent page settles in the browser, not here: the
   *  callback flips its state and nothing tells this page. Polling only while a
   *  row is `authorizing` is what turns it into `authorized` when the user comes
   *  back, and it stops the moment the state settles.
   *
   *  A grant that lands is tested straight away, the way the web client does it:
   *  the tool list the row shows is what tells the user the connection works. */
  const authorizingIds = (servers ?? [])
    .filter((server) => server.authorization?.state === "authorizing")
    .map((server) => server.id);
  const authorizingKey = authorizingIds.join(",");
  useEffect(() => {
    if (authorizingKey === "") return undefined;
    const waiting = authorizingKey.split(",");
    let active = true;
    const poll = async () => {
      try {
        const items = await listMcpServers(client);
        if (!active) return;
        const granted = items.filter((item) => waiting.includes(item.id) && item.authorization?.state === "authorized");
        for (const item of granted) {
          await testMcpServer(client, item.id).catch(() => undefined);
          if (!active) return;
        }
        loaded.reload();
      } catch {
        // The next tick retries; a failed read must not stop the watch.
      }
    };
    const timer = globalThis.setInterval(() => void poll(), 1_500);
    return () => {
      active = false;
      globalThis.clearInterval(timer);
    };
  }, [authorizingKey, client, loaded]);

  const submit = async (form: HTMLFormElement) => {
    if (!current || busy) return;
    // The create form opens with an empty name; saving it says why nothing
    // happened instead of looking unresponsive.
    if (current.name.trim() === "") {
      setFailure(TEXT.settings.system.mcp.nameRequired);
      return;
    }
    const problem = current.transport === "stdio"
      ? secretProblem(current.envRows)
      : secretProblem(current.headerRows);
    if (problem !== undefined) {
      setFailure(problem);
      return;
    }
    if (!form.reportValidity()) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const saved = await saveMcpServer(client, inputOf(current), current.id);
      if (current.id === undefined) {
        // A newly created server is tested straight away: the row's status is
        // what tells the user whether the command or URL it was typed with works,
        // and finding that out here keeps the form — and the mistake — on screen.
        let tools: string[] = [];
        let testError: string | undefined;
        try {
          const tested = await testMcpServer(client, saved.id);
          tools = tested.tools.map((tool) => tool.name);
          testError = tested.error;
        } catch (reason) {
          testError = reason instanceof Error ? reason.message : TEXT.errors.generic;
        }
        setCreated({ error: testError, name: saved.name, tools });
        loaded.reload();
        onToast(TEXT.settings.system.mcp.saved, "info");
        return;
      }
      closeForm();
      loaded.reload();
      onToast(TEXT.settings.system.mcp.saved, "info");
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const isSelected = (id: string) => {
    const page = loaded.value;
    return page ? page.enabledConnectorIds.includes(id) : false;
  };

  return (
    <>
      <p className="settings-note">{TEXT.settings.system.mcp.help}</p>

      <LoadGate loaded={loaded}>
        {(page) => (
          <Group>
            {/* Creating and importing are the two ways in for a server this
                machine has never seen; both write through the same routes the web
                client uses, so the two clients cannot drift. */}
            <div className="mcp-toolbar-actions">
              <button className="secondary-button" disabled={busy} onClick={openCreate} type="button">
                {TEXT.settings.system.mcp.addServer}
              </button>
              <button className="secondary-button" disabled={busy} onClick={openImport} type="button">
                {TEXT.settings.system.mcp.importServers}
              </button>
            </div>
            {page.custom.length === 0 && page.builtins.length === 0 ? (
              <p className="settings-empty">{TEXT.settings.system.mcp.empty}</p>
            ) : (
              <div className="settings-list">
                <div className="settings-bulk">
                  <button className="bulk-button" disabled={busy} onClick={() => void setAllSelected(true)} type="button">
                    {TEXT.settings.system.mcp.selectAll}
                  </button>
                  <button className="bulk-button" disabled={busy} onClick={() => void setAllSelected(false)} type="button">
                    {TEXT.settings.system.mcp.clearSelection}
                  </button>
                </div>
                {(servers ?? page.custom).map((server) => (
                  <div className="settings-card" key={server.id}>
                    <span className="settings-card-mark">{initialOf(server.name)}</span>
                    <div className="settings-card-main">
                      <strong>
                        {server.name}
                        <Tag tone={STATUS_TONE[server.status]}>{statusLabel(server.status)}</Tag>
                        {server.authorization !== undefined && server.authorization.state !== "authorized"
                          ? <Tag tone="warn">{server.authorization.state === "expired" ? TEXT.settings.system.mcp.authorizationExpired : TEXT.settings.system.mcp.unauthorized}</Tag>
                          : null}
                        <Tag tone="off">{TEXT.settings.system.mcp.toolCount(server.tools.length)}</Tag>
                      </strong>
                      {server.description ? <small>{server.description}</small> : null}
                      <small className={server.description ? "settings-detail-meta" : undefined}>
                        {server.transport} · {server.transport === "stdio" ? server.command : server.url}
                        {server.error ? ` · ${server.error}` : ""}
                      </small>
                      {toolsOpen === server.id ? (
                        <span className="settings-detail">
                          {server.tools.length === 0 ? (
                            <small className="settings-detail-meta">{TEXT.settings.system.mcp.toolsNone}</small>
                          ) : (
                            <span className="settings-builtin-tools">
                              {server.tools.map((tool) => (
                                <span key={tool.name}>
                                  <code>{tool.name}</code>
                                  {tool.description ? <small>{tool.description}</small> : null}
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                      ) : null}
                    </div>
                    <div className="settings-card-actions">
                      <button
                        className="link-button"
                        disabled={busy}
                        onClick={() => setToolsOpen(toolsOpen === server.id ? undefined : server.id)}
                        type="button"
                      >
                        {TEXT.settings.system.mcp.tools}
                      </button>
                      <button
                        className="link-button"
                        disabled={busy}
                        onClick={() => {
                          setBusy(true);
                          void testMcpServer(client, server.id)
                            .then((next) => {
                              loaded.reload();
                              const passed = next.status === "ready" || next.status === "disabled";
                              onToast(
                                next.error ?? (passed ? TEXT.settings.system.mcp.testPassed : statusLabel(next.status)),
                                passed && !next.error ? "info" : "error",
                              );
                            })
                            .catch((reason: unknown) => {
                              setFailure(reason instanceof Error ? reason.message : TEXT.errors.generic);
                            })
                            .finally(() => setBusy(false));
                        }}
                        type="button"
                      >
                        {TEXT.settings.system.mcp.test}
                      </button>
                      <button
                        className="link-button"
                        disabled={busy}
                        onClick={() => openEdit(server)}
                        type="button"
                      >
                        {TEXT.settings.edit}
                      </button>
                      {/* A server that needs OAuth says so instead of looking
                          broken; the three controls are the ones the route pair
                          offers, and 清除 is what removes a stored grant. */}
                      {server.authorization !== undefined ? (
                        <>
                          <button
                            className="link-button"
                            disabled={busy || server.authorization.state === "authorizing"}
                            onClick={() => void authorize(server)}
                            type="button"
                          >
                            {TEXT.settings.system.mcp.authorize}
                          </button>
                          {server.authorization.state === "authorizing" ? (
                            <>
                              <button
                                className="link-button"
                                disabled={busy}
                                onClick={() => void endAuthorization(server, "cancel")}
                                type="button"
                              >
                                {TEXT.settings.system.mcp.cancelAuthorization}
                              </button>
                              {/* A blocked popup leaves the minted URL only here. */}
                              {authorizingUrl?.id === server.id ? (
                                <a
                                  className="link-button"
                                  href={authorizingUrl.url}
                                  rel="noopener noreferrer"
                                  target="_blank"
                                >
                                  {TEXT.settings.system.mcp.openAuthorization}
                                </a>
                              ) : null}
                            </>
                          ) : null}
                          <button
                            className="link-button is-danger"
                            disabled={busy}
                            onClick={() => void endAuthorization(server, "clear")}
                            type="button"
                          >
                            {TEXT.settings.system.mcp.clearAuthorization}
                          </button>
                        </>
                      ) : null}
                      <button
                        className="link-button is-danger"
                        disabled={busy}
                        onClick={() => onConfirm({
                          accept: TEXT.menu.delete,
                          body: TEXT.settings.system.mcp.deleteBody(server.name),
                          eyebrow: TEXT.settings.system.mcp.heading,
                          onAccept: () => {
                            void deleteMcpServer(client, server.id)
                              .then(() => loaded.reload())
                              .catch((reason: unknown) => {
                                setFailure(reason instanceof Error ? reason.message : TEXT.errors.generic);
                              });
                          },
                          title: TEXT.settings.system.mcp.deleteTitle(server.name),
                        })}
                        type="button"
                      >
                        {TEXT.menu.delete}
                      </button>
                      <Switch
                        disabled={busy}
                        label={`${server.name} · ${TEXT.settings.system.mcp.useByDefault}`}
                        onChange={() => void toggleDefaultUse(server.id)}
                        value={isSelected(server.id)}
                      />
                    </div>
                  </div>
                ))}

                {page.builtins.map((source) => {
                  const open = openId === source.manifest.id;
                  const on = isSelected(source.manifest.id);
                  const tools = Object.values(source.manifest.tools ?? {});
                  const meta = [
                    source.manifest.publisher,
                    source.manifest.version ? `v${source.manifest.version}` : undefined,
                  ].filter((part) => part !== undefined && part !== "").join(" · ");
                  return (
                    <div
                      className={`settings-card is-expandable${open ? " is-open" : ""}${on ? "" : " is-off"}`}
                      key={source.manifest.id}
                    >
                      <span className="settings-card-mark">
                        {initialOf(source.manifest.displayName || source.manifest.id)}
                      </span>
                      <button
                        className="settings-card-main"
                        onClick={() => setOpenId(open ? undefined : source.manifest.id)}
                        type="button"
                      >
                        <strong>
                          {source.manifest.displayName || source.manifest.id}
                          <Tag tone="off">{TEXT.settings.system.mcp.builtin}</Tag>
                          <Tag tone={catalogTone(source.status.status)}>
                            {statusLabel(source.status.status)}
                          </Tag>
                          <Tag tone="off">{TEXT.settings.system.mcp.toolCount(tools.length)}</Tag>
                        </strong>
                        <small>{source.manifest.description || source.manifest.id}</small>
                        {open ? (
                          <span className="settings-detail">
                            {tools.length === 0 ? null : (
                              <span className="settings-builtin-tools">
                                {tools.map((tool) => (
                                  <span key={tool.id}>
                                    <code>{tool.id}</code>
                                    {tool.description ? <small>{tool.description}</small> : null}
                                  </span>
                                ))}
                              </span>
                            )}
                            {meta === "" ? null : (
                              <small className="settings-detail-meta">{meta}</small>
                            )}
                          </span>
                        ) : null}
                      </button>
                      <div className="settings-card-actions">
                        <Switch
                          disabled={busy}
                          label={`${source.manifest.displayName || source.manifest.id} · ${TEXT.settings.system.mcp.useByDefault}`}
                          onChange={() => void toggleDefaultUse(source.manifest.id)}
                          value={on}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Group>
        )}
      </LoadGate>

      {current ? (
        <SettingsModal
          label={editing ? TEXT.settings.system.mcp.editTitle : TEXT.settings.system.mcp.createTitle}
          onClose={() => { if (!busy) closeForm(); }}
          wide
        >
          {created === undefined ? (
          <form
            className="settings-card is-form"
            noValidate
            onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}
          >
            <div className="settings-card-form">
              <Row title={TEXT.settings.system.mcp.enableService}>
                <label className="settings-check">
                  <input
                    checked={current.enabled}
                    onChange={(event) => change({ enabled: event.target.checked })}
                    type="checkbox"
                  />
                  <span>{TEXT.settings.system.mcp.enableService}</span>
                </label>
              </Row>
              <Row title={TEXT.settings.system.mcp.name}>
                <input
                  aria-label={TEXT.settings.system.mcp.name}
                  className="field-input"
                  maxLength={100}
                  required
                  onChange={(event) => change({ name: event.target.value })}
                  value={current.name}
                />
              </Row>
              <Row title={TEXT.settings.system.mcp.description}>
                <input
                  className="field-input"
                  onChange={(event) => change({ description: event.target.value })}
                  value={current.description}
                />
              </Row>
              <Row title={TEXT.settings.system.mcp.transport}>
                <Select
                  label={TEXT.settings.system.mcp.transport}
                  onChange={(value) => change({ transport: value as Draft["transport"] })}
                  options={[
                    { label: "Streamable HTTP", value: "http" },
                    { label: "SSE", value: "sse" },
                    { label: "STDIO", value: "stdio" },
                  ]}
                  value={current.transport}
                />
              </Row>
              {current.transport === "stdio" ? (
                <>
                  <Row title={TEXT.settings.system.mcp.command}>
                    <input
                      aria-label={TEXT.settings.system.mcp.command}
                      className="field-input"
                      required
                      onChange={(event) => change({ command: event.target.value })}
                      value={current.command}
                    />
                  </Row>
                  <Row hint={TEXT.settings.system.mcp.argsHint} title={TEXT.settings.system.mcp.args}>
                    <textarea
                      aria-label={TEXT.settings.system.mcp.args}
                      className="field-input"
                      rows={3}
                      onChange={(event) => change({ args: event.target.value })}
                      value={current.args}
                    />
                  </Row>
                  <Row hint={TEXT.settings.system.mcp.optional} title={TEXT.settings.system.mcp.cwd}>
                    <input
                      className="field-input"
                      onChange={(event) => change({ cwd: event.target.value })}
                      value={current.cwd}
                    />
                  </Row>
                  <SecretFields
                    label={TEXT.settings.system.mcp.env}
                    onChange={(envRows) => change({ envRows })}
                    rows={current.envRows}
                  />
                </>
              ) : (
                <>
                  <Row title={TEXT.settings.system.mcp.url}>
                    <input
                      aria-label={TEXT.settings.system.mcp.url}
                      className="field-input"
                      type="url"
                      required
                      onChange={(event) => change({ url: event.target.value })}
                      value={current.url}
                    />
                  </Row>
                  <Row title={TEXT.settings.system.mcp.authMode}>
                    <Select
                      label={TEXT.settings.system.mcp.authMode}
                      onChange={(value) => change({ authMode: value as Draft["authMode"] })}
                      options={[
                        { label: TEXT.settings.system.mcp.authHeaders, value: "headers" },
                        { label: TEXT.settings.system.mcp.authOauth, value: "oauth" },
                      ]}
                      value={current.authMode}
                    />
                  </Row>
                  {current.authMode === "oauth" ? (
                    <>
                      <Row hint={TEXT.settings.system.mcp.optional} title={TEXT.settings.system.mcp.clientId}>
                        <input
                          className="field-input"
                          onChange={(event) => change({
                            oauth: { ...current.oauth, clientId: event.target.value },
                          })}
                          value={current.oauth.clientId}
                        />
                      </Row>
                      <Row
                        hint={current.savedOauthSecret
                          ? TEXT.settings.system.mcp.secretSaved
                          : TEXT.settings.system.mcp.optional}
                        title={TEXT.settings.system.mcp.clientSecret}
                      >
                        <input
                          autoComplete="off"
                          className="field-input"
                          onChange={(event) => change({
                            oauth: { ...current.oauth, clientSecret: event.target.value },
                          })}
                          type="password"
                          value={current.oauth.clientSecret}
                        />
                      </Row>
                      <Row hint={TEXT.settings.system.mcp.optional} title={TEXT.settings.system.mcp.scope}>
                        <input
                          className="field-input"
                          onChange={(event) => change({
                            oauth: { ...current.oauth, scope: event.target.value },
                          })}
                          value={current.oauth.scope}
                        />
                      </Row>
                      <Row hint={TEXT.settings.system.mcp.optional} title={TEXT.settings.system.mcp.metadataUrl}>
                        <input
                          className="field-input"
                          onChange={(event) => change({
                            oauth: { ...current.oauth, clientMetadataUrl: event.target.value },
                          })}
                          value={current.oauth.clientMetadataUrl}
                        />
                      </Row>
                      <Row title={TEXT.settings.system.mcp.callback}>
                        <input
                          className="field-input"
                          readOnly
                          value={`${window.location.origin}/api/mcp/oauth/callback`}
                        />
                      </Row>
                    </>
                  ) : null}
                  <SecretFields
                    label={TEXT.settings.system.mcp.headers}
                    onChange={(headerRows) => change({ headerRows })}
                    rows={current.headerRows}
                  />
                </>
              )}
              <Row title={TEXT.settings.system.mcp.timeout}>
                <input
                  aria-label={TEXT.settings.system.mcp.timeout}
                  className="field-input is-number"
                  min="1"
                  max="600"
                  required
                  onChange={(event) => change({ timeoutSeconds: event.target.value })}
                  type="number"
                  value={current.timeoutSeconds}
                />
              </Row>
              {failure ? <small className="row-note is-error" role="alert">{failure}</small> : null}
              <div className="settings-card-actions">
                <button className="secondary-button" disabled={busy} onClick={closeForm} type="button">
                  {TEXT.settings.cancel}
                </button>
                <button className="primary-button" disabled={busy} type="submit">
                  {TEXT.settings.system.save}
                </button>
              </div>
            </div>
          </form>
          ) : (
            <section className="settings-card is-form">
              <div className="settings-card-form">
                <Row title={TEXT.settings.system.mcp.name}>
                  <span>{created.name}</span>
                </Row>
                {/* The first test of the server just created, on the screen its
                    command or URL was typed on. */}
                {created.error === undefined ? (
                  <Row title={TEXT.settings.system.mcp.testedResult}>
                    <span className="settings-detail">
                      {created.tools.length === 0
                        ? TEXT.settings.system.mcp.toolsNone
                        : <span className="settings-builtin-tools">
                          {created.tools.map((tool) => <code key={tool}>{tool}</code>)}
                        </span>}
                    </span>
                  </Row>
                ) : <small className="row-note is-error">{created.error}</small>}
                <div className="settings-card-actions">
                  <button className="primary-button" onClick={closeForm} type="button">
                    {TEXT.settings.system.mcp.done}
                  </button>
                </div>
              </div>
            </section>
          )}
        </SettingsModal>
      ) : null}

      {failure && current === undefined ? <small className="row-note is-error" role="alert">{failure}</small> : null}
      {importOpen ? (
        <SettingsModal
          label={TEXT.settings.system.mcp.importTitle}
          onClose={() => setImportOpen(false)}
          wide
        >
          <section className="settings-card is-form">
            <div className="settings-card-form">
              <Row hint={TEXT.settings.system.mcp.importHint} title={TEXT.settings.system.mcp.importJson}>
                <textarea
                  aria-label={TEXT.settings.system.mcp.importJson}
                  className="field-input settings-textarea"
                  onChange={(event) => {
                    setImportText(event.target.value);
                    setImportEntries(undefined);
                    setImportError(undefined);
                    setOutcomes(undefined);
                  }}
                  rows={10}
                  spellCheck={false}
                  value={importText}
                />
              </Row>
              <div className="settings-card-actions">
                <button
                  className="secondary-button"
                  disabled={busy || importText.trim() === ""}
                  onClick={previewImport}
                  type="button"
                >
                  {TEXT.settings.system.mcp.importPreview}
                </button>
              </div>
              {importError ? <small className="row-note is-error">{importError}</small> : null}
              {importEntries !== undefined && importEntries.length > 0 ? (
                <ul className="mcp-import-list" aria-label={TEXT.settings.system.mcp.importPreview}>
                  {importEntries.map((entry) => (
                    <li key={entry.name}>
                      <code>{entry.name}</code>
                      <small>{entry.transport} · {entry.target}</small>
                    </li>
                  ))}
                </ul>
              ) : null}
              {outcomes !== undefined && outcomes.length > 0 ? (
                <ul className="mcp-import-list" aria-label={TEXT.settings.system.mcp.importResults}>
                  {outcomes.map((outcome) => (
                    <li key={outcome.name}>
                      <code>{outcome.name}</code>
                      <small className={outcome.ok ? undefined : "is-error"}>
                        {outcome.ok
                          ? TEXT.settings.system.mcp.importAdded
                          : TEXT.settings.system.mcp.importFailed(outcome.message ?? TEXT.errors.generic)}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="settings-card-actions">
                <button className="secondary-button" onClick={() => setImportOpen(false)} type="button">
                  {TEXT.settings.cancel}
                </button>
                <button
                  className="primary-button"
                  disabled={busy || importText.trim() === ""}
                  onClick={() => void runImport()}
                  type="button"
                >
                  {TEXT.settings.system.mcp.importRun}
                </button>
              </div>
            </div>
          </section>
        </SettingsModal>
      ) : null}
    </>
  );
}

/** Key/value slots for `env` and `headers`. Saved keys show as empty password
 *  fields whose placeholder says the value is stored. */
function SecretFields({
  label,
  onChange,
  rows,
}: {
  label: string;
  onChange: (rows: SecretRow[]) => void;
  rows: SecretRow[];
}) {
  return (
    <div className="mcp-secret-fields">
      <strong>{label}</strong>
      {rows.map((row, index) => (
        <div className="mcp-secret-row" key={index}>
          <input
            aria-label={`${label} ${TEXT.settings.system.mcp.key} ${index + 1}`}
            className="field-input"
            onChange={(event) => onChange(rows.map((item, itemIndex) =>
              itemIndex === index ? { ...item, key: event.target.value } : item))}
            placeholder={TEXT.settings.system.mcp.key}
            value={row.key}
          />
          <input
            aria-label={`${label} ${TEXT.settings.system.mcp.value} ${index + 1}`}
            autoComplete="off"
            className="field-input"
            onChange={(event) => onChange(rows.map((item, itemIndex) =>
              itemIndex === index ? { ...item, value: event.target.value } : item))}
            placeholder={row.originalKey === row.key.trim() && row.value === ""
              ? TEXT.settings.system.mcp.secretSaved
              : TEXT.settings.system.mcp.value}
            type="password"
            value={row.value}
          />
          <button
            aria-label={TEXT.settings.system.mcp.removeEntry}
            className="link-button is-danger"
            onClick={() => onChange(rows.filter((_, itemIndex) => itemIndex !== index))}
            type="button"
          >
            {TEXT.menu.delete}
          </button>
        </div>
      ))}
      <button
        className="secondary-button"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
        type="button"
      >
        {TEXT.settings.system.mcp.addEntry}
      </button>
    </div>
  );
}
