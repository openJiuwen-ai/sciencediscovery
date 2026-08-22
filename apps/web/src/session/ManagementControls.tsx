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

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import type { ConnectorManifest, DeletionImpact, ModelProfile, RuntimeSettingsDetails, RuntimeSettingsOverrides, SessionListState, SkillDescriptor } from "@sciencediscovery/schema";

import { ArchiveIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, EditIcon, EllipsisIcon, PlusIcon, RestoreIcon, SettingsIcon, TrashIcon } from "../icons.js";
import { ScopedSettingsEditor } from "../ScopedSettingsEditor.js";
import { useLocale } from "../i18n/index.js";

export function selectAfterRemoval<T extends { id: string }>(items: T[], removedId: string, selectedId?: string): string | undefined {
  if (selectedId !== removedId && items.some((item) => item.id === selectedId)) return selectedId;
  return items.find((item) => item.id !== removedId)?.id;
}

export function normalizedInlineRename(draft: string, original: string): string | undefined {
  const name = draft.trim();
  return !name || name === original ? undefined : name;
}

export function inlineRenameInputColumns(value: string): number {
  return Math.min(40, Math.max(8, Array.from(value).length + 1));
}

export function InlineRenameInput({
  ariaLabel,
  className,
  disabled = false,
  onChange,
  onCommit,
  size,
  value,
}: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  size?: number;
  value: string;
}) {
  return <input
    aria-label={ariaLabel}
    autoFocus
    className={className}
    disabled={disabled}
    maxLength={120}
    onBlur={(event) => onCommit(event.currentTarget.value)}
    onChange={(event) => onChange(event.target.value)}
    onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
    onFocus={(event) => event.currentTarget.select()}
    onKeyDown={(event) => {
      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.currentTarget.blur();
    }}
    size={size}
    value={value}
  />;
}

export function SidebarSectionHeader({
  addDisabled = false,
  addLabel,
  count,
  expanded,
  headerAction,
  label,
  onAdd,
  onToggle,
  panelId,
}: {
  addDisabled?: boolean;
  addLabel: string;
  count: number;
  expanded: boolean;
  headerAction?: ReactNode;
  label: string;
  onAdd: () => void;
  onToggle: () => void;
  panelId: string;
}) {
  return <div className="sidebar-label">
    <button
      aria-controls={panelId}
      aria-expanded={expanded}
      className="sidebar-section-toggle"
      onClick={onToggle}
      type="button"
    >
      <span aria-hidden="true" className="sidebar-section-chevron">{expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}</span>
      <span>{label}</span>
    </button>
    {headerAction}
    <span className="sidebar-section-count">{count}</span>
    <button aria-label={addLabel} className="icon-button sidebar-add-button" disabled={addDisabled} onClick={onAdd} title={addLabel} type="button"><PlusIcon size={16} /></button>
  </div>;
}

function useAnchoredPopover(open: boolean) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useEffect(() => {
    if (!open) {
      setStyle({ visibility: "hidden" });
      return;
    }

    const placePopover = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;
      const triggerRect = trigger.getBoundingClientRect();
      const width = popover.offsetWidth || 160;
      const height = popover.offsetHeight || 120;
      const left = Math.max(8, Math.min(triggerRect.right - width, window.innerWidth - width - 8));
      const below = triggerRect.bottom + 5;
      const top = below + height <= window.innerHeight - 8
        ? below
        : Math.max(8, triggerRect.top - height - 5);
      setStyle({ left, top, visibility: "visible" });
    };

    placePopover();
    window.addEventListener("resize", placePopover);
    window.addEventListener("scroll", placePopover, true);
    return () => {
      window.removeEventListener("resize", placePopover);
      window.removeEventListener("scroll", placePopover, true);
    };
  }, [open]);

  return { popoverRef, style, triggerRef };
}

export function SessionFilterMenu({
  onChange,
  onToggle,
  open,
  value,
}: {
  onChange: (value: SessionListState) => void;
  onToggle: () => void;
  open: boolean;
  value: SessionListState;
}) {
  const { locale, t } = useLocale();
  const menuId = "session-filter-menu";
  const stateLabel = value === "active" ? t("sidebar.active") : value === "archived" ? t("sidebar.archived") : t("sidebar.all");
  const { popoverRef, style, triggerRef } = useAnchoredPopover(open);
  return <div className={open ? "session-filter open" : "session-filter"}>
    <button
      aria-controls={open ? menuId : undefined}
      aria-expanded={open}
      aria-haspopup="menu"
      aria-label={t("sidebar.filterCurrent", { state: locale === "en" ? value : stateLabel })}
      className={value === "active" ? "session-filter-trigger" : "session-filter-trigger filtered"}
      onClick={onToggle}
      ref={triggerRef}
      title={t("sidebar.filterSessions")}
      type="button"
    >
      <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M3 5h14M5.5 10h9M8 15h4" /></svg>
    </button>
    {open ? <div aria-label={t("sidebar.stateFilter")} className="session-filter-popover" id={menuId} ref={popoverRef} role="menu" style={style}>
      {(["active", "archived", "all"] as SessionListState[]).map((state) => <button
        aria-checked={value === state}
        className={value === state ? "active" : ""}
        key={state}
        onClick={() => onChange(state)}
        role="menuitemradio"
        type="button"
      ><span>{state === "active" ? t("sidebar.active") : state === "archived" ? t("sidebar.archived") : t("sidebar.all")}</span><span aria-hidden="true">{value === state ? <CheckIcon size={13} /> : ""}</span></button>)}
    </div> : null}
  </div>;
}

