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

import { useEffect, useId, useRef, useState } from "react";

import type { ConnectorId } from "@sciencediscovery/schema";
import { useMcpDiscoveryRefresh } from "@sciencediscovery/configuration-ui";

import type { ApiClient } from "../../../api/client.js";
import {
  cancelMcpAuthorization,
  clearMcpAuthorization,
  deleteMcpServer,
  getGlobalSettings,
  listMcpServers,
  listMcpSources,
  putGlobalSettings,
  saveMcpServer,
  startMcpAuthorization,
  testMcpServer,
} from "../../../api/settings.js";
import type {
  CustomMcpServerDetails,
  McpSource,
  RuntimeSettingsOverrides,
} from "../../../api/types.js";
import type { ConfirmRequest, Toast } from "../../../app/use-workspace.js";
import { useLoaded } from "../../../app/use-loaded.js";
import { writeSettingsCache } from "../../../app/settings-cache.js";
import { TEXT } from "../../../text.js";
import { McpModal } from "../McpModal.js";
import { McpAddMenu } from "../McpAddMenu.js";
import { draftOf, emptyDraft, inputOf, parseMcpDrafts, draftProblem, secretProblem, type Draft, type SecretRow } from "../mcp-config.js";
import { McpServerCard } from "../McpServerCard.js";
import { McpServerDetails } from "../McpServerDetails.js";
import { Group, LoadGate, Row, Select, Switch } from "../rows.js";

