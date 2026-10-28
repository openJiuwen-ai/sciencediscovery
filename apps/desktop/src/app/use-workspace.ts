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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { artifactName } from "./artifact-labels.js";
import { resolveCatalog, resolveConnection } from "./bootstrap.js";
import { changedFiles } from "./file-changes.js";
import { changesPanel, createPanelRefresh, type PanelRefresh } from "./panel-refresh.js";
import { fileName } from "./paths.js";
import { byRecency, reusableDraft, resumeOnBoot } from "./session-order.js";
import { sessionTitle } from "./session-title.js";
import { formatByteLimit, splitBySize } from "./upload.js";
import {
  closeTab as closeTabIn,
  initialTabState,
  patchVersion,
  placeDocument,
  type DocumentRequest,
  type PreviewSlot,
  type TabState,
} from "./preview-tabs.js";
import { ApiClient, isAbortError, isAuthFailure } from "../api/client.js";
import { getHealth, getSettings, listModels, listProviders, setGlobalModel } from "../api/models.js";
import {
  cancelCurrentRun,
  createProject as createProjectRequest,
  createSession,
  deleteSession,
  ensureInbox,
  getSession,
  getWorkspaceUploadLimit,
  listArtifactOutputs,
  listProjects,
  listRuns,
  listSessions,
  listWorkspaceFiles,
  readArtifactVersion,
  readWorkspaceFile,
  updateSession,
  uploadWorkspaceFiles,
} from "../api/sessions.js";
import { decidePermissionRequest } from "../api/permissions.js";
import { listRunEvents, streamMessage, subscribeRunEvents, type RunEventHandler } from "../api/stream.js";
import type {
  ApprovalMode,
  ModelProfile,
  ModelProvider,
  ModelProviderPreset,
  PermissionDecision,
  Project,
  Session,
  SessionArtifactOutput,
  SessionDetail,
  SessionRun,
  SessionRunStatus,
  WorkspaceFile,
} from "../api/types.js";
import { closeRunStream, reduceRunStream } from "../run-stream/reducer.js";
import { emptyRunStream, isTerminalRunStatus, type RunStreamState } from "../run-stream/model.js";
import { foldRunRecords, replayRun, type RunReplay } from "../run-stream/replay.js";
import { TEXT } from "../text.js";

/** A run in one of these states has not finished. `blocked` counts: the model
 *  is waiting on a permission decision, so the turn is still open. */
const ACTIVE_RUN_STATUSES: readonly SessionRunStatus[] = ["blocked", "queued", "running"];

export type BootState = "auth" | "loading" | "offline" | "ready" | "setup";
export type Connection = "degraded" | "offline" | "online";

export interface Toast {
  id: number;
  message: string;
  tone: "error" | "info";
}

/** Names the consequence rather than asking "are you sure?". */
export interface ConfirmRequest {
  accept: string;
  body: string;
  eyebrow?: string;
  onAccept: () => void | Promise<void>;
  title: string;
}

/** The composer's optimistic echo of the message being sent. It is replaced by
 *  the server's persisted copy at the post-run refresh, so the timeline shows
 *  the question while it is still streaming. */
export interface PendingMessage {
  content: string;
}

export type { PreviewSlot, TabState } from "./preview-tabs.js";

export interface WorkspaceState {
  /** The Project the open Session belongs to, or the inbox while no Session is
   *  open. Settings read this to know which Project they are editing. */
  activeProject?: Project;
  /** The project new sessions land in. */
  activeProjectId?: string;
  /** Its name, which the composer and the Session bar show. The inbox is titled
   *  with the interface's own word for it, never with the stored name. */
  activeProjectName?: string;
  connection: Connection;
  confirm: ConfirmRequest | undefined;
  defaultModelId?: string;
  detail?: SessionDetail;
  /** Counts the drafts started since the app opened. Two consecutive drafts
   *  share no Session id, so this is what tells them apart. */
  draftEpoch: number;
  /** The Project standalone conversations live in. It is a Project like any
   *  other — settings, runner allowlist, workspace — that the server keeps out
   *  of `GET /api/projects` and hands out through `POST /api/inbox`. */
  inboxProject?: Project;
  /** Every finished run of the open session, rebuilt from its events, oldest
   *  first. The transcript renders each in the place of the answer it wrote —
   *  the persisted transcript has no thinking, so a run that is not replayed
   *  shows a bare answer with none of the work that produced it behind it. */
  replays: RunReplay[];
  loadingSession: boolean;
  models: ModelProfile[];
  outputs: SessionArtifactOutput[];
  panelFiles: WorkspaceFile[];
  pendingMessage?: PendingMessage;
  /** What the model form needs to build a provider: the server's presets
   *  (which carry the protocol and variant) and the saved providers (which it
   *  updates instead of duplicating). */
  presets: ModelProviderPreset[];
  /** The Projects the user made, oldest first. The inbox is not here. */
  projects: Project[];
  providers: ModelProvider[];
  /** The inbox's Sessions, newest first — the sidebar's 最近会话 section. */
  recent: Session[];
  /** The run that is streaming right now, or the one that was still going when
   *  the session was opened. Finished runs are not here — they are in
   *  `replays`, which is what puts each of them back in its own place. */
  run: RunStreamState;
  running: boolean;
  selectedModelId?: string;
  sessionId?: string;
  /** Every Project's Sessions, keyed by Project id and including the inbox.
   *  The sidebar reads a Project's list from here; `recent` is the inbox's
   *  slice of it. */
  sessionsByProject: Record<string, Session[]>;
  tabs: TabState;
  toasts: Toast[];
  /** The per-file upload ceiling `/api/health` reported, in bytes. `undefined`
   *  while it is unknown, which is not the same as no limit. */
  uploadLimit?: number;
  /** True while a batch of files is being sent, so the composer can say so and
   *  a second drop cannot start a second upload. */
  uploading: boolean;
}

