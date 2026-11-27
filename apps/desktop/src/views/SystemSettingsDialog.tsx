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

import { useEffect, useRef, useState, type ReactNode } from "react";

import { createSession, ensureInbox } from "../api/sessions.js";
import type { ApiClient } from "../api/client.js";
import type { Specialist } from "../api/types.js";
import type { WorkspaceActions, WorkspaceState } from "../app/use-workspace.js";
import { TEXT } from "../text.js";
import { claimsEscape } from "./dialog-escape.js";
import { SidebarToggle } from "./SidebarToggle.js";
import { GeneralSettings } from "./settings/GeneralSettings.js";
import { ModelSettings } from "./settings/ModelSettings.js";
import { ModelUsageSettings } from "./settings/ModelUsageSettings.js";
import { NetworkSettings } from "./settings/NetworkSettings.js";
import { RuntimeSettings } from "./settings/RuntimeSettings.js";
import { QuotaSettings } from "./settings/QuotaSettings.js";
import { WebSearchSettings } from "./settings/WebSearchSettings.js";
import { ProxySettings } from "./settings/ProxySettings.js";
import { SkillsSettings } from "./settings/SkillsSettings.js";
import { McpServers } from "./settings/system/McpServers.js";
import { MemorySettings } from "./settings/system/MemorySettings.js";
import { SpecialistsSettings } from "./settings/system/Specialists.js";
import { TimeoutSettings } from "./settings/system/Timeouts.js";
import { ExportHistorySettings } from "./settings/system/ExportHistory.js";
import { SessionManagementSettings } from "./settings/system/Sessions.js";
import { IdeaTreeSettings } from "./settings/IdeaTreeSettings.js";

/** The original desktop nav, extended with MCP, 专家, 科学记忆 and 超时. */
export type SettingsGroup =
  | "general"
  | "memory"
  | "models"
  | "usage"
  | "skills"
  | "mcp"
  | "specialists"
  | "idea-tree"
  | "sandbox-network"
  | "remote"
  | "quotas"
  | "web"
  | "proxies"
  | "timeouts"
  | "session-management"
  | "export-history";

type CategoryId = "system" | "intelligence" | "connection" | "workspace";

const CATEGORIES: { groups: SettingsGroup[]; id: CategoryId }[] = [
  { groups: ["general"], id: "system" },
  // 科学记忆 is how the agent remembers what it read and made, so it sits with
  // the intelligence settings and after 专家, the last thing that is given to
  // the agent rather than the environment it runs in.
  { groups: ["models", "usage", "skills", "mcp", "specialists", "idea-tree", "memory", "web"], id: "intelligence" },
  { groups: ["sandbox-network", "proxies", "remote"], id: "connection" },
  { groups: ["timeouts", "quotas", "session-management", "export-history"], id: "workspace" },
];

function categoryOf(group: SettingsGroup): CategoryId {
  return CATEGORIES.find((category) => category.groups.includes(group))?.id ?? "system";
}

function SettingsMain({ standalonePage, children: [navigation, detail] }: {
  standalonePage?: ReactNode;
  children: [ReactNode, ReactNode];
}) {
  return <div className="settings-main">{navigation}{standalonePage ?? detail}</div>;
}

interface Props {
  onTrySpecialist?: (specialist: Specialist, prompt?: string) => Promise<void>;
  actions: WorkspaceActions;
  client: ApiClient;
  group: SettingsGroup;
  onClose: () => void;
  onGroupChange: (group: SettingsGroup) => void;
  /** Plays the first-run guide again. 通用 owns the row that asks for it, and
   *  the surface closes before the cards appear over the page. */
  onShowGuide: () => void;
  /** See `ModelSettings.signedIn`: the credits model is unavailable without it. */
  signedIn: boolean;
  state: WorkspaceState;
}

/**
 * 设置, in the original desktop app's shape: 系统 › 通用, 智能 › 模型/技能 plus
 * MCP 服务器, 专家 and 科学记忆, 连接 › 网络/远程, and the new 工作区 › 超时.
 *
 * There is no footer and no save button: every pane writes on the press — a
 * language, a model, a switch, a card's own 保存 — so a shared commit would
 * only ever be disabled. 超时, the last page that staged a draft, now commits
 * its own fields as they are left.
 */
