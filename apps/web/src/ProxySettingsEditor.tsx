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

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type FormEvent, type RefObject } from "react";

import type {
  CreateProxyServerRequest,
  McpProxyPolicies,
  ProxyDefaultPolicy,
  ProxyEnvironmentDetails,
  ProxyPolicy,
  ProxyServer,
  ProxyServerKind,
  ProxySettingsDetails,
  UpdateProxyServerRequest,
} from "@sciencediscovery/schema";

import { InfoIcon } from "./icons.js";
import { useLocale } from "./i18n/index.js";

function kindLabel(kind: ProxyServerKind, t: ReturnType<typeof useLocale>["t"]): string {
  if (kind === "custom_url") return t("proxy.kind.custom");
  if (kind === "environment") return t("proxy.kind.environment");
  return t("proxy.kind.system");
}

export function ProxyPolicySelect({
  disabled = false,
  id,
  includeInherit = true,
  label,
  onChange,
  settings,
  value,
}: {
  disabled?: boolean;
  id?: string;
  includeInherit?: boolean;
  label?: string;
  onChange: (policy: ProxyPolicy) => void;
  settings: ProxySettingsDetails;
  value: ProxyPolicy;
}) {
  const { t } = useLocale();
  const select = <select
    aria-label={label}
    disabled={disabled}
    id={id}
    onChange={(event) => onChange(event.target.value as ProxyPolicy)}
    value={value}
  >
    {includeInherit ? <option value="inherit">{t("proxy.policy.inherit")}</option> : null}
    <option value="none">{t("proxy.policy.none")}</option>
    {settings.servers.map((server) => (
      <option key={server.id} value={`proxy:${server.id}`}>{server.name} · {kindLabel(server.kind, t)}</option>
    ))}
  </select>;
  return label ? <label htmlFor={id}><span>{label}</span>{select}</label> : select;
}

interface ProxyServerDraft {
  kind: ProxyServerKind;
  name: string;
  url: string;
}
export interface ProxyFormDraft { editingId?: string; draft: ProxyServerDraft }

const EMPTY_SERVER: ProxyServerDraft = { kind: "custom_url", name: "", url: "" };

function EnvironmentStatus({ details }: { details: ProxyEnvironmentDetails }) {
  const { t } = useLocale();
  const statusLabel = t(`proxy.environment.${details.status}`);
  return <div className="proxy-environment-status">
    <div className="proxy-environment-summary">
      <span className={`proxy-status-badge ${details.status}`}>{statusLabel}</span>
      {details.reason ? <small>{details.reason}</small> : null}
    </div>
    <div className="proxy-environment-variables">
      {details.variables.map((variable) => <div key={variable.names.join(":")}>
        <code>{variable.names.join(" / ")}</code>
        <span className={`proxy-variable-state ${variable.status}`}>{t(`proxy.environment.${variable.status}`)}</span>
        {variable.effectiveName ? <small>{t("proxy.environment.source", { name: variable.effectiveName })}</small> : null}
        {variable.effectiveValue ? <code className="proxy-effective-value">{variable.effectiveValue}</code> : null}
        {variable.reason ? <small className="proxy-variable-error">{variable.reason}</small> : null}
      </div>)}
    </div>
  </div>;
}

export function ProxyUrlGuideContent({
  id,
  popoverRef,
  style,
}: {
  id?: string;
  popoverRef?: RefObject<HTMLDivElement | null>;
  style?: CSSProperties;
}) {
  const { t } = useLocale();
  return <div className="proxy-url-tooltip" id={id} ref={popoverRef} role="tooltip" style={style}>
    <strong>{t("proxy.guide.title")}</strong>
    <ul>
      <li>{t("proxy.guide.http")} <code>http://proxy.example.test:8080</code></li>
      <li>{t("proxy.guide.https")} <code>https://proxy.example.test:8443</code></li>
      <li>{t("proxy.guide.socks5")} <code>socks5://proxy.example.test:1080</code></li>
      <li>{t("proxy.guide.auth")} <code>scheme://username:password@host:port</code></li>
      <li>{t("proxy.guide.encode")} <code>http://research%40team:p%40ss%3Aword@proxy.example.test:8080</code></li>
    </ul>
  </div>;
}

