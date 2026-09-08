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

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CustomMcpServerDetails, CustomMcpServerInput, McpSourceManifest } from "@sciencediscovery/schema";
import type { ApiClient } from "./api.js";
import { useLocale } from "./i18n/index.js";
import { AlertCircleIcon, CheckIcon, CloseIcon, DatabaseIcon, EditIcon, PlusIcon, SearchIcon, SpinnerIcon, TrashIcon, UploadIcon } from "./icons.js";
import { MarkdownRenderer } from "./Markdown.js";
import { Bug } from "lucide-react";
import { McpInspector } from "./McpInspector.js";

type SecretRow = { key: string; value: string | null };
type Draft = Omit<CustomMcpServerInput, "env" | "headers" | "args"> & { argsText: string; envRows: SecretRow[]; headerRows: SecretRow[] };

function draftFor(server?: CustomMcpServerDetails): Draft {
  return {
    name: server?.name ?? "", description: server?.description ?? "",
    transport: server?.transport ?? "http", enabled: server?.enabled ?? false,
    command: server?.command ?? "", argsText: server?.args.join("\n") ?? "",
    cwd: server?.cwd ?? "", url: server?.url ?? "", timeoutSeconds: server?.timeoutSeconds ?? 60,
    envRows: Object.keys(server?.env ?? {}).map((key) => ({ key, value: null })),
    headerRows: Object.keys(server?.headers ?? {}).map((key) => ({ key, value: null })),
  };
}

function secretRows(rows: SecretRow[]): Record<string, string | null> {
  const entries = rows.map(({ key, value }) => [key.trim(), value] as const);
  if (entries.some(([key]) => !key) || new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("Keys must be non-empty and unique");
  return Object.fromEntries(entries);
}

function SecretFields({ rows, onChange, label }: { rows: SecretRow[]; onChange: (rows: SecretRow[]) => void; label: string }) {
  const { t } = useLocale();
  return <fieldset className="mcp-secret-fields">
    <legend>{label}</legend>
    {rows.map((row, index) => <div className="mcp-secret-row" key={index}>
      <input aria-label={`${label} ${t("mcp.key")} ${index + 1}`} placeholder={t("mcp.key")} value={row.key} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, key: event.target.value, value: item.value ?? "" } : item))} />
      <input aria-label={`${label} ${t("mcp.value")} ${index + 1}`} autoComplete="off" type="password" placeholder={row.value === null ? t("mcp.secretSaved") : t("mcp.value")} value={row.value ?? ""} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} />
      <button aria-label={t("mcp.removeEntry")} title={t("mcp.removeEntry")} className="icon-button" type="button" onClick={() => onChange(rows.filter((_, i) => i !== index))}><CloseIcon size={15} /></button>
    </div>)}
    <button className="text-button mcp-inline-command" type="button" onClick={() => onChange([...rows, { key: "", value: "" }])}><PlusIcon size={14} />{t("mcp.addEntry")}</button>
  </fieldset>;
}

