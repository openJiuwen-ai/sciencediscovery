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

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

import { ApiClient } from "./api/client.js";
import { useFileDrop } from "./app/use-file-drop.js";
import { useLanguage } from "./app/use-language.js";
import { usePanelWidth } from "./app/use-panel-width.js";
import { useWorkspace } from "./app/use-workspace.js";
import { formatByteLimit } from "./app/upload.js";
import {
  RIGHT_PANEL_STORAGE_KEY,
  TOKEN_STORAGE_KEY,
  readStoredFlag,
  writeStoredFlag,
} from "./state/storage.js";
import { applyDocumentLanguage, TEXT } from "./text.js";
import { AuthScreen } from "./views/AuthScreen.js";
import { Composer } from "./views/Composer.js";
import { ConfirmDialog } from "./views/ConfirmDialog.js";
import { Conversation } from "./views/Conversation.js";
import { OfflineScreen } from "./views/OfflineScreen.js";
import { Rail } from "./views/Rail.js";
import { SessionBar } from "./views/SessionBar.js";
import { SetupWizard } from "./views/SetupWizard.js";
import { SystemSettingsDialog, type SettingsGroup } from "./views/SystemSettingsDialog.js";
import { Sidebar } from "./views/Sidebar.js";
import { sessionTitle } from "./views/session-title.js";
import { Toasts } from "./views/Toasts.js";
import { WorkspacePanel, type PanelGroup } from "./views/WorkspacePanel.js";

interface Props {
  /** Read once in `main.tsx`, before the tree mounts. */
  initialToken: string;
}

