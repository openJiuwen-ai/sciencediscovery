// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ReactNode } from "react";
import type { CustomMcpServerDetails, McpSource } from "../../api/types.js";
import { TEXT } from "../../text.js";
import { McpModal } from "./McpModal.js";
import { McpActionMenu } from "./McpActionMenu.js";
import { Switch } from "./rows.js";

export function McpDialogHeading({ name, builtin = false }: { name: string; builtin?: boolean }) {
  return <div className="mcp-detail-identity"><span className={`mcp-source-mark${builtin ? " is-builtin" : ""}`} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span><div><h2>{name}</h2><small className="mcp-kind">{builtin ? TEXT.settings.system.mcp.builtin : TEXT.settings.system.mcp.custom}</small></div></div>;
}

/** Read-only view of the API record. Secret maps expose names, never values. */
export function McpServerDetails({ server, source, status, selected, busy, authorizationUrl, returnFocus, onClose, onEdit, onTest, onAuthorize, onEndAuthorization, onToggleEnabled, onToggleDefault, onTry, tryDisabled, onDelete, failure }: {
  server?: CustomMcpServerDetails; source?: McpSource; status: string; selected: boolean; busy: boolean;
  authorizationUrl?: string; onClose: () => void; onEdit: () => void; onTest: () => void;
  returnFocus?: HTMLElement | null;
  failure?: string;
  onAuthorize: () => void; onEndAuthorization: (operation: "cancel" | "clear") => void;
  onToggleEnabled: () => void; onToggleDefault: () => void; onTry: () => void; tryDisabled: boolean; onDelete: () => void;
}) {
  const t = TEXT.settings.system.mcp;
  const name = server?.name ?? source?.manifest.displayName ?? source?.manifest.id ?? "";
  const tools = server?.tools.map((tool) => ({ name: tool.name, description: tool.description }))
    ?? Object.values(source?.manifest.tools ?? {}).map((tool) => ({ name: tool.id, description: tool.description }));
  const checkedAt = server?.checkedAt ?? source?.status.lastCheckedAt;
  const error = server?.error ?? source?.status.error;
  const field = (label: string, value: ReactNode) => <div className="mcp-detail-field"><dt>{label}</dt><dd>{value || "—"}</dd></div>;
  const secrets = (map: Record<string, null>) => Object.keys(map).length
    ? Object.keys(map).map((key) => <span className="mcp-secret-name" key={key}><code>{key}</code><small>{t.storedValue}</small></span>) : "—";
  return <McpModal label={t.details} heading={<div className="mcp-details-heading"><h2>{t.details}</h2><McpActionMenu name={name} busy={busy} onTry={onTry} tryDisabled={tryDisabled} onEdit={server ? onEdit : undefined} onDelete={server ? onDelete : undefined} /></div>} closeDisabled={busy} onClose={onClose}  returnFocus={returnFocus} className="mcp-details-modal">
    {failure ? <p className="mcp-inline-error" role="alert">{failure}</p> : null}
    <div className="mcp-detail-body">
      <div className="mcp-detail-hero">
        <span className={`mcp-source-mark${source ? " is-builtin" : ""}`} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <div className="mcp-detail-name"><h3>{name}</h3><Switch label={`${name} · ${source ? t.useByDefault : t.enableService}`} value={server?.enabled ?? selected} disabled={busy} onChange={onToggleEnabled} /></div>
        <small className="mcp-kind">{source ? t.builtin : t.custom}</small>
        <p>{server?.description || source?.manifest.description || t.noDescription}</p>
      </div>
      <dl className="mcp-detail-fields">
        {field(t.transport, server ? server.transport === "http" ? "Streamable HTTP" : server.transport.toUpperCase() : source?.manifest.transport?.type)}
        {server?.transport === "stdio" ? <>
          {field(t.command, <code>{server.command}</code>)}
          {field(t.args, <pre>{server.args.join("\n") || "—"}</pre>)}
          {field(t.cwd, <code>{server.cwd || "—"}</code>)}
          {field(t.env, secrets(server.env))}
        </> : server ? <>
          {field(t.url, <code>{server.url}</code>)}
          {field(t.authMode, server.authMode === "oauth" ? t.authOauth : t.authHeaders)}
          {field(t.headers, secrets(server.headers))}
          {server.authMode === "oauth" ? <>
            {field(t.clientId, server.oauth?.clientId)}
            {field(t.scope, server.authorization?.scope || server.oauth?.scope)}
            {field(t.metadataUrl, server.oauth?.clientMetadataUrl)}
          </> : null}
        </> : field(t.publisher, [source?.manifest.publisher, source?.manifest.version].filter(Boolean).join(" · "))}
        {server ? field(t.timeout, String(server.timeoutSeconds)) : null}
        {server ? field(t.enableService, server.enabled ? t.serviceEnabled : t.statusDisabled) : null}
        {server ? field(t.useByDefault, <Switch label={t.useByDefault} value={selected} disabled={busy} onChange={onToggleDefault} />) : null}
        {field(t.testedResult, status)}
        {field(t.checkedAt, checkedAt || t.neverChecked)}
      </dl>
      <p className="mcp-check-note">{t.checkHint}</p>
      {error ? <p className="mcp-inline-error" role="alert">{error}</p> : null}
      {server?.authorization ? <section className="mcp-authorization">
        <h3>{t.authOauth}</h3>
        <p>{server.authorization.state === "authorized" ? t.authorized : server.authorization.state === "expired" ? t.authorizationExpired : server.authorization.state === "authorizing" ? t.authorizing : t.unauthorized}</p>
        {server.authorization.error ? <p className="mcp-inline-error">{server.authorization.error}</p> : null}
        <div className="mcp-detail-actions">
          <button className="secondary-button" disabled={busy || server.authorization.state === "authorizing"} onClick={() => { if (!busy && server.authorization?.state !== "authorizing") onAuthorize(); }} type="button">{t.authorize}</button>
          {server.authorization.state === "authorizing" ? <button className="secondary-button" disabled={busy} onClick={() => onEndAuthorization("cancel")} type="button">{t.cancelAuthorization}</button> : null}
          {authorizationUrl && server.authorization.state === "authorizing" ? <a className="secondary-button" aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} onClick={(event) => { if (busy) event.preventDefault(); }} href={authorizationUrl} rel="noopener noreferrer" target="_blank">{t.openAuthorization}</a> : null}
          <button className="link-button is-danger" disabled={busy} onClick={() => onEndAuthorization("clear")} type="button">{t.clearAuthorization}</button>
        </div>
      </section> : null}
      <section className="mcp-detail-tools"><h3>{t.tools} <span>{t.toolCount(tools.length)}</span></h3>
        {tools.length ? tools.map((tool) => <div key={tool.name}><code>{tool.name}</code>{tool.description ? <p>{tool.description}</p> : null}</div>) : <p>{t.toolsNone}</p>}
      </section>
      {source ? <p className="mcp-check-note">{t.builtinReadOnly}</p> : null}
    </div>
    {server ? <div className="mcp-drawer-footer"><button type="button" className="secondary-button" disabled={busy} onClick={onTest}>{t.test}</button><button type="button" className="primary-button" disabled={busy} onClick={onEdit}>{TEXT.settings.edit}</button></div> : null}
  </McpModal>;
}
