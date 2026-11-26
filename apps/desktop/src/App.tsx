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
import { appendEvolveDirection, isEvidenceSessionReadOnly, isEvolveRunActive, type EvolveAlgorithm, type EvolveDirectionInput } from "@sciencediscovery/schema";

import { ApiClient } from "./api/client.js";
import { TOKEN_STORAGE_KEY } from "./state/storage.js";
import { AccountApiError, accountsConfigured, revokeAccountSession } from "./auth/account.js";
import { CREDITS_PROVIDER_NAME, ensureCreditsModel } from "./auth/credits-model.js";
import { requiresLocalToken } from "./auth/gate.js";
import { clearSession, readSession, saveSession, sessionRefreshDelayMs, type UserSession } from "./auth/session.js";
import { ensureFreshAccountSession } from "./auth/session-refresh.js";
import { LoginPage, hasAuthCallback, settleAuthCallback } from "./views/LoginPage.js";
import { AccountPage, SignedOutAccount } from "./views/AccountPage.js";
import { cancelRun, getSubagent } from "./api/sessions.js";
import type {
  ComposerReference,
  PermissionDecision,
  PermissionRequest,
  SessionArtifactOutput,
  Subagent,
  SubagentStep,
} from "./api/types.js";
import { CATALOG_FAILURES_BEFORE_STALE, createCatalogPoll } from "./app/catalog-poll.js";
import { resumeGitSkillImport } from "./app/git-skill-import-job.js";
import type { GuideStep } from "./app/guide.js";
import { isEmptyTranscript, landingKey } from "./app/landing.js";
import { canExportSession } from "./app/session-export.js";
import { useIdeaResearches } from "./app/use-idea-researches.js";
import { useJiuwenReadiness, jwReadyFromBridge, wizardIntroHandled } from "./app/shell-bridge.js";
import type { ToolDetail } from "./app/tool-io.js";
import { followSubagent } from "./app/follow-subagent.js";
import { useFileDrop } from "./app/use-file-drop.js";
import { useLanguage } from "./app/use-language.js";
import { usePanelWidth } from "./app/use-panel-width.js";
import { useWorkspace } from "./app/use-workspace.js";
import { useConfigurationRequests } from "./app/use-configuration-requests.js";
import { formatByteLimit } from "./app/upload.js";
import {
  composeEvolveMessage,
  designHasSearch,
  evolveCommandAlgorithm,
  evolveCommandCheckpointMode,
  evolveCommandGoal,
  evolveDraftTask,
  isEvolveSkill,
  latestEvolveCheckpointMode,
  splitEvolveCommand,
} from "./evolve/command.js";
import { designAnchor, useAutoContinue } from "./evolve/use-auto-continue.js";
import { composeIdeaMessage, IDEA_TREE_TEAM_COMMAND, ideaCommandOf, ideaTaskOf, isIdeaTreeCommand } from "./idea/command.js";
import { stepAwaitingIdea } from "./idea/awaiting.js";
import { taskTabKept } from "./idea/task-tab.js";
import { useEvolve } from "./evolve/use-evolve.js";
import { allSubagents } from "./run-stream/model.js";
import { mergedSubagentSteps } from "./run-stream/subagent.js";
import {
  GUIDE_STORAGE_KEY,
  RIGHT_PANEL_STORAGE_KEY,
  SIDEBAR_STORAGE_KEY,
  readStoredFlag,
  readStoredFlagOnByDefault,
  writeStoredFlag,
} from "./state/storage.js";
import { applyDocumentLanguage, TEXT } from "./text.js";
import { inheritedApprovalMode, rememberApprovalMode } from "./app/approval-mode-preference.js";
import { FeedbackDialog } from "./feedback/FeedbackDialog.js";
import { ArtifactDialog } from "./views/ArtifactDialog.js";
import { CheckpointRefusedProvider, CheckpointReplyProvider, type CheckpointReply } from "./views/CheckpointCard.js";
import { Composer, type SeededCommand } from "./views/Composer.js";
import { ConfirmDialog } from "./views/ConfirmDialog.js";
import { Conversation } from "./views/Conversation.js";
import { draftEvolveDirection, retryEvolveRun } from "./api/evolve.js";
import { EvolveCreateDialog } from "./views/evolve/EvolveCreateDialog.js";
import { IdeaTreeOverrideDialog } from "./views/idea/IdeaTreeOverrideDialog.js";
import { defersIdeaSend } from "./idea/send-gate.js";
import { EvolveDetail } from "./views/evolve/EvolveDetail.js";
import { EvolveRuns } from "./views/evolve/EvolveRuns.js";
import { Guide } from "./views/Guide.js";
import { Landing } from "./views/Landing.js";
import { MemoryCardDialog } from "./views/MemoryCardDialog.js";
import { OfflineScreen } from "./views/OfflineScreen.js";
import { Rail } from "./views/Rail.js";
import { SessionBar } from "./views/SessionBar.js";
import { IdeaResearchCards } from "./views/idea/IdeaResearchCard.js";
import { IdeaResearchPanel } from "./views/idea/IdeaResearchPanel.js";
import { LegacyIdeaCard, LegacyIdeaTreePanel, useLegacyIdeaTree } from "./views/idea/LegacyIdeaTree.js";
import { ResearchPackage, type PackageRequest } from "./views/ResearchPackage.js";
import { SetupWizard } from "./views/SetupWizard.js";
import {
  SystemSettingsDialog,
  type SettingsGroup,
} from "./views/SystemSettingsDialog.js";
import { Sidebar } from "./views/Sidebar.js";
import { Toasts } from "./views/Toasts.js";
import { WorkspacePanel, type PanelGroup } from "./views/WorkspacePanel.js";
import type { TurnArtifact } from "./app/turn-artifacts.js";

interface Props {
  /** Read once in `main.tsx`, before the tree mounts. */
  initialToken: string;
}

