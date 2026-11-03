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
import { isEvolveRunActive } from "@sciencediscovery/schema";

import { ApiClient } from "./api/client.js";
import { getSubagent } from "./api/sessions.js";
import type { Subagent, SubagentStep } from "./api/types.js";
import { CATALOG_FAILURES_BEFORE_STALE, createCatalogPoll } from "./app/catalog-poll.js";
import type { GuideStep } from "./app/guide.js";
import { isEmptyTranscript, landingKey, type LandingSeed } from "./app/landing.js";
import { useJiuwenReadiness, jwReadyFromBridge, wizardIntroHandled } from "./app/shell-bridge.js";
import type { ToolDetail } from "./app/tool-io.js";
import { followSubagent } from "./app/follow-subagent.js";
import { useFileDrop } from "./app/use-file-drop.js";
import { useLanguage } from "./app/use-language.js";
import { usePanelWidth } from "./app/use-panel-width.js";
import { useWorkspace } from "./app/use-workspace.js";
import { formatByteLimit } from "./app/upload.js";
import { evolveCommandCheckpointMode, evolveCommandGoal } from "./evolve/command.js";
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
import { AuthScreen } from "./views/AuthScreen.js";
import { CheckpointReplyProvider, type CheckpointReply } from "./views/CheckpointCard.js";
import { Composer } from "./views/Composer.js";
import { ConfirmDialog } from "./views/ConfirmDialog.js";
import { Conversation } from "./views/Conversation.js";
import { EvolveCreateDialog } from "./views/evolve/EvolveCreateDialog.js";
import { EvolveOverlay } from "./views/evolve/EvolveOverlay.js";
import { EvolveShelf } from "./views/evolve/EvolveShelf.js";
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

  /** The runtime and the open Session's searches. The shelf reads `runs`
   *  directly, which is why the hook exists at this level rather than inside
   *  the panel: the searches must stay reachable while the panel is closed. */
  const evolve = useEvolve(client, state.sessionId);
  const refreshEvolve = evolve.refresh;
  /** Which search the panel is showing, by id. Storing the id rather than the
   *  record keeps the panel reading the same list the shelf does, so a status
   *  that moves while the panel is open changes both at once. */
  const [evolveRunId, setEvolveRunId] = useState<string>();
  /** The create dialog, open with a typed goal when the command was diverted
   *  here because the runtime is not ready. */
  const [evolveCreate, setEvolveCreate] = useState<{
    checkpointMode?: "auto" | "confirm";
    goal?: string;
  } | undefined>();

  // An open panel belongs to one session's searches, like a selected
  // subagent. The create dialog is deliberately left alone: it starts a run
  // in whichever session is open when it sends, and the session the app is
  // opening as it boots is not a reason to close a dialog the user just opened.
  useEffect(() => {
    setEvolveRunId(undefined);
  }, [state.sessionId]);

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

  const evolveRun = evolve.runs.find((run) => run.id === evolveRunId);
  const evolveLive = evolve.runs.some((run) => isEvolveRunActive(run.status));

  /** The header button goes to the search that wants attention — a running
   *  one, else the newest — and starts one only when the session has none. */
  const openEvolve = () => {
    const target = evolve.runs.find((run) => isEvolveRunActive(run.status)) ?? evolve.runs[0];
    if (target === undefined) setEvolveCreate({});
    else setEvolveRunId(target.id);
  };

  /** The command is a way into the surface, not only a message. While the
   *  runtime is not ready the goal typed after it is carried into the setup
   *  dialog instead of being sent to a server that cannot run it; a bare
   *  command opens the dialog that asks for one. */
  const sendMessage = (content: string) => {
    const goal = evolveCommandGoal(content);
    if (goal !== undefined && (goal === "" || evolve.status.state !== "ready")) {
      setEvolveCreate({
        checkpointMode: evolveCommandCheckpointMode(content),
        goal: goal === "" ? undefined : goal,
      });
      return;
    }
    void actions.send(content);
  };

  const closeEvolveCreate = () => setEvolveCreate(undefined);

  /** Text a checkpoint card puts in the composer. It replaces the draft
   *  rather than appending to it, the way a starter prompt does: the press is
   *  "I want to change this step", not "add a sentence to what I was typing".
   *  The nonce makes the same sentence land twice — choosing the same card
   *  again is still a choice. */
  const [composerSeed, setComposerSeed] = useState<LandingSeed>();
  const seedNonce = useRef(0);
  /** The current `sendMessage`, read at press time. Holding it in a ref is
   *  what lets the provider's value stay stable while a run streams: a value
   *  rebuilt on every event would re-render every checkpoint card in the
   *  transcript on every delta. */
  const latestSend = useRef(sendMessage);
  useEffect(() => {
    latestSend.current = sendMessage;
  });
  const checkpointReply = useMemo<CheckpointReply>(() => ({
    busy: state.running,
    draft: (text) => {
      seedNonce.current += 1;
      setComposerSeed({ nonce: seedNonce.current, text });
    },
    reply: (text) => latestSend.current(text),
  }), [state.running]);

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
    onSend: sendMessage,
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
            evolveLive={evolveLive}
            onEvolve={openEvolve}
            onExpandSidebar={expandSidebar}
            onToggleWorkspace={() => setWorkspaceOpen(true)}
            // A Session outside every Project is not "in 最近会话": that is
            // the column's name for the list, not a place to print beside the
            // title, so the bar carries no Project at all for one.
            projectName={state.activeProject?.kind === "inbox" ? undefined : state.activeProjectName}
            sidebarCollapsed={showExpand}
            workspaceOpen={workspaceOpen}
          />
          {/* A search keeps running after the turn that started it, so its
              handle belongs to the session rather than to the transcript. The
              shelf draws nothing at all for a session that has none. */}
          <EvolveShelf
            onNew={() => setEvolveCreate({})}
            onOpen={setEvolveRunId}
            runs={evolve.runs}
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
              <Composer {...composerProps} seed={composerSeed} />
            </>
          )}
        </main>

        <WorkspacePanel
          actions={actions}
          activeGroup={panelGroup}
          files={state.panelFiles}
          onCloseDetail={closePanelDetail}
          onCollapse={collapsePanel}
          onSelectGroup={setPanelGroup}
          outputs={state.outputs}
          resize={resize}
          sessionId={state.sessionId}
          sessions={state.recent}
          subagent={openSubagent}
          subagentLoading={subagentLoading && (openSubagent?.steps.length ?? 0) === 0}
          subagentStale={subagentStale}
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

      {evolveRun === undefined ? null : (
        <EvolveOverlay
          client={client}
          onClose={() => setEvolveRunId(undefined)}
          onError={(message) => actions.toast(message, "error")}
          onRunChanged={() => void refreshEvolve()}
          run={evolveRun}
        />
      )}

      {evolveCreate === undefined ? null : (
        <EvolveCreateDialog
          archived={state.detail?.archivedAt !== undefined}
          error={evolve.error}
          initialCheckpointMode={evolveCreate.checkpointMode}
          initialGoal={evolveCreate.goal}
          initializing={evolve.initializing}
          onClose={closeEvolveCreate}
          onInitialize={() => void evolve.initialize()}
          onSend={(command) => {
            closeEvolveCreate();
            void actions.send(command);
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