function ProxyUrlGuideTooltip() {
  const { t } = useLocale();
  const tooltipId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const open = pinned || (!dismissed && (focused || hovered));

  useEffect(() => {
    if (!open) return;
    function dismiss(): void {
      setPinned(false);
      setDismissed(true);
    }
    function handlePointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) dismiss();
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") dismiss();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverStyle({ visibility: "hidden" });
      return;
    }

    function placePopover(): void {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;
      const dialog = trigger.closest<HTMLElement>(".system-config-dialog");
      const dialogRect = dialog?.getBoundingClientRect();
      const edge = 8;
      const gap = 7;
      const boundaryLeft = Math.max(edge, (dialogRect?.left ?? 0) + edge);
      const boundaryRight = Math.min(window.innerWidth - edge, (dialogRect?.right ?? window.innerWidth) - edge);
      const boundaryTop = Math.max(edge, (dialogRect?.top ?? 0) + edge);
      const boundaryBottom = Math.min(window.innerHeight - edge, (dialogRect?.bottom ?? window.innerHeight) - edge);
      const width = Math.max(0, Math.min(620, boundaryRight - boundaryLeft));
      const maxHeight = Math.max(0, boundaryBottom - boundaryTop);

      // Apply the constrained size before measuring so wrapping is included in
      // the vertical flip decision without ever entering document flow.
      popover.style.width = `${width}px`;
      popover.style.maxHeight = `${maxHeight}px`;
      popover.style.visibility = "hidden";
      const popoverHeight = popover.getBoundingClientRect().height;
      const triggerRect = trigger.getBoundingClientRect();
      const left = Math.max(boundaryLeft, Math.min(triggerRect.left, boundaryRight - width));
      const below = triggerRect.bottom + gap;
      const above = triggerRect.top - popoverHeight - gap;
      const top = below + popoverHeight <= boundaryBottom
        ? below
        : above >= boundaryTop
          ? above
          : Math.max(boundaryTop, Math.min(below, boundaryBottom - popoverHeight));
      setPopoverStyle({ left, maxHeight, position: "fixed", top, visibility: "visible", width });
    }

    placePopover();
    window.addEventListener("resize", placePopover);
    window.addEventListener("scroll", placePopover, true);
    return () => {
      window.removeEventListener("resize", placePopover);
      window.removeEventListener("scroll", placePopover, true);
    };
  }, [open]);

  function handleBlur(event: FocusEvent<HTMLDivElement>): void {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setFocused(false);
      setPinned(false);
      setDismissed(false);
    }
  }

  return <div
    className="proxy-url-help"
    onBlur={handleBlur}
    onMouseEnter={() => {
      setHovered(true);
      setDismissed(false);
    }}
    onMouseLeave={() => {
      setHovered(false);
      if (!focused) setDismissed(false);
    }}
    ref={rootRef}
  >
    <button
      aria-controls={tooltipId}
      aria-describedby={open ? tooltipId : undefined}
      aria-expanded={open}
      aria-label={t("proxy.guide.infoAria")}
      className="proxy-url-info-trigger"
      onClick={() => {
        if (pinned) {
          setPinned(false);
          setDismissed(true);
        } else {
          setPinned(true);
          setDismissed(false);
        }
      }}
      onFocus={() => {
        setFocused(true);
        setDismissed(false);
      }}
      ref={triggerRef}
      type="button"
    >
      <InfoIcon size={16} />
    </button>
    {open ? <ProxyUrlGuideContent id={tooltipId} popoverRef={popoverRef} style={popoverStyle} /> : null}
  </div>;
}