export function McpServerSettings({ client, sources, sessionId, sessionTitle, onChanged }: {
  client: Pick<ApiClient, "listMcpServers" | "saveMcpServer" | "testMcpServer" | "deleteMcpServer" | "importMcpServers" | "inspectMcpTool">;
  sources: McpSourceManifest[];
  sessionId?: string;
  sessionTitle?: string;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [servers, setServers] = useState<CustomMcpServerDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"custom" | "builtin">("custom");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<{ id?: string; draft: Draft }>();
  const [importing, setImporting] = useState(false);
  const [json, setJson] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [inspecting, setInspecting] = useState<string>();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    void client.listMcpServers().then((items) => { if (active) setServers(items); }).catch((reason) => { if (active) setError(String(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (!deleting) return;
    const reset = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event.type === "pointerdown" && event.target instanceof Element && event.target.closest(`[data-mcp-delete="${deleting}"]`)) return;
      setDeleting(undefined);
    };
    document.addEventListener("pointerdown", reset);
    document.addEventListener("keydown", reset);
    return () => { document.removeEventListener("pointerdown", reset); document.removeEventListener("keydown", reset); };
  }, [deleting]);

  async function run(key: string, action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(key); setError(undefined); setNotice(undefined);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  }

  async function refresh(): Promise<void> {
    setServers(await client.listMcpServers());
    await onChanged();
  }

  function openEditor(server?: CustomMcpServerDetails): void {
    setEditor({ ...(server ? { id: server.id } : {}), draft: draftFor(server) });
    setImporting(false); setError(undefined); setNotice(undefined);
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!editor) return;
    void run("save", async () => {
      const { argsText, envRows, headerRows, ...values } = editor.draft;
      await client.saveMcpServer({ ...values, args: argsText ? argsText.split("\n").filter((line) => line.length > 0) : [], env: secretRows(envRows), headers: secretRows(headerRows) }, editor.id);
      setEditor(undefined);
      await refresh();
      setNotice(t("mcp.saved"));
    });
  }

  const filtered = servers.filter((server) => `${server.name} ${server.description}`.toLowerCase().includes(query.toLowerCase()));
  const builtins = sources.filter((source) => !source.id.startsWith("custom-"));
  const draft = editor?.draft;
  const inspectedServer = servers.find((server) => server.id === inspecting);
  const change = (patch: Partial<Draft>) => setEditor((current) => current ? { ...current, draft: { ...current.draft, ...patch } } : current);

  return <section className="mcp-settings" ref={root}>
    <div className="settings-detail-header"><span className="eyebrow">MCP</span><h3>{t("mcp.title")}</h3></div>
    {error ? <div className="mcp-feedback error" role="alert"><AlertCircleIcon size={16} /><span>{error}</span></div> : null}
    {notice ? <div className="mcp-feedback success" role="status"><CheckIcon size={16} /><span>{notice}</span></div> : null}
    {inspectedServer ? <McpInspector key={inspectedServer.id} server={inspectedServer} client={client} sessionId={sessionId} sessionTitle={sessionTitle} onBack={() => setInspecting(undefined)} /> : editor && draft ? <form className="model-editor mcp-editor" onSubmit={submit}>
      <div className="mcp-section-heading"><h4>{editor.id ? t("mcp.edit") : t("mcp.add")}</h4><button aria-label={t("common.cancel")} title={t("common.cancel")} className="icon-button" type="button" disabled={!!busy} onClick={() => setEditor(undefined)}><CloseIcon size={17} /></button></div>
      <fieldset disabled={!!busy} className="mcp-form-fields">
        <label><span>{t("mcp.name")}</span><input required maxLength={100} autoFocus value={draft.name} onChange={(event) => change({ name: event.target.value })} /></label>
        <label><span>{t("mcp.description")}</span><input maxLength={2000} value={draft.description} onChange={(event) => change({ description: event.target.value })} /></label>
        <label><span>{t("mcp.transport")}</span><select value={draft.transport} onChange={(event) => change({ transport: event.target.value as Draft["transport"] })}><option value="http">Streamable HTTP</option><option value="sse">SSE</option><option value="stdio">STDIO</option></select></label>
        {draft.transport === "stdio" ? <>
          <label><span>{t("mcp.command")}</span><input required placeholder="npx" value={draft.command} onChange={(event) => change({ command: event.target.value })} /></label>
          <label><span>{t("mcp.args")}</span><textarea rows={3} spellCheck={false} value={draft.argsText} onChange={(event) => change({ argsText: event.target.value })} /></label>
          <label><span>{t("mcp.cwd")}</span><input value={draft.cwd} onChange={(event) => change({ cwd: event.target.value })} /></label>
          <SecretFields label={t("mcp.env")} rows={draft.envRows} onChange={(envRows) => change({ envRows })} />
        </> : <>
          <label><span>URL</span><input required type="url" placeholder="https://example.com/mcp" value={draft.url} onChange={(event) => change({ url: event.target.value })} /></label>
          <SecretFields label={t("mcp.headers")} rows={draft.headerRows} onChange={(headerRows) => change({ headerRows })} />
        </>}
        <div className="mcp-form-tail"><label><span>{t("mcp.timeout")}</span><input type="number" min={1} max={600} required value={draft.timeoutSeconds} onChange={(event) => change({ timeoutSeconds: Number(event.target.value) })} /></label><label className="mcp-enable-label"><input type="checkbox" checked={draft.enabled} onChange={(event) => change({ enabled: event.target.checked })} /><span>{t("mcp.enabled")}</span></label></div>
      </fieldset>
      <div className="mcp-form-actions"><button className="secondary-button" type="button" disabled={!!busy} onClick={() => setEditor(undefined)}>{t("common.cancel")}</button><button className="primary-button" type="submit" disabled={!!busy}>{busy === "save" ? <SpinnerIcon className="spin" size={15} /> : null}{t("common.save")}</button></div>
    </form> : importing ? <form className="model-editor mcp-editor" onSubmit={(event) => { event.preventDefault(); void run("import", async () => { const config: unknown = JSON.parse(json); await client.importMcpServers(config); await refresh(); setImporting(false); setJson(""); setNotice(t("mcp.imported")); }); }}>
      <h4>{t("mcp.import")}</h4>
      <label><span>JSON (mcpServers)</span><textarea required rows={12} spellCheck={false} autoFocus value={json} onChange={(event) => setJson(event.target.value)} placeholder={'{\n  "mcpServers": {\n    "my-server": {\n      "type": "http",\n      "url": "https://example.com/mcp"\n    }\n  }\n}'} /></label>
      <div className="mcp-form-actions"><button type="button" className="secondary-button" disabled={!!busy} onClick={() => setImporting(false)}>{t("common.cancel")}</button><button type="submit" className="primary-button" disabled={!!busy}>{busy ? <SpinnerIcon className="spin" size={15} /> : <UploadIcon size={15} />}{t("mcp.import")}</button></div>
    </form> : <>
      <div className="mcp-tabs" role="tablist" aria-label={t("mcp.title")}><button type="button" role="tab" aria-selected={tab === "custom"} onClick={() => setTab("custom")}>{t("mcp.custom")} <span>{servers.length}</span></button><button type="button" role="tab" aria-selected={tab === "builtin"} onClick={() => setTab("builtin")}>{t("mcp.builtin")} <span>{builtins.length}</span></button></div>
      {tab === "custom" ? <>
        <div className="mcp-toolbar"><label className="mcp-search"><SearchIcon size={15} /><input aria-label={t("mcp.search")} placeholder={t("mcp.search")} value={query} onChange={(event) => setQuery(event.target.value)} /></label><button className="secondary-button" type="button" disabled={!!busy} onClick={() => { setImporting(true); setError(undefined); }}><UploadIcon size={15} />{t("mcp.import")}</button><button className="primary-button" type="button" disabled={!!busy} onClick={() => openEditor()}><PlusIcon size={15} />{t("mcp.add")}</button></div>
        {loading ? <div className="mcp-empty"><SpinnerIcon className="spin" size={20} /></div> : !filtered.length ? <div className="mcp-empty"><DatabaseIcon size={28} /><strong>{query ? t("mcp.noResults") : t("mcp.empty")}</strong></div> : <div className="mcp-server-list">
          {filtered.map((server) => <article className="mcp-server" key={server.id}>
            <div className="mcp-server-heading">
              <button className="mcp-server-title mcp-server-toggle" type="button"
                aria-label={`${t(collapsed.has(server.id) ? "mcp.expandServer" : "mcp.collapseServer")} ${server.name}`}
                title={t(collapsed.has(server.id) ? "mcp.expandServer" : "mcp.collapseServer")}
                aria-expanded={!collapsed.has(server.id)} aria-controls={`mcp-details-${server.id}`}
                onClick={() => setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(server.id)) next.delete(server.id); else next.add(server.id);
                  return next;
                })}>
              <DatabaseIcon size={18} /><div><strong title={server.name}>{server.name}</strong></div></button><label className="mcp-switch" title={server.enabled ? t("mcp.disable") : t("mcp.enable")}><input role="switch" aria-label={`${t("mcp.enabled")} ${server.name}`} type="checkbox" checked={server.enabled} disabled={!!busy} onChange={() => void run(server.id, async () => { await client.saveMcpServer({ ...server, enabled: !server.enabled }, server.id); await refresh(); })} /><span /></label></div>
            <div className="mcp-server-details" id={`mcp-details-${server.id}`} hidden={collapsed.has(server.id)}>
            <p className="mcp-server-description"><span className="mcp-server-transport">{server.transport === "http" ? "Streamable HTTP" : server.transport.toUpperCase()}</span>{server.description ? ` · ${server.description}` : ""}</p>
            <div className="mcp-server-actions"><div className="mcp-server-summary"><span className={`mcp-status ${server.status}`}><i />{t(`mcp.status.${server.status}`)}</span><span className="mcp-tool-count">{server.tools.length} {t("mcp.tools")}</span>
            {server.tools.length ? <button className="text-button mcp-inline-command" type="button" disabled={!!busy} onClick={() => { setInspecting(server.id); setNotice(undefined); setError(undefined); }}><Bug size={14} />MCP Inspector</button> : null}
            </div><div className="mcp-actions-end"><button type="button" className="mcp-test-button" aria-label={`${t("mcp.test")} ${server.name}`} title={t("mcp.test")} disabled={!!busy} onClick={() => void run(server.id, async () => { const result = await client.testMcpServer(server.id); setServers((items) => items.map((item) => item.id === server.id ? result : item)); await onChanged(); if (result.error) setError(result.error); else setNotice(`${server.name}: ${t("mcp.testPassed")}${result.durationMs !== undefined ? ` (${result.durationMs} ms)` : ""}`); })}>{busy === server.id ? <SpinnerIcon className="spin" size={14} /> : server.checkedAt ? server.error ? <AlertCircleIcon size={14} /> : <CheckIcon size={14} /> : null}{t("mcp.test")}</button><button type="button" className="icon-button" disabled={!!busy} aria-label={`${t("mcp.edit")} ${server.name}`} title={t("mcp.edit")} onClick={() => openEditor(server)}><EditIcon size={15} /></button><button type="button" className={`icon-button mcp-delete ${deleting === server.id ? "confirming" : ""}`} disabled={!!busy} data-mcp-delete={server.id} aria-label={`${deleting === server.id ? t("mcp.confirmDelete") : t("mcp.delete")} ${server.name}`} title={deleting === server.id ? t("mcp.confirmDelete") : t("mcp.delete")} onClick={() => { if (deleting !== server.id) setDeleting(server.id); else void run(server.id, async () => { await client.deleteMcpServer(server.id); setDeleting(undefined); await refresh(); setNotice(t("mcp.deleted")); }); }}>{deleting === server.id ? <CheckIcon size={15} /> : <TrashIcon size={15} />}</button></div></div>
            {server.error ? <p className="mcp-server-error">{server.error}</p> : null}
            {server.tools.length ? <details className="mcp-tool-list"><summary>{t("mcp.viewTools")} ({server.tools.length})</summary>{server.tools.map((tool) => <details className="mcp-tool" key={tool.name}><summary><code>{tool.name}</code></summary><MarkdownRenderer content={tool.description} /><div className="mcp-schema-heading">{t("mcp.parameters")}</div><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>)}</details> : null}
            </div>
          </article>)}
        </div>}
      </> : <div className="mcp-builtin-list">{builtins.map((source) => <details key={source.id} className="mcp-builtin"><summary><DatabaseIcon size={16} /><strong>{source.displayName}</strong><span>{Object.keys(source.tools).length} {t("mcp.tools")}</span></summary><p>{source.description}</p><ul>{Object.values(source.tools).map((tool) => <li key={tool.id}><code>{tool.mcpToolName}</code><p>{tool.description}</p></li>)}</ul></details>)}</div>}
    </>}
  </section>;
}
