import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiClient } from "../api.js";
import type { ChatMessage } from "@sciencediscovery/schema";
import type { ResearchPackageExportProfileView as ResearchPackageExportProfile } from "../api/plugins.js";
import { trackResearchPackageExport } from "./ResearchPackageExportTasks.js";
import { ContinueResearchButton } from "./ContinueResearchButton.js";
import { ExportPreviewCache } from "./export-preview-cache.js";

export type ResearchPackageDialogTarget = { projectId: string; sessionId: string; kind: "conversation" | "package" | "import" };
type DialogProps = { client: ApiClient; target: ResearchPackageDialogTarget; onClose: () => void; onImported?: (sessionIds: string[]) => Promise<void>; onContinued?: (sessionIds: string[], entrySessionId: string) => Promise<void>; onExportQueued?: (filename: string) => void };

function DialogFrame({ title, description, children, onClose, busy = false }: { title: string; description: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
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
      <header className="research-export-header"><div><span className="eyebrow">ScienceDiscovery</span><h2>{title}</h2><p>{description}</p></div><button aria-label="关闭" className="icon-button" disabled={busy} onClick={onClose} type="button">×</button></header>
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
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : "操作失败，请重试";
const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;

function PackageScope({ profile }: { profile?: ResearchPackageExportProfile }) {
  if (!profile) return <p className="research-export-note">旧版证据包未记录导出级别，请以包内已有内容及限制说明为准。</p>;
  const counts = profile.included;
  return <div className="research-export-note">
    <p>{profile.level === "necessary" ? "必要导出" : "完整导出"} · {counts.messages} 条消息 · {counts.artifactVersions} 个产物版本 · {counts.executionRuns} 条执行记录 · {counts.trajectoryEvents} 个轨迹事件 · {counts.memoryNodes} 个科学记忆节点</p>
    {!profile.capabilities.fullTrajectory ? <p>包含轨迹摘要，未包含完整思考及原始事件流。继续研究仅复制包内已有内容，无法补回省略的历史。</p> : null}
  </div>;
}

function ConversationExportDialog({ client, target, onClose }: DialogProps) {
  const [format, setFormat] = useState<"markdown" | "pdf">("markdown");
  const [scope, setScope] = useState<"all" | "custom">("all");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [title, setTitle] = useState("读取会话…");
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
      if (format === "pdf" && !printWindow) throw new Error("浏览器拦截了打印窗口，请允许弹出窗口后重试");
      const blob = await client.exportConversation(target.sessionId, format, scope === "custom" ? selectedIds : undefined);
      if (printWindow) {
        const href = URL.createObjectURL(blob); printWindow.location.href = href;
        window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
      } else download(blob, `${title.replace(/[\\/:*?"<>|]/g, "_")}.md`);
      onClose();
    } catch (reason) { printWindow?.close(); setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  return <DialogFrame description={title} onClose={onClose} title="导出会话">
    <div className="research-export-body">
      <fieldset><legend>格式</legend><div className="research-choice-grid"><ChoiceCard checked={format === "pdf"} description="通过浏览器打印窗口保存 PDF" onClick={() => setFormat("pdf")} title="PDF" /><ChoiceCard checked={format === "markdown"} description="保留结构，便于继续编辑" onClick={() => setFormat("markdown")} title="Markdown" /></div></fieldset>
      <fieldset><legend>内容</legend><div className="research-choice-grid"><ChoiceCard checked={scope === "all"} description="当前会话中的全部消息" onClick={() => setScope("all")} title="整个对话" /><ChoiceCard checked={scope === "custom"} description="勾选 Prompt 及其后续回复" onClick={() => setScope("custom")} title="已选择" /></div></fieldset>
      {scope === "custom" ? <div className="research-message-picker"><div className="research-picker-heading"><strong>选择 Prompt</strong><span>{selectedIds.length}/{messages.length}</span></div>{messages.map((message, index) => <label key={message.id}><input checked={selectedIds.includes(message.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, message.id] : current.filter((id) => id !== message.id))} type="checkbox" /><span>{message.content.trim() || `Prompt ${index + 1}`}</span></label>)}{!messages.length ? <p>当前会话没有可导出的 Prompt。</p> : null}</div> : null}
      {error ? <p role="alert" className="research-export-error">{error}</p> : null}
    </div>
    <footer className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={onClose} type="button">取消</button><button className="primary-button" disabled={busy || loading || (scope === "custom" && !selectedIds.length)} onClick={() => void exportConversation()} type="button">{busy ? "导出中…" : `导出 ${format === "pdf" ? "PDF" : "Markdown"}`}</button></footer>
  </DialogFrame>;
}

function PackageExportDialog({ client, target, onClose, onExportQueued }: DialogProps) {
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
  const [sessionTitle, setSessionTitle] = useState("当前会话");
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
      if (active) setSessionTitle(detail.title || "当前会话");
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
    const refresh = () => { void previewCache.refreshDefaults(target.projectId, target.sessionId).catch((reason: unknown) => { if (active) setError(errorText(reason)); }); };
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
      const safeTitle = sessionTitle.trim().replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").slice(0, 120) || "科研会话";
      download(await client.exportResearchPackage(target.projectId, target.sessionId, level, selectedPaths, level === "complete" && includeFullTrajectory, level === "complete" && includeFullMemoryGraph), `${safeTitle}.sdresearch`);
      onClose();
    }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  const exportPackageInBackground = async () => {
    if (!preview?.revision) return;
    setBusy(true); setMessage(undefined); setError(undefined);
    try {
      const safeTitle = sessionTitle.trim().replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").slice(0, 120) || "科研会话";
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
  return <DialogFrame description="保留所选会话的全部消息，按用途选择证据范围与工作区文件。" onClose={onClose} title="导出证据包">
    <div className="research-export-body">
      <div className="research-choice-grid"><ChoiceCard checked={level === "necessary"} description={`当前产物及依赖、溯源和轨迹摘要 · ${necessarySize === undefined ? "正在计算大小…" : formatSize(necessarySize)}`} onClick={() => chooseLevel("necessary")} title="必要导出" /><ChoiceCard checked={level === "complete"} description={`全部已有文件、产物版本和执行记录 · ${completeSize === undefined ? "正在计算大小…" : formatSize(completeSize)}`} onClick={() => chooseLevel("complete")} title="完整导出" /></div>
      <div className="research-export-estimate" aria-live="polite"><strong>{preview ? `预计 ${formatSize(preview.estimatedBytes)}` : "正在计算大小…"}</strong><span>已选择 {checkedPaths.length}/{files.length} 个工作区文件</span></div>
      <p className="research-export-note">大小预览随会话内容在后台更新。若最新会话版本仍在计算，会显示“正在计算大小…”，完成后自动显示当前选择的估算值。</p>
      {preview?.estimateKind === "uncompressed" ? <p className="research-export-note">显示所选内容的未压缩估算大小，实际下载大小以压缩后的证据包为准。</p> : null}
      {preview?.exportProfile ? <PackageScope profile={preview.exportProfile} /> : null}
      <details className="research-export-details"><summary>自定义内容</summary><p>必要导出默认勾选输入数据和与当前结果有关的文件，Python、JSON 等按溯源关联选择。切换级别会恢复该级别的默认选择；取消文件不会移除其已登记产物。</p><div className="research-message-picker">
        {files.map((file) => <label key={file.path}><input checked={checkedPaths.includes(file.path)} onChange={(event) => setSelectedPaths((current) => { const paths = current ?? checkedPaths; return event.target.checked ? [...new Set([...paths, file.path])] : paths.filter((path) => path !== file.path); })} type="checkbox" /><span>{file.path} <small>{formatSize(file.size)}</small></span></label>)}
        {!files.length ? <p>当前会话没有工作区文件。</p> : null}
      </div></details>
      {level === "complete" ? <label className="research-export-toggle"><input checked={includeFullTrajectory} onChange={(event) => setIncludeFullTrajectory(event.target.checked)} type="checkbox" /><span><strong>包含完整轨迹</strong><small>保存完整思考分片和原始事件流，会增加内存占用和导出体积。</small></span></label> : null}
      {level === "complete" ? <label className="research-export-toggle"><input checked={includeFullMemoryGraph} onChange={(event) => setIncludeFullMemoryGraph(event.target.checked)} type="checkbox" /><span><strong>包含完整科学记忆图谱</strong><small>勾选后保存科学记忆节点和关系；不勾选时保留科学记忆摘要。</small></span></label> : null}
      <p className="research-export-note">完整导出保留已有文件修订元数据及当前文件内容；Notebook 以工作区中的 .ipynb 文件保存，不会生成尚未持久化的历史内容。</p>
      {preview?.omissions.length ? <details className="research-export-details"><summary>省略内容与限制（{preview.omissions.length}）</summary><ul>{preview.omissions.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
      {error ? <p role="alert" className="research-export-error">{error}</p> : null}{message ? <p role="status" className="research-export-status">{message}</p> : null}
    </div>
    <footer className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={onClose} type="button">取消</button><span className="dialog-actions-spacer" /><button className="secondary-button" disabled={busy || !preview?.revision} onClick={() => void exportPackageInBackground()} type="button">后台导出</button><button className="primary-button" disabled={busy || !preview} onClick={() => void exportPackage()} type="button">{busy ? "处理中…" : "立即导出"}</button></footer>
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
      setError("请选择 .sdresearch 科研证据包");
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
  return <DialogFrame busy={busy} description="仅允许导入到没有消息、运行记录、文件或产物的新会话。" onClose={busy ? () => undefined : onClose} title="导入证据包">
    {stage === "select" ? <>
      <div className="research-export-body research-import-empty"><div className="research-import-file-icon">↓</div><strong>选择科研证据包</strong><p>仅支持 ScienceDiscovery 的 .sdresearch 格式。</p>{error ? <p role="alert" className="research-export-error">{error}</p> : null}</div>
      <footer className="dialog-actions"><span className="dialog-actions-spacer" /><button className="secondary-button" onClick={onClose} type="button">取消</button><button className="primary-button" onClick={() => inputRef.current?.click()} type="button">选择证据包</button><input ref={inputRef} accept=".sdresearch" hidden onChange={(event) => { const selected = event.target.files?.[0]; if (selected) void selectPackage(selected); }} type="file" /></footer>
    </> : null}
    {stage === "inspecting" ? <div className="research-import-progress" role="status" aria-live="polite" aria-busy="true"><div className="research-import-spinner" aria-hidden="true" /><h3>正在读取证据包…</h3><p>正在上传并校验文件内容，请稍候。</p><div className="research-import-progress-track" aria-hidden="true"><span /></div><small>正在检查科研证据包</small></div> : null}
    {stage === "review" ? <>
      <div className="research-export-body">
        <div className="research-import-file-row"><span className="research-import-file-icon">▣</span><div><strong>{file?.name}</strong><small>{file ? formatSize(file.size) : ""}</small></div></div>
        <div className="research-import-summary"><div><span>来源</span><strong>{inspection?.manifest?.source?.title || "科研会话"}</strong></div><div><span>会话</span><strong>{inspection?.manifest?.source?.sessionIds?.length ?? 1} 个</strong></div><div><span>记录</span><strong>{formatSize(inspection?.recordsBytes ?? 0)}</strong></div><div><span>文件对象</span><strong>{inspection?.objectCount ?? 0} 个</strong></div></div>
        <p className="research-import-target">将导入到当前空会话，保存为只读证据快照。继续研究时可创建内容相同的独立新会话。</p>
        <PackageScope profile={inspection?.manifest?.exportProfile} />
        {inspection?.manifest?.omissions?.length ? <details className="research-export-details"><summary>查看内容限制（{inspection.manifest.omissions.length}）</summary><ul>{inspection.manifest.omissions.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
        {error ? <p role="alert" className="research-export-error">{error}</p> : null}
      </div>
      <footer className="dialog-actions"><button className="secondary-button" onClick={() => { setFile(undefined); setInspection(undefined); setStage("select"); }} type="button">重新选择</button><span className="dialog-actions-spacer" /><button className="secondary-button" onClick={onClose} type="button">取消</button><button className="primary-button" onClick={() => void importPackage()} type="button">导入</button></footer>
    </> : null}
    {stage === "importing" ? <div className="research-import-progress"><div className="research-import-spinner" aria-hidden="true" /><h3>正在导入研究…</h3><p>正在恢复会话、文件和产物，请保持应用打开。</p><div className="research-import-progress-track"><span /></div><small>正在校验并写入科研证据</small></div> : null}
    {stage === "complete" ? <>
      <div className="research-import-complete"><div className="research-import-success" aria-hidden="true">✓</div><h3>证据包已导入</h3><p>{file?.name}</p><p>导入会话已锁定，保留本次导入的原始研究记录。继续研究将创建内容相同的新会话。</p><div className="research-import-complete-stats"><span>{receipt?.importedSessionIds?.length ?? 1} 个会话</span><span>{receipt?.artifactCount ?? 0} 个产物</span><span>{receipt?.omissions?.length ?? 0} 条限制记录</span></div>
      {(receipt?.importedSessionIds?.length ?? 1) > 1 ? <p>继续研究将复制全部 {receipt?.importedSessionIds?.length} 个关联会话。</p> : null}
      <PackageScope profile={receipt?.exportProfile} />
      {receipt?.continuationAvailable === false ? <p role="alert">部分记录未完整恢复，请先检查导入限制并重新导入。当前内容仍可查看。</p> : null}
      {receipt?.omissions?.length ? <details className="research-export-details"><summary>查看内容限制</summary><ul>{receipt.omissions.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
      {error ? <p role="alert" className="research-export-error">{error}</p> : null}</div>
      <footer className="dialog-actions"><button className="secondary-button" onClick={onClose} type="button">查看导入会话</button>{onContinued ? <ContinueResearchButton client={client} disabled={!receipt?.continuationAvailable} onCreated={onContinued} sessionId={target.sessionId} /> : null}</footer>
    </> : null}
  </DialogFrame>;
}
export function ResearchPackageDialogs({ client, target, onClose, onImported, onContinued, onExportQueued }: Omit<DialogProps, "target"> & { target?: ResearchPackageDialogTarget }) {
  if (!target) return null;
  if (target.kind === "conversation") return <ConversationExportDialog client={client} onClose={onClose} target={target} />;
  if (target.kind === "import") return <PackageImportDialog client={client} onClose={onClose} onImported={onImported} onContinued={onContinued} target={target} />;
  return <PackageExportDialog client={client} onClose={onClose} onExportQueued={onExportQueued} target={target} />;
}
