import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiClient } from "../api.js";
import type { ChatMessage } from "@sciencediscovery/schema";
import type { ResearchPackageExportProfileView as ResearchPackageExportProfile } from "../api/plugins.js";
import { trackResearchPackageExport } from "./ResearchPackageExportTasks.js";
import { ContinueResearchButton } from "./ContinueResearchButton.js";
import { ExportPreviewCache } from "./export-preview-cache.js";
import { ApiRequestError } from "../api/auth.js";
import { translateActive, useLocale } from "../i18n/index.js";

export type ResearchPackageDialogTarget = { projectId: string; sessionId: string; kind: "conversation" | "package" | "import" };
type DialogProps = { client: ApiClient; target: ResearchPackageDialogTarget; onClose: () => void; onImported?: (sessionIds: string[]) => Promise<void>; onContinued?: (sessionIds: string[], entrySessionId: string) => Promise<void>; onExportQueued?: (filename: string) => void };

function DialogFrame({ title, description, children, onClose, busy = false }: { title: string; description: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const { t } = useLocale();
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const section = ref.current;
    section?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab" || !section) return;
      const items = [...section.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden]), summary, [tabindex="0"]')].filter((item) => item.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={ref} aria-modal="true" aria-label={title} className="research-export-dialog" role="dialog">
      <header className="research-export-header"><div><span className="eyebrow">ScienceDiscovery</span><h2>{title}</h2><p>{description}</p></div><button aria-label={t("researchPackage.dialogClose")} className="icon-button" disabled={busy} onClick={onClose} type="button">×</button></header>
      {children}
    </section>
  </div>;
}
function ChoiceCard({ checked, title, description, onClick }: { checked: boolean; title: string; description: string; onClick: () => void }) {
  return <button aria-pressed={checked} className={checked ? "research-choice-card selected" : "research-choice-card"} onClick={onClick} type="button"><span><strong>{title}</strong><small>{description}</small></span><span className="research-choice-radio" aria-hidden="true">{checked ? "✓" : ""}</span></button>;
}
function download(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = href; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : translateActive("researchPackage.operationFailed");
const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;

function PackageScope({ profile }: { profile?: ResearchPackageExportProfile }) {
  const { t } = useLocale();
  if (!profile) return <p className="research-export-note">{t("researchPackage.legacyScope")}</p>;
  const counts = profile.included;
  return <div className="research-export-note">
    <p>{t("researchPackage.scopeCounts", { level: profile.level === "necessary" ? t("researchPackage.scopeNecessary") : t("researchPackage.scopeComplete"), ...counts })}</p>
    {!profile.capabilities.fullTrajectory ? <p>{t("researchPackage.scopeTrajectoryOmitted")}</p> : null}
  </div>;
}

function ConversationExportDialog({ client, target, onClose }: DialogProps) {
  const { t } = useLocale();
  const [format, setFormat] = useState<"markdown" | "pdf">("markdown");
  const [scope, setScope] = useState<"all" | "custom">("all");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [title, setTitle] = useState(t("researchPackage.readingSession"));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void client.getSession(target.sessionId).then((detail) => {
      if (!active) return;
      const prompts = detail.messages.filter((item) => item.role === "user" && (!item.kind || item.kind === "message"));
      setTitle(detail.title); setMessages(prompts); setSelectedIds(prompts.map((item) => item.id));
    }).catch((reason: unknown) => { if (active) setError(errorText(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, target.sessionId]);
  const exportConversation = async () => {
    setBusy(true); setError(undefined);
    const printWindow = format === "pdf" ? window.open("about:blank", "_blank") : null;
    try {
      if (format === "pdf" && !printWindow) throw new Error(t("researchPackage.popupBlocked"));
      const blob = await client.exportConversation(target.sessionId, format, scope === "custom" ? selectedIds : undefined);
      if (printWindow) {
        const href = URL.createObjectURL(blob); printWindow.location.href = href;
        window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
      } else download(blob, `${title.replace(/[\\/:*?"<>|]/g, "_")}.md`);
      onClose();
    } catch (reason) { printWindow?.close(); setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  return <DialogFrame description={title} onClose={onClose} title={t("researchPackage.exportConversation")}>
    <div className="research-export-body">
      <fieldset><legend>{t("researchPackage.format")}</legend><div className="research-choice-grid"><ChoiceCard checked={format === "pdf"} description={t("researchPackage.pdfDescription")} onClick={() => setFormat("pdf")} title="PDF" /><ChoiceCard checked={format === "markdown"} description={t("researchPackage.markdownDescription")} onClick={() => setFormat("markdown")} title="Markdown" /></div></fieldset>
      <fieldset><legend>{t("researchPackage.content")}</legend><div className="research-choice-grid"><ChoiceCard checked={scope === "all"} description={t("researchPackage.allMessages")} onClick={() => setScope("all")} title={t("researchPackage.wholeConversation")} /><ChoiceCard checked={scope === "custom"} description={t("researchPackage.promptAndReplies")} onClick={() => setScope("custom")} title={t("researchPackage.selected")} /></div></fieldset>
      {scope === "custom" ? <div className="research-message-picker"><div className="research-picker-heading"><strong>{t("researchPackage.selectPrompt")}</strong><span>{selectedIds.length}/{messages.length}</span></div>{messages.map((message, index) => <label key={message.id}><input checked={selectedIds.includes(message.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, message.id] : current.filter((id) => id !== message.id))} type="checkbox" /><span>{message.content.trim() || `Prompt ${index + 1}`}</span></label>)}{!messages.length ? <p>{t("researchPackage.noPrompts")}</p> : null}</div> : null}
      {error ? <p role="alert" className="research-export-error">{error}</p> : null}
    </div>
    <footer className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={onClose} type="button">{t("researchPackage.cancel")}</button><button className="primary-button" disabled={busy || loading || (scope === "custom" && !selectedIds.length)} onClick={() => void exportConversation()} type="button">{busy ? t("researchPackage.exporting") : t("researchPackage.exportFormat", { format: format === "pdf" ? "PDF" : "Markdown" })}</button></footer>
  </DialogFrame>;
}

function PackageExportDialog({ client, target, onClose, onExportQueued }: DialogProps) {
  const { t } = useLocale();
  const previewCache = useMemo(() => new ExportPreviewCache(client), [client]);
  const [level, setLevel] = useState<"necessary" | "complete">("necessary");
  const [includeFullTrajectory, setIncludeFullTrajectory] = useState(false);
  const [includeFullMemoryGraph, setIncludeFullMemoryGraph] = useState(false);
  const [files, setFiles] = useState<Array<{ path: string; size: number; selected?: boolean }>>(() => previewCache.peekDefaults(target.projectId, target.sessionId)?.necessary.files ?? []);
  const [selectedPaths, setSelectedPaths] = useState<string[] | undefined>();
  const [preview, setPreview] = useState<{ revision?: string; estimatedBytes: number; estimateKind?: "uncompressed"; omissions: string[]; exportProfile?: ResearchPackageExportProfile } | undefined>(() => previewCache.peekDefaults(target.projectId, target.sessionId)?.necessary);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  // The scope this dialog previews can be deleted while the dialog is open (another
  // client, another tab, a teardown). The poll then answers `deleted`; the last
  // estimate stays on screen as the pre-deletion snapshot, but exporting it would
  // only fail, so both export buttons are disabled from that answer on.
  const [scopeGone, setScopeGone] = useState(false);
  const [sessionTitle, setSessionTitle] = useState(t("researchPackage.currentSession"));
  const [defaults, setDefaults] = useState(() => previewCache.peekDefaults(target.projectId, target.sessionId));
  const sessionRevision = defaults?.revision;
  const chooseLevel = (next: "necessary" | "complete") => {
    if (next === level) return;
    const result = next === "necessary" ? defaults?.necessary : includeFullMemoryGraph
      ? includeFullTrajectory ? defaults?.completeWithTrajectoryAndMemoryGraph : defaults?.completeWithMemoryGraph
      : includeFullTrajectory ? defaults?.completeWithTrajectory : defaults?.complete;
    setLevel(next); setSelectedPaths(undefined); setFiles(result?.files ?? []); setPreview(result);
    if (next === "necessary") setIncludeFullTrajectory(false);
  };
  const checkedPaths = selectedPaths ?? files.filter((file) => file.selected !== false).map((file) => file.path);
  useEffect(() => {
    let active = true;
    if (typeof client.getSession !== "function") return () => { active = false; };
    void client.getSession(target.sessionId).then((detail) => {
      if (active) setSessionTitle(detail.title || t("researchPackage.currentSession"));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [client, target.sessionId]);
  useEffect(() => {
    let active = true;
    const unsubscribe = previewCache.subscribe(() => {
      if (!active) return;
      const next = previewCache.peekDefaults(target.projectId, target.sessionId);
      setDefaults(next);
      if (!next) setPreview(undefined);
    });
    setScopeGone(false);
    const refresh = () => { void previewCache.refreshDefaults(target.projectId, target.sessionId).catch((reason: unknown) => {
      if (!active) return;
      // The dialog renders this state from its own snapshot, so the wording can
      // match what is actually on screen; the rejection's message is not used.
      if (reason instanceof ApiRequestError && reason.code === "EXPORT_PREVIEW_RESOURCE_DELETED") {
        setScopeGone(true); setError(undefined); return;
      }
      setError(errorText(reason));
    }); };
    refresh();
    const timer = window.setInterval(refresh, 3_000);
    return () => { active = false; unsubscribe(); window.clearInterval(timer); };
  }, [previewCache, target.projectId, target.sessionId]);
  useEffect(() => {
    let active = true;
    setError(undefined);
    if (!defaults) { setPreview(undefined); return () => { active = false; }; }
    if (!selectedPaths) {
      const result = level === "necessary" ? defaults.necessary : includeFullMemoryGraph
        ? includeFullTrajectory ? defaults.completeWithTrajectoryAndMemoryGraph : defaults.completeWithMemoryGraph
        : includeFullTrajectory ? defaults.completeWithTrajectory : defaults.complete;
      setPreview(result); setFiles(result.files);
      return () => { active = false; };
    }
    setPreview(undefined);
    const load = () => { void previewCache.get(target.projectId, target.sessionId, level, selectedPaths, level === "complete" && includeFullTrajectory, sessionRevision, level === "complete" && includeFullMemoryGraph).then((result) => {
        if (active) { setPreview(result); setFiles(result.files); }
      }).catch((reason: unknown) => { if (active) setError(errorText(reason)); }); };
    // Collapse rapid checkbox changes; level defaults use their own cached/in-flight result.
    const timer = selectedPaths ? setTimeout(load, 180) : undefined;
    if (!selectedPaths) load();
    return () => { active = false; if (timer !== undefined) clearTimeout(timer); };
  }, [previewCache, defaults, level, includeFullTrajectory, includeFullMemoryGraph, selectedPaths, sessionRevision, target.projectId, target.sessionId]);
  const exportPackage = async () => {
    setBusy(true); setMessage(undefined); setError(undefined);
    try {
      const safeTitle = sessionTitle.trim().replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").slice(0, 120) || t("researchPackage.scientificSession");
      download(await client.exportResearchPackage(target.projectId, target.sessionId, level, selectedPaths, level === "complete" && includeFullTrajectory, level === "complete" && includeFullMemoryGraph), `${safeTitle}.sdresearch`);
      onClose();
    }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  const exportPackageInBackground = async () => {
    if (!preview?.revision) return;
    setBusy(true); setMessage(undefined); setError(undefined);
    try {
      const safeTitle = sessionTitle.trim().replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").slice(0, 120) || t("researchPackage.scientificSession");
      const task = await client.startResearchPackageExport(target.projectId, {
        sessionId: target.sessionId, level, filePaths: selectedPaths,
        includeFullTrajectory: level === "complete" && includeFullTrajectory,
        includeFullMemoryGraph: level === "complete" && includeFullMemoryGraph,
        revision: preview.revision,
      });
      trackResearchPackageExport(target.projectId, task);
      onExportQueued?.(task.filename || `${safeTitle}.sdresearch`);
      onClose();
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  const completeDefaultPreview = includeFullMemoryGraph
    ? includeFullTrajectory ? defaults?.completeWithTrajectoryAndMemoryGraph : defaults?.completeWithMemoryGraph
    : includeFullTrajectory ? defaults?.completeWithTrajectory : defaults?.complete;
  const necessarySize = defaults && defaults.necessary.revision === defaults.revision ? defaults.necessary.estimatedBytes : undefined;
  const completeSize = completeDefaultPreview && completeDefaultPreview.revision === defaults?.revision ? completeDefaultPreview.estimatedBytes : undefined;
  // A gone scope will never finish a preview, so the dialog stops promising
  // "Calculating…" next to an alert that says the opposite (#1074 F6).
  const unavailableSize = "—";
  const sizeText = (bytes: number | undefined) => bytes === undefined
    ? scopeGone ? unavailableSize : t("researchPackage.previewCalculating")
    : formatSize(bytes);
  // What the alert may claim is on screen. `preview` alone is not enough: picking
  // a file clears it while the two scope cards keep the sizes they read from
  // `defaults`, and those survive the gone answer — in that window the cards show
  // last-known bytes, so the sentence has to admit them.
  const hasVisibleSizes = preview !== undefined || necessarySize !== undefined || completeSize !== undefined;
  return <DialogFrame description={t("researchPackage.exportDescription")} onClose={onClose} title={t("researchPackage.exportEvidence")}>
    <div className="research-export-body">
      <div className="research-choice-grid"><ChoiceCard checked={level === "necessary"} description={t("researchPackage.necessaryDescription", { size: sizeText(necessarySize) })} onClick={() => chooseLevel("necessary")} title={t("researchPackage.scopeNecessary")} /><ChoiceCard checked={level === "complete"} description={t("researchPackage.completeDescription", { size: sizeText(completeSize) })} onClick={() => chooseLevel("complete")} title={t("researchPackage.scopeComplete")} /></div>
      <div className="research-export-estimate" aria-live="polite"><strong>{preview ? t("researchPackage.estimatedSize", { size: formatSize(preview.estimatedBytes) }) : sizeText(undefined)}</strong><span>{t("researchPackage.selectedFiles", { selected: checkedPaths.length, total: files.length })}</span></div>
      <p className="research-export-note">{t("researchPackage.previewNote")}</p>
      {preview?.estimateKind === "uncompressed" ? <p className="research-export-note">{t("researchPackage.uncompressedNote")}</p> : null}
      {preview?.exportProfile ? <PackageScope profile={preview.exportProfile} /> : null}
      <details className="research-export-details"><summary>{t("researchPackage.customContent")}</summary><p>{t("researchPackage.customContentNote")}</p><div className="research-message-picker">
        {files.map((file) => <label key={file.path}><input checked={checkedPaths.includes(file.path)} onChange={(event) => setSelectedPaths((current) => { const paths = current ?? checkedPaths; return event.target.checked ? [...new Set([...paths, file.path])] : paths.filter((path) => path !== file.path); })} type="checkbox" /><span>{file.path} <small>{formatSize(file.size)}</small></span></label>)}
        {!files.length ? <p>{t("researchPackage.noWorkspaceFiles")}</p> : null}
      </div></details>
      {level === "complete" ? <label className="research-export-toggle"><input checked={includeFullTrajectory} onChange={(event) => setIncludeFullTrajectory(event.target.checked)} type="checkbox" /><span><strong>{t("researchPackage.fullTrajectory")}</strong><small>{t("researchPackage.fullTrajectoryHint")}</small></span></label> : null}
      {level === "complete" ? <label className="research-export-toggle"><input checked={includeFullMemoryGraph} onChange={(event) => setIncludeFullMemoryGraph(event.target.checked)} type="checkbox" /><span><strong>{t("researchPackage.fullMemoryGraph")}</strong><small>{t("researchPackage.fullMemoryGraphHint")}</small></span></label> : null}
      <p className="research-export-note">{t("researchPackage.completeNote")}</p>
      {preview?.omissions.length ? <details className="research-export-details"><summary>{t("researchPackage.omissions", { count: preview.omissions.length })}</summary><ul>{preview.omissions.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
      {scopeGone ? <p role="alert" className="research-export-error">{t(hasVisibleSizes ? "researchPackage.resourceDeleted" : "researchPackage.resourceDeletedNoSizes")}</p> : error ? <p role="alert" className="research-export-error">{error}</p> : null}{message ? <p role="status" className="research-export-status">{message}</p> : null}
    </div>
    <footer className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={onClose} type="button">{t("researchPackage.cancel")}</button><span className="dialog-actions-spacer" /><button className="secondary-button" disabled={busy || scopeGone || !preview?.revision} onClick={() => void exportPackageInBackground()} type="button">{t("researchPackage.backgroundExport")}</button><button className="primary-button" disabled={busy || scopeGone || !preview} onClick={() => void exportPackage()} type="button">{busy ? t("researchPackage.processing") : t("researchPackage.immediateExport")}</button></footer>
  </DialogFrame>;
}

type PackageInspectionView = {
  manifest?: { source?: { projectId?: string; title?: string; sessionIds?: string[] }; packageKind?: string; createdAt?: string; omissions?: string[]; exportProfile?: ResearchPackageExportProfile };
  files?: Array<{ path: string; sizeBytes: number; kind: string }>;
  objectCount?: number;
  recordsBytes?: number;
  totalBytes?: number;
};

type ImportStage = "select" | "inspecting" | "review" | "importing" | "complete";

function PackageImportDialog({ client, target, onClose, onImported, onContinued }: DialogProps) {
  const { t } = useLocale();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<ImportStage>("select");
  const [file, setFile] = useState<File>();
  const [inspection, setInspection] = useState<PackageInspectionView & { packageChecksum?: string }>();
  const [receipt, setReceipt] = useState<{ artifactCount?: number; importedSessionIds?: string[]; omissions?: string[]; continuationAvailable?: boolean; exportProfile?: ResearchPackageExportProfile }>();
  const [error, setError] = useState<string>();
  const busy = stage === "importing" || stage === "inspecting";
  const selectPackage = async (candidate: File) => {
    setError(undefined);
    if (!candidate.name.toLowerCase().endsWith(".sdresearch")) {
      setError(t("researchPackage.selectSdresearch"));
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setFile(candidate);
    setInspection(undefined);
    setStage("inspecting");
    try {
      const result = await client.inspectResearchPackage(target.projectId, candidate) as PackageInspectionView;
      setInspection(result);
      setStage("review");
    } catch (reason) {
      setFile(undefined); setInspection(undefined); setStage("select"); setError(errorText(reason));
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };
  const importPackage = async () => {
    if (!file) return;
    setStage("importing"); setError(undefined);
    try {
      const imported = await client.importResearchPackage(target.projectId, file, target.sessionId, inspection?.packageChecksum) as NonNullable<typeof receipt>;
      setReceipt(imported);
      setStage("complete");
      await onImported?.(imported.importedSessionIds ?? [target.sessionId]).catch((reason: unknown) => setError(errorText(reason)));
    } catch (reason) { setStage("review"); setError(errorText(reason)); }
  };
  return <DialogFrame busy={busy} description={t("researchPackage.importDescription")} onClose={busy ? () => undefined : onClose} title={t("researchPackage.importEvidence")}>
    {stage === "select" ? <>
      <div className="research-export-body research-import-empty"><div className="research-import-file-icon">↓</div><strong>{t("researchPackage.choosePackage")}</strong><p>{t("researchPackage.onlySdresearch")}</p>{error ? <p role="alert" className="research-export-error">{error}</p> : null}</div>
      <footer className="dialog-actions"><span className="dialog-actions-spacer" /><button className="secondary-button" onClick={onClose} type="button">{t("researchPackage.cancel")}</button><button className="primary-button" onClick={() => inputRef.current?.click()} type="button">{t("researchPackage.chooseFile")}</button><input ref={inputRef} accept=".sdresearch" hidden onChange={(event) => { const selected = event.target.files?.[0]; if (selected) void selectPackage(selected); }} type="file" /></footer>
    </> : null}
    {stage === "inspecting" ? <div className="research-import-progress" role="status" aria-live="polite" aria-busy="true"><div className="research-import-spinner" aria-hidden="true" /><h3>{t("researchPackage.readingPackage")}</h3><p>{t("researchPackage.uploadValidate")}</p><div className="research-import-progress-track" aria-hidden="true"><span /></div><small>{t("researchPackage.checkingPackage")}</small></div> : null}
    {stage === "review" ? <>
      <div className="research-export-body">
        <div className="research-import-file-row"><span className="research-import-file-icon">▣</span><div><strong>{file?.name}</strong><small>{file ? formatSize(file.size) : ""}</small></div></div>
        <div className="research-import-summary"><div><span>{t("researchPackage.source")}</span><strong>{inspection?.manifest?.source?.title || t("researchPackage.scientificSession")}</strong></div><div><span>{t("researchPackage.sessions")}</span><strong>{t("researchPackage.sessionCount", { count: inspection?.manifest?.source?.sessionIds?.length ?? 1 })}</strong></div><div><span>{t("researchPackage.records")}</span><strong>{formatSize(inspection?.recordsBytes ?? 0)}</strong></div><div><span>{t("researchPackage.fileObjects")}</span><strong>{t("researchPackage.objectCount", { count: inspection?.objectCount ?? 0 })}</strong></div></div>
        <p className="research-import-target">{t("researchPackage.importTarget")}</p>
        <PackageScope profile={inspection?.manifest?.exportProfile} />
        {inspection?.manifest?.omissions?.length ? <details className="research-export-details"><summary>{t("researchPackage.viewLimitations", { count: inspection.manifest.omissions.length })}</summary><ul>{inspection.manifest.omissions.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
        {error ? <p role="alert" className="research-export-error">{error}</p> : null}
      </div>
      <footer className="dialog-actions"><button className="secondary-button" onClick={() => { setFile(undefined); setInspection(undefined); setStage("select"); }} type="button">{t("researchPackage.reselect")}</button><span className="dialog-actions-spacer" /><button className="secondary-button" onClick={onClose} type="button">{t("researchPackage.cancel")}</button><button className="primary-button" onClick={() => void importPackage()} type="button">{t("researchPackage.importEvidence")}</button></footer>
    </> : null}
    {stage === "importing" ? <div className="research-import-progress"><div className="research-import-spinner" aria-hidden="true" /><h3>{t("researchPackage.importingResearch")}</h3><p>{t("researchPackage.restoreContent")}</p><div className="research-import-progress-track"><span /></div><small>{t("researchPackage.writingEvidence")}</small></div> : null}
    {stage === "complete" ? <>
      <div className="research-import-complete"><div className="research-import-success" aria-hidden="true">✓</div><h3>{t("researchPackage.imported")}</h3><p>{file?.name}</p><p>{t("researchPackage.importedLocked")}</p><div className="research-import-complete-stats"><span>{t("researchPackage.statSessions", { count: receipt?.importedSessionIds?.length ?? 1 })}</span><span>{t("researchPackage.statArtifacts", { count: receipt?.artifactCount ?? 0 })}</span><span>{t("researchPackage.statLimitations", { count: receipt?.omissions?.length ?? 0 })}</span></div>
      {(receipt?.importedSessionIds?.length ?? 1) > 1 ? <p>{t("researchPackage.continueRelated", { count: receipt?.importedSessionIds?.length ?? 0 })}</p> : null}
      <PackageScope profile={receipt?.exportProfile} />
      {receipt?.continuationAvailable === false ? <p role="alert">{t("researchPackage.incompleteRestore")}</p> : null}
      {receipt?.omissions?.length ? <details className="research-export-details"><summary>{t("researchPackage.viewLimitations", { count: receipt.omissions.length })}</summary><ul>{receipt.omissions.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
      {error ? <p role="alert" className="research-export-error">{error}</p> : null}</div>
      <footer className="dialog-actions"><button className="secondary-button" onClick={onClose} type="button">{t("researchPackage.viewImported")}</button>{onContinued ? <ContinueResearchButton client={client} disabled={!receipt?.continuationAvailable} onCreated={onContinued} sessionId={target.sessionId} /> : null}</footer>
    </> : null}
  </DialogFrame>;
}
export function ResearchPackageDialogs({ client, target, onClose, onImported, onContinued, onExportQueued }: Omit<DialogProps, "target"> & { target?: ResearchPackageDialogTarget }) {
  if (!target) return null;
  if (target.kind === "conversation") return <ConversationExportDialog client={client} onClose={onClose} target={target} />;
  if (target.kind === "import") return <PackageImportDialog client={client} onClose={onClose} onImported={onImported} onContinued={onContinued} target={target} />;
  return <PackageExportDialog client={client} onClose={onClose} onExportQueued={onExportQueued} target={target} />;
}