export function ProxySettingsEditor({
  mcpPolicies,
  mcpServers,
  onCreate,
  onDefaultPolicyChange,
  onDelete,
  onMcpPolicyChange,
  onUpdate,
  onWebProxyPolicyChange,
  onTest,
  onNoProxyChange,
  formDraft,
  onFormDraftChange,
  settings,
  webProxyPolicy,
}: {
  mcpPolicies: McpProxyPolicies;
  mcpServers: Array<{ id: string; label: string }>;
  onCreate: (input: CreateProxyServerRequest) => Promise<void>;
  onDefaultPolicyChange: (policy: ProxyDefaultPolicy) => Promise<void>;
  onDelete: (server: ProxyServer) => Promise<void>;
  onMcpPolicyChange: (serverId: string, policy: ProxyPolicy) => Promise<void>;
  onUpdate: (serverId: string, input: UpdateProxyServerRequest) => Promise<void>;
  onWebProxyPolicyChange: (policy: ProxyPolicy) => void;
  settings: ProxySettingsDetails;
  webProxyPolicy: ProxyPolicy;
  onTest?: (proxy: import("@sciencediscovery/schema").ResolvedProxy) => Promise<{ ok: boolean; message: string; elapsedMs: number }>;
  onNoProxyChange?: (value: string) => void;
  formDraft?: ProxyFormDraft;
  onFormDraftChange?: (value: ProxyFormDraft | undefined) => void;
}) {
  const { t } = useLocale();
  const [editingId, setEditingId] = useState<string | undefined>(formDraft?.editingId);
  const [formOpen, setFormOpen] = useState(Boolean(formDraft));
  const [draft, setDraft] = useState<ProxyServerDraft>(formDraft?.draft ?? EMPTY_SERVER);
  useEffect(() => { onFormDraftChange?.(formOpen ? { editingId, draft } : undefined); }, [formOpen, editingId, draft, onFormDraftChange]);
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string>();
  const selected = settings.servers.find(server => `proxy:${server.id}` === settings.defaultPolicy);
  const environmentServer = settings.servers.find(server => server.kind === "environment");
  const proxyUrlInputId = useId();

  const editing = settings.servers.find((server) => server.id === editingId);
  useEffect(() => {
    if (editingId && !editing) closeForm();
  }, [editing, editingId]);

  function beginCreate(): void {
    setEditingId(undefined);
    setDraft({ ...EMPTY_SERVER, name: t("proxy.default.label") });
    setFormError(undefined);
    setFormOpen(true);
  }

  function beginEdit(server: ProxyServer): void {
    setEditingId(server.id);
    setDraft({ kind: server.kind, name: server.name, url: server.url ?? "" });
    setFormError(undefined);
    setFormOpen(true);
  }

  function closeForm(): void {
    setEditingId(undefined);
    setDraft(EMPTY_SERVER);
    setFormError(undefined);
    setFormOpen(false);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setFormError(undefined);
    try {
      if (editing) {
        await onUpdate(editing.id, {
          kind: draft.kind,
          name: draft.name,
          ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
        });
      } else {
        await onCreate({
          kind: draft.kind,
          name: draft.name,
          ...(draft.kind === "custom_url" ? { url: draft.url.trim() } : {}),
        });
      }
      closeForm();
    } catch (reason) {
      // Keep every draft field intact so validation/API failures are correctable in place.
      setFormError(reason instanceof Error ? reason.message : t("proxy.form.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return <div className="proxy-settings-editor">
    <div className="settings-detail-header proxy-page-header">
      <span className="eyebrow">{t("proxy.eyebrow")}</span>
      <h3>{t("proxy.title")}</h3>
      <p>{t("proxy.help")}</p>
      <p className="config-note">{t("proxy.immediateNote")}</p>
    </div>

    <section className="proxy-default-section" aria-labelledby="proxy-default-heading">
      <div className="proxy-section-heading">
        <span className="proxy-section-index">1</span>
        <div><h4 id="proxy-default-heading">{t("proxy.default.title")}</h4><p>{t("proxy.default.help")}</p></div>
      </div>
      <label><span>{t("proxy.default.label")}</span><select
        id="proxy-global-default"
        value={selected?.kind === "custom_url" ? "custom" : settings.defaultPolicy}
        onChange={event => {
          setTestResult(undefined);
          if (event.target.value === "custom") {
            const existing = settings.servers.find(server => server.kind === "custom_url");
            if (existing) void onDefaultPolicyChange(`proxy:${existing.id}`); else beginCreate();
          } else void onDefaultPolicyChange(event.target.value as ProxyDefaultPolicy);
        }}>
        {environmentServer ? <option value={`proxy:${environmentServer.id}`}>{t("proxy.kind.environment")}</option> : null}
        <option value="custom">{t("proxy.kind.custom")}</option>
        <option value="none">{t("proxy.policy.none")}</option>
        {selected?.kind === "system" ? <option value={settings.defaultPolicy}>{selected.name}</option> : null}
      </select></label>
      {selected?.kind === "custom_url" ? <label><span>{t("proxy.form.url")}</span><input aria-label={t("proxy.form.url")} type="password" autoComplete="off" value={selected.url ?? ""} onChange={event => { setTestResult(undefined); void onUpdate(selected.id, { url: event.target.value }); }} /></label> : null}
      {selected?.environment ? <EnvironmentStatus details={selected.environment} /> : null}
      {onTest ? <button className="secondary-button" type="button" disabled={busy || formOpen} onClick={async () => {
        setBusy(true); setTestResult(undefined);
        try {
          if (selected?.kind === "system") throw new Error(t("proxy.test.system"));
          const policy = settings.defaultPolicy === "none" ? { mode: "direct" as const } : selected?.kind === "custom_url" ? { mode: "url" as const, url: selected.url ?? "" } : { mode: "environment" as const };
          const result = await onTest({ ...policy, ...(settings.noProxy !== undefined ? { noProxy: settings.noProxy } : {}) });
          setTestResult(`${result.ok ? t("proxy.test.ok") : t("proxy.test.failed")}: ${result.message} (${result.elapsedMs} ms)`);
        } catch (error) { setTestResult(error instanceof Error ? error.message : t("proxy.test.failed")); }
        finally { setBusy(false); }
      }}>{busy ? t("proxy.test.running") : t("proxy.test.action")}</button> : null}
      {testResult ? <p role="status">{testResult}</p> : null}
    </section>

    <details>
    <summary>{t("proxy.advanced")}</summary>
    {onNoProxyChange ? <label><span>{t("proxy.noProxy")}</span><input value={settings.noProxy ?? ""} placeholder="internal.example.com,.corp.example.com" onChange={event => onNoProxyChange(event.target.value)} /></label> : null}
    <section className="proxy-server-section" aria-labelledby="proxy-servers-heading">
      <div className="proxy-section-heading">
        <span className="proxy-section-index">2</span>
        <div><h4 id="proxy-servers-heading">{t("proxy.servers.title")}</h4><p>{t("proxy.servers.help")}</p></div>
      </div>
      <div className="proxy-server-list" aria-label={t("proxy.servers.aria")}>
        {settings.servers.length ? settings.servers.map((server) => <article className="proxy-server-card" key={server.id}>
          <div className="proxy-server-summary">
            <span><strong>{server.name}</strong><small>{kindLabel(server.kind, t)}{server.kind === "custom_url" && !server.hasUrl ? ` · ${t("proxy.server.urlMissing")}` : ""}</small></span>
            <span className="proxy-server-actions">
              <button className="secondary-button compact-button" type="button" onClick={() => beginEdit(server)}>{t("proxy.server.edit")}</button>
              <button className="danger-button compact-button" type="button" onClick={() => void onDelete(server)}>{t("proxy.server.delete")}</button>
            </span>
          </div>
          {server.kind === "custom_url" && server.url ? <code className="proxy-server-url">{server.url.replace(/\/\/[^/@]+@/, "//***:***@")}</code> : null}
          {server.kind === "environment" && server.environment ? <EnvironmentStatus details={server.environment} /> : null}
        </article>) : <p className="muted">{t("proxy.servers.empty")}</p>}
      </div>
    </section>

    <ProxyPolicySelect includeInherit={false} label={t("proxy.default.label")} onChange={policy => void onDefaultPolicyChange(policy as ProxyDefaultPolicy)} settings={settings} value={settings.defaultPolicy} />
    {!formOpen ? <button className="secondary-button proxy-add-button" type="button" onClick={beginCreate}>{t("proxy.add.open")}</button> : null}
    </details>
    {formOpen ? <form aria-label={editing ? t("proxy.form.editAria", { name: editing.name }) : t("proxy.form.addAria")} className="proxy-server-form" onSubmit={(event) => void submit(event)}>
      <div className="editor-heading"><strong>{editing ? t("proxy.form.editTitle", { name: editing.name }) : t("proxy.form.addTitle")}</strong><small>{t("proxy.form.help")}</small></div>
      <label><span>{t("proxy.form.name")}</span><input required maxLength={200} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
      <label><span>{t("proxy.form.type")}</span><select value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as ProxyServerKind }))}>
        <option value="custom_url">{t("proxy.kind.custom")}</option>
        <option value="environment">{t("proxy.kind.environment")}</option>
        <option value="system">{t("proxy.kind.system")}</option>
      </select></label>
      {draft.kind === "custom_url" ? <div className="proxy-url-field">
        <div className="proxy-url-label-row">
          <label htmlFor={proxyUrlInputId}>{t("proxy.form.url")}</label>
          <ProxyUrlGuideTooltip />
        </div>
        <input
          required
          autoComplete="off"
          id={proxyUrlInputId}
          spellCheck={false}
          type="text"
          value={draft.url}
          onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
          placeholder="http://proxy.example.test:8080"
        />
      </div> : null}
      {formError ? <p className="proxy-form-error" role="alert">{formError}</p> : null}
      <div className="model-editor-actions proxy-form-actions">
        <button className="secondary-button" disabled={busy} type="button" onClick={closeForm}>{t("proxy.form.cancel")}</button>
        <button className="primary-button" disabled={busy} type="submit">{busy ? t("proxy.form.saving") : editing ? t("proxy.form.update") : t("proxy.form.add")}</button>
      </div>
    </form> : null}

    <details><summary>{t("proxy.modules.title")}</summary>
    <section className="proxy-module-section" aria-labelledby="proxy-modules-heading">
      <div className="settings-detail-header proxy-module-heading">
        <span className="eyebrow">{t("proxy.modules.eyebrow")}</span>
        <h3 id="proxy-modules-heading">{t("proxy.modules.title")}</h3>
        <p>{t("proxy.modules.help")}</p>
      </div>
      <div className="proxy-web-policy">
        <ProxyPolicySelect
          label={t("proxy.webSearch.label")}
          onChange={onWebProxyPolicyChange}
          settings={settings}
          value={webProxyPolicy}
        />
        <small>{t("proxy.webSearch.saveNote")}</small>
      </div>
      <div className="mcp-proxy-policy-list">
        {mcpServers.map((server) => <ProxyPolicySelect
          key={server.id}
          label={server.label}
          onChange={(policy) => void onMcpPolicyChange(server.id, policy)}
          settings={settings}
          value={mcpPolicies[server.id] ?? "inherit"}
        />)}
      </div>
    </section></details>
    <div className="config-note">{t("proxy.scopeNote")}</div>
  </div>;
}