export function SystemSettingsDialog({
  onTrySpecialist,
  actions,
  client,
  group,
  onClose,
  onGroupChange,
  onShowGuide,
  signedIn,
  state,
}: Props) {
  const [collapsed, setCollapsed] = useState<Partial<Record<CategoryId, boolean>>>({});
  /** The directory folds away like the session sidebar it sits where of; the
   *  pane keeps the width rather than reflowing around a zero column. */
  const [navOpen, setNavOpen] = useState(true);
  const [addingModel, setAddingModel] = useState(false);
  const [specialistSubpage, setSpecialistSubpage] = useState(false);
  const [addingSpecialist, setAddingSpecialist] = useState(false);
  /** The panel the keyboard is kept inside; see the effect below. */
  const panel = useRef<HTMLElement>(null);

  // A group picked from the directory opens its category, so a collapsed one
  // never hides the choice the user just made.
  useEffect(() => {
    setCollapsed((current) => ({ ...current, [categoryOf(group)]: false }));
  }, [group]);

  // Switching panes closes whatever form the previous one had open; the form
  // state lives in the pane and unmounts here.
  useEffect(() => {
    setAddingModel(false);
    setSpecialistSubpage(false);
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

  // The backdrop makes this surface modal for the pointer; until #1485 it was
  // modal for the pointer only. The focus stayed on the rail's 设置, #1485
  // measured 23 Tabs through the page the scrim was hiding and the 47th to
  // `BODY` and round again. This is the rule 导入会话 and 我要反馈 already use:
  // the panel takes the focus on open, Tab wraps at its two ends, and closing
  // gives the focus back to the control that opened it — so a reader who opens
  // 设置 with the keyboard stays inside it until Escape.
  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    const previous = document.activeElement as HTMLElement | null;
    node.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      // 添加模型 / 新增专家 / 技能的对话框 draw inside this panel and are a
      // smaller boundary with their own trap. While one is open the keys belong
      // to it, or this one would wrap at a boundary it is not holding.
      if (node.querySelector('[aria-modal="true"]')) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]):not([hidden]), textarea:not([disabled]), select:not([disabled]), a[href], summary, [tabindex="0"]'))
        .filter((item) => !item.matches(":disabled") && item.getClientRects().length > 0);
      const first = items[0], last = items.at(-1);
      if (!first || !last) { event.preventDefault(); node.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === node)) {
        event.preventDefault(); first.focus();
      }
    };
    node.addEventListener("keydown", trap);
    return () => {
      node.removeEventListener("keydown", trap);
      // 技能's 导入 and MCP's 试用 close this surface on their way somewhere else,
      // so the opener is only given the focus back while it is still on the page.
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const meta = TEXT.settings.system.groups[group];

  const pane = (() => {
    switch (group) {
      case "general":
        return <GeneralSettings onShowGuide={onShowGuide} />;
      case "memory":
        return <MemorySettings client={client} />;
      case "models":
        return (
          <ModelSettings
            actions={actions}
            adding={addingModel}
            client={client}
            onAddingChange={setAddingModel}
            signedIn={signedIn}
            state={state}
          />
        );
      case "usage":
        return <ModelUsageSettings client={client} />;
      case "skills":
        return <SkillsSettings client={client} onConfirm={actions.confirmAction} />;
      case "mcp":
        return (
          <McpServers
            client={client}
            onConfirm={actions.confirmAction}
            onTry={async (id) => {
              const inbox = state.inboxProject ?? await ensureInbox(client);
              const modelId = state.detail?.modelId ?? state.defaultModelId;
              const session = await createSession(client, inbox.id, { settingsOverrides: {
                enabledConnectorIds: [id], ...(modelId ? { modelId } : {}),
              } });
              await actions.refreshSessions();
              await actions.openSession(session.id, inbox.id);
              onClose();
            }}
            onToast={actions.toast}
          />
        );
      case "specialists":
        return (
          <SpecialistsSettings
            client={client}
            onSubpageChange={setSpecialistSubpage}
            onTry={onTrySpecialist}
            onConfirm={actions.confirmAction}
          />
        );
      case "idea-tree":
        return <IdeaTreeSettings client={client} />;
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
          />
        );
      case "quotas":
        return <QuotaSettings client={client} onSaved={actions.applyQuotaSettings} />;
      case "web":
        return <WebSearchSettings client={client} onConfirm={actions.confirmAction} />;
      case "proxies":
        return <ProxySettings client={client} onConfirm={actions.confirmAction} />;
      case "timeouts":
        return <TimeoutSettings client={client} />;
      case "session-management":
        return (
          <SessionManagementSettings
            actions={actions}
            client={client}
            inbox={state.inboxProject}
            onClose={onClose}
            projects={state.projects}
          />
        );
      case "export-history":
        return <ExportHistorySettings projects={state.projects} />;
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
        className={`config-panel${navOpen ? "" : " is-nav-collapsed"}${group === "specialists" && specialistSubpage ? " is-specialist-subpage" : ""}`}
        ref={panel}
        role="dialog"
        tabIndex={-1}
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

        <SettingsMain standalonePage={group === "specialists" ? pane : undefined}>
          {/* Folded, the directory's folder moves to the pane's top-left,
              where the session bar keeps its own: outside the scrolling
              detail, so a long page cannot carry it away. */}
          {navOpen ? null : (
            <div className="settings-main-fold">
              <SidebarToggle onClick={() => setNavOpen(true)} open={false} />
            </div>
          )}
          {group === "skills" || group === "mcp" ? pane : (
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

              {pane}
            </div>
          )}
        </SettingsMain>
      </section>
    </div>
  );
}