const MIN_SIDEBAR_SPLIT = 20;
const MAX_SIDEBAR_SPLIT = 75;

export function clampSidebarSplit(value: number): number {
  return Math.min(MAX_SIDEBAR_SPLIT, Math.max(MIN_SIDEBAR_SPLIT, value));
}

export function SidebarPanelResizer({
  onChange,
  onResizeEnd,
  onResizeStart,
  resizing,
  value,
}: {
  onChange: (value: number) => void;
  onResizeEnd: () => void;
  onResizeStart: () => void;
  resizing: boolean;
  value: number;
}) {
  const { t } = useLocale();
  const updateFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    onChange(clampSidebarSplit(((event.clientY - bounds.top) / bounds.height) * 100));
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    onResizeStart();
    if (event.key === "Home") onChange(MIN_SIDEBAR_SPLIT);
    else if (event.key === "End") onChange(MAX_SIDEBAR_SPLIT);
    else onChange(clampSidebarSplit(value + (event.key === "ArrowUp" ? -3 : 3)));
    onResizeEnd();
  };

  return <div
    aria-label={t("sidebar.resize")}
    aria-orientation="horizontal"
    aria-valuemax={MAX_SIDEBAR_SPLIT}
    aria-valuemin={MIN_SIDEBAR_SPLIT}
    aria-valuenow={Math.round(value)}
    className={resizing ? "sidebar-resizer resizing" : "sidebar-resizer"}
    onKeyDown={handleKeyDown}
    onPointerCancel={onResizeEnd}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      onResizeStart();
      updateFromPointer(event);
    }}
    onPointerMove={(event) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromPointer(event);
    }}
    onPointerUp={(event) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      onResizeEnd();
    }}
    role="separator"
    tabIndex={0}
  ><span /></div>;
}

export function ProjectCreationDialog({
  connectors,
  details,
  models,
  onCancel,
  onCreate,
  skills,
}: {
  connectors: ConnectorManifest[];
  details: RuntimeSettingsDetails;
  models: ModelProfile[];
  onCancel: () => void;
  onCreate: (name: string, settingsOverrides: RuntimeSettingsOverrides) => Promise<void> | void;
  skills: SkillDescriptor[];
}) {
  const { t } = useLocale();
  const [name, setName] = useState("");
  const inheritedDetails = { ...details, overrides: {} } satisfies RuntimeSettingsDetails;

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section aria-label={t("project.create")} aria-modal="true" className="creation-dialog" role="dialog">
      <span className="eyebrow">{t("project.new")}</span>
      <h2>{t("project.create")}</h2>
      <ScopedSettingsEditor
        beforeFields={<label className="creation-name">
          <span>{t("project.name")}</span>
          <input
            autoFocus
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("project.placeholder")}
          />
        </label>}
        connectors={connectors}
        description={t("project.inheritanceHelp")}
        details={inheritedDetails}
        models={models}
        onCancel={onCancel}
        onSave={(settingsOverrides) => onCreate(name.trim(), settingsOverrides)}
        scopeLabel={t("settings.project")}
        skillScope="project"
        skills={skills}
        submitLabel={t("project.create")}
      />
    </section>
  </div>;
}

interface OverflowMenuAction {
  danger?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
}

function ResourceOverflowMenu({
  actions,
  kind,
  label,
  onToggle,
  open,
  resourceId,
}: {
  actions: OverflowMenuAction[];
  kind: "project" | "session";
  label: string;
  onToggle: () => void;
  open: boolean;
  resourceId: string;
}) {
  const { t } = useLocale();
  const menuId = `${kind}-menu-${resourceId}`;
  const { popoverRef, style, triggerRef } = useAnchoredPopover(open);
  return <div className={open ? `resource-menu ${kind}-menu open` : `resource-menu ${kind}-menu`}>
    <button
      aria-controls={open ? menuId : undefined}
      aria-expanded={open}
      aria-haspopup="menu"
      aria-label={t("resource.moreActions", { label })}
      className="icon-button resource-menu-trigger"
      onClick={onToggle}
      ref={triggerRef}
      title={t("resource.moreKindActions", { kind: kind === "project" ? t("settings.project") : t("settings.session") })}
      type="button"
    ><EllipsisIcon size={17} /></button>
    {open ? <div aria-label={t("resource.actionsFor", { label })} className="resource-menu-popover" id={menuId} ref={popoverRef} role="menu" style={style}>
      {actions.map((action) => <button
        className={action.danger ? "danger" : undefined}
        disabled={action.disabled}
        key={action.label}
        onClick={action.onSelect}
        role="menuitem"
        type="button"
      ><span aria-hidden="true">{action.icon}</span><span>{action.label}</span></button>)}
    </div> : null}
  </div>;
}

