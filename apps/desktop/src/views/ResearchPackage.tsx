// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useCallback, useEffect, useRef, useState } from "react";
import { isEvidenceSessionReadOnly } from "@sciencediscovery/schema";
import { readResearchPackageBlob, ResearchPackageDownloadStalledError } from "../api/research-package-stream.js";
import { ApiRequestError, isAbortError, type ApiClient } from "../api/client.js";
import type { Project, SessionDetail } from "../api/types.js";
import { cancelExport, importPackage, inspectPackage, openExportStream, packagePreview, readCopy, readExport, ResearchPackageDownloadStartTimeoutError, startCopy, startExport, type CopyOperation, type ExportOperation, type PackageInspection, type PackagePreview } from "../api/research-package.js";
import { canStreamExport, exportHistoryBridge, exportShellBridge, writeExportStream, type ExportHistoryRow } from "../app/export-bridge.js";
import { ExportHistoryList } from "./ExportHistoryList.js";
import { getSession } from "../api/sessions.js";
import { formatBytes } from "../app/format-bytes.js";
import { TEXT } from "../text.js";
import { untitled } from "../app/session-order.js";
import { claimsEscape } from "./dialog-escape.js";
import { copyPollStep } from "./research-package-copy-poll.js";
import { exportPollStep } from "./research-package-poll.js";
import { omissionRows } from "./research-package-omissions.js";
import "../styles/research-package.css";

export interface PackageRequest {
  kind: "export" | "import" | "branch"; projectId?: string; sessionId?: string; messageId?: string;
}

/** Default "save as" name — the session title plus a local timestamp — so the
 *  native dialog opens with a sensible, editable filename. */
