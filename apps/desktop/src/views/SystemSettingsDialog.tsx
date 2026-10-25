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

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ApiClient } from "../api/client.js";
import type { WorkspaceActions, WorkspaceState } from "../app/use-workspace.js";
import { TEXT } from "../text.js";
import { GeneralSettings } from "./settings/GeneralSettings.js";
import { ModelSettings } from "./settings/ModelSettings.js";
import { NetworkSettings } from "./settings/NetworkSettings.js";
import { RuntimeSettings } from "./settings/RuntimeSettings.js";
import { SkillsSettings } from "./settings/SkillsSettings.js";
import { McpServers } from "./settings/system/McpServers.js";
import { SettingsSaveContext, type SettingsSaveHandler } from "./settings/system/save.js";
import { SpecialistsSettings } from "./settings/system/Specialists.js";
import { TimeoutSettings } from "./settings/system/Timeouts.js";

/** The original desktop nav, extended with MCP, 专家 and 超时. */
export type SettingsGroup =
  | "general"
  | "models"
  | "skills"
  | "mcp"
  | "specialists"
  | "sandbox-network"
  | "remote"
  | "timeouts";

type CategoryId = "system" | "intelligence" | "connection" | "workspace";

const CATEGORIES: { groups: SettingsGroup[]; id: CategoryId }[] = [
  { groups: ["general"], id: "system" },
  { groups: ["models", "skills", "mcp", "specialists"], id: "intelligence" },
  { groups: ["sandbox-network", "remote"], id: "connection" },
  { groups: ["timeouts"], id: "workspace" },
];

function categoryOf(group: SettingsGroup): CategoryId {
  return CATEGORIES.find((category) => category.groups.includes(group))?.id ?? "system";
}

interface Props {
  actions: WorkspaceActions;
  client: ApiClient;
  group: SettingsGroup;
  onClose: () => void;
  onGroupChange: (group: SettingsGroup) => void;
  state: WorkspaceState;
}

/**
 * 设置, in the original desktop app's shape: 系统 › 通用, 智能 › 模型/技能 plus
 * MCP 服务器 and 专家, 连接 › 网络/远程, and the new 工作区 › 超时.
 *
 * The footer is shared, but the panes are not all written the same way. 超时
 * stages a draft and registers a save handler; the ones built around immediate
 * actions (技能, MCP, 专家, 网络, 远程) write on the press and register nothing,
 * so the footer's save buttons are disabled rather than pretending there is
 * something to commit.
 */