export function ProjectOverflowMenu({
  label,
  onDelete,
  onRename,
  onSettings,
  onToggle,
  open,
  projectId,
}: {
  label: string;
  onDelete: () => void;
  onRename: () => void;
  onSettings: () => void;
  onToggle: () => void;
  open: boolean;
  projectId: string;
}) {
  const { t } = useLocale();
  return <ResourceOverflowMenu
    actions={[
      { icon: <EditIcon size={15} />, label: t("resource.rename"), onSelect: onRename },
      { icon: <SettingsIcon size={15} />, label: t("resource.settings"), onSelect: onSettings },
      { danger: true, icon: <TrashIcon size={15} />, label: t("resource.delete"), onSelect: onDelete },
    ]}
    kind="project"
    label={label}
    onToggle={onToggle}
    open={open}
    resourceId={projectId}
  />;
}

export function SessionOverflowMenu({
  archived,
  busy = false,
  label,
  onArchive,
  onDelete,
  onRename,
  onRestore,
  onSettings,
  onToggle,
  open,
  sessionId,
}: {
  archived: boolean;
  busy?: boolean;
  label: string;
  onArchive: () => void;
  onDelete: () => void;
  onRename: () => void;
  onRestore: () => void;
  onSettings: () => void;
  onToggle: () => void;
  open: boolean;
  sessionId: string;
}) {
  const { t } = useLocale();
  return <ResourceOverflowMenu
    actions={[
      { disabled: archived, icon: <EditIcon size={15} />, label: t("resource.rename"), onSelect: onRename },
      { disabled: busy, icon: <SettingsIcon size={15} />, label: t("resource.settings"), onSelect: onSettings },
      archived
        ? { disabled: busy, icon: <RestoreIcon size={15} />, label: t("resource.restore"), onSelect: onRestore }
        : { disabled: busy, icon: <ArchiveIcon size={15} />, label: t("resource.archive"), onSelect: onArchive },
      { danger: true, disabled: busy, icon: <TrashIcon size={15} />, label: t("resource.delete"), onSelect: onDelete },
    ]}
    kind="session"
    label={label}
    onToggle={onToggle}
    open={open}
    resourceId={sessionId}
  />;
}

export function DeletionDialog({
  confirmation,
  impact,
  label,
  onCancel,
  onChangeConfirmation,
  onConfirm,
}: {
  confirmation: string;
  impact: DeletionImpact;
  label: string;
  onCancel: () => void;
  onChangeConfirmation: (value: string) => void;
  onConfirm: () => void;
}) {
  const { t } = useLocale();
  const matches = confirmation === label;
  const kind = impact.targetType.toLowerCase() === "project" ? t("settings.project") : t("settings.session");
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section aria-label={t("delete.title", { kind, label })} aria-modal="true" className="deletion-dialog" role="dialog">
      <span className="eyebrow">{t("delete.irreversible")}</span>
      <h2>{t("delete.title", { kind, label })}</h2>
      <p>{t("delete.warning")}</p>
      {impact.targetType === "session" ? <p>{t("delete.sessionArtifactRetention")}</p> : null}
      <dl className="deletion-impact">
        <div><dt>{t("delete.totalSessions")}</dt><dd>{impact.totalSessionCount}</dd></div>
        <div><dt>{t("delete.active")}</dt><dd>{impact.activeSessionCount}</dd></div>
        <div><dt>{t("delete.archived")}</dt><dd>{impact.archivedSessionCount}</dd></div>
      </dl>
      <div className="impact-categories"><strong>{t("delete.dataRemoved")}</strong><span>{impact.dataCategories.join(", ") || t("delete.catalogMetadata")}</span></div>
      <label><span>{t("delete.confirm", { label })}</span><input autoFocus value={confirmation} onChange={(event) => onChangeConfirmation(event.target.value)} /></label>
      <div className="dialog-actions">
        <button className="secondary-button" onClick={onCancel} type="button">{t("common.cancel")}</button>
        <button className="danger-button" disabled={!matches} onClick={onConfirm} type="button">{t("delete.permanently")}</button>
      </div>
    </section>
  </div>;
}