export interface WorkspaceActions {
  /** Returns true when the close emptied the panel, which collapses it. */
  closeTab: (tabId: string) => boolean;
  /** Opens the confirmation dialog. Exposed so a settings row can route its own
   *  destructive action through the same dialog instead of growing a second one. */
  confirmAction: (request: ConfirmRequest) => void;
  /** Answer one authorization request raised by the running turn. */
  decidePermission: (requestId: string, decision: PermissionDecision) => Promise<void>;
  /** Opens the confirmation dialog; the deletion itself happens on accept. */
  deleteSession: (session: Session) => void;
  dismissConfirm: () => void;
  dismissToast: (id: number) => void;
  finishSetup: () => void;
  /** Make a Project from a name alone and open the Session the server creates
   *  with it — the sidebar's 新建项目. */
  createProject: (name: string) => Promise<void>;
  /** Start a Session in `projectId`, or in the inbox when it is omitted. The
   *  Session is written at click time, as the button has always done. */
  newSession: (projectId?: string) => void;
  /** Point the next conversation at `projectId`, or at the inbox (`undefined`),
   *  without writing anything: the welcome page's project picker. The Session
   *  is created by the first message, as it would be from an untouched draft. */
  selectProject: (projectId?: string) => void;
  openArtifact: (output: SessionArtifactOutput) => Promise<void>;
  openFile: (file: WorkspaceFile) => Promise<void>;
  /** Put another version of the artifact an open tab is showing on screen. The
   *  tab itself stays where it is — see `selectArtifactVersion`. */
  selectArtifactVersion: (tabId: string, output: SessionArtifactOutput) => Promise<void>;
  selectPanelTab: (tabId: string) => void;
  /** `projectId` is the Project the row came from: naming it lets the app file
   *  later writes under it before the Session read comes back. */
  openSession: (sessionId: string, projectId?: string) => Promise<void>;
  renameSession: (session: Session, title: string) => Promise<void>;
  /** Re-read the model catalog after the wizard or settings changed it. */
  refreshCatalog: () => Promise<void>;
  retryBoot: () => void;
  selectModel: (modelId: string) => Promise<void>;
  send: (content: string) => Promise<void>;
  /** Set how the open session handles approvals. The server accepts this on its
   *  own, so the composer's permission picker does not have to resend anything
   *  else about the session. */
  setApprovalMode: (mode: ApprovalMode) => Promise<void>;
  /** Bind an expert to the open session, or clear it with `undefined`. Like the
   *  permission mode, the choice lives on the session, so there is nothing to
   *  write before one exists. */
  selectSpecialist: (specialistId?: string) => Promise<void>;
  /** Change the global default from 设置 › 模型. Distinct from `selectModel`,
   *  which points the *open* session at a profile without touching the default
   *  that future sessions inherit. */
  setDefaultModel: (modelId: string) => Promise<void>;
  stop: () => Promise<void>;
  toast: (message: string, tone?: Toast["tone"]) => void;
  /** Put files in the open session's workspace, opening a session first if the
   *  app has none. Resolves true when at least one file was written — the
   *  caller uses that to show where it went rather than opening the workspace
   *  over an upload that never happened. */
  uploadFiles: (files: File[]) => Promise<boolean>;
}

export interface WorkspaceHandle {
  actions: WorkspaceActions;
  boot: BootState;
  state: WorkspaceState;
}

function isActiveRun(status: SessionRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim() !== "") return reason.message;
  return TEXT.errors.generic;
}

/** A rebuilt set of run replays, stamped with the session epoch it was read in
 *  so a batch that outlived its session cannot be committed. */
interface ReplayBatch {
  epoch: number;
  replays: RunReplay[];
}

/**
 * All of this app's state, in one place.
 *
 * A state library would be the usual answer, but there is one screen and one
 * subscriber, so a hook is the whole requirement — and it keeps the ordering
 * rules (bootstrap before sessions, run before refresh) in one file rather
 * than spread across reducers.
 *
 * Two server behaviours shape the run handling:
 *  - The `POST /messages` response closes when the run reaches a terminal
 *    status, so the end of the response body IS the end of the run.
 *  - A client disconnect cancels nothing. Only an explicit cancel route stops
 *    a run, which is why leaving a session mid-run is refused rather than
 *    silently abandoned.
 */
