// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useRef, useState } from "react";
import { isEvidenceSessionReadOnly } from "@sciencediscovery/schema";
import type { ApiClient } from "../api/client.js";
import type { Project, SessionDetail } from "../api/types.js";
import { downloadExport, importPackage, inspectPackage, packagePreview, readCopy, readExport, startCopy, startExport, type CopyOperation, type ExportOperation, type PackageInspection, type PackagePreview } from "../api/research-package.js";
import { TEXT } from "../text.js";
import { claimsEscape } from "./dialog-escape.js";
import { copyPollStep } from "./research-package-copy-poll.js";
import { exportPollStep } from "./research-package-poll.js";
import "../styles/research-package.css";

export interface PackageRequest {
  kind: "export" | "import" | "branch"; projectId?: string; sessionId?: string; messageId?: string;
}
interface Props {
  client: ApiClient; request?: PackageRequest; detail?: SessionDetail;
  projects: Project[];
  onOpen: (session: string) => void; onRefresh: () => Promise<void>;
}
export function ResearchPackage({ client, request, projects, detail: activeDetail, onOpen, onRefresh }: Props) {
  const t = TEXT.researchPackage;
  const [dialog, setDialog] = useState<"export" | "import" | "branch">();
  const [detail, setDetail] = useState<SessionDetail>();
  const [importProjectId, setImportProjectId] = useState("");
  const projectId = request?.kind === "import" ? importProjectId || request.projectId : request?.projectId;
  const [level, setLevel] = useState("necessary");
  const [trajectory, setTrajectory] = useState(false), [graph, setGraph] = useState(false);
  const [preview, setPreview] = useState<PackagePreview>();
  const [profiles, setProfiles] = useState<Record<string, PackagePreview>>({});
  const [files, setFiles] = useState<string[]>();
  const [file, setFile] = useState<File>(), [inspection, setInspection] = useState<PackageInspection>();
  const [inspectedProject, setInspectedProject] = useState<string>();
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [exportNotice, setExportNotice] = useState("");
  const [copy, setCopy] = useState<CopyOperation>();
  const [exportTask, setExportTask] = useState<{ project: string; task: ExportOperation }>();
  const [messageId, setMessageId] = useState("");
  const readOnly = isEvidenceSessionReadOnly(activeDetail);
  const canContinue = activeDetail?.researchSnapshot?.role === "imported_snapshot" && activeDetail.researchSnapshot.state === "ready" && activeDetail.researchSnapshot.continuationAvailable === true;
  const branch = activeDetail?.conversationBranch;
  const requestId = useRef(crypto.randomUUID());
  const copying = useRef(false);
  const busyRef = useRef(false);
  useEffect(() => {
    if (!request) return;
    let active = true;
    setImportProjectId(""); setInspectedProject(undefined);
    setDialog(request.kind); setDetail(undefined); setPreview(undefined); setProfiles({}); setError(""); setFiles(undefined); setFile(undefined); setInspection(undefined); setLevel("necessary"); setTrajectory(false); setGraph(false); setMessageId(request.messageId ?? "");
    if (request.sessionId) void client.request<SessionDetail>(`/api/sessions/${encodeURIComponent(request.sessionId)}`).then(value => { if (active) setDetail(value); }).catch(reason => { if (active) setError(reason?.status === 404 ? t.sourceUnavailable : String(reason.message ?? reason)); });
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
    setPreview(undefined); setError("");
    const load = () => { void packagePreview(client, projectId, detail.id, level, trajectory, graph, files).then(value => { if (active) setPreview(value); }).catch(reason => {
      if (!active) return;
      if (reason?.code === "EXPORT_PREVIEW_PENDING") timer = setTimeout(load, 1500);
      else setError(reason?.status === 404 ? t.sourceUnavailable : String(reason.message ?? reason));
    }); }; load();
    return () => { active = false; clearTimeout(timer); };
  }, [client, dialog, detail?.id, projectId, level, trajectory, graph, files]);
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
  useEffect(() => {
    if (!exportTask || !["queued", "running"].includes(exportTask.task.status)) return;
    let active = true; let timer: ReturnType<typeof setTimeout>; let failures = 0;
    const poll = () => { void readExport(client, exportTask.project, exportTask.task.id).then(task => {
      if (!active) return;
      const step = exportPollStep(exportTask.project, exportTask.task, failures, { ok: true, task }, t);
      failures = step.failures; setExportNotice(step.error); setExportTask(step.task);
      if (!step.terminate) timer = setTimeout(poll, 1000);
    }).catch(reason => {
      if (!active) return;
      const step = exportPollStep(exportTask.project, exportTask.task, failures, { ok: false, reason }, t);
      failures = step.failures; setExportNotice(step.error); setExportTask(step.task);
      if (!step.terminate) timer = setTimeout(poll, 3000);
    }); };
    timer = setTimeout(poll, 1000); return () => { active = false; clearTimeout(timer); };
  }, [client, exportTask?.task.id, exportTask?.task.status]);
  async function perform(action: () => Promise<void>) {
    busyRef.current = true; setBusy(true); setError(""); try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { busyRef.current = false; setBusy(false); }
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
  return <>
    {readOnly ? <div className="research-package-resume"><p className="research-package-notice">{canContinue ? t.readOnly : t.continueUnavailable}</p><button className="primary-button" disabled={!canContinue || busy || copy?.state === "copying"} onClick={() => void copyResearch()} type="button">{t.continue}</button></div> : null}
    {branch ? <button className="research-package-source" onClick={() => onOpen(branch.sourceSessionId)} type="button">{t.source}</button> : null}
    {copy ? <div className="research-package-status" role="status">{copy.state === "copying" ? t.copying : copy.state === "failed" ? copy.error ?? t.failed : t.ready}{copy.state === "ready" && copy.entrySessionId ? <button onClick={() => onOpen(copy.entrySessionId!)} type="button">{t.open}</button> : null}</div> : null}
    {exportTask ? <div className={`research-package-status${exportTask.task.status === "failed" ? " is-failed" : ""}`} role="status">{["queued", "running"].includes(exportTask.task.status) ? <span aria-hidden="true" className="spinner" /> : null}{exportTask.task.status === "completed" ? exportTask.task.filename : exportTask.task.status === "failed" ? exportTask.task.error ?? t.failed : t.preparing}{exportTask.task.status === "completed" ? <button onClick={() => void perform(() => downloadExport(client, exportTask.project, exportTask.task))} type="button">{t.download}</button> : null}</div> : null}
    {(error || exportNotice) ? <p role="alert" className="research-package-error">{error || exportNotice}</p> : null}
    {dialog ? <div className="modal-backdrop" onClick={() => !busy && setDialog(undefined)}><section className="modal-panel research-package-dialog" role="dialog" aria-modal="true" aria-labelledby="research-package-title" onClick={event => event.stopPropagation()}>
      <header className="modal-header"><span className="modal-eyebrow">ScienceDiscovery</span><h2 id="research-package-title">{dialog === "export" ? t.export : dialog === "import" ? t.import : t.branch}</h2><button className="modal-close" aria-label={t.close} disabled={busy} onClick={() => setDialog(undefined)} type="button">×</button></header>
      <div className="modal-body">
        {dialog === "export" ? <>
          <p className="research-package-notice">{t.sessionScope}</p>
          <div className="research-package-profiles">{["necessary", "complete"].map(value => <button key={value} aria-pressed={level === value} className={level === value ? "is-selected" : ""} onClick={() => { setLevel(value); setFiles(undefined); }} type="button">
            <span className="research-profile-heading"><span className="research-profile-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{value === "necessary" ? <><path d="M7 3h7l4 4v14H7zM14 3v5h4M10 12h5M10 16h5" /></> : <><rect x="4" y="6" width="16" height="15" rx="2" /><path d="M8 6V3h8v3M4 11h16M10 15h4" /></>}</svg></span><span className="research-profile-check" aria-hidden="true">{level === value ? "✓" : ""}</span></span>
            <strong>{value === "necessary" ? t.necessary : t.complete}</strong><span className="research-profile-description">{value === "necessary" ? t.necessaryHint : t.completeHint}</span>
            <span className="research-profile-contents">{value === "necessary" ? t.necessaryContents : t.completeContents}</span>
            <span className="research-package-size"><span>{t.estimate}</span><b>{profiles[value] ? `${(profiles[value]!.estimatedBytes / 1024).toFixed(1)} KiB` : "—"}</b></span>
          </button>)}</div>
          {level === "complete" ? <div className="research-package-options"><label><input type="checkbox" checked={trajectory} onChange={event => setTrajectory(event.target.checked)} />{t.trajectory}</label><label><input type="checkbox" checked={graph} onChange={event => setGraph(event.target.checked)} />{t.graph}</label></div> : null}
          <p>{preview ? `${t.estimate} ${(preview.estimatedBytes / 1024).toFixed(1)} KiB` : t.calculating}</p>
          {preview ? <details><summary>{t.files} · {preview.files.length}</summary><div className="research-package-files">{preview.files.map(item => <label key={item.path}><input type="checkbox" checked={files ? files.includes(item.path) : item.selected !== false} onChange={event => { const selected = files ?? preview.files.filter(row => row.selected !== false).map(row => row.path); setFiles(event.target.checked ? [...selected, item.path] : selected.filter(path => path !== item.path)); }} />{item.path}</label>)}</div></details> : null}
          {preview?.omissions.length ? <details><summary>{t.omissions} · {preview.omissions.length}</summary><ul>{preview.omissions.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
          <p className="research-package-notice">{t.evidenceOnly}</p>
        </> : dialog === "import" ? <>
          <label className="research-import-project">{t.projectDestination}<select value={importProjectId} disabled={busy} onChange={event => setImportProjectId(event.target.value)}><option value="">{t.noProject}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><span>{t.projectDestinationHint}</span></label>
          <label className="research-package-upload">{t.choose}<input type="file" accept=".sdresearch" disabled={busy} onChange={event => { const selected = event.target.files?.[0]; setFile(selected); setInspection(undefined); setInspectedProject(undefined); if (selected && projectId) void perform(async () => { setInspection(await inspectPackage(client, projectId, selected)); setInspectedProject(projectId); }); }} /></label>
          {inspection ? <><h3>{inspection.manifest.source.title}</h3><p>{file?.name} · {inspection.objectCount} {t.objects}</p><p>{t.importHint}</p><ul>{inspection.manifest.omissions.map((item, index) => <li key={index}>{item}</li>)}</ul></> : <p>{t.importHint}</p>}
        </> : <><p>{t.branchHint}</p><blockquote>{detail?.messages.find(message => message.id === messageId)?.content.slice(0, 240)}</blockquote></>}
        {error ? <p role="alert" className="research-package-error">{error}</p> : null}
      </div>
      <footer className="modal-footer"><button className="secondary-button" disabled={busy} onClick={() => setDialog(undefined)} type="button">{t.close}</button><button className="primary-button" disabled={busy || (dialog === "export" ? !preview?.revision : dialog === "import" ? !inspection : !messageId || !detail || isEvidenceSessionReadOnly(detail) || copy?.state === "copying")} type="button" onClick={() => {
        if (dialog === "branch") void copyResearch(messageId);
        else if (dialog === "export" && detail && projectId && preview?.revision) void perform(async () => { const task = await startExport(client, projectId, { sessionId: detail.id, revision: preview.revision!, level, includeFullTrajectory: level === "complete" && trajectory, includeFullMemoryGraph: level === "complete" && graph, filePaths: files }); setExportTask({ project: projectId, task }); setDialog(undefined); });
        else if (file && projectId) void perform(async () => { const result = await importPackage(client, projectId, file, inspectedProject === projectId ? inspection?.packageChecksum : undefined); await onRefresh(); setDialog(undefined); const source = result.importedSessionIds[0]; if (source) { onOpen(source); const restored = await client.request<SessionDetail>(`/api/sessions/${encodeURIComponent(source)}`); if (restored.researchSnapshot?.continuationAvailable !== true || restored.researchSnapshot.state !== "ready") return; const operation = await startCopy(client, source, crypto.randomUUID()); setCopy(operation); if (operation.state === "ready" && operation.entrySessionId) { await onRefresh(); onOpen(operation.entrySessionId); } } });
      }}>{busy ? t.working : dialog === "export" ? t.startExport : dialog === "import" ? t.confirmImport : t.branch}</button></footer>
    </section></div> : null}
  </>;
}