export function App({ initialToken }: Props) {
  const [packageRequest, setPackageRequest] = useState<PackageRequest>();
  const [token, setToken] = useState(initialToken);
  const [accountSession, setAccountSession] = useState<UserSession | undefined>(() => readSession());
  /** The HUAWEI callback is consumed on mount, before `replaceState` strips the
   *  fragment: a workspace that already holds a local token would otherwise
   *  skip the sign-in page and never exchange the ticket. It is released once
   *  an account exists, so a later sign-out stays in the workspace. */
  const [settlingAuth, setSettlingAuth] = useState(() => hasAuthCallback(window.location.hash));
  /** Set when the server answered 401, so the gate can say "this one was
   *  refused" instead of the generic "we have no credential". */
  const [rejected, setRejected] = useState(false);
  /** 设置 opens over the task surface and holds which pane it last showed, so
   *  reopening lands where the user left off. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** A sign-in started from the account panel comes back to it rather than to
   *  the way-in page. The panel's return address carries `?account=1`, which is
   *  read once here: the ticket exchange strips the address back to the page. */
  const returnToAccount = useRef(new URLSearchParams(window.location.search).has("account"));
  /** Opens on the panel for that return, so the workspace behind it is never
   *  replaced by the sign-in page while the ticket is being exchanged. */
  const [accountOpen, setAccountOpen] = useState(() => returnToAccount.current);
  const [settingsGroup, setSettingsGroup] = useState<SettingsGroup>("general");
  /** Bumped when 设置 closes after showing 技能. The composer's `/` palette reads
   *  the skill catalog once, so a skill installed or edited behind that surface
   *  would otherwise stay missing from — or stale in — the palette until the
   *  window reloads. Another page's close does not re-read it. */
  const [skillsEpoch, setSkillsEpoch] = useState(0);
  const skillsVisited = useRef(false);
  /** The citation whose memory card is open. It is a dialog over whichever
   *  document cites it, not a surface: closing it leaves the reader exactly
   *  where the chip was pressed. */
  const [memoryReference, setMemoryReference] = useState<{
    reference: ComposerReference;
    sessionId?: string;
  } | undefined>();
  /** The artifact whose preview dialog is open. An artifact citation opens the
   *  document itself in the middle of the window, as the old web UI did, so
   *  the reader never leaves the report they were reading. */
  const [artifactReference, setArtifactReference] = useState<{
    reference: ComposerReference;
    sessionId?: string;
  } | undefined>();
  /** The artifact a 上游文件 link in the open dialog put in the panel. While the
   *  panel is still showing it, the dialog moves out of the panel's way instead
   *  of covering it. It clears when the dialog closes: the link is a reading aid
   *  for the document on screen, not a lasting mode of the panel. */
  const [linkedArtifactId, setLinkedArtifactId] = useState<string | undefined>();
  /** The task sidebar folds away; the conversation's does too when the panel
   *  needs the room. */
  // The permission mode new conversations inherit: the reader's last choice, stored so
  // it survives a restart, and never applied to a session that already exists (#1204).
  const [lastApprovalMode, setLastApprovalMode] = useState(inheritedApprovalMode());
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    readStoredFlagOnByDefault(localStorage, SIDEBAR_STORAGE_KEY),
  );
  const [workspaceOpen, setWorkspaceOpen] = useState(() =>
    readStoredFlag(localStorage, RIGHT_PANEL_STORAGE_KEY),
  );
  /** Which of the panel's groups is showing. Opening an artifact or a file from
   *  elsewhere in the app lands on the group that lists it; a panel that is
   *  simply being opened lands on 产物, which is what a run produces. */
  const [panelGroup, setPanelGroup] = useState<PanelGroup>("artifacts");
  /** Latest values for the turn strip's stable callback — see
   *  `previewTurnArtifact`. Assigned during render, the way `use-workspace`
   *  keeps its own `tabsRef`. */
  const openArtifactInPanelRef = useRef<(output: SessionArtifactOutput) => void>(() => {});
  const outputsRef = useRef<readonly SessionArtifactOutput[]>([]);
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
  // The latest account, read by callbacks that must not change identity when
  // the account page updates the record (a new callback would restart its load).
  const accountSessionRef = useRef(accountSession);
  accountSessionRef.current = accountSession;
  // The page reads the account back after every change, so the record it hands
  // over is written through to storage as well: a rename must survive a reload.
  const updateAccountSession = useCallback((next: UserSession) => {
    setAccountSession(next);
    saveSession(next);
  }, []);

  // The client is rebuilt with the token, because every request carries it. A
  // token change is rare enough that re-creating it is cheaper than threading
  // a mutable header through every call site.
  const client = useMemo(() => new ApiClient(token, onAuthRejected), [onAuthRejected, token]);
  const { actions, boot, state } = useWorkspace(client, onAuthRejected);
  // A Git Skill import keeps running in the API across a reload, but switching
  // its new packages on is the client's work. Pick the job back up once the
  // backend has answered, before the reader opens 设置 again; an extra request
  // during the auth checks could turn a stale id into a 401 for the whole app.
  useEffect(() => {
    if (boot !== "ready" && boot !== "setup") return;
    void resumeGitSkillImport(client);
  }, [boot, client]);
  // Signing out drops the account, not the machine's credential: a workspace
  // running on a custom model keeps working, and the user surface turns into a
  // signed-out page with the one way back in. It is a decision with a visible
  // cost — the credit model stops answering until the next sign-in — so the
  // button asks before it acts.
  const signOut = useCallback(() => {
    actions.confirmAction({
      accept: TEXT.account.signOut,
      body: TEXT.account.signOutBody,
      eyebrow: "",
      onAccept: () => {
        const current = accountSessionRef.current;
        if (current) void revokeAccountSession(current.accessToken).catch(() => undefined);
        clearSession();
        setAccountSession(undefined);
        setAccountOpen(true);
      },
      title: TEXT.account.signOutTitle,
      warning: true,
    });
  }, [actions]);
  const creditsModelToken = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!accountSession || boot !== "ready") return;
    // A build with no account-service base cannot reach the credits gateway:
    // `ensureCreditsModel` would fetch `/v1/models` from the local API and get
    // the SPA's index.html. Skip it instead of failing invisibly.
    if (!accountsConfigured()) return;
    if (creditsModelToken.current === accountSession.accessToken) return;
    creditsModelToken.current = accountSession.accessToken;
    void ensureCreditsModel(client, accountSession)
      .then((models) => {
        if (models) void actions.refreshCatalog();
      })
      .catch(() => undefined);
  }, [accountSession, actions, boot, client]);
  // The account session is what the composer's balance and the sidebar's user
  // card read. The local service token alone is not an account: it is only the
  // credential that lets the shell reach this machine.
  useEffect(() => {
    if (!accountSession) return;
    let cancelled = false;
    let timerId: number | undefined;
    const schedule = (delay: number) => {
      if (cancelled) return;
      timerId = window.setTimeout(() => {
        void ensureFreshAccountSession(accountSession).then((next) => {
          if (!cancelled && next && next.accessToken !== accountSession.accessToken) setAccountSession(next);
        }).catch((error: unknown) => {
          if (!cancelled && error instanceof AccountApiError && error.denied) {
            clearSession();
            setAccountSession(undefined);
            setToken("");
          }
        }).finally(() => {
          schedule(Math.max(sessionRefreshDelayMs(accountSession), 30_000));
        });
      }, delay);
    };
    schedule(sessionRefreshDelayMs(accountSession));
    return () => {
      cancelled = true;
      if (timerId !== undefined) window.clearTimeout(timerId);
    };
  }, [accountSession]);
  const resize = usePanelWidth();

  /** The runtime and the open Session's searches. The transcript's run cards
   *  read `runs` directly, which is why the hook exists at this level rather
   *  than inside the panel: the searches must stay reachable while the panel is
   *  closed. */
  const evolve = useEvolve(client, state.sessionId);
  /** The session's Idea Tree researches. Read at this level for the same reason
   *  as the searches: a card stays reachable while the task panel is closed. */
  const idea = useIdeaResearches(client, state.sessionId);
  /** Sessions written before the research API still carry a legacy tree; it is
   *  only asked for when the session has no research to describe it. */
  const legacy = useLegacyIdeaTree(client, state.sessionId, idea.views.length === 0 && !idea.unavailable);
  /** Which research the task panel shows, by id. */
  const [ideaResearchId, setIdeaResearchId] = useState<string>();
  /** True from the moment `/idea-tree <task>` is sent until the research it
   *  starts shows up in the list. The command is a message the agent acts on —
   *  it is not intercepted — so the only way to open the panel at the start
   *  rather than at the next unrelated refresh is to know that one is expected. */
  const [awaitingIdea, setAwaitingIdea] = useState(false);
  /** The legacy tree, open in the 任务 tab. It has no research and no stream, so
   *  it is selected separately from `ideaResearchId`. */
  const [legacyOpen, setLegacyOpen] = useState(false);
  const refreshEvolve = evolve.refresh;
  /** Which search the panel is showing, by id. Storing the id rather than the
   *  record keeps the panel reading the same list the run cards do, so a status
   *  that moves while the panel is open changes both at once. */
  const [evolveRunId, setEvolveRunId] = useState<string>();
  /** Set the moment a design command leaves the composer, and cleared when the
   *  new run opens or the reader moves on. Only a run this window started opens
   *  任务 by itself: a reload or a session switch leaves the panel where it was,
   *  because the search is not news to the person who just came back to it. */
  const [awaitingRun, setAwaitingRun] = useState(false);
  /** The ids the list already held, so "new" means new and not merely "the
   *  first list a slow poll happened to return". */
  const seenRunIds = useRef<Set<string>>(new Set());
  /** The same for the session's researches, kept apart from the runs: an Idea
   *  Tree research is created by the agent, so it can only be recognised after
   *  the fact. `awaitingIdeaFrom` records how many list reads had finished when
   *  the command left, which is what makes the first read after it a baseline
   *  rather than news — a read that started earlier can still land later. */
  const awaitingIdeaFrom = useRef<{ loads: number; baseline?: ReadonlySet<string> } | undefined>(undefined);
  /** The instant the command was sent; a run older than it was already there. */
  const awaitingSince = useRef(0);
  /** The create dialog, open with a typed goal when the command was diverted
   *  here because the runtime is not ready. */
  const [evolveCreate, setEvolveCreate] = useState<{
    algorithm?: EvolveAlgorithm;
    checkpointMode?: "auto" | "confirm";
    goal?: string;
  } | undefined>();
  /** The Idea Tree parameters card. Declared with the other state, above the
   *  early returns, so the hook order never depends on which branch renders. */
  const [ideaTreeOpen, setIdeaTreeOpen] = useState(false);
  /** An Idea Tree command waiting for its parameters; the card is open on it. */
  const [pendingIdeaSend, setPendingIdeaSend] = useState<string>();
  /** The card was opened from 会话设置 instead of from a typed command. Confirming
   *  it starts the research, so the command is one this window sends itself —
   *  there is no draft to send, and cancelling must not seed one. */
  const [ideaTreeStart, setIdeaTreeStart] = useState(false);
  /** The task the composer held when the settings row was pressed. It becomes
   *  the sentence under the token, so a draft the reader already wrote is kept
   *  rather than replaced by an empty box. */
  const [ideaTreeTask, setIdeaTreeTask] = useState("");
  /** The same value for the callbacks a card holds from an earlier render: a
   *  write that resolves after the reader cancelled must not resurrect it. */
  const pendingIdeaSendRef = useRef<string | undefined>(undefined);

  const rememberPendingIdeaSend = (text: string | undefined) => {
    pendingIdeaSendRef.current = text;
    setPendingIdeaSend(text);
  };
  /** A design command the dialog placed in the composer instead of sending.
   *  Held here because the composer has two mounts — the welcome page and the
   *  conversation — and the dialog opens over either. Each seed names the
   *  surface it was collected for (#1434), and is cleared when the composer
   *  sends, when the reader removes the token, and when the session changes: a
   *  token kept across the switch would come back as a search in the session
   *  that collected it the next time the reader returned there. */
  const [seededCommand, setSeededCommand] = useState<SeededCommand>();

  // An open panel belongs to one session's searches, like a selected
  // subagent. The create dialog is deliberately left alone: it starts a run
  // in whichever session is open when it sends, and the session the app is
  // opening as it boots is not a reason to close a dialog the user just opened.
  //
  // The seeded command is not left alone either. The composer ignores a seed
  // another surface owns (#1434), but the seed itself belongs to the session
  // it was collected in: keeping it would put the token back in that session's
  // input on the next visit, where the reader never asked for it again.
  useEffect(() => {
    setEvolveRunId(undefined);
    // A research id is the previous session's, so it goes with the run id.
    setIdeaResearchId(undefined);
    setLegacyOpen(false);
    setAwaitingRun(false);
    setAwaitingIdea(false);
    awaitingIdeaFrom.current = undefined;
    setSeededCommand(undefined);
    setIdeaTreeStart(false);
    seenRunIds.current = new Set();
  }, [state.sessionId]);

  // The list is not polled until a research is live, and the agent creates this
  // one during a run, so the panel would otherwise wait for an unrelated
  // refresh. Looking every few seconds is bounded: a command that never produced
  // a research must not keep the window asking forever.
  useEffect(() => {
    if (!awaitingIdea) return undefined;
    void idea.reload();
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > 5 * 60_000) {
        setAwaitingIdea(false);
        return;
      }
      idea.reload();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [awaitingIdea, idea.reload]);

  // Open a research this window asked for. The first list read that finishes
  // after the command is the state the session was already in — a read that
  // started earlier can still land later — so only an id that appears in a later
  // read is the research the agent just created. A reopened session ends up with
  // no wait at all, and nothing opens by itself.
  useEffect(() => {
    if (!awaitingIdea) return;
    const wait = awaitingIdeaFrom.current;
    if (wait === undefined || idea.loads <= wait.loads) return;
    const step = stepAwaitingIdea(wait.baseline, idea.views.map((view) => view.research.id));
    wait.baseline = step.baseline;
    if (step.fresh === undefined) return;
    setAwaitingIdea(false);
    awaitingIdeaFrom.current = undefined;
    setIdeaResearchId(step.fresh);
    setEvolveRunId(undefined);
    setLegacyOpen(false);
    setPanelGroup("task");
    setWorkspaceOpen(true);
  }, [awaitingIdea, idea.loads, idea.views]);

  // A start is only visible once the list is re-read, and the list poll is
  // idle until something is active. Looking every few seconds until the new
  // run lands is what makes the panel open at the start rather than at the
  // next unrelated refresh.
  useEffect(() => {
    if (!awaitingRun) return;
    void refreshEvolve();
    const timer = window.setInterval(() => void refreshEvolve(), 3_000);
    return () => window.clearInterval(timer);
  }, [awaitingRun, refreshEvolve]);

  // Open a run this window started. Everything the list held before the
  // command is recorded as seen, and a run older than the command does not
  // count even if a slow load delivers it late.
  useEffect(() => {
    const fresh = awaitingRun
      ? evolve.runs.find((run) => {
        if (seenRunIds.current.has(run.id)) return false;
        const created = Date.parse(run.createdAt);
        return Number.isNaN(created) || created >= awaitingSince.current - 2_000;
      })
      : undefined;
    for (const run of evolve.runs) seenRunIds.current.add(run.id);
    if (fresh === undefined) return;
    setAwaitingRun(false);
    setEvolveRunId(fresh.id);
    setPanelGroup("task");
    setWorkspaceOpen(true);
  }, [awaitingRun, evolve.runs]);

  // 任务 is a tab an open panel shows; when the Session's runs go away (a new
  // Session, a deleted run) the tab goes with them, and an empty mode would
  // leave the column with nothing in it. An Idea Tree research is the other
  // thing the tab shows, so a selected one keeps the tab: without it, opening
  // a research's card landed on 产物 and the panel never appeared.
  useEffect(() => {
    if (panelGroup !== "task") return;
    const selected = idea.views.some((view) => view.research.id === ideaResearchId);
    if (taskTabKept(evolve.runs.length, selected)) return;
    setPanelGroup("artifacts");
  }, [evolve.runs.length, idea.views, ideaResearchId, panelGroup]);

  // A search is created by the server while the agent's turn is running, and
  // the list is not polled until one is active. The created event is therefore
  // the one moment the app knows to look now rather than at the next poll.
  useEffect(() => {
    if (state.run.evolveRunsCreated > 0) void refreshEvolve();
  }, [refreshEvolve, state.run.evolveRunsCreated]);

  // The same for a research: the agent starts it partway through the turn, the
  // list is only polled while one is live, and the command's waiting window is
  // shorter than a real model's preparation. The created event is the one
  // moment the app knows to look now, so the card at the transcript's foot
  // appears with the research rather than after an unrelated refresh.
  useEffect(() => {
    if (state.run.ideaResearchesCreated > 0) idea.reload();
  }, [idea.reload, state.run.ideaResearchesCreated]);

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

  // The task column's fold is a preference, not a side effect of the panel
  // taking the column: after a refresh the reader gets back the width they
  // asked for (#1291).
  useEffect(() => {
    writeStoredFlag(localStorage, SIDEBAR_STORAGE_KEY, sidebarOpen);
  }, [sidebarOpen]);

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
   *  the open child reaches a terminal status so the last steps are complete.
   *
   *  Only the open child is read: the panel shows one record at a time, and
   *  the roster route carried every sibling's steps — megabytes for a long
   *  run — to choose one of them. A running child is read on open and then
   *  polled until it settles (see the effect below). The followed stream below
   *  carries the steps emitted while this window is attached, but a child
   *  continued by a wake turn publishes its continuation under the wake run,
   *  not the run that named it, so it is not on the stream this panel tails.
   *  The catalog is where the run loop flushes those steps; skipping it left
   *  the panel without them until the child settled. */
  const [subagentCatalog, setSubagentCatalog] = useState<Subagent | undefined>(undefined);
  const [subagentLoading, setSubagentLoading] = useState(false);
  /** Set when the record has stopped being refreshed — a run of failed polls.
   *  The held copy stands, but the panel says it may be behind. */
  const [subagentStale, setSubagentStale] = useState(false);
  useEffect(() => {
    if (openSubagentId === undefined || state.sessionId === undefined) {
      setSubagentCatalog(undefined);
      setSubagentLoading(false);
      setSubagentStale(false);
      return;
    }
    // While the child runs this is the only source for a continuation the
    // wake run published, and the run loop keeps flushing it, so a read at
    // open would be a still image: poll it until the child settles. Once it
    // settles the effect runs again — `foundSubagent.status` changed — and
    // reads the complete record one last time.
    const polling = foundSubagent?.status === "running";
    let cancelled = false;
    setSubagentLoading(true);
    setSubagentStale(false);
    const read = () => getSubagent(client, state.sessionId!, openSubagentId).then((child) => {
      if (cancelled) return;
      setSubagentCatalog(child);
      setSubagentStale(false);
      setSubagentLoading(false);
    });
    if (!polling) {
      // Terminal record: one read, no cadence. A failure leaves the held copy
      // in place; there is no longer anything to expect it to grow.
      void read().catch(() => {
        if (!cancelled) setSubagentLoading(false);
      });
      return () => {
        cancelled = true;
      };
    }
    // A poll reads the whole record, so it runs only while the window is
    // shown; a hidden window waits for `visibilitychange` and reads once on
    // return. A failed read keeps the copy already held — the run-state copy
    // still names the task and shows its status, so this is not worth an
    // error banner — but failures in a row mean the record is frozen, and
    // after a few the panel says so instead of looking live.
    const poll = createCatalogPoll(read, {
      onFailing: (count) => {
        if (cancelled) return;
        setSubagentLoading(false);
        if (count >= CATALOG_FAILURES_BEFORE_STALE) setSubagentStale(true);
      },
    });
    const onVisibilityChange = () => poll.visibilityChanged();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      poll.stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [client, foundSubagent?.parentTurnId, foundSubagent?.status, openSubagentId, state.sessionId]);

  const catalogSubagent = subagentCatalog?.id === openSubagentId ? subagentCatalog : undefined;
  const resolvedSubagent = foundSubagent
    ?? catalogSubagent
    ?? (lastSubagent.current?.id === openSubagentId ? lastSubagent.current : undefined);

  /** The child's steps, read from its own stream while it is still working.
   *
   * The steps a child records are written to `subagent-<id>`; the run's own
   * timeline keeps only the milestones. The live copy on the run stream reaches
   * whoever is attached at the moment it is emitted, so a child that started
   * before this window did, or that was continued by a later process, is not on
   * it at all. The catalog read above covers what was already flushed; following
   * the child's stream is what keeps 执行详情 filling after it. */
  /** The followed stream's steps, bound to the record they were read for. A
   *  snapshot outlives the selection that asked for it by one render, so it
   *  carries its own id: another child's steps are never drawn under this one. */
  const [followed, setFollowed] = useState<{ runId: string; steps: SubagentStep[]; subagentId: string }>();
  const followedRunId = resolvedSubagent?.status === "running" && resolvedSubagent.parentTurnId
    ? resolvedSubagent.parentTurnId
    : undefined;
  useEffect(() => {
    if (openSubagentId === undefined || state.sessionId === undefined || followedRunId === undefined) return;
    const subagentId = openSubagentId;
    const runId = followedRunId;
    return followSubagent({
      client,
      onSteps: (steps) => setFollowed({ runId, steps, subagentId }),
      runId,
      sessionId: state.sessionId,
      subagentId,
    });
  }, [client, followedRunId, openSubagentId, state.sessionId]);

  // The record's steps come from three copies of unequal freshness — see
  // `mergedSubagentSteps`. A replay's snapshot is the terminal state but says
  // nothing about what the child did, so its steps come from the catalog; a
  // running child's snapshot carries what this window saw, the followed stream
  // carries what the child wrote, and the catalog carries the continuation a
  // wake turn published elsewhere. The snapshot stays the copy shown for an id
  // it shares, because it is the freshest of the three.
  const openSubagent = useMemo(() => {
    if (resolvedSubagent === undefined) return undefined;
    const followedSteps = followed !== undefined
      && followed.subagentId === openSubagentId
      && followed.runId === followedRunId
      ? followed.steps
      : [];
    const steps = mergedSubagentSteps(resolvedSubagent.steps, catalogSubagent?.steps, followedSteps);
    return steps === resolvedSubagent.steps ? resolvedSubagent : { ...resolvedSubagent, steps };
  }, [catalogSubagent, followed, followedRunId, openSubagentId, resolvedSubagent]);

  // A selection belongs to one session's transcript. Carrying it into another
  // would open a panel on a subagent the reader cannot see.
  useEffect(() => {
    setOpenSubagentId(undefined);
    setOpenTool(undefined);
    lastSubagent.current = undefined;
    setSubagentCatalog(undefined);
  }, [state.sessionId]);

  // Pressing a line opens the child it belongs to, and pressing the same line
  // again keeps it open: the reader pressed a row to read it, and a row that
  // took the record away on a second press would look like a misread rather
  // than a decision. The panel draws its own way back.
  const openSubagentDetails = useCallback((id: string) => {
    setOpenSubagentId(id);
    setOpenTool(undefined);
    setWorkspaceOpen(true);
  }, []);

  /**
   * The same gesture for a tool's input or result: the block opens it, and
   * pressing another block swaps the panel's content, because the panel is
   * where the reader is already looking.
   */
  const openToolDetails = useCallback((detail: ToolDetail) => {
    setOpenTool(detail);
    setOpenSubagentId(undefined);
    setWorkspaceOpen(true);
  }, []);

  /**
   * A turn strip's overflow row (#1252): the files the strip does not list are
   * in the panel's artifact group, so that is where it goes. Any record the
   * panel was showing steps aside, as it does for a dependency link.
   */
  const openArtifactPanel = useCallback(() => {
    setOpenSubagentId(undefined);
    setOpenTool(undefined);
    setPanelGroup("artifacts");
    setWorkspaceOpen(true);
  }, []);

  /**
   * A turn strip's card (#1252): read the file in the panel, where files are
   * read, at the version the card printed.
   *
   * The output record is matched on its version id, not on the ordinal alone:
   * the id is what the card names, and a record that has gone (deleted between
   * the render and the press) draws nothing rather than quietly opening the
   * newest version in place of the one asked for.
   */
  const previewTurnArtifact = useCallback((row: TurnArtifact) => {
    const output = outputsRef.current.find((candidate) =>
      candidate.artifact.id === row.artifact.id && candidate.version.id === row.version.id);
    if (output !== undefined) openArtifactInPanelRef.current(output);
  }, []);

  /** Back from a child's record or a tool's text to the panel's own groups. */
  const closePanelDetail = useCallback(() => {
    setOpenSubagentId(undefined);
    setOpenTool(undefined);
  }, []);

  /**
   * What a citation chip does.
   *
   * An Artifact chip is the artifact, not a record about it: pressing it opens
   * the document in a dialog in the middle of the window, the way the old web
   * UI did — a panel of path / media type / content hash was a detour between
   * the reader and the figure they cited. An Evidence chip has no document to
   * open, so it keeps its card.
   *
   * The reference names the Session that wrote the artifact when the report
   * carries one; the transcript's own Session is the fallback, since a chip is
   * always rendered inside the Session that cited it.
   *
   * Stable across renders on purpose: the transcript and the panel are
   * memoised on their props, and a new function here would make every chip
   * press re-render every answer it sits in — which is the bulk of the wait
   * between the press and the dialog.
   */
  const openReference = useCallback((reference: ComposerReference, sessionId?: string) => {
    if (reference.kind === "artifact") {
      // A new document is a new reading: the panel link belonged to the one
      // before it.
      setLinkedArtifactId(undefined);
      setArtifactReference({ reference, sessionId });
      return;
    }
    setMemoryReference({ reference, sessionId });
  }, []);

  const closeArtifactDialog = useCallback(() => {
    setArtifactReference(undefined);
    setLinkedArtifactId(undefined);
  }, []);

  // Same reason as `openReference`: the transcript is memoised, and this is a
  // prop it would otherwise see as new on every render.
  const decidePermission = useCallback(
    (request: PermissionRequest, decision: PermissionDecision) =>
      actions.decidePermission(request.id, decision),
    [actions],
  );

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
  const canUpload = boot === "ready" && state.detail?.archivedAt === undefined && !isEvidenceSessionReadOnly(state.detail);
  const dragging = useFileDrop((files) => void upload(files), canUpload);

  /** A session with nothing to read yet shows the welcome page instead of an
   *  empty transcript: the composer sits centred with the wordmark, rather
   *  than pinned to the bottom of a page with nothing above it. A run that is
   *  still going keeps the transcript, even before its first event lands. */
  // Poll the selected Session even while it still has no messages: an API-
  // created configuration request must not disappear behind the welcome page.
  const configuration = useConfigurationRequests({
    client, sessionId: state.detail?.id, active: state.running,
    refreshKey: `${state.detail?.updatedAt ?? ""}:${state.detail?.messages.map(message => message.id).join(",") ?? ""}:${state.run.status ?? ""}:${state.run.turns.flatMap(turn => turn.tools.map(tool => `${tool.id}:${tool.trace.status}`)).join(",")}`,
    onChange: actions.refreshConfiguration,
  });
  const landing = !state.loadingSession && !state.running && isEmptyTranscript(state)
    && !configuration.requests.length && !configuration.legacyRequests.length && !configuration.loading && !configuration.error;

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

  /** A HUAWEI sign-in opens the workspace directly: the credits-backed model is
   *  registered before the new token reaches the boot effect, so the catalog is
   *  never briefly empty (which would show the model wizard for a user who
   *  already chose to pay with credits). */
  const authenticate = useCallback(async (session: UserSession, localToken: string) => {
    let creditsModelReady = false;
    if (accountsConfigured()) {
      try {
        await ensureCreditsModel(new ApiClient(localToken, onAuthRejected), session);
        creditsModelReady = true;
      } catch {
        // The gateway may be unreachable; the model wizard is the fallback.
      }
    }
    // Otherwise this build has no account service to bill credits to: no
    // provider is registered, so the custom-model wizard is the way in.
    // A signed-out workspace already holds this machine's token: re-accepting
    // the same one would restart boot behind the account panel, and a sign-in
    // that came from that panel lands on the panel itself. Only the catalog
    // needs refreshing, which keeps the account details on screen.
    if (localToken !== token) {
      acceptToken(localToken);
    } else if (creditsModelReady) {
      // Re-run the bootstrap so a freshly registered credits model opens the
      // workspace. This is deliberately not gated on the `boot` value captured
      // in this callback: a callback return can settle while boot is still
      // reading an empty catalog, and that older closure would then leave the
      // setup wizard on screen even though the model now exists.
      actions.finishSetup();
    } else {
      void actions.refreshCatalog();
    }
    setAccountSession(session);
    setSettlingAuth(false);
    setAccountOpen(returnToAccount.current);
  }, [actions, onAuthRejected, token]);

  // A restored account settles the callback latch as well: the ticket is no
  // longer the reason this render is a sign-in page.
  useEffect(() => {
    if (accountSession) setSettlingAuth(false);
  }, [accountSession]);

  // A sign-in started from the account panel is settled here, not on the
  // sign-in page: the panel stays on screen, says it is confirming, and swaps
  // to the details as soon as the ticket is exchanged.
  const panelSettlementStarted = useRef(false);
  useEffect(() => {
    if (!returnToAccount.current || panelSettlementStarted.current) return;
    panelSettlementStarted.current = true;
    void (async () => {
      try {
        const settled = await settleAuthCallback(window.location.hash);
        if (settled) {
          await authenticate(settled.session, settled.localToken);
          return;
        }
      } catch {
        // A refused ticket or an unreachable service falls through to the
        // panel's signed-out state, which offers the button again.
      }
      window.history.replaceState(null, "", window.location.pathname);
      setSettlingAuth(false);
    })();
  }, [authenticate]);

  /** The command is a way into the surface, not only a message.
   *
   *  A command typed as text — pasted, or written without picking the skill
   *  from the palette — always opens the setup dialog rather than being sent.
   *  The dialog is the one place the task, the search, the pace and the
   *  parameters are visible together, and on a host with no sandbox it is the
   *  only writer of `--allow-direct`: a pasted flag is a word typed without
   *  the warning on screen, and the dialog is where that warning is read and
   *  answered. The sentence typed after the command rides along, so it is not
   *  written twice. A token the dialog already placed in the composer takes
   *  the branch above instead — sending it is the user's final word, and it
   *  must not reopen the dialog.
   *
   *  Defined above the boot screens' early returns because the checkpoint
   *  provider below reads it in an effect: a `const` declared after an early
   *  `return` is still in its temporal dead zone when that effect commits. */
  /** A research is expected: remember the baseline its panel opens against.
   *
   *  The command stays a message — the agent runs its preparation and calls
   *  `create_idea_research`, because the evidence it gathers cannot be produced
   *  here. Remembering that one was asked for, plus the ids the session already
   *  had when a read has finished, is what lets the panel open on the research
   *  that request creates rather than on one that was already there. */
  const rememberAwaitingIdea = () => {
    awaitingIdeaFrom.current = idea.loads > 0
      ? { loads: idea.loads, baseline: new Set(idea.views.map((view) => view.research.id)) }
      : { loads: idea.loads };
    setAwaitingIdea(true);
  };

  const sendMessage = (content: string, command?: string, direction?: EvolveDirectionInput): boolean => {
    if (isEvidenceSessionReadOnly(state.detail)) { actions.toast(TEXT.researchPackage.readOnly, "error"); return true; }
    // An archived Session is read-only on the server, and the composer alone is
    // not enough: a Session with no transcript opens on the welcome page, whose
    // composer had no reason to show. The refusal belongs at the send, where it
    // is one rule for both surfaces.
    if (state.detail?.archivedAt !== undefined) { actions.toast(TEXT.errors.archivedComposer, "error"); return true; }
    // The Idea Tree token the parameters card seeded. The composer will not send
    // it without a task, so a task is always here; composing rather than
    // deferring is what keeps the card out of the send path.
    if (command !== undefined && isIdeaTreeCommand(command)) {
      setSeededCommand(undefined);
      rememberAwaitingIdea();
      void actions.send(composeIdeaMessage(command, content));
      return true;
    }
    // The token came from the design dialog, which collected the goal, the
    // search and the no-sandbox consent before placing it. Sending it is a
    // question about the sentence only, so the detour below — which is for
    // commands typed by hand — does not apply.
    if (command !== undefined) {
      setSeededCommand(undefined);
      awaitingSince.current = Date.now();
      setAwaitingRun(true);
      const message = composeEvolveMessage(command, content);
      void actions.send(direction ? appendEvolveDirection(message, direction) : message);
      return true;
    }
    const goal = evolveCommandGoal(content);
    if (goal !== undefined) {
      setEvolveCreate({
        algorithm: evolveCommandAlgorithm(content),
        checkpointMode: evolveCommandCheckpointMode(content),
        goal: goal === "" ? undefined : goal,
      });
      return true;
    }
    // Only a Session can hold parameters. With no conversation open the card's
    // confirm is disabled by construction, so deferring there would hold the
    // command behind a button nobody can press: the welcome page sends it as it
    // always did, and `send()` creates the Session on the way.
    if (defersIdeaSend(content) && state.detail?.id !== undefined) {
      // #1277: the parameters card opens before an Idea Tree command leaves, but
      // the command is not intercepted — `confirmIdeaSend` sends the same draft
      // unchanged once the card is confirmed. The composer keeps it meanwhile,
      // because this send did not happen.
      rememberPendingIdeaSend(content);
      setIdeaTreeOpen(true);
      return false;
    }
    if (isIdeaTreeCommand(content)) {
      rememberAwaitingIdea();
    }
    void actions.send(content);
    return true;
  };

  /** The current `sendMessage`, read at press time. Holding it in a ref is
   *  what lets the provider's value stay stable while a run streams: a value
   *  rebuilt on every event would re-render every checkpoint card in the
   *  transcript on every delta. It starts as a no-op and the effect replaces
   *  it before any card can be pressed.
   *
   *  These hooks sit above the boot screens' early returns on purpose: a hook
   *  declared after them runs on the main screen and not on the loading one,
   *  and React counts that as a different number of hooks between renders. */
  const latestSend = useRef<(content: string) => void>(() => {});
  useEffect(() => {
    latestSend.current = sendMessage;
  });
  const checkpointReply = useMemo<CheckpointReply>(() => ({
    busy: state.running,
    reply: (text) => latestSend.current(text),
  }), [state.running]);

  /** The design the auto-continue belongs to, read from the Session itself:
   *  its design commands, plus the one being sent (the transcript is written
   *  when the turn settles, so a design's first ending would otherwise be
   *  keyed against the previous design's number). Derived rather than
   *  remembered here, so it cannot outlive the Session or disagree with a
   *  design another client started in it. */
  const design = useMemo(
    () => designAnchor(state.detail?.messages ?? [], state.pendingMessage?.content),
    [state.detail?.messages, state.pendingMessage?.content],
  );

  /** The pace that design was started with, from the same transcript. Only a
   *  design nobody is waiting on may be carried forward. */
  const designPace = useMemo(
    () => latestEvolveCheckpointMode(state.detail?.messages ?? [], state.pendingMessage?.content),
    [state.detail?.messages, state.pendingMessage?.content],
  );

  /** Whether *this design* already has a search. The Session's whole run list
   *  would answer for designs that are long finished, and a second no-confirm
   *  design in the same conversation would never be carried. The command `now`
   *  being sent counts: a design whose `/evolve-design` is still pending owns
   *  no run, whatever the previous design in the transcript started. */
  const searchStarted = useMemo(
    () => designHasSearch(
      evolve.runs,
      state.detail?.messages ?? [],
      state.pendingMessage?.content,
    ),
    [evolve.runs, state.detail?.messages, state.pendingMessage?.content],
  );

  // A no-confirm design that ends its turn on an auto card is carried forward
  // here — the model cannot start the next turn by itself, and the card offers
  // nothing to press. See the hook for what it refuses to act on.
  const autoContinue = useAutoContinue({
    checkpointMode: designPace,
    design,
    running: state.running,
    run: state.run,
    searchStarted,
    send: (text) => latestSend.current(text),
    sessionId: state.sessionId,
  });

  // Returning from HUAWEI ID takes priority over every other gate: the ticket
  // has to be exchanged even when the machine already has its local token (and
  // therefore a perfectly usable, signed-out workspace). A sign-in that came
  // from the account panel settles inside the panel instead (see above), so
  // the page is only shown for a callback that started on it.
  if (settlingAuth && !accountSession && !returnToAccount.current) {
    return (
      <>
        <LoginPage onAuthenticated={(session, localToken) => void authenticate(session, localToken)} />
        <Toasts onDismiss={actions.dismissToast} toasts={state.toasts} />
      </>
    );
  }

  // The local service token is the only hard credential: without it even the
  // model catalog is unreadable, so a browser that has never been handed one
  // can only be signed in through HUAWEI ID.
  if (requiresLocalToken(token)) {
    return (
      <>
        <LoginPage
          onAuthenticated={(session, localToken) => void authenticate(session, localToken)}
        />
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
    // The dialog still mounts here: the offline screen offers a feedback entry
    // that carries the failure's diagnostics, so it must have a listener.
    return (
      <>
        <OfflineScreen onRetry={actions.retryBoot} reason="unreachable" />
        <FeedbackDialog />
      </>
    );
  }

  // No account and no model: the entry page offers the two ways in — sign in
  // for credits, or point the workspace at a model endpoint. Either one is
  // enough to open the workspace; the other stays configurable from there.
  if (!accountSession && (boot === "setup" || boot === "auth")) {
    return (
      <>
        <LoginPage
          client={client}
          offerModelSetup
          onAuthenticated={(session, localToken) => void authenticate(session, localToken)}
          onModelConfigured={() => actions.finishSetup()}
          onProvidersChanged={actions.refreshCatalog}
          presets={state.presets}
          providers={state.providers}
        />
        <Toasts onDismiss={actions.dismissToast} toasts={state.toasts} />
      </>
    );
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
    // A 上游文件 link is a relationship between two visible surfaces; one of
    // them going away ends it.
    setLinkedArtifactId(undefined);
    // The group belongs to the panel being open in the same way: a panel the
    // reader asked for again opens on 产物, not on the file tree they happened
    // to be browsing when they closed it.
    setPanelGroup("artifacts");
  };

  // The column width is published as a custom property rather than written into
  // the grid here, because two things have to agree on it: the shell's third
  // track, and the panel that fills it. `--panel-width` inherits, so setting it
  // once on the shell reaches both, and neither has to be told twice.
  outputsRef.current = state.outputs;

  const shellStyle = { "--panel-width": `${resize.width}px` } as CSSProperties;

  const openSettings = (group: SettingsGroup) => {
    setSettingsGroup(group);
    // 会话 / 设置 / 用户 are peers in the rail: opening one puts the other away,
    // so the user page is never buried under the settings surface.
    setAccountOpen(false);
    if (group === "skills") skillsVisited.current = true;
    setSettingsOpen(true);
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    // 导入 or a card's 编辑 happens on this surface, so closing it after 技能 is
    // the moment the composer's palette is known to be out of date.
    if (skillsVisited.current) {
      skillsVisited.current = false;
      setSkillsEpoch((epoch) => epoch + 1);
    }
  };

  /** The run the 任务 tab shows: the one the reader picked, else the one that
   *  wants attention, else the newest. The tab appears for any run, so there is
   *  always something behind it when the Session has one. */
  const evolveRun = evolve.runs.find((run) => run.id === evolveRunId)
    ?? evolve.runs.find((run) => isEvolveRunActive(run.status))
    ?? evolve.runs[0];
  /** Retry writes a new run into the Session, so a read-only Session only
   *  gets the reason. The server enforces the same rule; this keeps the card
   *  from offering an action it knows will be refused. */
  const evolveRetryAllowed = state.detail?.archivedAt === undefined
    && !isEvidenceSessionReadOnly(state.detail);

  /** Open a run in the panel from its card in the transcript: the card should
   *  not have to open the panel first. */
  /** The research the 任务 tab shows, when its card was the way in. */
  const ideaResearch = idea.views.find((view) => view.research.id === ideaResearchId);

  const showEvolveRun = (id: string) => {
    setEvolveRunId(id);
    // 任务 shows one thing: a research or a legacy tree left selected would keep
    // drawing over the run the reader just asked for, and #1169 requires Evolve
    // to stay usable in a session that has both.
    setIdeaResearchId(undefined);
    setLegacyOpen(false);
    setPanelGroup("task");
    setWorkspaceOpen(true);
  };

  /** Retry a failed search from the card. The server owns the goal: this only
   *  names the failed record, so the frozen scorecard/baseline cannot be
   *  replaced by a client. A refusal is already a localized sentence when it
   *  comes from this side's own rules; anything else is reported with the
   *  card's own retry sentence rather than leaking a raw server string. */
  const retryEvolve = async (id: string) => {
    try {
      await retryEvolveRun(client, id);
      // The new run is active, so the poll picks it up; refreshing now makes
      // the replacement card appear without waiting for the next three-second
      // tick.
      await refreshEvolve();
    } catch {
      actions.toast(TEXT.evolve.retryFailed, "error");
    }
  };

  /** The same for a research's card: the panel is the 任务 tab, and the search
   *  detail steps aside for it. */
  const showIdeaResearch = (id: string) => {
    setIdeaResearchId(id);
    setEvolveRunId(undefined);
    setLegacyOpen(false);
    setPanelGroup("task");
    setWorkspaceOpen(true);
  };

  /** 会话设置's row always starts a new design. A search already in the
   *  session stays reachable through its card in the transcript, so opening
   *  the newest one here would only hide the create dialog behind a run that
   *  has nothing left to do. The composer's draft rides into the new design's
   *  task field: a sentence already written is the one the design would start
   *  from. */
  const openEvolve = (draft?: string) => {
    setEvolveCreate({ goal: evolveDraftTask(draft ?? "") });
  };

  const closeEvolveCreate = () => setEvolveCreate(undefined);

  /** The Idea Tree parameters card, opened from 会话设置's `idea-tree` row.
   *
   *  Confirming it is not a send. The card writes this conversation's parameters
   *  and then `seedIdeaTree` places the command token in the composer, where the
   *  reader completes the task and sends it — the same shape Evolve's setup
   *  dialog already uses. `goal` is whatever the composer held; a draft that is
   *  itself an Idea Tree command contributes no task, so a token can never
   *  become another token's objective. */
  const openIdeaTree = (goal = "") => {
    rememberPendingIdeaSend(undefined);
    setIdeaTreeTask(ideaTaskOf(goal));
    setIdeaTreeStart(true);
    setIdeaTreeOpen(true);
  };

  const closeIdeaTree = () => {
    setIdeaTreeStart(false);
    setIdeaTreeOpen(false);
  };

  /** Put the command token in the composer, with the task the reader already
   *  wrote under it. Nothing is sent: the send button is theirs, and it is also
   *  the only place a running turn refuses the message. */
  const seedIdeaCommand = (command: string, task: string) => {
    setIdeaTreeStart(false);
    setIdeaTreeOpen(false);
    setIdeaTreeTask("");
    setSeededCommand({ command, nonce: Date.now(), owner: landingKey(state), text: task });
  };

  const seedIdeaTree = () => seedIdeaCommand(IDEA_TREE_TEAM_COMMAND, ideaTreeTask);

  /** A typed Idea Tree command was waiting for the card: turn it into the token
   *  the reader sends, keeping the command they typed and the task under it. */
  const confirmIdeaSend = () => {
    // Read through the ref: the card may be calling a callback captured before a
    // cancel cleared this.
    const pending = pendingIdeaSendRef.current;
    rememberPendingIdeaSend(undefined);
    setIdeaTreeOpen(false);
    if (pending === undefined) return;
    seedIdeaCommand(ideaCommandOf(pending) ?? IDEA_TREE_TEAM_COMMAND, ideaTaskOf(pending));
  };

  /** The card was dismissed: nothing is sent and the draft comes back. */
  const cancelIdeaSend = () => {
    const pending = pendingIdeaSendRef.current;
    rememberPendingIdeaSend(undefined);
    setIdeaTreeOpen(false);
    if (pending !== undefined) setSeededCommand({ nonce: Date.now(), owner: landingKey(state), text: pending });
  };

  /**
   * A 上游文件 link inside the open artifact dialog.
   *
   * The dialog stays on the artifact the reader was reading: pressing a
   * dependency is a question about *this* document, and swapping the document
   * under the cursor would throw away the context the question came from. The
   * dependency opens beside it in the panel instead.
   *
   * The panel needs no room to itself — it is already a column of the window,
   * and opening it is what the link asks for. `panelOffset` is what keeps the
   * dialog from covering it; neither surface draws any extra chrome for the
   * link.
   */
  const openDependencyInPanel = (output: SessionArtifactOutput) => {
    setWorkspaceOpen(true);
    setPanelGroup("artifacts");
    // The panel shows one record; a child's steps or a tool block would sit
    // in front of the document the link asked for.
    setOpenSubagentId(undefined);
    setOpenTool(undefined);
    setLinkedArtifactId(output.artifact.id);
    // An open tab keeps its place and only its version moves: `openArtifact`
    // focuses a tab that is already open rather than re-reading it, which
    // would leave an older version of the dependency on screen.
    const openTab = state.tabs.tabs.find(
      (tab) => tab.artifactId === output.artifact.id,
    );
    if (openTab === undefined) {
      void actions.openArtifact(output);
      return;
    }
    actions.selectPanelTab(openTab.id);
    if (openTab.versionId !== output.version.id) {
      void actions.selectArtifactVersion(openTab.id, output);
    }
  };

  // The strip's door into the panel: `openDependencyInPanel` already focuses an
  // open tab and moves it to the requested version, which is exactly the gesture
  // a card asks for.
  openArtifactInPanelRef.current = openDependencyInPanel;

  // The dialog only keeps its offset while the panel is still showing the
  // dependency: pointing the panel at another document or another group ends
  // the gesture, and the dialog goes back to the middle of the window.
  const activeArtifactId = state.tabs.tabs.find(
    (tab) => tab.id === state.tabs.activeTabId,
  )?.artifactId;
  const linkedToPanel = linkedArtifactId !== undefined
    && workspaceOpen
    && panelGroup === "artifacts"
    && activeArtifactId === linkedArtifactId;

  /** Checkpoints whose review is still queued or running. The review card
   *  reads this to draw its running line instead of an empty verdict.
   *
   *  Deliberately not a hook: this sits below the boot screens' early returns,
   *  and a hook here would change the hook order when boot settles. */
  const reviewerActive = new Set(
    state.reviewerTasks
      .filter((task) => task.status === "queued" || task.status === "running")
      .map((task) => task.toolCallId),
  );

  /** The composer is one component in two places — under the transcript, and
   *  in the middle of the welcome page — so its props are assembled once. */
  // Signing out revokes the credits provider's token, so leaving it in the
  // picker would offer a model whose every run fails with 401. The provider
  // stays in the catalog — signing back in needs no setup — it just is not
  // offered until there is an account again.
  const creditsProviderIds = new Set(
    state.providers
      .filter((provider) => provider.name === CREDITS_PROVIDER_NAME)
      .map((provider) => provider.id)
      .filter((id): id is string => Boolean(id)),
  );
  const isCreditsModel = (model: { providerId?: string }) => model.providerId !== undefined && creditsProviderIds.has(model.providerId);
  const offeredModels = accountSession ? state.models : state.models.filter((model) => !isCreditsModel(model));
  const creditsModelSignedOut = !accountSession
    && state.models.some((model) => model.id === state.selectedModelId && isCreditsModel(model));
  const composerProps: Omit<ComponentProps<typeof Composer>, "landing" | "seed" | "tag"> = {
    activeProjectId: state.activeProjectId,
    // The session's own mode, else the reader's last choice, else the project/global
  // default the service would apply — never a third "follow settings" state (#1204).
  approvalMode: state.detail?.approvalMode ?? lastApprovalMode ?? state.defaultApprovalMode ?? "ask_for_dangerous",
    // A review is something a Session does. On the welcome or draft composer
    // there is nothing to review, and the rows would answer a click by
    // returning early; they are not drawn at all.
    automaticReviewEnabled: state.sessionId === undefined ? undefined : state.reviewerSettings?.automaticReviewEnabled,
    reviewerEnabled: state.sessionId === undefined ? undefined : state.reviewerEnabled,
    // The same queued-or-running test the cards use: one notion of "a review
    // is happening now", so the menu's 停止审查 and the running lines cannot
    // disagree about whether there is anything to stop.
    reviewerRunning: state.sessionId !== undefined && reviewerActive.size > 0,
    reviewLevel: state.sessionId === undefined ? undefined : state.reviewerSettings?.level,
    onAutomaticReview: state.sessionId === undefined
      ? undefined
      : (enabled) => void actions.setAutomaticReview(enabled),
    onReviewLevel: state.sessionId === undefined
      ? undefined
      : (level) => void actions.setReviewLevel(level),
    onRunReview: state.sessionId === undefined ? undefined : () => void actions.runReview(),
    onStopReview: state.sessionId === undefined ? undefined : () => void actions.stopReview(),
    attachBlocked: canUpload ? undefined : TEXT.composer.attachArchived,
    attachLimit,
    attachments: state.attachments,
    client,
    jwBlocked: jwReady ? undefined : TEXT.composer.jwBlocked,
    models: offeredModels,
    // Part of the props, not of one call site: the composer is drawn under the
    // transcript *and* in the middle of the welcome page, and an archived
    // Session with an empty transcript takes the second path. Passing the reason
    // only where the transcript is non-empty left that Session looking writable.
    readOnlyReason: state.detail?.archivedAt !== undefined ? TEXT.errors.archivedComposer : undefined,
    onApprovalMode: (mode) => {
    // The choice is remembered before it is applied: a new conversation started
    // from this instance inherits it, and the selector on the landing page has
    // nothing else to read it from.
    rememberApprovalMode(mode);
    setLastApprovalMode(mode);
    // Unconditional: the action itself is a no-op without an open session, while
    // `state.detail` is cleared during a read, so guarding on it loses the choice
    // made in that window.
    void actions.setApprovalMode(mode);
  },
    onClearAttachments: actions.clearAttachments,
    onClearCommand: () => setSeededCommand(undefined),
    onCreateProject: (name) => void actions.createProject(name),
    onEvolve: openEvolve,
    onIdeaTree: openIdeaTree,
    onOpenSettings: () => openSettings("models"),
    // A skill that has a setup surface opens it instead of dropping its
    // command into the draft — the same dialog 会话设置's evolve row opens.
    // The draft is the task it was going to replace.
    onPickSkill: (skill, draft) => {
      if (!isEvolveSkill(skill)) return false;
      setEvolveCreate({ goal: evolveDraftTask(draft) });
      return true;
    },
    onRemoveAttachment: actions.removeAttachment,
    onRetryAttachment: actions.retryAttachment,
    onSelectModel: (modelId) => void actions.selectModel(modelId),
    onSelectProject: (projectId) => actions.selectProject(projectId),
    onSelectSpecialist: (specialistId) => void actions.selectSpecialist(specialistId),
    onSend: sendMessage,
    onStop: () => void actions.stop(),
    onUpload: (files) => void upload(files),
    // No name when the next conversation goes into no Project: the strip then
    // shows its invitation to choose one, which is what the inbox means from
    // the welcome page — 会话 is the column's word for the result, not a
    // place the user would pick.
    projectName: state.activeProject?.kind === "inbox" ? undefined : state.activeProjectName,
    projects: state.projects,
    providers: state.providers,
    running: state.running,
    seededCommand,
    selectedModelId: state.selectedModelId,
    // A seed is drawn only by the surface that created it (#1434): the
    // page and the conversation are named the way `Landing` is keyed.
    surfaceKey: landingKey(state),
    skillsEpoch,
    unavailableModel: creditsModelSignedOut
      || Boolean(state.detail?.settingsOverrides?.modelId && !state.models.some(model => model.id === state.detail?.settingsOverrides.modelId)),
    unavailableModelText: creditsModelSignedOut ? TEXT.errors.modelSignInRequired : undefined,
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
    accountOpen ? "account-open" : "",
  ].filter(Boolean).join(" ");

  return (
    <CheckpointReplyProvider value={checkpointReply}>
      <div className={shellClass} style={shellStyle}>
        <Rail
          account={accountSession}
          accountOpen={accountOpen}
          onOpenAccount={() => {
            setSettingsOpen(false);
            setAccountOpen(true);
          }}
          onOpenSettings={() => openSettings(settingsGroup)}
          onSelectTask={() => {
            setSettingsOpen(false);
            setAccountOpen(false);
          }}
          settingsOpen={settingsOpen}
        />

        {taskSidebar ? (
          <Sidebar
            actions={actions}
            onExportSession={session => {
              if (!canExportSession(session, state.projects, state.inboxProject?.id)) { actions.toast(TEXT.researchPackage.sourceUnavailable, "error"); return; }
              setPackageRequest({ kind: "export", sessionId: session.id, projectId: session.projectId });
            }}
            onImportSession={() => setPackageRequest({ kind: "import", projectId: state.inboxProject?.id })}
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
            // A Session outside every Project is not "in 会话": that is
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
              {/* A design the client stopped carrying says so on the card it
                  stopped at; the value is the step, and every other card
                  ignores it. Hidden while a turn runs: the refusal describes
                  the ending that already happened, and a new answer that
                  happens to stream a card of the same step must not wear that
                  ending's badge for a frame. */}
              <CheckpointRefusedProvider value={state.running ? undefined : autoContinue.refusedStep}>
                <Conversation
                  onOpenConfigurationSettings={openSettings}
                  client={client}
                  detail={state.detail}
                  configuration={configuration}
                  onConfigurationChange={actions.refreshConfiguration}
                  configurationReadOnly={isEvidenceSessionReadOnly(state.detail) || state.detail?.archivedAt !== undefined}
                  // One card per research; the panel is where the tree and the
                  // controls live, so the card itself only opens it. These are
                  // the transcript's foot, not its header: `Conversation` draws
                  // them after the last turn, where an Evolve run card also sits.
                  // They keep their order: researches, the legacy graph that
                  // predates them, and a list that could not be read. An empty
                  // column would otherwise read as "nothing was ever started"
                  // when the sidecar is down.
                  ideaCards={idea.views.length ? <IdeaResearchCards onOpen={showIdeaResearch} views={idea.views} /> : null}
                  ideaLegacy={legacy.graph ? (
                    <LegacyIdeaCard
                      graph={legacy.graph}
                      onOpen={() => { setLegacyOpen(true); setIdeaResearchId(undefined); setEvolveRunId(undefined); setPanelGroup("task"); setWorkspaceOpen(true); }}
                    />
                  ) : null}
                  ideaNotice={idea.unavailable || idea.error || legacy.error ? (
                    <p className="idea-notice" role="alert">
                      {idea.unavailable ? TEXT.ideaTree.unavailable : idea.error ?? legacy.error}
                    </p>
                  ) : null}
                  // A search keeps running after the turn that started it, so its
                  // card is the last thing the conversation produced. It draws
                  // nothing at all for a session that has no searches.
                  evolve={<EvolveRuns
                    onOpen={showEvolveRun}
                    onRetry={evolveRetryAllowed ? retryEvolve : undefined}
                    runs={evolve.runs}
                  />}
                  loading={state.loadingSession}
                  onDecidePermission={decidePermission}
                  onOpenArtifactPanel={openArtifactPanel}
                  onOpenSubagent={openSubagentDetails}
                  onPreviewArtifact={previewTurnArtifact}
                  onOpenTool={openToolDetails}
                  onBranch={isEvidenceSessionReadOnly(state.detail) || state.running ? undefined : messageId => setPackageRequest({ kind: "branch", sessionId: state.detail?.id, projectId: state.detail?.projectId, messageId })}
                  onReferenceClick={openReference}
                  outputs={state.outputs}
                  pending={state.pendingMessage}
                  reviews={state.reviews}
                  reviewerActive={reviewerActive}
                  onReview={() => void actions.reviewCheckpoint()}
                  replays={state.replays}
                  run={state.run}
                  workspaceFiles={state.panelFiles}
                />
              </CheckpointRefusedProvider>
              {state.detail?.archivedAt !== undefined ? (
            <p className="session-archived-banner" role="status">{TEXT.errors.archivedBanner}</p>
          ) : null}
          {isEvidenceSessionReadOnly(state.detail) ? null : (
            <Composer {...composerProps} key={landingKey(state)} />
          )}
            </>
          )}
          <ResearchPackage client={client} request={packageRequest} projects={state.projects} detail={state.detail} onOpen={(id) => void actions.openSession(id)} onRefresh={actions.refreshSessions} />
        </main>

        <WorkspacePanel
          actions={actions}
          activeGroup={panelGroup}
          files={state.panelFiles}
          onCloseDetail={closePanelDetail}
          onCollapse={collapsePanel}
          onReferenceClick={openReference}
          onSelectGroup={setPanelGroup}
          outputs={state.outputs}
          resize={resize}
          sessionId={state.sessionId}
          sessions={state.recent}
          subagent={openSubagent}
          subagentLoading={subagentLoading && (openSubagent?.steps.length ?? 0) === 0}
          subagentStale={subagentStale}
          task={legacyOpen && legacy.graph !== undefined
            ? <LegacyIdeaTreePanel graph={legacy.graph} onClose={() => setLegacyOpen(false)} />
            : ideaResearch !== undefined
              ? <IdeaResearchPanel
                client={client}
                key={ideaResearch.research.id}
                onClose={() => setIdeaResearchId(undefined)}
                onResearchChanged={idea.apply}
                researchId={ideaResearch.research.id}
                sessionId={state.sessionId!}
              />
              : evolveRun === undefined ? undefined : <EvolveDetail
                client={client}
                key={evolveRun.id}
                onError={(message) => actions.toast(message, "error")}
                onRunChanged={() => void refreshEvolve()}
                run={evolveRun}
              />}
          tabs={state.tabs}
          tool={openTool}
        />
      </div>
      {accountOpen && accountSession ? (
        <AccountPage
          account={accountSession}
          onAccountChange={updateAccountSession}
          onSignOut={signOut}
          onToggleSidebar={expandSidebar}
          sidebarOpen={taskSidebar}
        />
      ) : accountOpen ? (
        // After signing out the account surface shows a grey avatar and the
        // single way back in; the workspace behind it stays usable with a
        // custom model.
        <SignedOutAccount onClose={() => setAccountOpen(false)} pending={settlingAuth} />
      ) : null}

      {settingsOpen ? (
        <SystemSettingsDialog
          actions={actions}
          client={client}
          group={settingsGroup}
          onClose={closeSettings}
          onGroupChange={(next) => {
            if (next === "skills") skillsVisited.current = true;
            setSettingsGroup(next);
          }}
          // 设置 is where a user looks when the interface is what they cannot
          // find, so the guide's one replay lives there. The dialog has to go
          // first: the cards point at the page behind it.
          onShowGuide={() => {
            setSettingsOpen(false);
            openGuide();
          }}
          signedIn={accountSession !== undefined}
          state={state}
        />
      ) : null}

      {artifactReference ? (
        <ArtifactDialog
          client={client}
          key={`artifact:${artifactReference.reference.id}:${artifactReference.reference.version ?? ""}`}
          onClose={closeArtifactDialog}
          onOpenArtifact={openDependencyInPanel}
          onReferenceClick={openReference}
          // Portaled dialogs sit outside the shell, so the panel's width is
          // handed over as a number rather than read from `--panel-width`.
          panelOffset={linkedToPanel ? resize.width : 0}
          reference={artifactReference.reference}
          sessionId={artifactReference.sessionId}
        />
      ) : null}

      {memoryReference ? (
        <MemoryCardDialog
          client={client}
          key={`${memoryReference.reference.kind}:${memoryReference.reference.id}:${memoryReference.reference.version ?? ""}`}
          onClose={() => setMemoryReference(undefined)}
          onOpenSettings={() => {
            setMemoryReference(undefined);
            openSettings("memory");
          }}
          reference={memoryReference.reference}
          sessionId={memoryReference.sessionId}
        />
      ) : null}

      {guideOpen ? <Guide onClose={closeGuide} onStep={guideStep} /> : null}

      {ideaTreeOpen ? (
        <IdeaTreeOverrideDialog
          client={client}
          onClose={pendingIdeaSend === undefined ? closeIdeaTree : cancelIdeaSend}
          // Both paths seed the command token; neither sends. The settings row's
          // confirm is also the write, so it needs a Session open.
          onConfirm={pendingIdeaSend === undefined
            ? (ideaTreeStart && state.detail?.id !== undefined ? seedIdeaTree : undefined)
            : confirmIdeaSend}
          sessionId={state.detail?.id}
          seedsCommand={pendingIdeaSend === undefined && ideaTreeStart}
        />
      ) : null}

      {evolveCreate === undefined ? null : (
        <EvolveCreateDialog
          activeRun={evolve.runs.some((run) => isEvolveRunActive(run.status))}
          archived={state.detail?.archivedAt !== undefined}
          error={evolve.error}
          initialAlgorithm={evolveCreate.algorithm}
          initialCheckpointMode={evolveCreate.checkpointMode}
          initialGoal={evolveCreate.goal}
          initializing={evolve.initializing}
          onClose={closeEvolveCreate}
          onGenerateDirection={state.detail
            ? (task, signal) => draftEvolveDirection(client, state.detail!.id, task, signal)
            : undefined}
          onInitialize={() => void evolve.initialize()}
          onRefreshStatus={evolve.refreshStatus}
          onSend={(command, direction) => {
            closeEvolveCreate();
            // The flags become a token in the composer, the task the sentence
            // after it, and the confirmed parameters ride with the token until
            // the user sends. The message leaves when the user says so, not
            // when the dialog closes: the design usually needs a sentence of
            // its own added after the task.
            const draft = splitEvolveCommand(command);
            setSeededCommand({
              command: draft.command,
              direction,
              nonce: Date.now(),
              owner: landingKey(state),
              text: draft.goal,
            });
          }}
          running={state.running}
          status={evolve.status}
        />
      )}

      {/* The whole window is the drop target, so the whole window is what has
          to say so. It is drawn only while a file is actually over the app,
          and it repeats the reason when there is no session — a drop that does
          nothing is the one outcome the user cannot diagnose. */}
      {dragging ? (
        <div className="drop-overlay">
          <div className={`drop-card${canUpload ? "" : " is-blocked"}`}>
            <span className="drop-mark" aria-hidden="true">{canUpload ? "⬇" : "⊘"}</span>
            <strong className="drop-title">
              {canUpload
                ? TEXT.upload.dropTitle
                : state.detail?.archivedAt !== undefined
                  ? TEXT.upload.archived
                  : TEXT.upload.readOnly}
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

      <FeedbackDialog />
    </CheckpointReplyProvider>
  );
}