export function App({ initialToken }: Props) {
  const [token, setToken] = useState(initialToken);
  /** Set when the server answered 401, so the gate can say "this one was
   *  refused" instead of the generic "we have no credential". */
  const [rejected, setRejected] = useState(false);
  /** 设置 opens over the task surface and holds which pane it last showed, so
   *  reopening lands where the user left off. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsGroup, setSettingsGroup] = useState<SettingsGroup>("general");
  /** The task sidebar folds away; the conversation's does too when the panel
   *  needs the room. */
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [workspaceOpen, setWorkspaceOpen] = useState(() =>
    readStoredFlag(localStorage, RIGHT_PANEL_STORAGE_KEY),
  );
  /** Which of the panel's three groups is showing. Opening an artifact or a
   *  file from elsewhere in the app lands on the group that lists it. */
  const [panelGroup, setPanelGroup] = useState<PanelGroup>("files");

  // The language lives in a module store rather than in state, because
  // `TEXT` is read from components the tree passes no props to. Reading it
  // here is what turns a switch in 设置 › 通用 into a re-render of the whole
  // app; `TEXT` itself then resolves against the new dictionary.
  const language = useLanguage();
  useEffect(applyDocumentLanguage, [language]);

  const onAuthRejected = useCallback(() => {
    setRejected(true);
    setToken("");
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // A credential we could not clear is still one we do not use.
    }
  }, []);

  // The client is rebuilt with the token, because every request carries it. A
  // token change is rare enough that re-creating it is cheaper than threading
  // a mutable header through every call site.
  const client = useMemo(() => new ApiClient(token, onAuthRejected), [onAuthRejected, token]);
  const { actions, boot, state } = useWorkspace(client, onAuthRejected);
  const resize = usePanelWidth();

  useEffect(() => {
    writeStoredFlag(localStorage, RIGHT_PANEL_STORAGE_KEY, workspaceOpen);
  }, [workspaceOpen]);

  /**
   * Upload, then show where the file went.
   *
   * The files land in the workspace tree, which lives on the panel's home tab
   * — and the panel starts collapsed and stays that way until asked for. An
   * upload that produced only a toast would leave the user with exactly the
   * question this answers: where is it now. Only a file that actually landed
   * moves the panel; a refusal already says so, and rearranging the screen
   * around a failure would be motion about nothing.
   */
  const upload = useCallback(
    async (files: File[]) => {
      if (!(await actions.uploadFiles(files))) return;
      setPanelGroup("files");
      setWorkspaceOpen(true);
    },
    [actions],
  );

  // Uploading needs a session, and opens one if there is none — so the only
  // thing it cannot survive is an archived session, which the server refuses
  // to write into. The listeners are installed regardless of that: a file
  // dropped on a page that ignores it would otherwise navigate away from the
  // app entirely.
  const canUpload = boot === "ready" && state.detail?.archivedAt === undefined;
  const dragging = useFileDrop((files) => void upload(files), canUpload);

  const acceptToken = (next: string) => {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, next);
    } catch {
      // Session-only credential; the app still works until the tab closes.
    }
    setRejected(false);
    setToken(next);
    actions.retryBoot();
  };

  // No token is its own screen, ahead of the boot states: without one nothing
  // the app can say about the server is knowable, including whether it is up.
  if (token === "") {
    return (
      <>
        <AuthScreen onSubmit={acceptToken} rejected={rejected} />
        <Toasts onDismiss={actions.dismissToast} toasts={state.toasts} />
      </>
    );
  }

  if (boot === "loading") {
    return (
      <div className="boot-page">
        <div className="boot-card">
          <div className="boot-mark" aria-hidden="true">
            ⬡
          </div>
          <h1 className="boot-title">{TEXT.appName}</h1>
          <p className="boot-body">{TEXT.boot.checking}</p>
        </div>
      </div>
    );
  }

  if (boot === "offline") {
    return <OfflineScreen onRetry={actions.retryBoot} reason="unreachable" />;
  }

  // The wizard replaces the shell rather than sitting over it: with no model
  // there is no session to send from, so there is nothing behind it to see.
  if (boot === "setup") {
    return (
      <>
        <SetupWizard
          client={client}
          onConfigured={() => actions.finishSetup()}
          onProvidersChanged={actions.refreshCatalog}
          presets={state.presets}
          providers={state.providers}
        />
        <Toasts onDismiss={actions.dismissToast} toasts={state.toasts} />
      </>
    );
  }

  const panelOpen = workspaceOpen;

  /** The ceiling as a phrase, for the two places that state it: the attach
   *  button's tooltip and the drop overlay. `undefined` means the service never
   *  said, and then no number is shown rather than a guessed one. */
  const limit = state.uploadLimit;
  const attachLimit = limit === undefined
    ? undefined
    : formatByteLimit(limit) ?? TEXT.upload.unlimited;

  // The panel has no collapsed state of its own: closing its last tab lands
  // here, and so does the toolbar's panel toggle.
  const collapsePanel = () => {
    setWorkspaceOpen(false);
  };

  // The column width is published as a custom property rather than written into
  // the grid here, because two things have to agree on it: the shell's third
  // track, and the panel that fills it. `--panel-width` inherits, so setting it
  // once on the shell reaches both, and neither has to be told twice.
  const shellStyle = { "--panel-width": `${resize.width}px` } as CSSProperties;

  const openSettings = (group: SettingsGroup) => {
    setSettingsGroup(group);
    setSettingsOpen(true);
  };

  // The panel takes the sidebar's place rather than sharing the window with
  // it: the handoff's open-panel frames show the conversation wider by exactly
  // the 296px the task column gives back.
  const taskSidebar = sidebarOpen && !panelOpen;
  const showExpand = !taskSidebar;
  const expandSidebar = () => {
    // The task surface gives the column to the right panel; asking for the
    // sidebar back is also asking for the panel to step aside.
    if (workspaceOpen) collapsePanel();
    setSidebarOpen(true);
  };

  const shellClass = [
    "app-shell",
    "page-task",
    taskSidebar ? "" : "sidebar-hidden",
    panelOpen ? "panel-open" : "workspace-hidden",
  ].filter(Boolean).join(" ");

  return (
    <>
      <div className={shellClass} style={shellStyle}>
        <Rail
          onOpenSettings={() => openSettings(settingsGroup)}
          onSelectTask={() => setSettingsOpen(false)}
          settingsOpen={settingsOpen}
        />

        {taskSidebar ? (
          <Sidebar
            actions={actions}
            activeSessionId={state.sessionId}
            onToggleSidebar={() => setSidebarOpen(false)}
            projectName={state.activeProjectName ?? TEXT.project.defaultName}
            recent={state.recent}
            running={state.running}
            taskTitle={state.detail ? sessionTitle(state.detail.title) : undefined}
          />
        ) : null}

        <main className="main-area">
          <SessionBar
            actions={actions}
            detail={state.detail}
            onExpandSidebar={expandSidebar}
            onToggleWorkspace={() => setWorkspaceOpen(true)}
            projectName={state.activeProjectName}
            sidebarCollapsed={showExpand}
            workspaceOpen={workspaceOpen}
          />
          <Conversation
            client={client}
            detail={state.detail}
            loading={state.loadingSession}
            onDecidePermission={(request, decision) => actions.decidePermission(request.id, decision)}
            pending={state.pendingMessage}
            replays={state.replays}
            run={state.run}
          />
          <Composer
            approvalMode={state.detail?.approvalMode}
            attachBlocked={canUpload ? undefined : TEXT.composer.attachArchived}
            attachLimit={attachLimit}
            models={state.models}
            onApprovalMode={(mode) => void actions.setApprovalMode(mode)}
            onOpenSettings={() => openSettings("models")}
            onOpenSpecialists={() => openSettings("specialists")}
            onSelectModel={(modelId) => void actions.selectModel(modelId)}
            onSend={(content) => void actions.send(content)}
            onStop={() => void actions.stop()}
            onUpload={(files) => void upload(files)}
            running={state.running}
            selectedModelId={state.selectedModelId}
            uploading={state.uploading}
          />
        </main>

        <WorkspacePanel
          actions={actions}
          activeGroup={panelGroup}
          files={state.panelFiles}
          onCollapse={collapsePanel}
          onSelectGroup={setPanelGroup}
          outputs={state.outputs}
          resize={resize}
          tabs={state.tabs}
        />
      </div>

      {settingsOpen ? (
        <SystemSettingsDialog
          actions={actions}
          client={client}
          group={settingsGroup}
          onClose={() => setSettingsOpen(false)}
          onGroupChange={setSettingsGroup}
          state={state}
        />
      ) : null}

      {/* The whole window is the drop target, so the whole window is what has
          to say so. It is drawn only while a file is actually over the app,
          and it repeats the reason when there is no session — a drop that does
          nothing is the one outcome the user cannot diagnose. */}
      {dragging ? (
        <div className="drop-overlay">
          <div className={`drop-card${canUpload ? "" : " is-blocked"}`}>
            <span className="drop-mark" aria-hidden="true">{canUpload ? "⬇" : "⊘"}</span>
            <strong className="drop-title">
              {canUpload ? TEXT.upload.dropTitle : TEXT.upload.archived}
            </strong>
            {canUpload ? <span className="drop-body">{TEXT.upload.dropBody(attachLimit)}</span> : null}
          </div>
        </div>
      ) : null}

      <Toasts onDismiss={actions.dismissToast} toasts={state.toasts} />

      {state.confirm ? (
        <ConfirmDialog onDismiss={actions.dismissConfirm} request={state.confirm} />
      ) : null}
    </>
  );
}
