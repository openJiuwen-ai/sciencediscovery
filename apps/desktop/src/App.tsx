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
import type { GuideStep } from "./app/guide.js";
import { isEmptyTranscript, landingKey } from "./app/landing.js";
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
  isEvolveSkill,
  latestEvolveCheckpointMode,
  splitEvolveCommand,
} from "./evolve/command.js";
import { designAnchor, useAutoContinue } from "./evolve/use-auto-continue.js";
import { useEvolve } from "./evolve/use-evolve.js";
import { allSubagents } from "./run-stream/model.js";
import { mergedSubagentSteps } from "./run-stream/subagent.js";
import {
  GUIDE_STORAGE_KEY,
  RIGHT_PANEL_STORAGE_KEY,
  TOKEN_STORAGE_KEY,
  readStoredFlag,
  writeStoredFlag,
} from "./state/storage.js";
import { applyDocumentLanguage, TEXT } from "./text.js";
import { FeedbackDialog } from "./feedback/FeedbackDialog.js";
import { ArtifactDialog } from "./views/ArtifactDialog.js";
import { AuthScreen } from "./views/AuthScreen.js";
import { CheckpointRefusedProvider, CheckpointReplyProvider, type CheckpointReply } from "./views/CheckpointCard.js";
import { Composer, type SeededCommand } from "./views/Composer.js";
import { ConfirmDialog } from "./views/ConfirmDialog.js";
import { Conversation } from "./views/Conversation.js";
import { draftEvolveDirection } from "./api/evolve.js";
import { EvolveCreateDialog } from "./views/evolve/EvolveCreateDialog.js";
import { EvolveDetail } from "./views/evolve/EvolveDetail.js";
import { EvolveRuns } from "./views/evolve/EvolveRuns.js";
import { Guide } from "./views/Guide.js";
import { Landing } from "./views/Landing.js";
import { MemoryCardDialog } from "./views/MemoryCardDialog.js";
import { OfflineScreen } from "./views/OfflineScreen.js";
import { Rail } from "./views/Rail.js";
import { SessionBar } from "./views/SessionBar.js";
import { ResearchPackage, type PackageRequest } from "./views/ResearchPackage.js";
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
  const [packageRequest, setPackageRequest] = useState<PackageRequest>();
  const [token, setToken] = useState(initialToken);
  /** Set when the server answered 401, so the gate can say "this one was
   *  refused" instead of the generic "we have no credential". */
  const [rejected, setRejected] = useState(false);
  /** 设置 opens over the task surface and holds which pane it last showed, so
   *  reopening lands where the user left off. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsGroup, setSettingsGroup] = useState<SettingsGroup>("general");
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

  /** The runtime and the open Session's searches. The transcript's run cards
   *  read `runs` directly, which is why the hook exists at this level rather
   *  than inside the panel: the searches must stay reachable while the panel is
   *  closed. */
  const evolve = useEvolve(client, state.sessionId);
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
  /** The instant the command was sent; a run older than it was already there. */
  const awaitingSince = useRef(0);
  /** The create dialog, open with a typed goal when the command was diverted
   *  here because the runtime is not ready. */
  const [evolveCreate, setEvolveCreate] = useState<{
    algorithm?: EvolveAlgorithm;
    checkpointMode?: "auto" | "confirm";
    goal?: string;
  } | undefined>();
  /** A design command the dialog placed in the composer instead of sending.
   *  Held here because the composer has two mounts — the welcome page and the
   *  conversation — and the dialog opens over either. Cleared when the composer
   *  sends, when the reader removes the token, and when the session changes: a
   *  token that outlived its session would turn the next ordinary message into
   *  a long, costly search the reader never asked for. */
  const [seededCommand, setSeededCommand] = useState<SeededCommand>();

  // An open panel belongs to one session's searches, like a selected
  // subagent. The create dialog is deliberately left alone: it starts a run
  // in whichever session is open when it sends, and the session the app is
  // opening as it boots is not a reason to close a dialog the user just opened.
  //
  // The seeded command is not left alone: the dialog collected its goal for
  // the session it was opened in, and the composer it would land in survives
  // the switch.
  useEffect(() => {
    setEvolveRunId(undefined);
    setAwaitingRun(false);
    setSeededCommand(undefined);
    seenRunIds.current = new Set();
  }, [state.sessionId]);

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
  // leave the column with nothing in it.
  useEffect(() => {
    if (panelGroup === "task" && evolve.runs.length === 0) setPanelGroup("artifacts");
  }, [evolve.runs.length, panelGroup]);

  // A search is created by the server while the agent's turn is running, and
  // the list is not polled until one is active. The created event is therefore
  // the one moment the app knows to look now rather than at the next poll.
  useEffect(() => {
    if (state.run.evolveRunsCreated > 0) void refreshEvolve();
  }, [refreshEvolve, state.run.evolveRunsCreated]);

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

  /** The command is a way into the surface, not only a message. While the
   *  runtime is not ready the goal typed after it is carried into the setup
   *  dialog instead of being sent to a server that cannot run it; a bare
   *  command opens the dialog that asks for one. On a host with no sandbox
   *  every command detours there, including one that already carries
   *  `--allow-direct`: a pasted flag is a word the user typed without the
   *  warning on screen, and the dialog is where that warning is read and
   *  answered. So the dialog is the only writer of the flag — a command that
   *  reaches the server with it is one the user confirmed here.
   *
   *  Defined above the boot screens' early returns because the checkpoint
   *  provider below reads it in an effect: a `const` declared after an early
   *  `return` is still in its temporal dead zone when that effect commits. */
  const sendMessage = (content: string, command?: string, direction?: EvolveDirectionInput) => {
    if (isEvidenceSessionReadOnly(state.detail)) { actions.toast(TEXT.researchPackage.readOnly, "error"); return; }
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
      return;
    }
    const goal = evolveCommandGoal(content);
    if (goal !== undefined
        && (goal === "" || evolve.status.state !== "ready"
            || evolve.status.sandbox === "direct")) {
      setEvolveCreate({
        algorithm: evolveCommandAlgorithm(content),
        checkpointMode: evolveCommandCheckpointMode(content),
        goal: goal === "" ? undefined : goal,
      });
      return;
    }
    if (goal !== undefined) {
      awaitingSince.current = Date.now();
      setAwaitingRun(true);
    }
    void actions.send(content);
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
    // The dialog still mounts here: the offline screen offers a feedback entry
    // that carries the failure's diagnostics, so it must have a listener.
    return (
      <>
        <OfflineScreen onRetry={actions.retryBoot} reason="unreachable" />
        <FeedbackDialog />
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
  const shellStyle = { "--panel-width": `${resize.width}px` } as CSSProperties;

  const openSettings = (group: SettingsGroup) => {
    setSettingsGroup(group);
    setSettingsOpen(true);
  };

  /** The run the 任务 tab shows: the one the reader picked, else the one that
   *  wants attention, else the newest. The tab appears for any run, so there is
   *  always something behind it when the Session has one. */
  const evolveRun = evolve.runs.find((run) => run.id === evolveRunId)
    ?? evolve.runs.find((run) => isEvolveRunActive(run.status))
    ?? evolve.runs[0];

  /** Open a run in the panel: the card and 会话设置 both land here, and neither
   *  should have to open the panel first. */
  const showEvolveRun = (id: string) => {
    setEvolveRunId(id);
    setPanelGroup("task");
    setWorkspaceOpen(true);
  };

  /** 会话设置's row goes to the search that wants attention — a running one,
   *  else the newest — and starts one only when the session has none. */
  const openEvolve = () => {
    const target = evolve.runs.find((run) => isEvolveRunActive(run.status)) ?? evolve.runs[0];
    if (target === undefined) setEvolveCreate({});
    else showEvolveRun(target.id);
  };

  const closeEvolveCreate = () => setEvolveCreate(undefined);

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
    onClearCommand: () => setSeededCommand(undefined),
    onCreateProject: (name) => void actions.createProject(name),
    onEvolve: openEvolve,
    evolveSetup: {
      archived: state.detail?.archivedAt !== undefined,
      error: evolve.error,
      initializing: evolve.initializing,
      onInitialize: () => void evolve.initialize(),
      status: evolve.status,
    },
    canConfirmTypedEvolve: evolve.status.state === "ready" && evolve.status.sandbox !== "direct",
    onGenerateEvolveDirection: state.detail ? (task, signal) => draftEvolveDirection(client, state.detail!.id, task, signal) : undefined,
    onOpenSettings: () => openSettings("models"),
    // A skill that has a setup surface opens it instead of dropping its
    // command into the draft — the same dialog 会话设置's evolve row opens.
    onPickSkill: (skill) => {
      if (!isEvolveSkill(skill)) return false;
      setEvolveCreate({});
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
    unavailableModel: Boolean(state.detail?.settingsOverrides?.modelId && !state.models.some(model => model.id === state.detail?.settingsOverrides.modelId)),
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
    <CheckpointReplyProvider value={checkpointReply}>
      <div className={shellClass} style={shellStyle}>
        <Rail
          onOpenSettings={() => openSettings(settingsGroup)}
          onSelectTask={() => setSettingsOpen(false)}
          settingsOpen={settingsOpen}
        />

        {taskSidebar ? (
          <Sidebar
            actions={actions}
            onExportSession={session => {
              if (session.projectId !== state.inboxProject?.id && !state.projects.some(project => project.id === session.projectId)) { actions.toast(TEXT.researchPackage.sourceUnavailable, "error"); return; }
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
                  // A search keeps running after the turn that started it, so its
                  // card is the last thing the conversation produced. It draws
                  // nothing at all for a session that has no searches.
                  evolve={<EvolveRuns onOpen={showEvolveRun} runs={evolve.runs} />}
                  loading={state.loadingSession}
                  onDecidePermission={decidePermission}
                  onOpenSubagent={openSubagentDetails}
                  onOpenTool={openToolDetails}
                  onBranch={isEvidenceSessionReadOnly(state.detail) || state.running ? undefined : messageId => setPackageRequest({ kind: "branch", sessionId: state.detail?.id, projectId: state.detail?.projectId, messageId })}
                  onReferenceClick={openReference}
                  pending={state.pendingMessage}
                  replays={state.replays}
                  run={state.run}
                  workspaceFiles={state.panelFiles}
                />
              </CheckpointRefusedProvider>
              {isEvidenceSessionReadOnly(state.detail) ? null : <Composer {...composerProps} />}
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
          task={evolveRun === undefined ? undefined : <EvolveDetail
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

      {evolveCreate === undefined ? null : (
        <EvolveCreateDialog
          archived={state.detail?.archivedAt !== undefined}
          error={evolve.error}
          initialAlgorithm={evolveCreate.algorithm}
          initialCheckpointMode={evolveCreate.checkpointMode}
          initialGoal={evolveCreate.goal}
          initializing={evolve.initializing}
          onClose={closeEvolveCreate}
          onInitialize={() => void evolve.initialize()}
          onSend={(command) => {
            closeEvolveCreate();
            // The flags become a token in the composer and the goal becomes
            // the sentence after it. The message leaves when the user says so,
            // not when the dialog closes: the design usually needs a sentence
            // of its own added after the goal.
            const draft = splitEvolveCommand(command);
            setSeededCommand({ command: draft.command, nonce: Date.now(), text: draft.goal });
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

      <FeedbackDialog />
    </CheckpointReplyProvider>
  );
}
