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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";

import { ApiClient } from "./api/client.js";
import { listSubagents } from "./api/sessions.js";
import type { Subagent } from "./api/types.js";
import type { GuideStep } from "./app/guide.js";
import { isEmptyTranscript, landingKey } from "./app/landing.js";
import { useJiuwenReadiness, jwReadyFromBridge, wizardIntroHandled } from "./app/shell-bridge.js";
import type { ToolDetail } from "./app/tool-io.js";
import { useFileDrop } from "./app/use-file-drop.js";
import { useLanguage } from "./app/use-language.js";
import { usePanelWidth } from "./app/use-panel-width.js";
import { useWorkspace } from "./app/use-workspace.js";
import { formatByteLimit } from "./app/upload.js";
import { allSubagents } from "./run-stream/model.js";
import {
  GUIDE_STORAGE_KEY,
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
import { Guide } from "./views/Guide.js";
import { Landing } from "./views/Landing.js";
import { OfflineScreen } from "./views/OfflineScreen.js";
import { Rail } from "./views/Rail.js";
import { SessionBar } from "./views/SessionBar.js";
import { SetupWizard } from "./views/SetupWizard.js";
import {
  SystemSettingsDialog,
  type SettingsGroup,
} from "./views/SystemSettingsDialog.js";
import { Sidebar } from "./views/Sidebar.js";
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
  /** Which of the panel's groups is showing. Opening an artifact or a file from
   *  elsewhere in the app lands on the group that lists it; a panel that is
   *  simply being opened lands on 产物, which is what a run produces. */
  const [panelGroup, setPanelGroup] = useState<PanelGroup>("artifacts");
  /** The subagent whose execution the panel is showing, if any. It is a
   *  mode of the panel rather than a fourth tab: the transcript's line opens
   *  it, and the panel's own back arrow closes it. */
  const [openSubagentId, setOpenSubagentId] = useState<string | undefined>();
  /** One input or result block of a tool call, shown in the panel. Like the
   *  subagent, it is a mode of the panel rather than a tab, and the two are
   *  mutually exclusive: one panel can only show one record. */
  const [openTool, setOpenTool] = useState<ToolDetail | undefined>();

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

  // The shell (when present) pushes JiuwenSwarm cluster readiness.
  // "shell present, no verdict yet" is NOT ready — the composer stays gated
  // with an explanatory banner until the cluster actually reports reachable
  // (a `?? true` default here would let messages hit semantic-errors while
  // the cluster is still booting). Browser dev (no shell) is never gated.
  const { hasShell: jwHasShell, state: jiuwenState } = useJiuwenReadiness();
  const jwReady = jwReadyFromBridge(jwHasShell, jiuwenState);

  useEffect(() => {
    writeStoredFlag(localStorage, RIGHT_PANEL_STORAGE_KEY, workspaceOpen);
  }, [workspaceOpen]);

  /** The first-run guide: three cards over the composer, 设置 and the panel. */
  const [guideOpen, setGuideOpen] = useState(false);
  /** Whether the guide has been dealt with — shown, dismissed, or never shown
   *  because it had been read. A ref, not state: it only decides whether the
   *  timer below may still fire, and a state change would re-run the effect
   *  that started it.
   *
   *  It also covers storage that refuses to keep the flag: without it, a
   *  dismissed guide would reopen on the next render forever. */
  const guideHandled = useRef(false);
  /** The panel as the user left it. The guide opens the panel for its last card
   *  and 结束 puts back what was there, so reading three cards does not
   *  rearrange the window. */
  const panelBeforeGuide = useRef(false);
  /** What the page was on the last render. The guide is opened from a timer and
   *  from a settings button, neither of which may close over the page as it was
   *  when the handler was built. */
  const pageRef = useRef({ landing: false, running: false });
  const workspaceOpenRef = useRef(workspaceOpen);
  useEffect(() => {
    workspaceOpenRef.current = workspaceOpen;
  }, [workspaceOpen]);

  const openGuide = useCallback(() => {
    panelBeforeGuide.current = workspaceOpenRef.current;
    // The welcome page is where a conversation starts, so that is the page the
    // first card describes. Switched here, before the cards are drawn, so the
    // card is placed against the composer it is about rather than jumping to
    // it once the page changes underneath. Nothing is written: a draft is what
    // the app shows before the first message, and it is where the reader is
    // left — the tour is for someone who has not started yet.
    const page = pageRef.current;
    if (!page.landing && !page.running) actions.startDraft();
    setGuideOpen(true);
  }, [actions]);

  // Shown on the first arrival at the task page, which is also the first
  // moment it is true: `setup` replaces the shell with the wizard, and the
  // cards describe a page that is not there yet. The pause is for the paint —
  // a card that lands before the page has drawn measures nothing.
  useEffect(() => {
    if (boot !== "ready" || guideHandled.current) return;
    if (readStoredFlag(localStorage, GUIDE_STORAGE_KEY)) {
      guideHandled.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      guideHandled.current = true;
      openGuide();
    }, 400);
    return () => window.clearTimeout(timer);
  }, [boot, openGuide]);

  const closeGuide = useCallback(() => {
    setGuideOpen(false);
    // Written on every exit, including a skip: the guide has had its one
    // chance, and 设置 › 通用 › 重新查看 is the way back.
    writeStoredFlag(localStorage, GUIDE_STORAGE_KEY, true);
    setWorkspaceOpen(panelBeforeGuide.current);
  }, []);

  /** 右侧栏 is a card about something that may be closed, so the guide opens
   *  it; the other two put the panel back the way the user had it. */
  const guideStep = useCallback((step: GuideStep) => {
    setWorkspaceOpen(step.key === "panel" ? true : panelBeforeGuide.current);
  }, []);

  /** A subagent may be in the live run or in any replayed one; both are the
   *  same view of the session, so the lookup spans both. */
  const foundSubagent = useMemo(() => {
    if (openSubagentId === undefined) return undefined;
    const candidates = [
      ...allSubagents(state.run),
      ...state.replays.flatMap((replay) => allSubagents(replay.state)),
    ];
    return candidates.find((subagent) => subagent.id === openSubagentId);
  }, [openSubagentId, state.replays, state.run]);
  // A settled run moves from `run` to `replays` in the same tick it is
  // refreshed, and a lookup that failed for that one render would blank the
  // panel the user is reading. Keeping the last resolved copy bridges it.
  const lastSubagent = useRef<Subagent | undefined>(undefined);
  useEffect(() => {
    if (foundSubagent !== undefined) lastSubagent.current = foundSubagent;
  }, [foundSubagent]);

  /** The run's event log stores subagent snapshots without their steps, so a
   *  replayed child arrives empty. The catalog has them, and is re-read when
   *  the open child reaches a terminal status so the last steps are complete. */
  const [subagentCatalog, setSubagentCatalog] = useState<Subagent[]>([]);
  const [subagentLoading, setSubagentLoading] = useState(false);
  useEffect(() => {
    if (openSubagentId === undefined || state.sessionId === undefined) {
      setSubagentCatalog([]);
      setSubagentLoading(false);
      return;
    }
    let cancelled = false;
    setSubagentLoading(true);
    void listSubagents(client, state.sessionId)
      .then((children) => {
        if (!cancelled) setSubagentCatalog(children);
      })
      .catch(() => {
        // The run-state copy still names the task and shows its status; only
        // the steps are missing, so this is not worth an error banner.
        if (!cancelled) setSubagentCatalog([]);
      })
      .finally(() => {
        if (!cancelled) setSubagentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, foundSubagent?.status, openSubagentId, state.sessionId]);

  const catalogSubagent = openSubagentId === undefined
    ? undefined
    : subagentCatalog.find((subagent) => subagent.id === openSubagentId);
  const resolvedSubagent = foundSubagent
    ?? catalogSubagent
    ?? (lastSubagent.current?.id === openSubagentId ? lastSubagent.current : undefined);
  // Live snapshots are fresher and already carry steps. A replay's copy is the
  // terminal state but says nothing about what the child did, so its steps come
  // from the catalog.
  const openSubagent = resolvedSubagent === undefined
    ? undefined
    : resolvedSubagent.steps.length === 0 && catalogSubagent !== undefined
      ? { ...resolvedSubagent, steps: catalogSubagent.steps }
      : resolvedSubagent;

  // A selection belongs to one session's transcript. Carrying it into another
  // would open a panel on a subagent the reader cannot see.
  useEffect(() => {
    setOpenSubagentId(undefined);
    setOpenTool(undefined);
    lastSubagent.current = undefined;
    setSubagentCatalog([]);
  }, [state.sessionId]);

  // The line that opens a child is also the way out: pressing the open line
  // again returns the panel to its groups. The panel has no back arrow of its
  // own, so the toggle is the only way back.
  const openSubagentDetails = useCallback((id: string) => {
    setOpenSubagentId((current) => (current === id ? undefined : id));
    setOpenTool(undefined);
    setWorkspaceOpen(true);
  }, []);

  /**
   * The same gesture for a tool's input or result: the block opens it, and a
   * second press on the same block closes it. Pressing another block swaps the
   * panel's content, because the panel is where the reader is already looking.
   */
  const openToolDetails = useCallback((detail: ToolDetail) => {
    setOpenTool((current) =>
      current !== undefined && current.toolId === detail.toolId && current.id === detail.id
        ? undefined
        : detail);
    setOpenSubagentId(undefined);
    setWorkspaceOpen(true);
  }, []);

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

  /** A session with nothing to read yet shows the welcome page instead of an
   *  empty transcript: the composer sits centred with the wordmark, rather
   *  than pinned to the bottom of a page with nothing above it. A run that is
   *  still going keeps the transcript, even before its first event lands. */
  const landing = !state.loadingSession && !state.running && isEmptyTranscript(state);

  useEffect(() => {
    pageRef.current = { landing, running: state.running };
  }, [landing, state.running]);

  // The tour is a tour of the page a new conversation starts on, so while it is
  // on screen the page stays there. Switching once when the guide opens is not
  // enough: the Session the boot listing resumes can finish opening after the
  // cards are already up. A run in progress is left alone — it is not a page
  // the tour may discard, and the composer card is true of it as it stands. The
  // overlay takes the clicks, so nothing else can move the page in between.
  useEffect(() => {
    if (!guideOpen || landing || state.running) return;
    actions.startDraft();
  }, [actions, guideOpen, landing, state.running]);

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
          initialStep={wizardIntroHandled() ? "model" : "workspace"}
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
  //
  // A mode (a subagent's record, a tool block) belongs to the panel being
  // open. Leaving it set would mean the next time the panel appears it shows
  // the record that happened to be up when it was closed, and that the
  // transcript's line for that record would then toggle it *off* instead of
  // opening it — the reader closed the panel, not the record, and asking for
  // the panel back asks for its groups.
  const collapsePanel = () => {
    setWorkspaceOpen(false);
    setOpenSubagentId(undefined);
    setOpenTool(undefined);
    // The group belongs to the panel being open in the same way: a panel the
    // reader asked for again opens on 产物, not on the file tree they happened
    // to be browsing when they closed it.
    setPanelGroup("artifacts");
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

  /** The composer is one component in two places — under the transcript, and
   *  in the middle of the welcome page — so its props are assembled once. */
  const composerProps: Omit<ComponentProps<typeof Composer>, "landing" | "seed" | "tag"> = {
    activeProjectId: state.activeProjectId,
    approvalMode: state.detail?.approvalMode,
    attachBlocked: canUpload ? undefined : TEXT.composer.attachArchived,
    attachLimit,
    attachments: state.attachments,
    client,
    jwBlocked: jwReady ? undefined : TEXT.composer.jwBlocked,
    models: state.models,
    onApprovalMode: (mode) => void actions.setApprovalMode(mode),
    onClearAttachments: actions.clearAttachments,
    onCreateProject: (name) => void actions.createProject(name),
    onOpenSettings: () => openSettings("models"),
    onRemoveAttachment: actions.removeAttachment,
    onRetryAttachment: actions.retryAttachment,
    onSelectModel: (modelId) => void actions.selectModel(modelId),
    onSelectProject: (projectId) => actions.selectProject(projectId),
    onSelectSpecialist: (specialistId) => void actions.selectSpecialist(specialistId),
    onSend: (content) => void actions.send(content),
    onStop: () => void actions.stop(),
    onUpload: (files) => void upload(files),
    // No name when the next conversation goes into no Project: the strip then
    // shows its invitation to choose one, which is what the inbox means from
    // the welcome page — 最近会话 is the column's word for the result, not a
    // place the user would pick.
    projectName: state.activeProject?.kind === "inbox" ? undefined : state.activeProjectName,
    projects: state.projects,
    providers: state.providers,
    running: state.running,
    selectedModelId: state.selectedModelId,
    selectedSpecialistId: state.detail?.specialistId,
    uploading: state.uploading,
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
            activeProjectId={state.activeProjectId}
            activeSessionId={state.sessionId}
            onToggleSidebar={() => setSidebarOpen(false)}
            projects={state.projects}
            recent={state.recent}
            running={state.running}
            sessionsByProject={state.sessionsByProject}
          />
        ) : null}

        <main className="main-area">
          <SessionBar
            actions={actions}
            detail={state.detail}
            onExpandSidebar={expandSidebar}
            onToggleWorkspace={() => setWorkspaceOpen(true)}
            // A Session outside every Project is not "in 最近会话": that is
            // the column's name for the list, not a place to print beside the
            // title, so the bar carries no Project at all for one.
            projectName={state.activeProject?.kind === "inbox" ? undefined : state.activeProjectName}
            sidebarCollapsed={showExpand}
            workspaceOpen={workspaceOpen}
          />
          {landing ? (
            /* The page's category and its open topic row belong to one
               session; the key is what ends them when the session does. */
            <Landing composer={composerProps} key={landingKey(state)} />
          ) : (
            <>
              <Conversation
                client={client}
                detail={state.detail}
                loading={state.loadingSession}
                onDecidePermission={(request, decision) => actions.decidePermission(request.id, decision)}
                onOpenSubagent={openSubagentDetails}
                onOpenTool={openToolDetails}
                pending={state.pendingMessage}
                replays={state.replays}
                run={state.run}
                workspaceFiles={state.panelFiles}
              />
              <Composer {...composerProps} />
            </>
          )}
        </main>

        <WorkspacePanel
          actions={actions}
          activeGroup={panelGroup}
          files={state.panelFiles}
          onCollapse={collapsePanel}
          onSelectGroup={setPanelGroup}
          outputs={state.outputs}
          resize={resize}
          sessionId={state.sessionId}
          sessions={state.recent}
          subagent={openSubagent}
          subagentLoading={subagentLoading && (openSubagent?.steps.length ?? 0) === 0}
          tabs={state.tabs}
          tool={openTool}
        />
      </div>

      {settingsOpen ? (
        <SystemSettingsDialog
          actions={actions}
          client={client}
          group={settingsGroup}
          onClose={() => setSettingsOpen(false)}
          onGroupChange={setSettingsGroup}
          // 设置 is where a user looks when the interface is what they cannot
          // find, so the guide's one replay lives there. The dialog has to go
          // first: the cards point at the page behind it.
          onShowGuide={() => {
            setSettingsOpen(false);
            openGuide();
          }}
          state={state}
        />
      ) : null}

      {guideOpen ? <Guide onClose={closeGuide} onStep={guideStep} /> : null}

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

      {/* Rendered whenever chat is gated — including the "shell
          present but no verdict yet" case, so a disabled composer is always
          explained. Right-bottom overlay, out of the layout's way. */}
      {!jwReady ? (
        <div className="jw-banner" role="status">
          <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
          <div className="jw-banner-body">
            <strong>{TEXT.jiuwen.starting}</strong>
            <span>
              {jiuwenState?.message ?? TEXT.jiuwen.preparing}
              {jiuwenState?.elapsed !== undefined ? ` (${jiuwenState.elapsed}s)` : ""}
            </span>
          </div>
        </div>
      ) : null}

      {state.confirm ? (
        <ConfirmDialog onDismiss={actions.dismissConfirm} request={state.confirm} />
      ) : null}
    </>
  );
}