interface Props {
  client: ApiClient;
  onTry?: (id: string) => Promise<void>;
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

const STATUS_TONE: Record<CustomMcpServerDetails["status"], string> = {
  disabled: "off",
  error: "warn",
  ready: "ok",
  untested: "off",
};

interface ImportEntry { draft: Draft; saved?: boolean; error?: string; }

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

function testProblem(server: CustomMcpServerDetails): string | undefined {
  if (server.error) return server.error;
  if (server.authorization && server.authorization.state !== "authorized") {
    return server.authorization.state === "expired"
      ? TEXT.settings.system.mcp.authorizationExpired : TEXT.settings.system.mcp.unauthorized;
  }
  return server.status === "ready" || server.status === "disabled" ? undefined : statusLabel(server.status);
}

/**
 * 数据源设置：选择会话默认使用的数据源。
 *
 * 内置来源和自定义 MCP 都通过全局 `enabledConnectorIds` 管理是否默认选用；
 * 自定义服务的连接状态仍由各自的 `enabled` 字段控制，二者相互独立。
 */
export function McpServers({ client, onConfirm, onToast, onTry }: Props) {
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
  const errorId = useId();
  const [draft, setDraft] = useState<Draft>();
  const [detailId, setDetailId] = useState<string>();
  const detailFocus = useRef<HTMLElement | null>(null);
  const openDetails = (id: string) => {
    detailFocus.current = document.activeElement as HTMLElement | null;
    setFailure(undefined);
    setDetailId(id);
  };
  /** The provider URL minted for the row now waiting on consent; kept so a
   *  blocked popup still leaves a way to reach the provider. */
  const [authorizingUrl, setAuthorizingUrl] = useState<{ id: string; url: string }>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [discovery, setDiscovery] = useState<{ base: Page; servers: CustomMcpServerDetails[] }>();
  const servers = discovery?.base === loaded.value ? discovery?.servers : loaded.value?.custom;

  const [category, setCategory] = useState<"all" | "mine" | "official">("all");
  const [query, setQuery] = useState("");
  const matches = (name: string, description: string) => `${name} ${description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const visibleServers = (servers ?? []).filter((server) => category !== "official" && matches(server.name, server.description));
  const visibleBuiltins = (loaded.value?.builtins ?? []).filter((source) => category !== "mine"
    && matches(source.manifest.displayName || source.manifest.id, source.manifest.description || ""));

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

  const [importOpen, setImportOpen] = useState(false);
  const importFileInput = useRef<HTMLInputElement>(null);
  const importedName = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [importFileName, setImportFileName] = useState<string>();
  const [importText, setImportText] = useState("");
  const [importEntries, setImportEntries] = useState<ImportEntry[]>();
  const [importError, setImportError] = useState<string>();
  const [importIndex, setImportIndex] = useState(0);
  const [sourceOpen, setSourceOpen] = useState(true);
  const [populated, setPopulated] = useState(0);
  useEffect(() => { if (populated > 0) importedName.current?.focus(); }, [populated]);

  const resetImport = () => {
    setImportEntries(undefined); setImportError(undefined); setImportText("");
    setImportFileName(undefined); setImportIndex(0); setSourceOpen(true);
  };
  const openCreate = () => {
    resetImport(); setImportOpen(false); setFailure(undefined);
    detailFocus.current = document.activeElement as HTMLElement | null;
    setDraft(emptyDraft());
  };
  const openEdit = (server: CustomMcpServerDetails) => {
    resetImport(); setImportOpen(false); setFailure(undefined);
    if (!detailId) detailFocus.current = document.activeElement as HTMLElement | null;
    setDetailId(undefined); setDraft(draftOf(server));
  };
  const openImport = () => {
    resetImport(); setDraft(undefined); setFailure(undefined); setImportOpen(true);
    detailFocus.current = document.activeElement as HTMLElement | null;
  };
  const populateImport = (text: string, collapse = false) => {
    const parsed = parseMcpDrafts(text);
    setImportText(text); setImportIndex(0); setFailure(undefined);
    setImportError(text.trim() === "" ? undefined : parsed.error);
    setImportEntries(parsed.error ? undefined : parsed.drafts.map((draft) => ({ draft })));
    // A file upload hands editing to the filled form. Text entry keeps its
    // caret even when an intermediate document happens to parse successfully.
    if (!parsed.error && parsed.drafts.length && collapse) {
      setSourceOpen(false);
      setPopulated((version) => version + 1);
    }
  };
  const loadImportFile = async (file: File) => {
    if (busy || importEntries?.some((entry) => entry.saved)) return;
    setBusy(true); setImportEntries(undefined); setImportError(undefined);
    setImportText(""); setImportFileName(undefined); setSourceOpen(true);
    try {
      if (file.size > 1_500_000) setImportError(TEXT.settings.system.mcp.importFileTooLarge);
      else {
        const text = (await file.text()).replace(/^\uFEFF/, "");
        populateImport(text, true); setImportFileName(file.name);
      }
    } catch { setImportError(TEXT.settings.system.mcp.importFileReadFailed); }
    finally { setBusy(false); }
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

  const current = importOpen ? importEntries?.[importIndex]?.draft : draft;
  const editing = current?.id !== undefined;
  const sourceLocked = importEntries?.some((entry) => entry.saved) ?? false;
  const pending = importEntries?.filter((entry) => !entry.saved).length ?? 0;
  useEffect(() => {
    const t = TEXT.settings.system.mcp;
    const label = failure === t.nameRequired || failure === t.duplicateName ? t.name
      : failure === t.commandRequired ? t.command
        : failure === t.timeoutInvalid ? t.timeout : failure === t.urlInvalid ? t.url : undefined;
    if (label) Array.from(formRef.current?.querySelectorAll<HTMLElement>("[aria-label]") ?? [])
      .find((element) => element.getAttribute("aria-label") === label)?.focus();
  }, [failure, importIndex]);
  const change = (patch: Partial<Draft>) => {
    setFailure(undefined);
    if (importOpen) setImportEntries((entries) => entries?.map((entry, index) => index === importIndex
      ? { ...entry, draft: { ...entry.draft, ...patch }, error: undefined } : entry));
    else setDraft((previous) => ({ ...(previous ?? emptyDraft()), ...patch }));
  };
  const closeForm = () => {
    setDraft(undefined); setImportOpen(false); resetImport(); setFailure(undefined);
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

  // Use the same serializer as editing: stored secrets and legacy STDIO args survive.
  const toggleEnabled = async (server: CustomMcpServerDetails) => {
    if (busy) return;
    setBusy(true); setFailure(undefined);
    try { await saveMcpServer(client, inputOf({ ...draftOf(server), enabled: !server.enabled }), server.id); }
    catch (reason) { setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed); }
    finally { loaded.reload(); setBusy(false); }
  };
  const setAllEnabled = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true); setFailure(undefined);
    const failed: string[] = [];
    for (const server of visibleServers.filter((item) => item.enabled !== enabled)) {
      try { await saveMcpServer(client, inputOf({ ...draftOf(server), enabled }), server.id); }
      catch { failed.push(server.name); }
    }
    loaded.reload(); setBusy(false);
    if (failed.length) setFailure(TEXT.settings.system.mcp.bulkFailed(failed.join(", ")));
  };
  const tryServer = async (id: string) => {
    if (busy || !onTry) return;
    setBusy(true); setFailure(undefined);
    try { await onTry(id); }
    catch (reason) { setFailure(reason instanceof Error ? reason.message : TEXT.errors.generic); }
    finally { setBusy(false); }
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
    if (!current || busy || importOpen && importError) return;
    if (current.name.trim() === "") { setFailure(TEXT.settings.system.mcp.nameRequired); return; }
    const problem = secretProblem(current.transport === "stdio" ? current.envRows : current.headerRows);
    if (problem) { setFailure(problem); return; }
    if (!form.reportValidity()) return;
    // Every hidden batch entry is checked before the first write.
    if (importOpen && importEntries && importEntries.length > 1) {
      const names = new Set<string>();
      for (const [index, entry] of importEntries.entries()) {
        const duplicate = names.has(entry.draft.name.trim().toLowerCase());
        names.add(entry.draft.name.trim().toLowerCase());
        const problem = !entry.saved ? draftProblem(entry.draft) ?? (duplicate ? TEXT.settings.system.mcp.duplicateName : undefined) : undefined;
        if (problem) { setImportIndex(index); setFailure(problem); return; }
      }
      setBusy(true); setFailure(undefined);
      const results = importEntries.map((entry) => ({ ...entry }));
      try {
        for (const entry of results) {
          if (entry.saved) continue;
          try { await saveMcpServer(client, inputOf(entry.draft)); entry.saved = true; entry.error = undefined; }
          catch (reason) { entry.error = reason instanceof Error ? reason.message : TEXT.settings.saveFailed; }
          setImportEntries([...results]);
        }
        loaded.reload();
        const failed = results.findIndex((entry) => !entry.saved);
        if (failed < 0) { closeForm(); onToast(TEXT.settings.system.mcp.addedCount(results.length), "info"); }
        else { setImportIndex(failed); setFailure(results[failed]!.error); onToast(TEXT.settings.system.mcp.importProgress(results.filter((entry) => entry.saved).length, results.length), "error"); }
      } finally { setBusy(false); }
      return;
    }
    setBusy(true); setFailure(undefined);
    try {
      const saved = await saveMcpServer(client, inputOf(current), current.id);
      let checkedProblem: string | undefined;
      if (!editing) {
        try { checkedProblem = testProblem(await testMcpServer(client, saved.id)); }
        catch (reason) { checkedProblem = reason instanceof Error ? reason.message : TEXT.errors.generic; }
      }
      closeForm(); loaded.reload();
      onToast(checkedProblem ? TEXT.settings.system.mcp.savedCheckFailed(checkedProblem) : TEXT.settings.system.mcp.saved, checkedProblem ? "error" : "info");
    } catch (reason) { setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed); }
    finally { setBusy(false); }
  };

  const isSelected = (id: string) => {
    const page = loaded.value;
    return page ? page.enabledConnectorIds.includes(id) : false;
  };

  const testServer = (server: CustomMcpServerDetails) => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    void testMcpServer(client, server.id)
      .then((next) => {
        loaded.reload();
        const problem = testProblem(next);
        onToast(
          problem ?? TEXT.settings.system.mcp.testPassed,
          problem ? "error" : "info",
        );
      })
      .catch((reason: unknown) => {
        setFailure(reason instanceof Error ? reason.message : TEXT.errors.generic);
      })
      .finally(() => setBusy(false));
  };

  const removeServer = (server: CustomMcpServerDetails) => onConfirm({
    accept: TEXT.menu.delete,
    body: TEXT.settings.system.mcp.deleteBody(server.name),
    eyebrow: TEXT.settings.system.mcp.heading,
    title: TEXT.settings.system.mcp.deleteTitle(server.name),
    onAccept: async () => {
      if (busy) return;
      setBusy(true);
      setFailure(undefined);
      try {
        await deleteMcpServer(client, server.id);
        setDetailId((id) => id === server.id ? undefined : id);
        loaded.reload();
        onToast(TEXT.settings.system.mcp.deleted, "info");
      } catch (reason) {
        setFailure(reason instanceof Error ? reason.message : TEXT.errors.generic);
      } finally { setBusy(false); }
    },
  });
  const detailServer = (servers ?? loaded.value?.custom)?.find((server) => server.id === detailId);
  const detailSource = loaded.value?.builtins.find((source) => source.manifest.id === detailId);

  return (
    <div className="settings-group-detail mcp-settings">
      <header className="mcp-page-header"><h2>MCP</h2><p>{TEXT.settings.system.groups.mcp.description}</p></header>

      <LoadGate loaded={loaded}>
        {(page) => (
          <Group>
            <div className="mcp-page-toolbar">
              <div className="mcp-catalog-tabs" role="tablist" aria-label="MCP">
                {(["all", "mine", "official"] as const).map((value) => <button key={value} role="tab" type="button"
                  aria-selected={category === value} onClick={() => setCategory(value)}>
                  {value === "all" ? TEXT.settings.system.mcp.allMcp : value === "mine" ? TEXT.settings.system.mcp.myMcp : TEXT.settings.system.mcp.officialMcp}
                  <span>({value === "all" ? (servers ?? page.custom).length + page.builtins.length : value === "mine" ? (servers ?? page.custom).length : page.builtins.length})</span>
                </button>)}
              </div>
              <div className="mcp-toolbar-actions">
                <button className="mcp-bulk-button" disabled={busy || !visibleServers.some((server) => !server.enabled)} onClick={() => void setAllEnabled(true)} type="button"><svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4Z" /></svg>{TEXT.settings.system.mcp.enableAll}</button>
                <button className="mcp-bulk-button" disabled={busy || !visibleServers.some((server) => server.enabled)} onClick={() => void setAllEnabled(false)} type="button"><svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2v10M6 5a9 9 0 1 0 12 0" /></svg>{TEXT.settings.system.mcp.disableAll}</button>
                <input type="search" className="field-input mcp-search" aria-label={TEXT.settings.system.mcp.searchMcp} placeholder={TEXT.settings.system.mcp.searchMcp} value={query} onChange={(event) => setQuery(event.target.value)} />
                <McpAddMenu disabled={busy} onChoose={(source) => { if (source === "manual") openCreate(); else openImport(); }} />
              </div>
            </div>
            <p className="mcp-bulk-hint">{TEXT.settings.system.mcp.bulkHint}</p>
            {page.custom.length === 0 && page.builtins.length === 0 ? (
              <p className="settings-empty">{TEXT.settings.system.mcp.empty}</p>
            ) : (
              <div className="mcp-servers-grid">
                {!visibleServers.length && !visibleBuiltins.length ? <p className="settings-empty">{TEXT.settings.system.mcp.noMatches}</p> : null}
                {visibleServers.map((server) => <McpServerCard key={server.id}
                  name={server.name} description={server.description} builtin={false}
                  status={server.authorization && server.authorization.state !== "authorized"
                    ? server.authorization.state === "expired" ? TEXT.settings.system.mcp.authorizationExpired : TEXT.settings.system.mcp.unauthorized
                    : statusLabel(server.status)} tone={server.authorization && server.authorization.state !== "authorized" ? "warn" : STATUS_TONE[server.status]} tools={server.tools.length}
                  selected={server.enabled} busy={busy} onSelect={() => void toggleEnabled(server)} onTry={() => void tryServer(server.id)} tryDisabled={!server.enabled || !onTry}
                  onOpen={() => openDetails(server.id)} onEdit={() => openEdit(server)} onDelete={() => removeServer(server)} onTest={() => testServer(server)} />)}
                {visibleBuiltins.map((source) => <McpServerCard key={source.manifest.id}
                  name={source.manifest.displayName || source.manifest.id} description={source.manifest.description || ""} builtin
                  status={statusLabel(source.status.status)} tone={catalogTone(source.status.status)} tools={Object.keys(source.manifest.tools ?? {}).length}
                  selected={isSelected(source.manifest.id)} busy={busy} onSelect={() => void toggleDefaultUse(source.manifest.id)}
                  onOpen={() => openDetails(source.manifest.id)} onTry={() => void tryServer(source.manifest.id)} tryDisabled={source.status.status !== "ready" || !onTry} />)}

              </div>
            )}
          </Group>
        )}
      </LoadGate>

      {detailServer || detailSource ? <McpServerDetails server={detailServer} source={detailSource}
        failure={failure}
        onToggleEnabled={() => { if (detailServer) void toggleEnabled(detailServer); else if (detailSource) void toggleDefaultUse(detailSource.manifest.id); }}
        onToggleDefault={() => void toggleDefaultUse(detailId!)}
        onTry={() => void tryServer(detailId!)} tryDisabled={!onTry || (detailServer ? !detailServer.enabled : detailSource?.status.status !== "ready")}
        onDelete={() => { if (detailServer) { setDetailId(undefined); removeServer(detailServer); } }}
        returnFocus={detailFocus.current}
        status={statusLabel(detailServer?.status ?? detailSource?.status.status ?? "untested")}
        selected={isSelected(detailId ?? "")} busy={busy} onClose={() => setDetailId(undefined)}
        authorizationUrl={authorizingUrl?.id === detailId ? authorizingUrl?.url : undefined}
        onEdit={() => { if (detailServer) openEdit(detailServer); }} onTest={() => { if (detailServer) testServer(detailServer); }}
        onAuthorize={() => { if (detailServer) void authorize(detailServer); }}
        onEndAuthorization={(operation) => { if (detailServer) void endAuthorization(detailServer, operation); }} /> : null}

      {draft || importOpen ? (
        <McpModal
          
          className="mcp-config-modal"
          returnFocus={detailFocus.current}
          label={editing ? TEXT.settings.system.mcp.editTitle : TEXT.settings.system.mcp.createTitle}
          closeDisabled={busy}
          onClose={() => { if (!busy) closeForm(); }}
          wide
        >
          {importOpen ? <section className="mcp-json-source">
            <details open={sourceOpen} onToggle={(event) => setSourceOpen(event.currentTarget.open)}>
              <summary>{TEXT.settings.system.mcp.jsonSource}{importFileName ? <small>{importFileName}</small> : null}</summary>
              <p className="settings-note">{TEXT.settings.system.mcp.importFillHint}</p>
              <button type="button" className="secondary-button" disabled={busy || sourceLocked} onClick={() => importFileInput.current?.click()}>{TEXT.settings.system.mcp.importFile}</button>
              <textarea aria-label={TEXT.settings.system.mcp.importJson} className="field-textarea is-code" disabled={busy || sourceLocked}
                rows={7} spellCheck={false} value={importText} onChange={(event) => { setImportFileName(undefined); populateImport(event.target.value); }} />
            </details>
            <input accept=".json,application/json" aria-label={TEXT.settings.system.mcp.importFile} disabled={busy || sourceLocked} hidden type="file" ref={importFileInput}
              onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void loadImportFile(file); }} />
            {importError ? <p className="mcp-inline-error" role="alert">{importError}</p> : null}
            {importEntries?.length ? <div className="mcp-import-configurations">
              <p className="mcp-check-note" role="status">{sourceLocked
                ? TEXT.settings.system.mcp.importProgress(importEntries.filter((entry) => entry.saved).length, importEntries.length)
                : TEXT.settings.system.mcp.importFilled(importEntries.length)}</p>
              {importEntries.length > 1 ? <Select label={TEXT.settings.system.mcp.chooseConfiguration} disabled={busy} value={String(importIndex)}
                onChange={(value) => { const index = Number(value); setImportIndex(index); setFailure(importEntries[index]?.error); }}
                options={importEntries.map((entry, index) => ({ value: String(index), label: entry.draft.name + (entry.saved ? " · " + TEXT.settings.system.mcp.importAdded : entry.error ? " · " + TEXT.settings.system.mcp.statusError : "") }))} /> : null}
            </div> : null}
          </section> : null}
          <form
            className="settings-card is-form"
            ref={formRef}
            noValidate
            onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}
          >
            <fieldset disabled={busy || importEntries?.[importIndex]?.saved} className="settings-card-form mcp-form-fields">
              {current ? <>
              <Row title={TEXT.settings.system.mcp.name}>
                <input
                  ref={importOpen ? importedName : undefined}
                  aria-invalid={failure === TEXT.settings.system.mcp.nameRequired || failure === TEXT.settings.system.mcp.duplicateName || undefined}
                  aria-describedby={failure === TEXT.settings.system.mcp.nameRequired || failure === TEXT.settings.system.mcp.duplicateName ? errorId : undefined}
                  aria-label={TEXT.settings.system.mcp.name}
                  className="field-input"
                  maxLength={100}
                  required
                  onChange={(event) => change({ name: event.target.value })}
                  value={current.name}
                />
              </Row>
              <Row title={TEXT.settings.system.mcp.description}>
                <textarea
                  aria-label={TEXT.settings.system.mcp.description}
                  className="field-textarea"
                  rows={2}
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
                      aria-invalid={failure === TEXT.settings.system.mcp.commandRequired || undefined}
                      aria-describedby={failure === TEXT.settings.system.mcp.commandRequired ? errorId : undefined}
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
                      className="field-textarea is-code"
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
                      aria-invalid={failure === TEXT.settings.system.mcp.urlInvalid || undefined}
                      aria-describedby={failure === TEXT.settings.system.mcp.urlInvalid ? errorId : undefined}
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
                  aria-invalid={failure === TEXT.settings.system.mcp.timeoutInvalid || undefined}
                  aria-describedby={failure === TEXT.settings.system.mcp.timeoutInvalid ? errorId : undefined}
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
              <Row title={TEXT.settings.system.mcp.enableService}>
                <Switch label={TEXT.settings.system.mcp.enableService} value={current.enabled} disabled={busy}
                  onChange={(enabled) => change({ enabled })} />
              </Row>
              </> : <p className="mcp-check-note">{TEXT.settings.system.mcp.importEmptyHint}</p>}
            </fieldset>
            {failure ? <small id={errorId} className="row-note is-error" role="alert">{failure}</small> : null}
            <div className="settings-card-actions mcp-form-actions">
              <button className="secondary-button" disabled={busy} onClick={closeForm} type="button">{TEXT.settings.cancel}</button>
              <button className="primary-button" disabled={busy || !current || importOpen && (!!importError || pending === 0)} type="submit">
                {editing ? TEXT.settings.system.save : TEXT.settings.system.mcp.confirmAdd(importOpen ? pending : 1)}
              </button>
            </div>
          </form>
        </McpModal>
      ) : null}

      {failure && !draft && !importOpen && !detailId ? <small className="row-note is-error" role="alert">{failure}</small> : null}

    </div>
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
