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

import { resolveCatalog, resolveConnection } from "./bootstrap.js";
import { fileName } from "./paths.js";
import { byRecency, resumeOnBoot } from "./session-order.js";
import { formatByteLimit, splitBySize } from "./upload.js";
import {
  addTab,
  closeTab as closeTabIn,
  initialTabState,
  placeDocument,
  type DocumentRequest,
  type PreviewSlot,
  type TabState,
} from "./preview-tabs.js";
import { ApiClient, isAbortError, isAuthFailure } from "../api/client.js";
import { getHealth, getSettings, listModels, listProviders, setGlobalModel } from "../api/models.js";
import {
  cancelCurrentRun,
  createProject,
  createSession,
  deleteSession,
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
  /** The project new sessions land in. */
  activeProjectId?: string;
  /** Its name, which the sidebar shows under 科研任务. */
  activeProjectName?: string;
  connection: Connection;
  confirm: ConfirmRequest | undefined;
  defaultModelId?: string;
  detail?: SessionDetail;
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
  providers: ModelProvider[];
  /** Every session this app knows about, newest first. */
  recent: Session[];
  /** The run that is streaming right now, or the one that was still going when
   *  the session was opened. Finished runs are not here — they are in
   *  `replays`, which is what puts each of them back in its own place. */
  run: RunStreamState;
  running: boolean;
  selectedModelId?: string;
  sessionId?: string;
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
  /** Opens another empty tab in the right panel. */
  addPanelTab: () => void;
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
  newSession: () => void;
  openArtifact: (output: SessionArtifactOutput) => Promise<void>;
  openFile: (file: WorkspaceFile) => Promise<void>;
  selectPanelTab: (tabId: string) => void;
  openSession: (sessionId: string) => Promise<void>;
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
  const [activeProjectName, setActiveProjectName] = useState<string>();
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, Session[]>>({});
  const [sessionId, setSessionId] = useState<string>();
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
   *  races the click, joins that write instead of making a second Session. */
  const sessionCreation = useRef<Promise<string | undefined> | undefined>(undefined);
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
  /** Re-read the sidebar's list. Returns every Session it now holds, so the
   *  caller can act on the same snapshot the list was built from — `undefined`
   *  when the listing failed, which is not the same as an empty workspace. */
  const refreshSessionLists = useCallback(async (): Promise<Session[] | undefined> => {
    try {
      const known = await listProjects(client);
      const entries = await Promise.all(
        known.map(async (project) => [project.id, await listSessions(client, project.id)] as const),
      );
      setSessionsByProject(Object.fromEntries(entries));
      return entries.flatMap(([, sessions]) => sessions);
    } catch (reason) {
      report(reason);
      return undefined;
    }
  }, [client, report]);

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
    const inFlight = sessionCreation.current;
    if (inFlight !== undefined) return inFlight;
    const projectId = projectRef.current;
    if (!projectId) {
      // The one project is created at boot, so this is only reachable if that
      // write failed. The user has no vocabulary for it, so the error is
      // phrased as the session that could not be created.
      toast(TEXT.errors.sessionCreate);
      return Promise.resolve(undefined);
    }
    const epoch = viewEpoch.current;
    const modelId = selectedModelRef.current ?? defaultModelRef.current;
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
        // At most one creation is ever in flight — a second caller is handed
        // this promise — so clearing unconditionally cannot drop a newer one.
        sessionCreation.current = undefined;
      }
    })();
    sessionCreation.current = creation;
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

  const refreshPanel = useCallback(
    async (target: string) => {
      try {
        const [nextOutputs, nextFiles] = await Promise.all([
          listArtifactOutputs(client, target),
          listWorkspaceFiles(client, target),
        ]);
        // The panel belongs to the Session it was read for; a read that lands
        // after the user has left it must not fill another Session's panel.
        if (sessionRef.current !== target) return;
        setOutputs(nextOutputs);
        setPanelFiles(nextFiles);
      } catch {
        // The panel is secondary; a failure here must not disturb the run.
      }
    },
    [client],
  );

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
    setOutputs([]);
    setPanelFiles([]);
    resetRun();
  }, [resetRun]);

  /** Clear the view back to an empty draft, writing nothing. Used by 新增会话
   *  before it creates, and by a deletion that removed the open Session (there
   *  is nothing to show, and making a replacement session is not this app's
   *  call — the next message will, if the user writes one). */
  const startDraft = useCallback(() => {
    viewEpoch.current += 1;
    clearSession();
    setSessionId(undefined);
    sessionRef.current = undefined;
    setSelectedModelId(defaultModelRef.current);
    // A draft is not waiting on anything: an open that was still reading its
    // Session has been abandoned above, and will not clear this itself.
    setLoadingSession(false);
  }, [clearSession]);

  /**
   * 新增会话.
   *
   * The click creates the Session now rather than leaving a silent draft: the
   * sidebar lists what the server has, so a draft that only becomes real when
   * the first message arrives makes the button look broken and the message
   * look like it created a Session beside the one already on screen.
   */
  const newSession = useCallback(() => {
    // A creation already in flight — a double click, or a send that had to
    // make the session first — will open its session when it lands. Starting
    // a draft now would only make that creation's epoch check discard it.
    if (sessionCreation.current !== undefined) return;
    startDraft();
    void createOpenSession();
  }, [createOpenSession, startDraft]);

  const openSession = useCallback(
    async (id: string) => {
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

  const settleTab = useCallback((id: string, patch: Partial<PreviewSlot>) => {
    setTabs((current) => ({
      ...current,
      tabs: current.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
    }));
  }, []);

  const openPreview = useCallback(
    async (request: DocumentRequest, read: (target: string) => Promise<string>) => {
      const target = sessionRef.current;
      if (!target) return;
      // Placement happens before the read, so the tab appears immediately and
      // the content lands in it when it arrives.
      const placed = placeDocument(tabs.tabs, tabs.activeTabId, request);
      const openedId = placed.activeTabId;
      setTabs(placed);
      try {
        settleTab(openedId, { content: await read(target), loading: false });
      } catch (reason) {
        settleTab(openedId, { error: errorMessage(reason), loading: false });
      }
    },
    [settleTab, tabs.activeTabId, tabs.tabs],
  );

  const openFile = useCallback(
    (file: WorkspaceFile) =>
      openPreview(
        { label: fileName(file.path), path: file.path, source: "file" },
        (target) => readWorkspaceFile(client, target, file.path),
      ),
    [client, openPreview],
  );

  const openArtifact = useCallback(
    (output: SessionArtifactOutput) =>
      openPreview(
        {
          artifactId: output.version.id,
          label: output.artifact.title ?? fileName(output.artifact.name),
          path: output.version.sourcePath ?? "",
          source: "artifact",
        },
        (target) => readArtifactVersion(client, target, output.version.id),
      ),
    [client, openPreview],
  );

  const selectPanelTab = useCallback((tabId: string) => {
    setTabs((current) => ({ ...current, activeTabId: tabId }));
  }, []);

  const addPanelTab = useCallback(() => setTabs((current) => addTab(current.tabs)), []);

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
        let known = await listProjects(client);
        if (known.length === 0) {
          // No Project means no place for a Session, and this UI never asks
          // about one — so it makes the Project it needs.
          const created = await createProject(client, TEXT.project.defaultName);
          known = [created.project];
        }
        setActiveProjectId((current) => current ?? known[0]!.id);
        projectRef.current = projectRef.current ?? known[0]!.id;
        setActiveProjectName((current) => current ?? known[0]!.name);
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
            const project = known.find((entry) => entry.id === projectId);
            if (project) setActiveProjectName(project.name);
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

  // The list is the whole list: the sidebar gives it the height that is left
  // and scrolls it, rather than deciding on the user's behalf that everything
  // past some number is not worth showing.
  const recent = useMemo(() => byRecency(Object.values(sessionsByProject).flat()), [sessionsByProject]);

  const actions: WorkspaceActions = useMemo(
    () => ({
      addPanelTab,
      closeTab,
      confirmAction,
      deleteSession: (session) =>
        confirmAction({
          accept: TEXT.menu.delete,
          body: TEXT.errors.deleteWarning(session.title),
          eyebrow: TEXT.menu.delete,
          onAccept: () =>
            mutate({ dropIfCurrent: true, id: session.id, operation: () => deleteSession(client, session.id) }),
          title: session.title,
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
      selectModel,
      selectPanelTab,
      send,
      setApprovalMode,
      setDefaultModel,
      stop,
      toast,
      uploadFiles,
    }),
    [
      addPanelTab,
      closeTab,
      confirmAction,
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
      selectModel,
      selectPanelTab,
      send,
      setApprovalMode,
      setDefaultModel,
      stop,
      toast,
      uploadFiles,
    ],
  );

  const state: WorkspaceState = {
    activeProjectId,
    activeProjectName,
    connection,
    confirm,
    defaultModelId,
    detail,
    loadingSession,
    models,
    outputs,
    panelFiles,
    pendingMessage,
    presets,
    providers,
    recent,
    replays,
    run,
    running,
    selectedModelId,
    sessionId,
    tabs,
    toasts,
    uploadLimit,
    uploading,
  };

  return { actions, boot, state };
}