export function SystemSettingsDialog({
  actions,
  client,
  group,
  onClose,
  onGroupChange,
  state,
}: Props) {
  const [collapsed, setCollapsed] = useState<Partial<Record<CategoryId, boolean>>>({});
  const [saveHandler, setSaveHandler] = useState<SettingsSaveHandler>();
  const [busy, setBusy] = useState(false);
  const [addingModel, setAddingModel] = useState(false);
  const [failure, setFailure] = useState<string>();

  const register = useCallback((handler?: SettingsSaveHandler) => {
    setSaveHandler(handler === undefined ? undefined : () => handler);
  }, []);
  const saveContext = useMemo(() => ({ register }), [register]);

  // A group picked from the directory opens its category, so a collapsed one
  // never hides the choice the user just made.
  useEffect(() => {
    setCollapsed((current) => ({ ...current, [categoryOf(group)]: false }));
  }, [group]);

  // Switching panes drops the previous pane's unsaved draft with it; the form
  // state lives in the pane and unmounts here.
  useEffect(() => {
    setAddingModel(false);
    setFailure(undefined);
  }, [group]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const save = async (close: boolean) => {
    if (saveHandler === undefined) {
      if (close) onClose();
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      const saved = await saveHandler();
      if (saved && close) onClose();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const meta = TEXT.settings.system.groups[group];

  const pane = (() => {
    switch (group) {
      case "general":
        return <GeneralSettings />;
      case "models":
        return (
          <ModelSettings
            actions={actions}
            adding={addingModel}
            client={client}
            onAddingChange={setAddingModel}
            state={state}
          />
        );
      case "skills":
        return <SkillsSettings activeProjectId={state.activeProjectId} client={client} />;
      case "mcp":
        return (
          <McpServers
            client={client}
            onConfirm={actions.confirmAction}
            onToast={(message) => actions.toast(message)}
          />
        );
      case "specialists":
        return <SpecialistsSettings client={client} onConfirm={actions.confirmAction} />;
      case "sandbox-network":
        return (
          <NetworkSettings
            client={client}
            onConfirm={actions.confirmAction}
            toast={(message, tone) => actions.toast(message, tone)}
          />
        );
      case "remote":
        return (
          <RuntimeSettings
            activeProjectId={state.activeProjectId}
            client={client}
            onConfirm={actions.confirmAction}
          />
        );
      case "timeouts":
        return <TimeoutSettings client={client} />;
    }
  })();

  return (
    <div
      className="config-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-label={TEXT.settings.system.title}
        aria-modal="true"
        className="config-panel"
        role="dialog"
      >
        <nav aria-label={TEXT.settings.system.navLabel} className="settings-group-nav">
          <div className="settings-nav-head">
            <h2>{TEXT.settings.system.title}</h2>
            <button
              aria-label={TEXT.settings.close}
              className="settings-nav-close"
              onClick={onClose}
              title={TEXT.settings.close}
              type="button"
            >
              <svg aria-hidden="true" fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" viewBox="0 0 24 24" width="18">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div className="settings-nav-scroll">
            {CATEGORIES.map((entry) => {
              const open = collapsed[entry.id] !== true;
              return (
                <section className="settings-tree-category" key={entry.id}>
                  <div className="settings-tree-heading">
                    <button
                      aria-controls={`settings-category-${entry.id}`}
                      aria-expanded={open}
                      onClick={() => setCollapsed((current) => ({ ...current, [entry.id]: open }))}
                      type="button"
                    >
                      <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                      <strong>{TEXT.settings.system.categories[entry.id]}</strong>
                    </button>
                  </div>
                  <ul hidden={!open} id={`settings-category-${entry.id}`}>
                    {entry.groups.map((item) => (
                      <li key={item}>
                        <button
                          aria-current={group === item ? "page" : undefined}
                          className={group === item ? "active" : ""}
                          onClick={() => onGroupChange(item)}
                          title={TEXT.settings.system.groups[item].description}
                          type="button"
                        >
                          <strong>{TEXT.settings.system.groups[item].label}</strong>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </nav>

        <div className="settings-main">
          <div className="settings-group-detail" key={group}>
            <header className="settings-detail-header">
              <div>
                <h3>{meta.label}</h3>
                <p>{meta.description}</p>
              </div>
              {group === "models" ? (
                <button className="pill-button is-dark" onClick={() => setAddingModel(true)} type="button">
                  {TEXT.settings.model.add}
                </button>
              ) : null}
            </header>

            <SettingsSaveContext.Provider value={saveContext}>
              {pane}
            </SettingsSaveContext.Provider>

            {failure ? <small className="row-note is-error">{failure}</small> : null}
          </div>

          <div className="system-config-footer">
            <button className="secondary-button" disabled={busy} onClick={onClose} type="button">
              {TEXT.settings.system.cancelAndClose}
            </button>
            <button
              className="secondary-button"
              disabled={busy || saveHandler === undefined}
              onClick={() => void save(false)}
              title={saveHandler === undefined ? TEXT.settings.system.autoSaved : undefined}
              type="button"
            >
              {busy ? TEXT.settings.system.saving : TEXT.settings.system.save}
            </button>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void save(true)}
              title={saveHandler === undefined ? TEXT.settings.system.autoSaved : undefined}
              type="button"
            >
              {busy ? TEXT.settings.system.saving : TEXT.settings.system.saveAndClose}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