export function suggestedExportName(detail: SessionDetail): string {
  const scrub = (value: string) => value.trim().replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").slice(0, 120);
  const title = scrub(detail.title ?? "");
  // An unused session carries the sentinel "Untitled session" (#1398 review F2),
  // so the fallback has to cover it as well as a blank title. The label goes
  // through the same scrub as a real title: a translation with a colon or a
  // slash must not compose a filename the save dialog rejects.
  const name = untitled(title) ? scrub(TEXT.researchPackage.untitledSession) : title;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${name}_${stamp}.sdresearch`;
}

interface ExportRecord {
  id: string;
  project: string;
  filename: string;
  /** Opaque token for the destination the user picked in the shell's save
   *  dialog; null in a plain browser, which saves through a download instead.
   *  The path itself never reaches the renderer. */
  destinationToken: string | null;
  phase: "packaging" | "saving" | "saved" | "save-failed" | "pack-failed" | "canceled";
  task: ExportOperation;
  /** Consecutive poll failures for this task, so one task's outage cannot
   *  exhaust another task's retry budget. */
  failures: number;
  savedToken?: string;
  /** What the dialog shows: localized when the sentence is one the client knows. */
  error?: string;
  /** The failure's own wording — the server's, the transport's, or a rejected
   *  value — shown only inside a details block (#1024, #1398). */
  rawError?: string;
  /** The package profile and session title travel with the write, so the shell
   *  can record a row that says which search the package belongs to. */
  level?: "necessary" | "complete";
  /** The session this package was exported from, captured when the export
   *  starts: packaging outlives the dialog, so the live request is not the
   *  exporting session by the time the write lands. */
  sessionId?: string;
  sessionTitle?: string;
}

const EXPORT_STATUS_REQUEST_TIMEOUT_MS = 15_000;
const EXPORT_DOWNLOAD_RETRY_DELAYS_MS = [500, 1_500] as const;

function isRetryableExportReadError(reason: unknown): boolean {
  if (reason instanceof ApiRequestError) return reason.status === 502 || reason.status === 503 || reason.status === 504;
  return reason instanceof TypeError && !isAbortError(reason);
}

export async function openExportStreamWithRetry(client: ApiClient, project: string, task: ExportOperation): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= EXPORT_DOWNLOAD_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await openExportStream(client, project, task);
    } catch (reason) {
      lastError = reason;
      if (!isRetryableExportReadError(reason) || attempt === EXPORT_DOWNLOAD_RETRY_DELAYS_MS.length) throw reason;
      await new Promise<void>(resolve => setTimeout(resolve, EXPORT_DOWNLOAD_RETRY_DELAYS_MS[attempt]!));
    }
  }
  // Defensive only: the loop rethrows on its last attempt, so nothing reaches
  // this line today, and the caller rethrows on the final attempt as well.
  // Should that ever change, the failure must still be a localized sentence
  // rather than a bare non-Error value.
  throw new Error(TEXT.researchPackage.downloadFailed, { cause: lastError });
}

/**
 * What a failed download tells the user (#1398 reviews F1/F4).
 *
 * `persistArchive` uses this only while the failure still belongs to the
 * download, i.e. before the archive starts going to its destination; a save
 * that fails afterwards is the shell's failure and gets the generic save
 * sentence instead. The visible sentence comes from the text table — a
 * transport failure's own wording, such as Chromium's "Failed to fetch", is
 * English in a Chinese dialog — so that wording is demoted to `rawError`, which
 * only the technical-details block shows. A timeout the client phrased itself,
 * or a server error the client knows, keeps its more specific localized
 * sentence. A rejection that carries no readable text contributes no
 * `rawError` rather than "undefined" or "[object Object]".
 */
export function saveFailureDetail(reason: unknown, timeoutDetail?: string): { error: string; rawError?: string } {
  const raw = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  // A refusal the stream itself can name keeps its advice above the fold: the
  // export task is gone (404) or the archive expired (410), which the generic
  // download sentence would bury in the details block (#1398 review).
  const status = reason instanceof ApiRequestError ? reason.status : undefined;
  const statusDetail = status === 404
    ? TEXT.researchPackage.taskMissing
    : status === 410
      ? TEXT.researchPackage.taskExpired
      : undefined;
  const error = timeoutDetail ?? statusDetail ?? taskErrorMessage(raw) ?? TEXT.researchPackage.downloadFailed;
  return { error, rawError: raw && raw !== error ? raw : undefined };
}
interface ExportFlash { id: number; tone: "success" | "error" | "neutral"; message: string; savedToken?: string; }

interface Props {
  client: ApiClient; request?: PackageRequest; detail?: SessionDetail;
  projects: Project[];
  onOpen: (session: string) => void; onRefresh: () => Promise<void>;
}
/** What the copy line says, if anything. A ready copy is reached through 继续聊天,
 *  which navigates on its own, so there is deliberately no text and no second
 *  "open" affordance for that state (#1057). */
export function copyStatusLine(copy: CopyOperation | undefined, t: typeof TEXT.researchPackage): string | undefined {
  if (!copy || copy.state === "ready") return undefined;
  return copy.state === "copying" ? t.copying : copy.error ?? t.failed;
}
/**
 * The task failures the client can phrase itself (#1024). A failure that is not
 * named here keeps the server's wording, but only inside the details block: the
 * alert line must not be raw English in a Chinese dialog.
 */
export function taskErrorMessage(error?: string): string | undefined {
  if (!error) return undefined;
  const t = TEXT.researchPackage;
  const trimmed = error.trim();
  if (/exceeds the archive size limit/i.test(error)) return t.packageTooLarge;
  if (/^(Export task not found|Completed export not found)$/i.test(trimmed)) return t.taskMissing;
  if (/导出文件已过期|export (file )?(has )?expired/i.test(error)) return t.taskExpired;
  if (/服务重启时导出尚未完成/i.test(error)) return t.taskRestarted;
  // The poll settles its own terminal answers with sentences from these same
  // dictionaries (a deleted task, the retry limit). Those are already the copy
  // the user must read, so they pass through instead of collapsing into 操作失败
  // with the real sentence demoted to 技术细节 (#1235 review 2, F9).
  return [t.exportMissing, t.exportPollingFailed, t.taskMissing, t.taskExpired, t.taskRestarted, t.failed, t.legacyUnavailable]
    .includes(trimmed) ? trimmed : undefined;
}

/**
 * Every omission the manifest carries is shown; `research-package-omissions.ts`
 * turns each entry into a row: the package's own text verbatim, with only the
 * dialog's family name beside it. The count the card prints is `items.length`,
 * never the number of rows that happen to be pretty: a package whose entries are
 * all reference-shaped must not read as complete.
 */

export function ResearchPackage({ client, request, projects, detail: activeDetail, onOpen, onRefresh }: Props) {
  const t = TEXT.researchPackage;
  const [dialog, setDialog] = useState<"export" | "import" | "branch">();
  const [detail, setDetail] = useState<SessionDetail>();
  const [importProjectId, setImportProjectId] = useState("");
  const projectId = request?.kind === "import" ? importProjectId || request.projectId : request?.projectId;
  const [level, setLevel] = useState("necessary");
  // The export dialog offers both optional payloads the API understands. The
  const [graph, setGraph] = useState(false);
  const [preview, setPreview] = useState<PackagePreview>();
  // Keyed by revision + size: a new selection has to be confirmed again.
  const [acknowledgedLimitKey, setAcknowledgedLimitKey] = useState<string>();
  const [profiles, setProfiles] = useState<Record<string, PackagePreview>>({});
  const [files, setFiles] = useState<string[]>();
  /** True while a preview for the current selection is in flight: the file list
   *  stays mounted and only the size line reports the recalculation (#1057). */
  const [estimating, setEstimating] = useState(false);
  /** The level/options the last preview described. Only a change there may
   *  reset the list, because only then does the list itself change. */
  const previewScope = useRef("");
  /** How many times the pending answer has come back for this selection. A bounded
   *  wait turns the silent retry into a status line with a manual retry (#1024). */
  const pendingTries = useRef(0);
  /** The selection the pending budget belongs to, so a file tick restarts it. */
  const pendingScope = useRef("");
  const [previewStalled, setPreviewStalled] = useState(false);
  /** Bumped by the manual retry so the preview effect runs again. */
  const [previewNonce, setPreviewNonce] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File>(), [inspection, setInspection] = useState<PackageInspection>();
  const [inspectedProject, setInspectedProject] = useState<string>();
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [copy, setCopy] = useState<CopyOperation>();
  const [exports, setExports] = useState<ExportRecord[]>([]);
  const [progressExpanded, setProgressExpanded] = useState(false);
  const [flashQueue, setFlashQueue] = useState<ExportFlash[]>([]);
  // A transient poll message ("retrying…"), kept apart from `error` so a poll
  // step never clears an error it did not set.
  const [exportNotice, setExportNotice] = useState("");
  const [messageId, setMessageId] = useState("");
  const readOnly = isEvidenceSessionReadOnly(activeDetail);
  const canContinue = activeDetail?.researchSnapshot?.role === "imported_snapshot" && activeDetail.researchSnapshot.state === "ready" && activeDetail.researchSnapshot.continuationAvailable === true;
  const branch = activeDetail?.conversationBranch;
  const [sourceTitle, setSourceTitle] = useState<string>();
  useEffect(() => {
    if (!branch?.sourceSessionId) { setSourceTitle(undefined); return; }
    let active = true;
    setSourceTitle(undefined);
    void getSession(client, branch.sourceSessionId)
      .then(source => { if (active) setSourceTitle(source.title?.trim() || undefined); })
      .catch(() => {});
    return () => { active = false; };
  }, [client, branch?.sourceSessionId]);
  const requestId = useRef(crypto.randomUUID());
  const copying = useRef(false);
  const busyRef = useRef(false);
  const exportsRef = useRef<ExportRecord[]>([]);
  const flashTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const flashSeq = useRef(0);

  const patchExport = useCallback((id: string, patch: Partial<ExportRecord>) => {
    setExports(current => current.map(record => record.id === id ? { ...record, ...patch } : record));
  }, []);
  /** Toasts stack in the corner, as many as fit; each one retires on its own timer. */
  const pushFlash = useCallback((tone: ExportFlash["tone"], message: string, savedToken?: string) => {
    const id = (flashSeq.current += 1);
    setFlashQueue(current => [...current.slice(-3), { id, tone, message, savedToken }]);
    const timer = setTimeout(() => {
      flashTimers.current.delete(id);
      setFlashQueue(current => current.filter(flash => flash.id !== id));
    }, tone === "error" ? 8000 : 5000);
    flashTimers.current.set(id, timer);
  }, []);
  // A toast timer must not fire after the view is gone or the toast was dismissed
  // (#1235 review 2, F15).
  useEffect(() => () => { for (const timer of flashTimers.current.values()) clearTimeout(timer); flashTimers.current.clear(); }, []);
  const dismissFlash = useCallback((id: number) => {
    const timer = flashTimers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    flashTimers.current.delete(id);
    setFlashQueue(current => current.filter(flash => flash.id !== id));
  }, []);

  useEffect(() => { exportsRef.current = exports; }, [exports]);

  /** The shell's durable list of finished exports (#1154): the dialog shows
   *  this session's rows from it, so closing the dialog — or restarting the app
   *  — no longer erases the package. */
  const historyBridge = exportHistoryBridge();
  const [history, setHistory] = useState<ExportHistoryRow[]>([]);
  const refreshHistory = useCallback(async () => {
    if (!historyBridge) return;
    try {
      setHistory(await historyBridge.list());
    } catch {
      setHistory([]);
    }
  }, [historyBridge]);

  // Save the completed archive to its destination. In the shell this is a write
  // bound to the token the dialog issued; in a plain browser it falls back to a
  // browser download (the browser's save prompt is that platform's destination
  // choice). Used for both auto-save and retry.
  const persistArchive = useCallback(async (record: ExportRecord) => {
    patchExport(record.id, { phase: "saving" });
    /** True once the archive starts going to its destination. Before that a
     *  failure is a download failure; after it, it is a save failure, and the
     *  shell's own wording can name the destination path the renderer must not
     *  show (#1398 review F4). */
    let writing = false;
    try {
      const response = await openExportStreamWithRetry(client, record.project, record.task);
      const bridge = exportShellBridge();
      let savedToken: string | undefined;
      if (bridge && record.destinationToken && canStreamExport(bridge) && response.body) {
        writing = true;
        await writeExportStream(bridge, record.destinationToken, response.body, {
          level: record.level,
          projectId: record.project,
          recordId: record.id,
          sessionId: record.sessionId,
          sessionTitle: record.sessionTitle,
        });
        savedToken = record.destinationToken;
        await refreshHistory();
      } else if (bridge && record.destinationToken) {
        // An older shell without the streaming channels; the archive arrives as
        // one buffer, which is what this shell can accept. The buffer is read
        // before the write starts, so a failed read still counts as a download
        // failure.
        const archive = await (await readResearchPackageBlob(response)).arrayBuffer();
        writing = true;
        await bridge.write(record.destinationToken, archive, {
          level: record.level,
          projectId: record.project,
          recordId: record.id,
          sessionId: record.sessionId,
          sessionTitle: record.sessionTitle,
        });
        savedToken = record.destinationToken;
        await refreshHistory();
      } else {
        const blob = await readResearchPackageBlob(response);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = record.task.filename;
        document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      patchExport(record.id, { phase: "saved", savedToken });
      pushFlash("success", TEXT.researchPackage.exportSaved, savedToken);
    } catch (reason) {
      let timeoutDetail: string | undefined;
      if (reason instanceof ResearchPackageDownloadStalledError) {
        timeoutDetail = TEXT.researchPackage.exportDownloadStalled;
      } else if (reason instanceof ResearchPackageDownloadStartTimeoutError) {
        timeoutDetail = TEXT.researchPackage.exportDownloadStartTimeout;
      }
      // A download failure gets the localized download sentence with the raw
      // wording kept for the details block. Once the write has begun, the shell
      // said what happened and may have named a path: only the generic save
      // sentence is shown, and no raw wording is recorded (#1398 review F4).
      // The row and the toast beside it read the same sentence, so one failure
      // never gets two explanations (#1398 review, HongyeZhou).
      const detail = writing
        ? { error: timeoutDetail ?? TEXT.researchPackage.exportSaveFailed, rawError: undefined }
        : saveFailureDetail(reason, timeoutDetail);
      patchExport(record.id, { phase: "save-failed", ...detail });
      pushFlash("error", detail.error);
    }
  }, [client, detail?.id, patchExport, pushFlash, refreshHistory, request?.sessionId]);
  // The polling tick keeps one timer and must not restart when a save
  // callback identity changes; it reads the latest through this ref.
  const persistArchiveRef = useRef(persistArchive);
  useEffect(() => { persistArchiveRef.current = persistArchive; }, [persistArchive]);

  // Poll every packaging task until it is terminal, then auto-save on
  // completion. One tick handles all active tasks, and each task keeps its own
  // failure count through exportPollStep, so a deleted task (404) and the
  // legacy outage each settle that task instead of spinning forever.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = async (record: ExportRecord, task: ExportOperation): Promise<void> => {
      if (task.status === "completed") { patchExport(record.id, { task }); await persistArchiveRef.current({ ...record, task }); }
      else if (task.status === "canceled") { patchExport(record.id, { task, phase: "canceled" }); pushFlash("neutral", TEXT.researchPackage.exportCanceled); }
      else { const message = taskErrorMessage(task.error); patchExport(record.id, { task, phase: "pack-failed", error: message ?? TEXT.researchPackage.failed, rawError: task.error }); pushFlash("error", message ?? TEXT.researchPackage.failed); }
    };
    const tick = async () => {
      if (cancelled) return;
      const active = exportsRef.current.filter(record => record.phase === "packaging" && (record.task.status === "queued" || record.task.status === "running"));
      for (const record of active) {
        if (cancelled) return;
        try {
          const next = await readExport(client, record.project, record.task.id, AbortSignal.timeout(EXPORT_STATUS_REQUEST_TIMEOUT_MS));
          if (cancelled) return;
          const step = exportPollStep(record.project, record.task, record.failures, { ok: true, task: next }, t);
          patchExport(record.id, { failures: step.failures, task: step.task.task });
          setExportNotice(step.error);
          if (step.terminate) await settle(record, step.task.task);
        } catch (reason) {
          if (cancelled) return;
          const step = exportPollStep(record.project, record.task, record.failures, { ok: false, reason }, t);
          patchExport(record.id, { failures: step.failures, task: step.task.task });
          setExportNotice(step.error);
          if (step.terminate) await settle(record, step.task.task);
        }
      }
      timer = setTimeout(tick, 1000);
    };
    timer = setTimeout(tick, 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, patchExport, pushFlash]);

  useEffect(() => {
    if (!request) return;
    let active = true;
    setImportProjectId(""); setInspectedProject(undefined);
    setDialog(request.kind); setDetail(undefined); setPreview(undefined); setEstimating(false); previewScope.current = ""; setProfiles({}); setError(""); setFiles(undefined); setFile(undefined); setInspection(undefined); setLevel("necessary"); setGraph(false); setAcknowledgedLimitKey(undefined); setMessageId(request.messageId ?? "");
    // Every open starts a fresh bounded wait: a stalled preview from the previous
    // open must not greet the user as already exhausted (#1235 review 2, F11).
    pendingTries.current = 0; pendingScope.current = ""; setPreviewStalled(false);
    if (request.sessionId) void getSession(client, request.sessionId).then(value => { if (active) setDetail(value); }).catch(reason => { if (active) setError(reason?.status === 404 ? t.sourceUnavailable : String(reason.message ?? reason)); });
    return () => { active = false; };
  }, [client, request]);

  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = document.querySelector<HTMLElement>(".research-package-dialog");
    panel?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), select")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if ([...document.querySelectorAll('[role="dialog"]')].at(-1) !== panel) return;
      if (claimsEscape(event)) { event.preventDefault(); if (!busyRef.current) setDialog(undefined); }
      if (event.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), summary")];
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [dialog]);

  useEffect(() => {
    if (dialog !== "export") return;
    void refreshHistory();
  }, [dialog, refreshHistory]);

  useEffect(() => {
    if (dialog !== "export" || !detail || !projectId) return;
    let active = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const value of ["necessary", "complete"]) {
      const load = () => { void packagePreview(client, projectId, detail.id, value, false, false).then(result => { if (active) setProfiles(current => ({ ...current, [value]: result })); }).catch(reason => { if (active && reason?.code === "EXPORT_PREVIEW_PENDING") timers.push(setTimeout(load, 1500)); }); }; load();
    }
    return () => { active = false; timers.forEach(clearTimeout); };
  }, [client, dialog, detail?.id, projectId]);
  useEffect(() => {
    if (dialog !== "export" || !detail || !projectId) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    // Ticking a workspace file must not blank the dialog: the list stays mounted and
    // only the size line says it is recalculating (#1057). The pending budget is
    // keyed on the whole selection, so a changed file set starts it over without
    // touching what is already on screen.
    const scope = `${level}|${graph}`;
    if (previewScope.current !== scope) {
      previewScope.current = scope;
      setPreview(undefined);
    }
    const selection = `${detail.id}|${scope}|${files?.join(",") ?? ""}`;
    if (pendingScope.current !== selection) {
      pendingScope.current = selection;
      pendingTries.current = 0;
      setPreviewStalled(false);
    }
    setEstimating(true); setError("");
    const load = () => { void packagePreview(client, projectId, detail.id, level, false, graph && level === "complete", files).then(value => {
      if (!active) return;
      pendingTries.current = 0; setPreviewStalled(false);
      setPreview(value); setEstimating(false);
    }).catch(reason => {
      if (!active) return;
      if (reason?.code === "EXPORT_PREVIEW_PENDING") {
        // The server says the preview is still being computed. Keep retrying for a
        // bounded wait, then stop and say so: a permanently disabled button with no
        // status line is what #1024 reports.
        pendingTries.current += 1;
        if (pendingTries.current >= 6) { setPreviewStalled(true); setEstimating(false); }
        else { setEstimating(true); timer = setTimeout(load, 1500); }
      } else { setEstimating(false); setError(reason?.status === 404 ? t.sourceUnavailable : String(reason.message ?? reason)); }
    }); }; load();
    return () => { active = false; clearTimeout(timer); };
  }, [client, dialog, detail?.id, projectId, level, graph, files, previewNonce]);
  useEffect(() => {
    if (copy?.state !== "copying") return;
    let active = true; let timer: ReturnType<typeof setTimeout>; let failures = 0;
    const poll = () => { void readCopy(client, copy.sourceSessionId, copy.id).then(async next => {
      if (!active) return;
      const step = copyPollStep(copy, failures, { ok: true, copy: next }, t);
      failures = step.failures; setCopy(step.copy);
      if (!step.terminate) { timer = setTimeout(poll, 1000); return; }
      requestId.current = crypto.randomUUID(); await onRefresh();
      if (next.state === "ready" && next.entrySessionId) onOpen(next.entrySessionId);
    }).catch(reason => {
      if (!active) return;
      const step = copyPollStep(copy, failures, { ok: false, reason }, t);
      failures = step.failures; setCopy(step.copy);
      if (step.error) setError(step.error);
      if (!step.terminate) timer = setTimeout(poll, 3000);
    }); };
    timer = setTimeout(poll, 1000); return () => { active = false; clearTimeout(timer); };
  }, [client, copy?.id, copy?.state]);
  async function perform(action: () => Promise<void>) {
    busyRef.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (reason) {
      // Both refusals carry a code; their server sentences are English and must not
      // reach a localized dialog. This is the one path every refused action passes.
      const code = (reason as { code?: string } | undefined)?.code;
      const message = reason instanceof Error ? reason.message : String(reason);
      const tooLarge = code === "RESEARCH_PACKAGE_TOO_LARGE" || code === "PAYLOAD_TOO_LARGE"
        || message === "Research package exceeds the archive size limit";
      setError(tooLarge ? t.packageTooLarge : message);
    }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function copyResearch(id?: string) {
    const source = id ? detail : activeDetail;
    if (!source || copying.current || copy?.state === "copying" || (id ? isEvidenceSessionReadOnly(source) : !canContinue)) return;
    copying.current = true;
    try { await perform(async () => {
      const operation = await startCopy(client, source.id, requestId.current, id); setCopy(operation);
      if (operation.state !== "copying") requestId.current = crypto.randomUUID();
      if (operation.state === "ready" && operation.entrySessionId) { await onRefresh(); onOpen(operation.entrySessionId); }
      if (operation.state !== "failed") setDialog(undefined);
      else throw new Error(operation.error ?? t.failed);
    }); } finally { copying.current = false; }
  }
  // Settle the record from what the server actually did. `cancel` returns a
  // terminal task unchanged, so a cancel that raced completion must not replace
  // a successful package with "canceled" (or claim a cancellation that never
  // happened).
  async function cancelOne(record: ExportRecord) {
    try {
      const next = await cancelExport(client, record.project, record.id);
      if (next.status === "canceled") {
        patchExport(record.id, { task: next, phase: "canceled" });
        pushFlash("neutral", t.exportCanceled);
      } else if (next.status === "completed") {
        // Packaging finished first: keep the package and go straight to saving.
        const completed = { ...record, task: next };
        patchExport(record.id, { task: next });
        await persistArchiveRef.current(completed);
      } else if (next.status === "failed") {
        patchExport(record.id, { task: next, phase: "pack-failed", error: taskErrorMessage(next.error) ?? t.failed, rawError: next.error });
        pushFlash("error", taskErrorMessage(next.error) ?? t.failed);
      } else {
        patchExport(record.id, { task: next });
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function openLocation(token: string) {
    const bridge = exportShellBridge();
    if (bridge) { try { await bridge.showInFolder(token); } catch { /* reveal is best-effort */ } }
  }
  function retrySave(record: ExportRecord) { void persistArchiveRef.current(record); }

  /** The dialog's rows are this session's only. */
  /** The session the open dialog packages; without one there is no list to
   *  scope to, rather than every session's packages. */
  const dialogSessionId = request?.sessionId ?? detail?.id;
  const sessionHistory = dialogSessionId === undefined
    ? []
    : history.filter(row => row.sessionId === dialogSessionId);

  async function revealHistory(row: ExportHistoryRow) {
    if (!historyBridge) return;
    try {
      const result = await historyBridge.reveal(row.token);
      if (result.missing) await refreshHistory();
    } catch { await refreshHistory(); }
  }

  async function forgetHistory(row: ExportHistoryRow) {
    if (!historyBridge) return;
    try { await historyBridge.forget(row.id); } finally { await refreshHistory(); }
  }
  /** Cancel only while the server task can still be cancelled — not while the
   *  archive is already being written to its destination. */
  const canCancel = (record: ExportRecord): boolean =>
    record.phase === "packaging" && (record.task.status === "queued" || record.task.status === "running");

  const activeExports = exports.filter(record => record.phase === "packaging" || record.phase === "saving");
  const finishedExports = exports.filter(record => record.phase === "saved" || record.phase === "save-failed" || record.phase === "pack-failed");

  // The only omission number derivable from this payload: files the user unticked
  // (or that the server did not select), never an invented version count (#1057).
  const excludedWorkspaceFiles = preview
    ? preview.files.filter(item => files ? !files.includes(item.path) : item.selected === false).length
    : 0;
  const allFilesSelected = preview ? preview.files.length > 0 && excludedWorkspaceFiles === 0 : false;
  // A ready copy is reached through 继续聊天, which navigates as soon as the copy
  // exists; a second permanent "open" entry point only duplicated it (#1057).
  // The cap and the exact tar size come from the preview response, so this gate
  // matches what the server refuses on instead of re-deriving an estimate.
  const limitBytes = preview?.maxBytes;
  const archiveBytes = preview?.archiveBytes ?? preview?.estimatedBytes;
  const overLimit = limitBytes !== undefined && archiveBytes !== undefined && archiveBytes > limitBytes;
  const limitKey = overLimit ? `${preview?.revision ?? ""}:${archiveBytes}` : undefined;
  const overLimitAcknowledged = limitKey !== undefined && acknowledgedLimitKey === limitKey;
  const blockedByLimit = overLimit && !overLimitAcknowledged;
  const formatLimit = (bytes: number) => formatBytes(bytes);
  // Every manifest entry becomes a row, and the summary counts all of them: a
  // package whose entries are all reference-shaped must not read as complete.
  const importOmissions = inspection
    ? omissionRows(inspection.manifest.omissions, t.omissionText)
    : [];
  return <>
    {readOnly ? <div className="research-package-resume"><div><strong>{t.readOnlyTitle}</strong><p className="research-package-notice">{canContinue ? t.readOnly : t.continueUnavailable}</p></div><button className="primary-button" disabled={!canContinue || busy || copy?.state === "copying"} onClick={() => void copyResearch()} type="button">{t.continue}</button></div> : null}
    {branch ? <div className="research-package-source">{t.contextFrom} <button aria-label={t.source} onClick={() => onOpen(branch.sourceSessionId)} type="button">{sourceTitle ?? t.source}</button></div> : null}
    {copyStatusLine(copy, t) !== undefined ? <div className="research-package-status" role="status">{copyStatusLine(copy, t)}</div> : null}
    {activeExports.length > 0 || flashQueue.length ? <div className="research-toast-stack">
      {activeExports.length > 0 ? <div className="research-toast is-neutral research-export-progress" role="status"><span aria-hidden="true" className="spinner" /><button className="research-package-progress-toggle" onClick={() => setProgressExpanded(value => !value)} type="button">{t.exportsInProgress(activeExports.length)}</button>{progressExpanded ? <ul className="research-package-progress-list">{activeExports.map(record => <li key={record.id}><span>{record.task.filename}</span>{canCancel(record) ? <button onClick={() => void cancelOne(record)} type="button">{TEXT.menu.cancel}</button> : null}</li>)}</ul> : null}</div> : null}
      {flashQueue.map(flash => <div className={`research-toast is-${flash.tone}`} key={flash.id} role="status">
      <span aria-hidden="true" className="research-toast-icon">{flash.tone === "success" ? <svg fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="14"><path d="M4 12.5l5 5L20 6.5" /></svg> : flash.tone === "error" ? <svg fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="14"><path d="M6 6l12 12M18 6L6 18" /></svg> : <svg fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="14"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>}</span>
      <span className="research-toast-text">{flash.message}</span>
      {flash.savedToken ? <button className="research-toast-action" onClick={() => void openLocation(flash.savedToken!)} type="button">{t.openLocation}</button> : null}
      <button aria-label={t.close} className="research-toast-close" onClick={() => dismissFlash(flash.id)} type="button">×</button>
    </div>)}</div> : null}
    {!dialog && (error || exportNotice) ? <p role="alert" className="research-package-error">{error || exportNotice}</p> : null}
    {dialog ? <div className="modal-backdrop" onClick={() => !busy && setDialog(undefined)}><section className={`modal-panel research-package-dialog${dialog === "import" ? " is-import" : ""}`} role="dialog" aria-modal="true" aria-labelledby="research-package-title" onClick={event => event.stopPropagation()}>
      <header className="modal-header"><h2 id="research-package-title">{dialog === "export" ? t.export : dialog === "import" ? t.import : t.branch}</h2><div className="research-dialog-tools"><button className="modal-close" aria-label={t.close} disabled={busy} onClick={() => setDialog(undefined)} type="button">×</button></div></header>
      <div className="modal-body">
        {dialog === "export" ? <>
          <p className="research-dialog-lede">{t.evidenceOnly}</p>
          <p className="research-field-label">{t.exportTypes}</p>
          <div className="research-package-profiles">{["necessary", "complete"].map(value => <button key={value} aria-pressed={level === value} className={level === value ? "is-selected" : ""} onClick={() => { setLevel(value); setFiles(undefined); if (value !== "complete") { setGraph(false); } }} type="button">
            <span className="research-profile-heading"><span className="research-profile-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{value === "necessary" ? <><path d="M7 3h7l4 4v14H7zM14 3v5h4M10 12h5M10 16h5" /></> : <><rect x="4" y="6" width="16" height="15" rx="2" /><path d="M8 6V3h8v3M4 11h16M10 15h4" /></>}</svg></span><strong>{value === "necessary" ? t.necessary : t.complete}</strong></span>
            <span className="research-profile-badges">{(value === "necessary"
              ? [t.badgeConversation, t.badgeCurrentFiles, t.badgeDependencies]
              : [t.badgeConversation, t.badgeFileVersions, t.badgeHistory]).map(badge => <span className="research-badge" key={badge}>{badge}</span>)}</span>
            <span className="research-profile-description">{value === "necessary" ? t.necessaryHint : t.completeHint}</span>
            <span className="research-package-size"><span>{t.estimate}</span><b>{profiles[value] ? formatBytes(profiles[value]!.estimatedBytes) : "—"}</b></span>
          </button>)}</div>
          {level === "complete" ? <>
            <p className="research-field-label">{t.otherContent}</p>
            <div className="research-package-options">
              <label><input type="checkbox" checked={graph} onChange={event => setGraph(event.target.checked)} />{t.graph}</label>
            </div>
          </> : null}
          {estimating ? <p className="research-package-notice">{t.recalculating}</p> : null}
          {estimating && !preview ? <p className="research-package-status" role="status"><span aria-hidden="true" className="spinner" />{t.previewRetrying}</p> : null}
          {previewStalled ? <div className="research-package-pending" role="status"><p>{t.pendingLong}</p><button className="secondary-button" onClick={() => { pendingTries.current = 0; setPreviewStalled(false); setEstimating(true); setPreviewNonce(value => value + 1); }} type="button">{t.retryPreview}</button></div> : null}
          <p className="research-package-selected-size">{preview ? <>{t.estimateUncompressed} <b>{formatBytes(preview.estimatedBytes)}</b>{estimating ? ` · ${t.recalculating}` : null}</> : t.calculating}</p>
          {limitBytes !== undefined ? <p className="research-package-notice">{t.sizeLimit(formatLimit(limitBytes))}</p> : null}
          {blockedByLimit ? <div role="alert" className="research-package-limit">
            <p>{t.overLimit(formatLimit(archiveBytes ?? 0), formatLimit(limitBytes ?? 0))}</p>
            {level === "necessary" ? <p>{t.overLimitNecessaryOnly}</p> : null}
            <p>{t.overLimitRisk}</p>
            <button className="secondary-button" onClick={() => setAcknowledgedLimitKey(limitKey)} type="button">{t.exportAnyway}</button>
          </div> : null}
          {overLimitAcknowledged ? <p role="status" className="research-package-notice">{t.overLimitConfirmed}</p> : null}
          {preview ? <details className="research-files-block" open>
            <summary>{t.filesWithCount(preview.files.length)}</summary>
            <label className="research-select-all"><input type="checkbox" checked={allFilesSelected} onChange={event => setFiles(event.target.checked ? preview.files.map(row => row.path) : [])} />{t.selectAll}</label>
            <div className="research-file-grid">{preview.files.map(item => <label key={item.path} title={item.path}><input type="checkbox" checked={files ? files.includes(item.path) : item.selected !== false} onChange={event => { const selected = files ?? preview.files.filter(row => row.selected !== false).map(row => row.path); setFiles(event.target.checked ? [...selected, item.path] : selected.filter(path => path !== item.path)); }} /><span title={item.path}>{item.path}</span></label>)}</div>
          </details> : null}
          {excludedWorkspaceFiles > 0 ? <p className="research-package-notice">{t.omissionsSummary(excludedWorkspaceFiles)}</p> : null}
          {sessionHistory.length > 0 || finishedExports.some(record => record.phase !== "saved") ? <div className="research-package-saved"><h3>{t.savedExports}</h3>
            {historyBridge ? <ExportHistoryList locale={TEXT.languageTag} onForget={record => void forgetHistory(record)} onReveal={record => void revealHistory(record)} rows={sessionHistory} /> : null}
            {finishedExports.filter(record => record.phase !== "saved").map(record => <div className="research-package-saved-row" key={record.id}><span>{record.filename}</span>{record.phase === "save-failed" ? <><span className="is-error">{record.error ?? t.exportSaveFailed}</span>{record.rawError ? <details className="research-package-raw"><summary>{t.detailsRaw}</summary><code>{record.rawError}</code></details> : null}<button onClick={() => retrySave(record)} type="button">{t.retrySave}</button></> : null}{record.phase === "pack-failed" ? <><span className="is-error">{record.error ?? t.failed}</span>{record.rawError && record.rawError !== record.error ? <details className="research-package-raw"><summary>{t.detailsRaw}</summary><code>{record.rawError}</code></details> : null}</> : null}</div>)}
            {historyBridge ? null : finishedExports.filter(record => record.phase === "saved" && record.savedToken).map(record => <div className="research-package-saved-row" key={record.id}><span>{record.filename}</span><button onClick={() => void openLocation(record.savedToken!)} type="button">{t.openLocation}</button></div>)}
          </div> : null}
        </> : dialog === "import" ? <>
          <p className="research-dialog-lede">{t.importHint}</p>
          <p className="research-field-label">{t.projectDestination}</p>
          <select className="research-import-select" value={importProjectId} disabled={busy} onChange={event => setImportProjectId(event.target.value)}><option value="">{t.noProject}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
          <p className="research-package-notice">{t.projectDestinationHint}</p>
          <p className="research-field-label">{t.chooseFile}</p>
          {file ? (
            <div className="research-file-card">
              <div className="research-file-card-header">
                <span aria-hidden="true" className="research-file-card-icon"><svg fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="20"><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v5h4" /></svg></span>
                <span className="research-file-card-body"><b>{file.name}</b><span>{formatBytes(file.size)}</span></span>
                <label className="research-file-card-reselect">{t.reselect}<input className="research-package-upload-input" type="file" accept=".sdresearch" disabled={busy} onChange={event => { const selected = event.target.files?.[0]; setFile(selected); setInspection(undefined); setInspectedProject(undefined); if (selected && projectId) void perform(async () => { setInspection(await inspectPackage(client, projectId, selected)); setInspectedProject(projectId); }); }} /></label>
              </div>
              {inspection ? <>
                <p className="research-import-meta">{inspection.manifest.source.title ? <><b>{inspection.manifest.source.title}</b> · </> : null}{inspection.objectCount} {t.objects} · {t.recordsBytes} {formatBytes(inspection.recordsBytes)}</p>
                {/* The package's own omissions, from `inspection.manifest.omissions`
                    — never a fixed list, and never a subset: every entry is a row and
                    the count is its length. A row's id, path and reason are the
                    package's own text; the count line, the family name, the hover hint,
                    the not-readable marker and the placeholder for an entry that cannot
                    be described are the dialog's words. The list starts collapsed — the
                    count is the useful part, the rows are one click away. */}
                {importOmissions.length > 0 ? <details className="research-import-omissions">
                  <summary>{t.importOmissions(importOmissions.length)}</summary>
                  <ul className="research-import-omissions-list">{importOmissions.map((row) => <li key={row.key} title={row.hint}>{row.label}</li>)}</ul>
                </details> : <p className="research-import-omissions is-empty">{t.importOmissions(0)}</p>}
              </> : null}

            </div>
          ) : (
            <label className={`research-package-upload${dragging ? " is-dragging" : ""}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); const selected = event.dataTransfer.files[0]; if (!selected || busy) return; setFile(selected); setInspection(undefined); setInspectedProject(undefined); if (projectId) void perform(async () => { setInspection(await inspectPackage(client, projectId, selected)); setInspectedProject(projectId); }); }}><svg aria-hidden="true" className="research-upload-icon" width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 11a3 3 0 0 1 3-3h8l4 4h12a3 3 0 0 1 3 3v16a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z"/><circle cx="31" cy="13" r="7" fill="white"/><path d="M31 9v8m-4-4h8"/></svg><strong>{t.choose}</strong><span>{t.dropHint}</span><input className="research-package-upload-input" type="file" accept=".sdresearch" disabled={busy} onChange={event => { const selected = event.target.files?.[0]; setFile(selected); setInspection(undefined); setInspectedProject(undefined); if (selected && projectId) void perform(async () => { setInspection(await inspectPackage(client, projectId, selected)); setInspectedProject(projectId); }); }} /></label>
          )}
        </> : <p>{t.branchHint}</p>}
        {error ? <p role="alert" className="research-package-error">{error}</p> : null}
      </div>
      <footer className="modal-footer"><button className="secondary-button" disabled={busy} onClick={() => setDialog(undefined)} type="button">{dialog === "branch" ? t.close : t.cancelAction}</button><button className="primary-button" disabled={busy || (dialog === "export" ? !preview?.revision || estimating || blockedByLimit : dialog === "import" ? !inspection : !messageId || !detail || isEvidenceSessionReadOnly(detail) || copy?.state === "copying")} type="button" onClick={() => {
        if (dialog === "branch") void copyResearch(messageId);
        else if (dialog === "export" && detail && projectId && preview?.revision) void perform(async () => {
          // Choose the destination first; cancelling the dialog aborts the
          // export before any packaging task is started. Only the opaque token
          // crosses the bridge — the path stays in the main process.
          const bridge = exportShellBridge();
          let destinationToken: string | null = null;
          if (bridge) {
            const picked = await bridge.saveDialog(suggestedExportName(detail));
            if (picked.canceled || !picked.token) return;
            destinationToken = picked.token;
          }
          const task = await startExport(client, projectId, { sessionId: detail.id, revision: preview.revision!, level, includeFullTrajectory: false, includeFullMemoryGraph: level === "complete" && graph, filePaths: files, allowOverCap: overLimitAcknowledged });
          const record: ExportRecord = { id: task.id, project: projectId, filename: task.filename, destinationToken, phase: "packaging", task, failures: 0, error: taskErrorMessage(task.error), level: level as "necessary" | "complete", sessionId: request?.sessionId ?? detail?.id, sessionTitle: detail?.title };
          setExports(current => [...current, record]); setDialog(undefined);
          // startExport normally returns `queued`; a terminal answer still has
          // to be settled immediately instead of waiting for a poll that never
          // runs against a non-active status.
          if (task.status === "completed") { await persistArchiveRef.current(record); }
          else if (task.status === "failed") { const message = taskErrorMessage(task.error); patchExport(task.id, { phase: "pack-failed", error: message ?? t.failed, rawError: task.error }); pushFlash("error", message ?? t.failed); }
          else if (task.status === "canceled") { patchExport(task.id, { phase: "canceled" }); pushFlash("neutral", t.exportCanceled); }
        });
        else if (file && projectId) void perform(async () => { const result = await importPackage(client, projectId, file, inspectedProject === projectId ? inspection?.packageChecksum : undefined); await onRefresh(); setDialog(undefined); const source = result.importedSessionIds[0]; if (source) onOpen(source); });
      }}>{busy ? t.working : dialog === "export" ? t.startExport : dialog === "import" ? t.confirmImport : t.branch}</button></footer>
    </section></div> : null}
  </>;
}
