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

import type { ApiClient } from "../api/client.js";
import type { WorkspaceActions, WorkspaceState } from "../app/use-workspace.js";
import { TEXT } from "../text.js";
import { claimsEscape } from "./dialog-escape.js";
import { SidebarToggle } from "./SidebarToggle.js";
import { GeneralSettings } from "./settings/GeneralSettings.js";
import { ModelSettings } from "./settings/ModelSettings.js";
import { NetworkSettings } from "./settings/NetworkSettings.js";
import { RuntimeSettings } from "./settings/RuntimeSettings.js";
import { SkillsSettings } from "./settings/SkillsSettings.js";
import { McpServers } from "./settings/system/McpServers.js";
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
 * There is no footer and no save button: every pane writes on the press — a
 * language, a model, a switch, a card's own 保存 — so a shared commit would
 * only ever be disabled. 超时, the last page that staged a draft, now commits
 * its own fields as they are left.
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
  /** The directory folds away like the session sidebar it sits where of; the
   *  pane keeps the width rather than reflowing around a zero column. */
  const [navOpen, setNavOpen] = useState(true);
  const [addingModel, setAddingModel] = useState(false);
  const [addingSkill, setAddingSkill] = useState(false);

  // A group picked from the directory opens its category, so a collapsed one
  // never hides the choice the user just made.
  useEffect(() => {
    setCollapsed((current) => ({ ...current, [categoryOf(group)]: false }));
  }, [group]);

  // Switching panes closes whatever form the previous one had open; the form
  // state lives in the pane and unmounts here.
  useEffect(() => {
    setAddingModel(false);
    setAddingSkill(false);
  }, [group]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A modal form over this surface claims Escape first; the settings
      // surface closes only when nothing above it wanted the key.
      if (!claimsEscape(event)) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
        return (
          <SkillsSettings
            activeProjectId={state.activeProjectId}
            adding={addingSkill}
            client={client}
            onAddingChange={setAddingSkill}
          />
        );
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
            client={client}
            onConfirm={actions.confirmAction}
            project={state.activeProject}
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
        className={`config-panel${navOpen ? "" : " is-nav-collapsed"}`}
        role="dialog"
      >
        <nav aria-label={TEXT.settings.system.navLabel} className="settings-group-nav">
          <div className="settings-nav-head">
            <h2>{TEXT.settings.system.title}</h2>
            <SidebarToggle onClick={() => setNavOpen(false)} open />
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
          {/* Folded, the directory's folder moves to the pane's top-left,
              where the session bar keeps its own: outside the scrolling
              detail, so a long page cannot carry it away. */}
          {navOpen ? null : (
            <div className="settings-main-fold">
              <SidebarToggle onClick={() => setNavOpen(true)} open={false} />
            </div>
          )}
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
              ) : group === "skills" ? (
                <button className="pill-button is-dark" onClick={() => setAddingSkill(true)} type="button">
                  {TEXT.settings.skills.add}
                </button>
              ) : null}
            </header>

            {pane}
          </div>
        </div>
      </section>
    </div>
  );
}