export function useWorkspace(client: ApiClient, onAuthRejected: () => void): WorkspaceHandle {
  const [boot, setBoot] = useState<BootState>("loading");
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<Connection>("online");
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [inboxProject, setInboxProject] = useState<Project>();
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, Session[]>>({});
  const [sessionId, setSessionId] = useState<string>();
  // A draft has no Session to be named by, and the welcome page has to be able
  // to tell one draft from the next — see `landingKey`.
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [detail, setDetail] = useState<SessionDetail>();
  const [loadingSession, setLoadingSession] = useState(false);
  const [models, setModels] = useState<ModelProfile[]>([]);
  const [presets, setPresets] = useState<ModelProviderPreset[]>([]);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [defaultModelId, setDefaultModelId] = useState<string>();
  const [selectedModelId, setSelectedModelId] = useState<string>();
  const [run, setRun] = useState<RunStreamState>(emptyRunStream);
  const [running, setRunning] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<PendingMessage>();
  const [replays, setReplays] = useState<RunReplay[]>([]);
  const [outputs, setOutputs] = useState<SessionArtifactOutput[]>([]);
  const [panelFiles, setPanelFiles] = useState<WorkspaceFile[]>([]);
  const [tabs, setTabs] = useState<TabState>(initialTabState);
  /** The documents on screen, for the refresh that runs outside a render. */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirm, setConfirm] = useState<ConfirmRequest>();
  const [uploading, setUploading] = useState(false);
  /** The per-file ceiling `/api/health` reported. `undefined` means the service
   *  did not say, which is not the same as "no limit" — see `splitBySize`. */
  const [uploadLimit, setUploadLimit] = useState<number | undefined>(undefined);

  // Mirrors for the async paths. A run's own callbacks outlive the render that
  // started them, so they cannot close over the state they need to read.
  const sessionRef = useRef<string | undefined>(undefined);
  const projectRef = useRef<string | undefined>(undefined);
  /** The listing 新建会话 reads to decide whether the empty page it would
   *  write already exists. A mirror for the same reason as the rest: the
   *  callback runs long after the render that made it. */
  const sessionsByProjectRef = useRef<Record<string, Session[]>>({});
  /** The inbox, for the paths that write a Session before a render can hand
   *  them one. `refreshSessionLists` is the only reader that may not fail. */
  const inboxRef = useRef<Project | undefined>(undefined);
  const defaultModelRef = useRef<string | undefined>(undefined);
  const selectedModelRef = useRef<string | undefined>(undefined);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const runRef = useRef<RunStreamState>(emptyRunStream());
  const replaysRef = useRef<RunReplay[]>([]);
  /** Bumped every time the open session goes away. Reading a session's runs is
   *  a batch of requests, and one can still be in flight when another session
   *  is opened; only the batch belonging to the current epoch may be committed. */
  const replayEpoch = useRef(0);
  const toastSeq = useRef(0);
  /** The Session the app is creating right now. A second click, or a send that
   *  races the click, joins that write instead of making a second Session —
   *  but only when it asks for the same Project: 新增会话 in one Project and a
   *  `+` on another are two different Sessions. */
  const sessionCreation = useRef<
    { projectId: string; promise: Promise<string | undefined>; token: object } | undefined
  >(undefined);
  /** Whether startup has already opened the Session it resumes. Resuming is a
   *  one-time event: a later listing must not pull the user out of a draft they
   *  went back to on purpose (a deletion, 新增会话 before its creation lands). */
  const resumed = useRef(false);
  /** Bumped whenever the open Session is replaced — opened or started fresh.
   *  A create still in flight may only adopt its Session while this matches, so
   *  a slow write cannot pull the view back from one the user has since opened. */
  const viewEpoch = useRef(0);

  sessionRef.current = sessionId;
  projectRef.current = activeProjectId;
  inboxRef.current = inboxProject;
  sessionsByProjectRef.current = sessionsByProject;
  defaultModelRef.current = defaultModelId;
  selectedModelRef.current = selectedModelId;

  const toast = useCallback((message: string, tone: Toast["tone"] = "error") => {
    const id = (toastSeq.current += 1);
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((entry) => entry.id !== id)),
      tone === "error" ? 8000 : 4000,
    );
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const report = useCallback(
    (reason: unknown) => {
      if (isAuthFailure(reason)) {
        onAuthRejected();
        return;
      }
      toast(errorMessage(reason));
    },
    [onAuthRejected, toast],
  );

  /** The run state is written through one funnel so `runRef` can never drift
   *  from it — several async paths read it outside a render. */
  const updateRun = useCallback((next: (current: RunStreamState) => RunStreamState) => {
    runRef.current = next(runRef.current);
    setRun(runRef.current);
  }, []);

  const resetRun = useCallback(() => updateRun(() => emptyRunStream()), [updateRun]);

  /**
   * Rebuild every finished run of the open session, in the order the server
   *  listed them (`listRuns` orders by `queueOrder`, oldest first, which is also
   *  the order the transcript needs).
   *
   * A session holds one run per turn taken, and each is replayed into a state
   * of its own rather than folded into a single one — see `RunReplay`. The
   * reading is deliberately incremental: a run already held is reused instead
   * of re-read, because a finished run's events never change and `settle` runs
   * after every message.
   *
   * Which runs are worth holding, and which of them may take a message's place,
   * is `replayRun`'s call — see it. The case it guards is a run recorded before
   * events were persisted: its replay is empty, so its stored answer is the only
   * account of it, and a reconstruction with nothing in it must not hide it.
   */
  const buildReplays = useCallback(
    async (target: string, runs: SessionRun[]): Promise<ReplayBatch> => {
      const epoch = replayEpoch.current;
      const held = new Map(replaysRef.current.map((replay) => [replay.runId, replay]));
      const missing = runs.filter((entry) => isTerminalRunStatus(entry.status) && !held.has(entry.id));
      if (missing.length > 0) {
        const rebuilt = await Promise.all(
          missing.map(async (entry): Promise<RunReplay | undefined> => {
            try {
              return replayRun(entry, foldRunRecords(await listRunEvents(client, target, entry.id, 0)));
            } catch {
              // A run the server kept no events for. Its stored answer stands.
              return undefined;
            }
          }),
        );
        for (const replay of rebuilt) if (replay) held.set(replay.runId, replay);
      }
      return { epoch, replays: runs.flatMap((entry) => held.get(entry.id) ?? []) };
    },
    [client],
  );

  /** Land a rebuilt batch — unless the session it was read for is already gone,
   *  in which case the reads were wasted but harmless. */
  const commitReplays = useCallback((target: string, batch: ReplayBatch) => {
    if (batch.epoch !== replayEpoch.current || sessionRef.current !== target) return;
    replaysRef.current = batch.replays;
    setReplays(batch.replays);
  }, []);

  // ── bootstrap ────────────────────────────────────────────────────────────
  // Health first: it is the one route ahead of the token gate, so it separates
  // "the backend is not up" from "the backend rejected the credential".
  useEffect(() => {
    let cancelled = false;
    setBoot("loading");
    // With no credential there is nothing to check: the app is showing the
    // gate, and firing a request only to be refused would turn "paste your
    // token" into "the token was rejected" — the wrong thing to ask of a
    // first visit. Health is public, but everything behind it is not.
    if (client.token === "") return undefined;
    void (async () => {
      try {
        const health = await getHealth(client);
        if (cancelled) return;
        setConnection(resolveConnection(health));
      } catch (reason) {
        if (cancelled) return;
        if (isAuthFailure(reason)) {
          onAuthRejected();
          return;
        }
        setConnection("offline");
        setBoot("offline");
        return;
      }
      try {
        // The provider catalog is only needed by the two screens that configure
        // a model. A failure there must not block a workspace that would
        // otherwise work, so it degrades to an empty list instead of an offline
        // screen.
        const [profiles, settings, catalog] = await Promise.all([
          listModels(client),
          getSettings(client),
          listProviders(client).catch(() => ({ presets: [], providers: [] })),
        ]);
        if (cancelled) return;
        setModels(profiles);
        setPresets(catalog.presets);
        setProviders(catalog.providers);
        const decision = resolveCatalog(profiles, settings.overrides);
        if (decision.boot === "setup") {
          setBoot("setup");
          return;
        }
        setDefaultModelId(decision.defaultModelId);
        setSelectedModelId(decision.defaultModelId);
        if (decision.adopt !== undefined) await setGlobalModel(client, decision.adopt);
        if (cancelled) return;
        setBoot("ready");
      } catch (reason) {
        if (cancelled) return;
        if (isAuthFailure(reason)) {
          onAuthRejected();
          return;
        }
        setConnection("offline");
        setBoot("offline");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, client, onAuthRejected]);

  const retryBoot = useCallback(() => setAttempt((current) => current + 1), []);

  /**
   * Re-read the model catalog.
   *
   * Called after the model form writes anything, so the new profile shows up in
   * the composer's list. The default is read back from the server too, so the
   * card's 默认 tag follows a write the form just made; merely adding a profile
   * changes nothing, because the server's default is still the old one. When
   * the stored default names no profile at all it falls back to the first,
   * which is the only case where the catalog itself decides.
   */
  const refreshModels = useCallback(
    async (withProviders = false) => {
      try {
        const [profiles, settings, catalog] = await Promise.all([
          listModels(client),
          withProviders ? getSettings(client).catch(() => undefined) : Promise.resolve(undefined),
          withProviders
            ? listProviders(client).catch(() => ({ presets: [], providers: [] }))
            : Promise.resolve(undefined),
        ]);
        setModels(profiles);
        if (catalog) {
          setPresets(catalog.presets);
          setProviders(catalog.providers);
        }
        const current = defaultModelRef.current;
        const stored = settings?.overrides.modelId;
        if (stored !== undefined && profiles.some((profile) => profile.id === stored)) {
          setDefaultModelId(stored);
          return;
        }
        const fallback = profiles[0]?.id;
        if (fallback !== undefined && !profiles.some((profile) => profile.id === current)) {
          setDefaultModelId(fallback);
          setSelectedModelId(fallback);
        }
      } catch (reason) {
        report(reason);
      }
    },
    [client, report],
  );

  // ── projects and session lists ───────────────────────────────────────────
  /**
   * Artifacts read per Session, and the set of reads already in flight.
   *
   * The panel lists every Session's output, not only the open one's. A Session
   * cannot gain an artifact while it is not open — a run writes into the open
   * Session — so its list is read once and then kept; only the open Session is
   * re-read, by `refreshPanel`.
   */
  const artifactsBySession = useRef<Record<string, SessionArtifactOutput[]>>({});
  const artifactsReading = useRef(new Set<string>());

  const publishArtifacts = useCallback(() => {
    setOutputs(Object.values(artifactsBySession.current).flat());
  }, []);

  const readSessionArtifacts = useCallback(
    (target: string) => {
      if (artifactsBySession.current[target] !== undefined) return;
      if (artifactsReading.current.has(target)) return;
      artifactsReading.current.add(target);
      void listArtifactOutputs(client, target)
        .then((list) => {
          artifactsBySession.current[target] = list;
          publishArtifacts();
        })
        .catch(() => {
          // The panel is secondary. The next listing — a run, an upload, a
          // session action — tries this one again.
        })
        .finally(() => artifactsReading.current.delete(target));
    },
    [client, publishArtifacts],
  );

  /** Forget what a Session that is gone had listed. An artifact another Session
   *  also wrote survives under the Session that made it — only the deleted
   *  Session's versions leave. */
  const pruneArtifacts = useCallback(
    (sessions: readonly Session[]) => {
      const live = new Set(sessions.map((session) => session.id));
      let dropped = false;
      for (const id of Object.keys(artifactsBySession.current)) {
        if (live.has(id)) continue;
        delete artifactsBySession.current[id];
        dropped = true;
      }
      if (dropped) publishArtifacts();
    },
    [publishArtifacts],
  );

  /** Re-read the sidebar's list. Returns every Session it now holds, so the
   *  caller can act on the same snapshot the list was built from — `undefined`
   *  when the listing failed, which is not the same as an empty workspace.
   *
   * The inbox is read alongside the user's Projects even though the server
   * leaves it out of `GET /api/projects`: this map is replaced whole on every
   * refresh (after each create, rename and delete), so a listing that skipped
   * it would empty 最近会话 the first time the user did anything. */
  const refreshSessionLists = useCallback(async (): Promise<Session[] | undefined> => {
    try {
      const inbox = inboxRef.current ?? (await ensureInbox(client));
      if (inboxRef.current === undefined) {
        inboxRef.current = inbox;
        setInboxProject(inbox);
      }
      const known = await listProjects(client);
      const entries = await Promise.all(
        [...known, inbox].map(async (project) => [project.id, await listSessions(client, project.id)] as const),
      );
      setProjects(known);
      const sessions = entries.flatMap(([, list]) => list);
      setSessionsByProject(Object.fromEntries(entries));
      // The artifact list spans Sessions; read the ones this app has not seen,
      // and forget the ones the listing no longer has.
      pruneArtifacts(sessions);
      for (const session of sessions) readSessionArtifacts(session.id);
      return sessions;
    } catch (reason) {
      report(reason);
      return undefined;
    }
  }, [client, pruneArtifacts, readSessionArtifacts, report]);

  /**
   * Create a Session in the current Project and make it the open one.
   *
   * The one implementation for both paths that need it, 新增会话 and the first
   * write from a draft. It writes to the server — the sidebar lists Sessions
   * that exist, so a draft that only becomes real on the next keystroke is a
   * button that appears to do nothing until the message, which then looks like
   * it created a second Session beside the one already listed. Creating on the
   * click keeps the list and the composer talking about the same Session from
   * the start.
   *
   * Returns `undefined` when no session could be had, having already reported
   * why; the caller has nothing useful left to do.
   */
  const createOpenSession = useCallback((): Promise<string | undefined> => {
    const projectId = projectRef.current;
    if (!projectId) {
      // The inbox is created at boot, so this is only reachable if that write
      // failed. The user has no vocabulary for it, so the error is phrased as
      // the session that could not be created.
      toast(TEXT.errors.sessionCreate);
      return Promise.resolve(undefined);
    }
    const inFlight = sessionCreation.current;
    if (inFlight !== undefined && inFlight.projectId === projectId) return inFlight.promise;
    const epoch = viewEpoch.current;
    const modelId = selectedModelRef.current ?? defaultModelRef.current;
    const token = {};
    const creation = (async () => {
      try {
        const created = await createSession(client, projectId, modelId ? { modelId } : {});
        if (viewEpoch.current === epoch) {
          setSessionId(created.id);
          sessionRef.current = created.id;
          setDetail({ ...created, messages: [] });
        }
        await refreshSessionLists();
        return created.id;
      } catch (reason) {
        report(reason);
        return undefined;
      } finally {
        // Compare tokens rather than clearing blindly: a creation for another
        // Project may have replaced this one while it was in flight.
        if (sessionCreation.current?.token === token) sessionCreation.current = undefined;
      }
    })();
    sessionCreation.current = { projectId, promise: creation, token };
    return creation;
  }, [client, refreshSessionLists, report, toast]);

  /**
   * The session a write should land in, created if the app has none open.
   */
  const ensureSession = useCallback(async (): Promise<string | undefined> => {
    const open = sessionRef.current;
    if (open !== undefined) return open;
    return createOpenSession();
  }, [createOpenSession]);

  const settleTab = useCallback((id: string, patch: Partial<PreviewSlot>) => {
    setTabs((current) => ({
      ...current,
      tabs: current.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
    }));
  }, []);

  /** The workspace listing the panel showed last, and which Session it was
   *  read for. A refresh compares against it to tell which documents on screen
   *  are out of date. */
  const panelListing = useRef<{ files: WorkspaceFile[]; sessionId: string } | undefined>(undefined);

  /** Read an open workspace document again after the run rewrote it.
   *
   * The tree is only the index: a document the user has open in the panel
   * showed the text it had when they opened it, so a run that rewrites that
   * file in place left the document behind the list beside it. Only the files
   * whose size or modification time moved are read, and a read that lands
   * after the tab was closed or replaced finds no tab to fill.
   */
  const reloadOpenFiles = useCallback(
    (target: string, files: readonly WorkspaceFile[]) => {
      if (files.length === 0) return;
      const changed = new Set(files.map((file) => file.path));
      for (const tab of tabsRef.current.tabs) {
        // `loading` means the reader's own click is still fetching this one;
        // its answer is newer than this listing is.
        if (tab.source !== "file" || tab.loading || !changed.has(tab.path)) continue;
        void readWorkspaceFile(client, target, tab.path)
          .then((content) => settleTab(tab.id, { content, error: undefined, loading: false }))
          .catch(() => {
            // The document keeps what it had; the next write reads it again.
          });
      }
    },
    [client, settleTab],
  );

  const refreshPanel = useCallback(
    async (target: string) => {
      // The two halves are independent: an artifact listing that fails must not
      // leave the workspace tree on the files it had before the run.
      const [listed, files] = await Promise.allSettled([
        listArtifactOutputs(client, target),
        listWorkspaceFiles(client, target),
      ]);
      // The panel belongs to the Session it was read for; a read that lands
      // after the user has left it must not fill another Session's panel.
      if (sessionRef.current !== target) return;
      if (listed.status === "fulfilled") {
        artifactsBySession.current[target] = listed.value;
        publishArtifacts();
      }
      if (files.status === "rejected") return;
      const previous = panelListing.current?.sessionId === target ? panelListing.current.files : [];
      panelListing.current = { files: files.value, sessionId: target };
      setPanelFiles(files.value);
      reloadOpenFiles(target, changedFiles(previous, files.value));
    },
    [client, publishArtifacts, reloadOpenFiles],
  );

  // A run publishes artifacts and writes workspace files while it streams, and
  // the panel used to hear about them only when the run ended. `applyEvent`
  // asks for a read on those two events, throttled: the first one lands at
  // once, so a new artifact is listed while the run is still writing, and the
  // rest of the burst collapses into one read per window.
  //
  // The target is kept beside the throttle because `refreshPanel` is bound to
  // one Session; a read scheduled for the Session the user is about to leave
  // must not be fired for the one they moved to. The read itself refuses a
  // mismatch, this is what supplies the Session to ask about.
  const panelRefreshTarget = useRef<string | undefined>(undefined);
  const refreshPanelRef = useRef(refreshPanel);
  refreshPanelRef.current = refreshPanel;
  const panelRefresh = useRef<PanelRefresh | undefined>(undefined);
  if (panelRefresh.current === undefined) {
    panelRefresh.current = createPanelRefresh(() => {
      const target = panelRefreshTarget.current;
      if (target !== undefined) void refreshPanelRef.current(target);
    });
  }

  /**
   * Send files to the open session's workspace, then re-read the panel.
   *
   * The re-read is the point: an upload that only added a toast would leave the
   * workspace tree claiming the files are not there. `refreshPanel` is what the
   * end of a run uses, and it already covers both halves — the tree, and the
   * artifact list, because the route registers each upload as an artifact.
   *
   * An oversized file is dropped here rather than sent to be refused, but only
   * when the server actually told us the ceiling: without it there is nothing to
   * compare against, and a local guess that refuses a file the server would have
   * accepted is a dead end the user cannot get around.
   */
  const uploadFiles = useCallback(
    async (files: File[]): Promise<boolean> => {
      if (files.length === 0) return false;
      const { accepted, oversized } = uploadLimit === undefined
        ? { accepted: files, oversized: [] as File[] }
        : splitBySize(files, uploadLimit);
      const ceiling = uploadLimit === undefined
        ? undefined
        : formatByteLimit(uploadLimit) ?? TEXT.upload.unlimited;
      for (const file of oversized) {
        if (ceiling !== undefined) toast(TEXT.upload.tooLarge(file.name, ceiling));
      }
      if (accepted.length === 0) return false;
      setUploading(true);
      try {
        // Only now, after the local checks: a drop that is going to be refused
        // for its size must not leave an empty session behind.
        const target = await ensureSession();
        if (target === undefined) return false;
        const result = await uploadWorkspaceFiles(client, target, accepted);
        await refreshPanel(target);
        let landed = false;
        for (const item of result.uploaded) {
          // The path, not the name: a collision is renamed on the server, and
          // the name the user chose is then not where the file is.
          if (item.status === "failed") toast(TEXT.upload.failed(item.originalName, item.error ?? TEXT.errors.generic));
          else {
            landed = true;
            toast(TEXT.upload.uploaded(item.path ?? item.originalName), "info");
          }
        }
        for (const entry of result.errors) toast(TEXT.upload.failed(entry.name, entry.error));
        return landed;
      } catch (reason) {
        report(reason);
        return false;
      } finally {
        setUploading(false);
      }
    },
    [client, ensureSession, refreshPanel, report, toast, uploadLimit],
  );

  // ── run stream ───────────────────────────────────────────────────────────
  /** The stream's write into the shared run state, bound to the Session the
   *  run belongs to. Leaving a Session aborts its wire, but events already
   *  decoded can still arrive; they belong to a run that is no longer on
   *  screen and must not be folded into the one that is. */
  const applyEvent = useCallback(
    (target: string): RunEventHandler =>
      (event, sequence) => {
        if (sessionRef.current !== target) return;
        updateRun((current) => reduceRunStream(current, event, sequence));
        // 产物 and the workspace tree are read back from the service rather
        // than folded in from the event: the artifact list spans Sessions and
        // every version, and a read is what keeps it agreeing with the
        // catalog. The event only says that the moment has changed.
        if (changesPanel(event.type)) {
          panelRefreshTarget.current = target;
          panelRefresh.current?.request();
        }
      },
    [updateRun],
  );

  /**
   * Re-read everything a finished run could have changed: the persisted
   * messages (including the server-generated title) and the run list — the
   * only place an assistant message id can be found after the fact.
   *
   * The rebuilt batch and the transcript land in one commit, with the live run
   * cleared alongside them: the run that just ended is in both, and splitting
   * the three would print it twice or leave the answer blinking through its
   * persisted form.
   */
  const settle = useCallback(
    async (target: string) => {
      try {
        const [fresh, runs] = await Promise.all([getSession(client, target), listRuns(client, target)]);
        const batch = await buildReplays(target, runs);
        // `commitReplays` drops a batch read for a Session that is no longer
        // open; the transcript and the live run need the same gate. The reads
        // belong to the Session the run was in — the run keeps going on the
        // server, and coming back resumes it — so writing here would put that
        // Session over the one now on screen. The list below is shared and
        // stays worth refreshing either way.
        commitReplays(target, batch);
        if (sessionRef.current === target) {
          setDetail(fresh);
          resetRun();
        }
      } catch (reason) {
        if (!isAuthFailure(reason) && sessionRef.current === target) report(reason);
      }
      if (sessionRef.current === target) setPendingMessage(undefined);
      await Promise.all([refreshSessionLists(), refreshPanel(target)]);
    },
    [buildReplays, client, commitReplays, refreshPanel, refreshSessionLists, report, resetRun],
  );

  /** Follow an already-existing run. `live` marks it as unfinished, which is
   *  what puts the composer into 停止 state. */
  const follow = useCallback(
    async (target: string, runId: string, live: boolean) => {
      const controller = new AbortController();
      abortRef.current = controller;
      if (live) {
        runningRef.current = true;
        setRunning(true);
      }
      try {
        await subscribeRunEvents(client, target, runId, 0, applyEvent(target), controller.signal);
      } catch (reason) {
        if (isAuthFailure(reason)) {
          onAuthRejected();
        } else if (!isAbortError(reason)) {
          toast(TEXT.conversation.streamEnded);
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = undefined;
        // Leaving the Session aborts this wire but not the wait: by the time
        // the finally lands, `running` and the live run describe whichever
        // Session is on screen. Clearing them here would stop a run this view
        // no longer owns — `clearSession` has already cleared them for the
        // Session being left.
        if (sessionRef.current === target) {
          runningRef.current = false;
          setRunning(false);
          updateRun(closeRunStream);
        }
      }
    },
    [applyEvent, client, onAuthRejected, toast, updateRun],
  );

  // ── sending ──────────────────────────────────────────────────────────────
  const send = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (text === "" || runningRef.current) return;
      // Shown from the press, before the Session exists: the composer clears
      // its box on submit, and a message that disappears for the length of a
      // create request reads as a press that was dropped.
      setPendingMessage({ content: text });
      const session = await ensureSession();
      if (session === undefined) {
        setPendingMessage(undefined);
        return;
      }
      // Creating the Session takes a request, and the view can move on while
      // it does. The message was written for the Session that was on screen;
      // sending it into a different one — or drawing its run there — would be
      // a write the user did not ask for.
      if (sessionRef.current !== session) {
        setPendingMessage(undefined);
        return;
      }
      resetRun();
      runningRef.current = true;
      setRunning(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await streamMessage(client, session, { content: text }, applyEvent(session), controller.signal);
      } catch (reason) {
        if (isAuthFailure(reason)) {
          onAuthRejected();
        } else if (!isAbortError(reason)) {
          // The server keeps the run going; only this view lost the wire.
          report(reason);
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = undefined;
        // A send that was left mid-flight has already had its view cleared by
        // `clearSession`; settling it now would write the old Session's
        // transcript over the one the user has since opened.
        if (sessionRef.current === session) {
          runningRef.current = false;
          setRunning(false);
          updateRun(closeRunStream);
          await settle(session);
        }
      }
    },
    [applyEvent, client, ensureSession, onAuthRejected, report, resetRun, settle, updateRun],
  );

  /**
   * Answer one authorization request.
   *
   * The reply is folded back in through the same reducer as the stream's own
   * `permission.resolved`, so a card settles the same way whether the
   * resolution came over the wire or was made here — the event for a decision
   * made in this window does still arrive, and the merge is idempotent, so
   * folding it twice costs nothing.
   *
   * `allow_matching` decides its siblings server-side, and `resolvedRequests`
   * is what says which. Folding only the clicked request would leave the
   * siblings' buttons live until their own events landed, which is exactly the
   * window in which a second click sends a second decision.
   */
  const decidePermission = useCallback(
    async (requestId: string, decision: PermissionDecision) => {
      try {
        const result = await decidePermissionRequest(client, requestId, decision);
        for (const request of [...result.resolvedRequests, result.request]) {
          updateRun((current) => reduceRunStream(current, { request, type: "permission.resolved" }));
        }
      } catch (reason) {
        report(reason);
      }
    },
    [client, report, updateRun],
  );

  const stop = useCallback(async () => {
    const target = sessionRef.current;
    if (!target) return;
    try {
      const result = await cancelCurrentRun(client, target);
      // Nothing was running any more, so no terminal event is coming and the
      // stream will simply not close the turn for us.
      if (!result.cancelled) await settle(target);
    } catch (reason) {
      report(reason);
    }
  }, [client, report, settle]);

  // ── session lifecycle ────────────────────────────────────────────────────
  const clearSession = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = undefined;
    // The stream whose wire was just cut will not clear these itself — it
    // only writes while its own Session is still the open one — so leaving a
    // run stops the composer here, and the next Session starts from idle.
    runningRef.current = false;
    setRunning(false);
    setDetail(undefined);
    setPendingMessage(undefined);
    // Any batch still being read belongs to the session being left behind.
    replayEpoch.current += 1;
    replaysRef.current = [];
    setReplays([]);
    // Open documents belong to the session's workspace, so leaving the session
    // takes them with it rather than showing another session's file contents.
    setTabs(initialTabState());
    // The artifact list is every Session's, so leaving one empties no more than
    // that Session's group — the others keep their rows without a re-read.
    publishArtifacts();
    setPanelFiles([]);
    // The listing belonged to the Session being left, so the next one starts
    // with nothing to compare against rather than reading its documents as
    // rewritten because the paths happen to collide.
    panelListing.current = undefined;
    // A read waiting for its window to close was scheduled for the Session
    // being left; firing it would only be refused, and leaving it armed would
    // fire it for whichever Session is open by then.
    panelRefresh.current?.cancel();
    panelRefreshTarget.current = undefined;
    resetRun();
  }, [publishArtifacts, resetRun]);

  /** Clear the view back to an empty draft, writing nothing. Used by 新增会话
   *  before it creates, and by a deletion that removed the open Session (there
   *  is nothing to show, and making a replacement session is not this app's
   *  call — the next message will, if the user writes one). */
  const startDraft = useCallback(() => {
    viewEpoch.current += 1;
    clearSession();
    setSessionId(undefined);
    setDraftEpoch((epoch) => epoch + 1);
    sessionRef.current = undefined;
    setSelectedModelId(defaultModelRef.current);
    // A draft is not waiting on anything: an open that was still reading its
    // Session has been abandoned above, and will not clear this itself.
    setLoadingSession(false);
  }, [clearSession]);

  /**
   * The welcome page's project picker: point the *next* conversation
   * somewhere, without writing a Session.
   *
   * Unlike 新建会话 this deliberately creates nothing. The picker is offered
   * on a page that may already hold a Session — 新增会话 creates one and lands
   * on an empty transcript — and choosing a Project there is a correction of
   * where the message is going, not a second Session. So the draft starts
   * over and the first send creates the Session in the chosen Project.
   */
  const selectProject = useCallback(
    (projectId?: string) => {
      const target = projectId ?? inboxRef.current?.id;
      if (target === undefined || target === projectRef.current) return;
      // Refs before state, for the same reason as `newSession`: the next send
      // reads `projectRef`, and state would only land on the next render.
      projectRef.current = target;
      setActiveProjectId(target);
      // Whatever was on screen was started in the Project the user just left.
      // Leaving it behind empty is the cost of a Session this app creates at
      // click time; sending into it would be the wrong Project, and moving the
      // conversation is not something this release does.
      startDraft();
    },
    [startDraft],
  );

  const openSession = useCallback(
    async (id: string, projectId?: string) => {
      // The row's Project is known before the Session is read, so it can be
      // adopted first: a message or an upload started while `getSession` is in
      // flight then lands where the user is looking.
      if (projectId !== undefined) {
        projectRef.current = projectId;
        setActiveProjectId(projectId);
      }
      if (id === sessionRef.current) return;
      viewEpoch.current += 1;
      clearSession();
      setSessionId(id);
      sessionRef.current = id;
      setLoadingSession(true);
      try {
        const [fresh, runs] = await Promise.all([getSession(client, id), listRuns(client, id)]);
        // The user may have opened another Session — or started a new one —
        // while these were in flight. The reads are then wasted, and writing
        // them would show one Session's transcript under another's name.
        if (sessionRef.current !== id) return;
        setDetail(fresh);
        // The listing the row came from is not proof: the Session's own record
        // is what says which Project it is in.
        projectRef.current = fresh.projectId;
        setActiveProjectId(fresh.projectId);
        setSelectedModelId(fresh.modelId ?? defaultModelRef.current);
        void refreshPanel(id);
        setLoadingSession(false);
        // Replaying a run is the only way its thinking block comes back — the
        // persisted transcript has no thinking field at all — so every finished
        // run is rebuilt, and the one still going (if any) streams into `run`.
        // Both start together: `follow` does not return until the run it is
        // watching ends, and awaiting it first would hold the whole transcript
        // back for as long as that run takes. A session may be left mid-run —
        // the run keeps going on the server, and coming back to it resumes the
        // follow below.
        const live = runs.filter((entry) => isActiveRun(entry.status)).at(-1);
        const rebuilt = buildReplays(id, runs).then((batch) => commitReplays(id, batch));
        if (live !== undefined) await follow(id, live.id, true);
        await rebuilt;
      } catch (reason) {
        // A failure for a Session the user has already left is not theirs to
        // see: the one they are on reports its own.
        if (sessionRef.current !== id) return;
        setLoadingSession(false);
        report(reason);
      }
    },
    [buildReplays, clearSession, client, commitReplays, follow, refreshPanel, report],
  );

  /**
   * 新增会话.
   *
   * The click creates the Session now rather than leaving a silent draft: the
   * sidebar lists what the server has, so a draft that only becomes real when
   * the first message arrives makes the button look broken and the message
   * look like it created a Session beside the one already on screen.
   *
   * Unless the empty page is already there. The service names a Session from
   * its first message, so a Session still carrying the untitled sentinel has
   * never been written in — clicking again on it is asking for the page that
   * one already is. Opening it is the whole answer; writing a second one buys
   * the user a row they cannot tell from the first.
   */
  const newSession = useCallback(
    (projectId?: string) => {
      const target = projectId ?? inboxRef.current?.id;
      if (target === undefined) {
        toast(TEXT.errors.sessionCreate);
        return;
      }
      // A creation already in flight for the same Project — a double click, or
      // a send that had to make the session first — will open its session when
      // it lands. Starting a draft now would only make that creation's epoch
      // check discard it. A creation for a *different* Project is left to land
      // on its own: this click is asking for another one.
      if (sessionCreation.current?.projectId === target) return;

      const reusable = reusableDraft(sessionsByProjectRef.current[target] ?? []);
      if (reusable !== undefined) {
        // The listing is a mirror, so the row may be the one already open; the
        // open costs one read, and `openSession` returns before doing even that
        // when the ids match.
        void openSession(reusable.id, target);
        return;
      }

      // Refs go before state on purpose: `projectRef` is otherwise only
      // refreshed by a render, and `createOpenSession` below reads it now.
      projectRef.current = target;
      setActiveProjectId(target);
      startDraft();
      void createOpenSession();
    },
    [createOpenSession, openSession, startDraft, toast],
  );

  /**
   * 新建项目: a Project needs nothing but a name, and the server answers with
   * its first Session. Opening that Session is what keeps a new Project from
   * carrying an untitled Session nobody asked for.
   */
  const createProjectAndOpen = useCallback(
    async (name: string) => {
      try {
        const created = await createProjectRequest(client, name);
        setProjects((current) => [...current, created.project]);
        await openSession(created.firstSession.id, created.project.id);
        await refreshSessionLists();
      } catch (reason) {
        report(reason);
      }
    },
    [client, openSession, refreshSessionLists, report],
  );

  const selectModel = useCallback(
    async (modelId: string) => {
      setSelectedModelId(modelId);
      selectedModelRef.current = modelId;
      const target = sessionRef.current;
      // With no Session yet there is nothing to point at; the choice rides
      // into the Session this app is about to create.
      if (!target) return;
      try {
        await updateSession(client, target, { modelId });
        setDetail((current) => (current ? { ...current, modelId } : current));
      } catch (reason) {
        report(reason);
      }
    },
    [client, report],
  );

  /**
   * Change the open session's approval mode.
   *
   * With no session open there is nothing to write: the choice applies to the
   * session that exists, and a draft inherits the server's default. The reply
   * is read back rather than assumed — the detail is what the composer's
   * picker shows, and a failed write must not leave it claiming a mode the
   * session does not have.
   */
  const setApprovalMode = useCallback(
    async (mode: ApprovalMode) => {
      const target = sessionRef.current;
      if (!target) return;
      try {
        const updated = await updateSession(client, target, { approvalMode: mode });
        setDetail((current) => (current ? { ...current, approvalMode: updated.approvalMode } : current));
      } catch (reason) {
        report(reason);
      }
    },
    [client, report],
  );

  /**
   * Bind an expert to the open session, or unbind it.
   *
   * The reply is read back for the same reason the approval mode's is: the
   * server drops an id it cannot resolve or that is disabled, and the
   * composer's row must not claim an expert the session does not hold.
   */
  const selectSpecialist = useCallback(
    async (specialistId?: string) => {
      const target = sessionRef.current;
      if (!target) return;
      try {
        const updated = await updateSession(client, target, { specialistId: specialistId ?? null });
        setDetail((current) => (current ? { ...current, specialistId: updated.specialistId } : current));
      } catch (reason) {
        report(reason);
      }
    },
    [client, report],
  );

  const setDefaultModel = useCallback(
    async (modelId: string) => {
      try {
        const settings = await setGlobalModel(client, modelId);
        // Read the answer rather than assume it: the server drops a `modelId`
        // it cannot resolve, and a silent no-op here would show a checkmark
        // against a default that never changed.
        if (settings.overrides.modelId !== modelId) {
          report(new Error(TEXT.settings.model.defaultFailed));
          return;
        }
        setDefaultModelId(modelId);
      } catch (reason) {
        report(reason);
      }
    },
    [client, report],
  );

  // ── mutations ────────────────────────────────────────────────────────────
  const confirmAction = useCallback((request: ConfirmRequest) => setConfirm(request), []);
  const dismissConfirm = useCallback(() => setConfirm(undefined), []);

  /** Run one mutation and, when it succeeds, bring the lists back in step.
   *  `dropIfCurrent` is for the operations that remove the open session. */
  const mutate = useCallback(
    async (options: { dropIfCurrent?: boolean; id: string; operation: () => Promise<unknown> }) => {
      try {
        await options.operation();
      } catch (reason) {
        report(reason);
        return;
      }
      if (options.dropIfCurrent && sessionRef.current === options.id) startDraft();
      await refreshSessionLists();
    },
    [refreshSessionLists, report, startDraft],
  );

  /** The same write, gated on the version the read was made for: a pick that
   *  replaces one still in flight must not be overwritten by the older answer. */
  const settleVersion = useCallback((id: string, versionId: string, patch: Partial<PreviewSlot>) => {
    setTabs((current) => patchVersion(current, id, versionId, patch));
  }, []);

  const openPreview = useCallback(
    async (request: DocumentRequest, read: (target: string) => Promise<string>) => {
      // An artifact carries the Session its version was written in: the list
      // shows every Session's output, so the open one is only the fallback.
      const target = request.sessionId ?? sessionRef.current;
      if (!target) return;
      // Placement happens before the read, so the tab appears immediately and
      // the content lands in it when it arrives.
      const placed = placeDocument(tabs.tabs, tabs.activeTabId, request);
      // Already open: the click is a request to look at the document, so its
      // tab takes focus and nothing is read a second time.
      if (placed.reused) {
        setTabs(placed);
        return;
      }
      const openedId = placed.activeTabId;
      // The open read and a version pick can race: the picker can move the tab
      // to another version before this read lands, and the newer choice has to
      // win. A file has no version to hold the tab to, so only an artifact's
      // answer is gated.
      const versionId = request.versionId;
      const settle = (patch: Partial<PreviewSlot>) => {
        if (versionId === undefined) settleTab(openedId, patch);
        else settleVersion(openedId, versionId, patch);
      };
      setTabs(placed);
      try {
        settle({ content: await read(target), loading: false });
      } catch (reason) {
        settle({ error: errorMessage(reason), loading: false });
      }
    },
    [settleTab, settleVersion, tabs.activeTabId, tabs.tabs],
  );

  const openFile = useCallback(
    (file: WorkspaceFile) =>
      openPreview(
        { label: fileName(file.path), path: file.path, source: "file" },
        (target) => readWorkspaceFile(client, target, file.path),
      ),
    [client, openPreview],
  );

  // A row is an artifact, not a version: it opens on the version it shows (the
  // newest), and the picker beside the document reaches the rest. The tab is
  // keyed by the artifact, so clicking the row again lands on the open tab
  // whichever version it has been switched to.
  const openArtifact = useCallback(
    (output: SessionArtifactOutput) =>
      openPreview(
        {
          artifactId: output.artifact.id,
          label: artifactName(output),
          path: output.version.sourcePath ?? "",
          sessionId: output.version.sessionId || undefined,
          source: "artifact",
          versionId: output.version.id,
        },
        (target) => readArtifactVersion(client, target, output.version.id),
      ),
    [client, openPreview],
  );

  /**
   * Show another version of the artifact a tab already holds.
   *
   * The tab keeps its id and its place in the strip: a version is a property of
   * the open document, not something to open beside it. The tab is blanked to
   * its loading state first so the old text never sits under the new version's
   * name, and the read only lands if the tab is still on that version — a
   * second pick while the first is in flight wins.
   */
  const selectArtifactVersion = useCallback(
    async (tabId: string, output: SessionArtifactOutput) => {
      // The version is read through the Session that wrote it: the artifact may
      // have been open since another Session wrote it last.
      const target = output.version.sessionId || sessionRef.current;
      if (!target) return;
      const versionId = output.version.id;
      setTabs((current) => ({
        ...current,
        tabs: current.tabs.map((tab) =>
          tab.id === tabId && tab.artifactId === output.artifact.id
            ? {
                ...tab,
                content: undefined,
                error: undefined,
                loading: true,
                // A version may have been written elsewhere than the one before
                // it, and the preview picks its renderer from this path.
                path: output.version.sourcePath ?? "",
                versionId,
              }
            : tab),
      }));
      try {
        const content = await readArtifactVersion(client, target, versionId);
        settleVersion(tabId, versionId, { content, loading: false });
      } catch (reason) {
        settleVersion(tabId, versionId, { error: errorMessage(reason), loading: false });
      }
    },
    [client, settleVersion],
  );

  const selectPanelTab = useCallback((tabId: string) => {
    setTabs((current) => ({ ...current, activeTabId: tabId }));
  }, []);

  // Closing the last tab leaves a fresh home tab in state and reports that the
  // panel should collapse; re-opening it therefore starts from 新标签页 rather
  // than from whatever was closed.
  const closeTab = useCallback(
    (tabId: string): boolean => {
      const result = closeTabIn(tabs.tabs, tabs.activeTabId, tabId);
      setTabs({ activeTabId: result.activeTabId, tabs: result.tabs });
      return result.collapse;
    },
    [tabs.activeTabId, tabs.tabs],
  );

  const finishSetup = useCallback(() => {
    // Re-runs the bootstrap effect, which is also what loads the Project the
    // first-run wizard could not have seen yet.
    setAttempt((current) => current + 1);
  }, []);

  /** After the model form writes a provider or a profile, both halves of the
   *  catalog are stale: the composer reads `models`, the form reads `providers`. */
  const refreshCatalog = useCallback(() => refreshModels(true), [refreshModels]);

  // ── data loading once the app is usable ──────────────────────────────────
  const usable = boot === "ready";
  useEffect(() => {
    if (!usable) return;
    void (async () => {
      try {
        // The inbox is where a launch with no Project begins. It is created
        // here rather than a Project invented for the user: a fresh install
        // now opens with no Projects at all, and 最近会话 is simply where the
        // first conversation lands.
        const inbox = await ensureInbox(client);
        inboxRef.current = inbox;
        setInboxProject(inbox);
        setProjects(await listProjects(client));
        setActiveProjectId((current) => current ?? inbox.id);
        projectRef.current = projectRef.current ?? inbox.id;
        const listed = await refreshSessionLists();
        // The sidebar now shows Sessions while the composer is still a draft
        // with none behind it. Sending from there would create a second
        // Session beside the one on screen, so the listing opens the most
        // recent one — the same Session a click on that row would open.
        resumeOnBoot({
          // The listing spans every Project, so the Session being resumed need
          // not belong to the one adopted above. Following it there keeps
          // 新增会话 and uploads in the Project the user is looking at.
          adoptProject: (projectId) => {
            setActiveProjectId(projectId);
            projectRef.current = projectId;
          },
          listed,
          open: sessionRef.current,
          opened: resumed,
          openSession: (id) => void openSession(id),
        });
      } catch (reason) {
        report(reason);
      }
    })();
  }, [client, openSession, refreshSessionLists, report, usable]);

  useEffect(() => {
    if (!usable) return;
    void refreshModels();
  }, [refreshModels, usable]);

  // The upload ceiling is a quota setting, so it can only be read from the
  // service. A failure leaves it unknown rather than guessed, and uploading
  // still works — the check it enables is a convenience, not a permission.
  useEffect(() => {
    if (!usable) return;
    void getWorkspaceUploadLimit(client)
      .then((limit) => setUploadLimit(limit))
      .catch(() => setUploadLimit(undefined));
  }, [client, usable]);

  // Unmounting must not leave anything running that the user cannot stop; the
  // stream is dropped, and the backend's own cancel route is the only thing
  // that ends the work itself.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  // 最近会话 is the inbox's own list, not every Session in the workspace: the
  // user's Projects show their Sessions under their own fold.
  const recent = useMemo(
    () => (inboxProject === undefined ? [] : byRecency(sessionsByProject[inboxProject.id] ?? [])),
    [inboxProject, sessionsByProject],
  );

  // Which Project the open Session is in, or the inbox while none is open. The
  // name is derived rather than stored so a rename, a switch and a language
  // change all reach it without a second piece of state to keep in step. The
  // inbox is never shown under its stored name: it is a server label, and the
  // interface has its own word for it.
  const activeProject = activeProjectId === undefined
    ? inboxProject
    : (inboxProject?.id === activeProjectId ? inboxProject : undefined)
      ?? projects.find((project) => project.id === activeProjectId);
  const activeProjectName = activeProject === undefined
    ? undefined
    : activeProject.id === inboxProject?.id
      ? TEXT.sidebar.recent
      : activeProject.name;

  const actions: WorkspaceActions = useMemo(
    () => ({
      closeTab,
      confirmAction,
      createProject: createProjectAndOpen,
      deleteSession: (session) =>
        confirmAction({
          accept: TEXT.menu.delete,
          // The name the user is looking at, not the one the service stored:
          // an unnamed Session is filed under an English sentinel, and the
          // dialog asking to delete it is interface text.
          body: TEXT.errors.deleteWarning(sessionTitle(session.title)),
          eyebrow: TEXT.menu.delete,
          onAccept: () =>
            mutate({ dropIfCurrent: true, id: session.id, operation: () => deleteSession(client, session.id) }),
          title: sessionTitle(session.title),
        }),
      decidePermission,
      dismissConfirm,
      dismissToast,
      finishSetup,
      newSession,
      openArtifact,
      openFile,
      openSession,
      renameSession: (session, title) =>
        mutate({ id: session.id, operation: () => updateSession(client, session.id, { title }) }),
      refreshCatalog,
      retryBoot,
      selectArtifactVersion,
      selectModel,
      selectPanelTab,
      selectProject,
      selectSpecialist,
      send,
      setApprovalMode,
      setDefaultModel,
      stop,
      toast,
      uploadFiles,
    }),
    [
      closeTab,
      confirmAction,
      createProjectAndOpen,
      decidePermission,
      dismissConfirm,
      dismissToast,
      finishSetup,
      mutate,
      newSession,
      openArtifact,
      openFile,
      openSession,
      refreshCatalog,
      retryBoot,
      selectArtifactVersion,
      selectModel,
      selectPanelTab,
      selectProject,
      selectSpecialist,
      send,
      setApprovalMode,
      setDefaultModel,
      stop,
      toast,
      uploadFiles,
    ],
  );

  const state: WorkspaceState = {
    activeProject,
    activeProjectId,
    activeProjectName,
    connection,
    confirm,
    defaultModelId,
    detail,
    draftEpoch,
    inboxProject,
    loadingSession,
    models,
    outputs,
    panelFiles,
    pendingMessage,
    presets,
    projects,
    providers,
    recent,
    replays,
    run,
    running,
    selectedModelId,
    sessionId,
    sessionsByProject,
    tabs,
    toasts,
    uploadLimit,
    uploading,
  };

  return { actions, boot, state };
}
