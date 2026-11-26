// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { TEXT } from "../../text.js";
import { Switch } from "./rows.js";
import { McpActionMenu } from "./McpActionMenu.js";

export function McpServerCard({ name, description, builtin, status, tone, tools, selected, busy, onSelect, onOpen, onEdit, onDelete, onTry, tryDisabled, onTest }: {
  name: string; description: string; builtin: boolean; status: string; tone: string; tools: number;
  selected: boolean; busy: boolean; onSelect: () => void; onOpen: () => void;
  onEdit?: () => void; onDelete?: () => void; onTry: () => void; tryDisabled?: boolean; onTest?: () => void;
}) {
  return <article className="settings-card mcp-server-card">
    <div className="mcp-card-heading">
      <button type="button" className="mcp-card-identity" onClick={onOpen} aria-label={TEXT.settings.system.mcp.openDetails(name)}>
        <span className={`mcp-source-mark${builtin ? " is-builtin" : ""}`} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <span className="mcp-card-name"><strong>{name}</strong><small className="mcp-kind">{builtin ? TEXT.settings.system.mcp.builtin : TEXT.settings.system.mcp.custom}</small></span>
      </button>
      <div className="mcp-card-controls">
        <Switch disabled={busy} label={`${name} · ${builtin ? TEXT.settings.system.mcp.useByDefault : TEXT.settings.system.mcp.enableService}`} value={selected} onChange={onSelect} />
        <McpActionMenu name={name} busy={busy} onTry={onTry} tryDisabled={tryDisabled} onEdit={onEdit} onDelete={onDelete} />
      </div>
    </div>
    <button type="button" className="mcp-card-description" onClick={onOpen}>{description || TEXT.settings.system.mcp.noDescription}</button>
    <div className="mcp-card-status">
      <span className={`mcp-connection is-${tone}`}><span aria-hidden="true" />{status}</span>
      <small>{TEXT.settings.system.mcp.toolCount(tools)}</small>
      {onTest ? <button className="link-button" disabled={busy} onClick={onTest} type="button">{TEXT.settings.system.mcp.test}</button> : null}
    </div>
  </article>;
}
