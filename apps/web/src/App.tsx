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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";

import type {
  ArtifactDerivation,
  ArtifactJob,
  ArtifactPlan,
  ArtifactAnnotation,
  ArtifactReviewRun,
  ChatMessage,
  Claim,
  ComposerReference,
  ConnectorId,
  ConnectorManifest,
  CreateProxyServerRequest,
  DeletionImpact,
  Environment,
  EnvironmentRevision,
  ExecutionRun,
  EvidenceLink,
  McpProxyPolicies,
  McpInvocation,
  McpSourceManifest,
  ModelProfile,
  ModelUsageBucket,
  MemoryGraphNodeLabel,
  PaperAcquisition,
  PaperVisionRun,
  PermissionEpoch,
  PermissionGrant,
  PermissionDecision,
  PermissionRequest,
  PromptManifest,
  Project,
  ProxyPolicy,
  ProxyServer,
  ProxySettingsDetails,
  RemoteJob,
  ReviewerSpecialistSettings,
  RuntimeSettingsDetails,
  RuntimeSettingsOverrides,
  RunStreamEvent,
  SessionRun,
  ToolTrace,
  Session,
  SessionDetail,
  SessionListState,
  SessionPlan,
  SessionRunEvent,
  SessionUsageSummary,
  ScientificArtifact,
  ScientificArtifactKind,
  GlobalModelUsageSummary,
  Subagent,
  SkillDescriptor,
  Specialist,
  SystemQuotaSettings,
  SystemTimeoutSettings,
  UpdateSessionRequest,
  UpdateProxyServerRequest,
  UpdateWebSettingsRequest,
  MemoryGraphSettingsDetails,
  UpdateMemoryGraphSettingsRequest,
  WebSettingsDetails,
  WorkspaceCapabilities,
  WorkspaceFile,
  WorkbenchSearchResult,
} from "@science-agent/schema";
import { classifyScientificArtifact, createLocalSessionTitle, resolveScientificArtifactKind, UNTITLED_SESSION_TITLE } from "@science-agent/schema";

import { ApiClient, ApiRequestError, isAbortError } from "./api.js";
import { createSessionActivity } from "./run-stream/session-activity.js";
import { mergePermissionRequestSnapshot } from "./permission-state.js";
import {
  clampWorkspaceWidth,
  DEFAULT_WORKSPACE_WIDTH,
  fallbackSidebarWidth,
  MIN_WORKSPACE_WIDTH,
  workspaceMaxWidth,
} from "./workspaceWidth.js";
import {
  ArchiveIcon,
  BrandIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  CodeFileIcon,
  DownloadIcon,
  EditIcon,
  FileIcon,
  ImageIcon,
  MarkdownIcon,
  NotebookIcon,
  PanelRightIcon,
  ProjectIcon,
  ReportIcon,
  SearchIcon,
  SendIcon,
  SessionIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SparkleIcon,
  StopIcon,
  StructureIcon,
  TableIcon,
  TargetIcon,
  UploadIcon,
} from "./icons.js";
import { CopyButton } from "./CopyButton.js";
import { findMarkdownFigureArtifact, KIND_TO_LABEL, MarkdownRenderer } from "./Markdown.js";
import {
  DeletionDialog,
  inlineRenameInputColumns,
  InlineRenameInput,
  normalizedInlineRename,
  ProjectOverflowMenu,
  ProjectCreationDialog,
  selectAfterRemoval,
  SessionFilterMenu,
  SessionOverflowMenu,
  SidebarPanelResizer,
  SidebarSectionHeader,
} from "./session/ManagementControls.js";
import {
  reduceRunTimeline,
  RunTimeline,
  setTimelineEntryExpanded,
  type RunTimelineEntry,
} from "./timeline/RunTimeline.js";
import { globalSettingsDraft, ScopedSettingsEditor } from "./ScopedSettingsEditor.js";
import { duplicateModelProfileId, modelOptionLabel } from "./modelLabels.js";
import { SkillManager } from "./SkillManager.js";
import { EnvironmentManager } from "./EnvironmentManager.js";
import { OrchestrationPanel, SpecialistManager, SubagentCards } from "./Orchestration.js";
import { QuotaSettingsEditor, RuntimeStatusPanel, TimeoutSettingsEditor } from "./RuntimeControls.js";
import { RemoteHostManager, RemoteJobsPanel } from "./RemoteCompute.js";
import { RunUsageInline, UsagePage } from "./UsagePage.js";
import { formatCompactTokenValue, usageInOutLabel } from "./usageFormat.js";
import { ArtifactModal } from "./ScientificArtifacts.js";
import {
  artifactArchiveBlob,
  artifactArchiveLimitError,
  createArtifactArchive,
  downloadBlob,
  normalizeArtifactArchivePath,
} from "./artifact-download.js";
import {
  buildArtifactTree,
  buildWorkspaceFileTree,
  pathTreeCount,
  pathTreeLeaves,
  type ArtifactTreeEntry,
  type PathTreeDirectory,
  type PathTreeEntry,
  type PathTreeLeaf,
  type WorkspaceFileTreeEntry,
} from "./artifactTree.js";
import { createWebSettingsDraft, WebSettingsEditor, webSettingsRequest, type WebSettingsDraft } from "./WebSettingsEditor.js";
import { ProxyPolicySelect, ProxySettingsEditor } from "./ProxySettingsEditor.js";
import { createMemoryGraphSettingsDraft, MemoryGraphSettingsEditor, memoryGraphSettingsRequest, type MemoryGraphSettingsDraft } from "./MemoryGraphSettingsEditor.js";
import { EvidenceModal } from "./EvidenceModal.js";
import { GovernedDownloadCards } from "./GovernedDownloadCards.js";
import { MemoryGraphView } from "./MemoryGraphView.js";
import { ReviewerControlCard } from "./ReviewerControlCard.js";
import { ConnectorPicker } from "./composer/ConnectorPicker.js";
import { ReviewerPanel } from "./ReviewerPanel.js";
import { ToastViewport, useToasts } from "./Toasts.js";
import { createAuthTokenPromptGate } from "./auth-token-prompt.js";
import { InlineErrorAlert, updateInlineErrors } from "./InlineErrorAlert.js";
import { createSettingsErrorRouter } from "./settings-error-routing.js";
import { isPrimaryViewChange, parseViewState, serializeViewState, type ViewState } from "./view-url.js";
import { PermissionCards, PermissionGrantManager } from "./Permissions.js";
import { useLocale, type MessageKey } from "./i18n/index.js";
import {
  ComposerReferenceChips,
  ComposerReferenceMenu,
  composerReferenceToken,
  composerSkillSuggestions,
  getComposerTrigger,
  GlobalSearchDialog,
  insertComposerReference,
  type ComposerSuggestion,
} from "./composer/WorkbenchNavigation.js";

import {
  buildCreateSessionRequest,
  ComposerNoModelNotice,
  ComposerRunButton,
  resolveComposerRunAction,
  type ComposerRunAction,
} from "./composer/model.js";
import {
  isActiveRunStatus,
  isSessionRunning,
  isTerminalRunStatus,
  queuedCancelToast,
  requestRunStop,
  routeRunStreamEvent,
  runsRequiringEventReplay,
  shouldApplySessionScopedUpdate,
} from "./run-stream/model.js";
import {
  buildConversationBlocks,
  followSessionTitleRefinement,
  forgetSession,
  getVisibleProjects,
  messageForSessionTitle,
  sortSessionRuns,
} from "./session/model.js";
import {
  activityCardId,
  collectRunChangedPaths,
  groupRunActivity,
  setActivityCardExpanded,
  type ActivityCardExpansion,
  type GovernedDownloadCandidate,
  type RunActivityGroup,
} from "./session/run-activity.js";
import {
  clearSessionTimeline,
  collectTimelinePermissionRequestIds,
  EMPTY_TIMELINE,
  hydrateSessionRunTimeline,
  hydrateTerminalRunTimelines,
  reconcilePermissionTimeline,
  reconcileSessionTimelinePermissions,
  recordSessionTimelineEvent,
  selectSessionReplayRun,
  type SessionRunTimeline,
  type SessionRunTimelines,
} from "./timeline/model.js";

export function artifactTreeIconKind(
  artifact: Pick<ScientificArtifact, "kind" | "name">,
): ScientificArtifactKind {
  if (artifact.kind === "other") return classifyScientificArtifact(artifact.name) ?? "other";
  return resolveScientificArtifactKind(artifact.kind, artifact.name);
}

export function workspaceFileTreeIconKind(
  file: Pick<WorkspaceFile, "previewKind">,
): ScientificArtifactKind {
  return file.previewKind ?? "other";
}

function TreeFileIcon({ kind }: { kind: ScientificArtifactKind }): ReactNode {
  const props = { className: `artifact-tree-node-icon artifact-tree-node-icon-${kind}`, size: 14 };

  switch (kind) {
    case "dataset": return <TableIcon {...props} />;
    case "figure": return <ImageIcon {...props} />;
    case "markdown": return <MarkdownIcon {...props} />;
    case "report": return <ReportIcon {...props} />;
    case "notebook": return <NotebookIcon {...props} />;
    case "structure": return <StructureIcon {...props} />;
    case "html":
    case "json":
    case "latex": return <CodeFileIcon {...props} />;
    default: return <FileIcon {...props} />;
  }
}

function CompactPathTreeList<TLeaf extends PathTreeLeaf>({
  renderDirectoryControl,
  entries,
  renderLeaf,
}: {
  renderDirectoryControl?: (entry: PathTreeDirectory<TLeaf>) => ReactNode;
  entries: readonly PathTreeEntry<TLeaf>[];
  renderLeaf: (leaf: TLeaf) => ReactNode;
}): ReactNode {
  return <div className={renderDirectoryControl ? "artifact-tree selection-mode" : "artifact-tree"}>
    {entries.map((entry) => entry.kind === "directory" ? <details className="artifact-tree-directory" key={`directory:${entry.path}`} open>
      <summary aria-label={`Folder ${entry.path}`} className={renderDirectoryControl ? "selection-mode" : undefined}>
        <ChevronRightIcon className="artifact-tree-chevron" size={14} />
        {renderDirectoryControl?.(entry)}
        <ProjectIcon className="artifact-tree-node-icon artifact-tree-folder-icon" size={14} />
        <span className="artifact-tree-label">{entry.name}</span>
        <span className="artifact-tree-meta">{pathTreeCount(entry.children)}</span>
      </summary>
      <CompactPathTreeList entries={entry.children} renderDirectoryControl={renderDirectoryControl} renderLeaf={renderLeaf} />
    </details> : <Fragment key={`leaf:${entry.path}`}>{renderLeaf(entry)}</Fragment>)}
  </div>;
}

export function ArtifactTreeList({
  entries,
  onOpen,
  onSelectionChange,
  selectedArtifactIds,
}: {
  entries: readonly ArtifactTreeEntry[];
  onOpen: (artifact: ScientificArtifact) => void;
  onSelectionChange?: (artifacts: readonly ScientificArtifact[], selected: boolean) => void;
  selectedArtifactIds?: ReadonlySet<string>;
}): ReactNode {
  const selection = selectedArtifactIds && onSelectionChange
    ? { change: onSelectionChange, ids: selectedArtifactIds }
    : undefined;
  return <CompactPathTreeList
    entries={entries}
    renderDirectoryControl={selection ? (entry) => {
      const artifacts = pathTreeLeaves(entry.children).map((leaf) => leaf.artifact);
      const selectedCount = artifacts.filter((artifact) => selection.ids.has(artifact.id)).length;
      const allSelected = selectedCount === artifacts.length;
      const checked = allSelected ? true : selectedCount ? "mixed" as const : false;
      return <button
        aria-checked={checked}
        aria-label={`${allSelected ? "Deselect" : "Select"} folder ${entry.path}`}
        className="artifact-tree-selection-control"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          selection.change(artifacts, !allSelected);
        }}
        role="checkbox"
        type="button"
      ><span aria-hidden="true">{allSelected ? "✓" : selectedCount ? "−" : ""}</span></button>;
    } : undefined}
    renderLeaf={(entry) => selection ? <button
      aria-checked={selection.ids.has(entry.artifact.id)}
      aria-label={`${selection.ids.has(entry.artifact.id) ? "Deselect" : "Select"} ${entry.artifact.name}`}
      className={selection.ids.has(entry.artifact.id) ? "artifact-tree-file selection-mode selected" : "artifact-tree-file selection-mode"}
      onClick={() => selection.change([entry.artifact], !selection.ids.has(entry.artifact.id))}
      role="checkbox"
      title={entry.artifact.name}
      type="button"
    >
      <span aria-hidden="true" className="artifact-tree-selection-control"><span>{selection.ids.has(entry.artifact.id) ? "✓" : ""}</span></span>
      <TreeFileIcon kind={artifactTreeIconKind(entry.artifact)} />
      <span className="artifact-tree-label">{entry.name}</span>
    </button> : <button
      aria-label={`Open ${entry.artifact.name}`}
      className="artifact-tree-file"
      onClick={() => onOpen(entry.artifact)}
      title={entry.artifact.name}
      type="button"
    >
        <span className="artifact-tree-spacer" aria-hidden="true" />
        <TreeFileIcon kind={artifactTreeIconKind(entry.artifact)} />
        <span className="artifact-tree-label">{entry.name}</span>
      </button>}
  />;
}

export function WorkspaceFileTreeList({
  entries,
  onOpen,
  onSelectionChange,
  selectedPaths,
}: {
  entries: readonly WorkspaceFileTreeEntry[];
  onOpen: (file: WorkspaceFile) => void;
  onSelectionChange?: (files: readonly WorkspaceFile[], selected: boolean) => void;
  selectedPaths?: ReadonlySet<string>;
}): ReactNode {
  const selection = selectedPaths && onSelectionChange
    ? { change: onSelectionChange, paths: selectedPaths }
    : undefined;
  return <CompactPathTreeList
    entries={entries}
    renderDirectoryControl={selection ? (entry) => {
      const files = pathTreeLeaves(entry.children).map((leaf) => leaf.file);
      const selectedCount = files.filter((file) => selection.paths.has(file.path)).length;
      const allSelected = selectedCount === files.length;
      const checked = allSelected ? true : selectedCount ? "mixed" as const : false;
      return <button
        aria-checked={checked}
        aria-label={`${allSelected ? "Deselect" : "Select"} folder ${entry.path}`}
        className="artifact-tree-selection-control"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          selection.change(files, !allSelected);
        }}
        role="checkbox"
        type="button"
      ><span aria-hidden="true">{allSelected ? "✓" : selectedCount ? "−" : ""}</span></button>;
    } : undefined}
    renderLeaf={(entry) => selection ? <button
      aria-checked={selection.paths.has(entry.file.path)}
      aria-label={`${selection.paths.has(entry.file.path) ? "Deselect" : "Select"} ${entry.file.path}`}
      className={selection.paths.has(entry.file.path)
        ? "artifact-tree-file workspace-file-tree-leaf selection-mode selected"
        : "artifact-tree-file workspace-file-tree-leaf selection-mode"}
      onClick={() => selection.change([entry.file], !selection.paths.has(entry.file.path))}
      role="checkbox"
      title={entry.file.path}
      type="button"
    >
      <span aria-hidden="true" className="artifact-tree-selection-control"><span>{selection.paths.has(entry.file.path) ? "✓" : ""}</span></span>
      <TreeFileIcon kind={workspaceFileTreeIconKind(entry.file)} />
      <span className="artifact-tree-label">{entry.name}</span>
    </button> : <button
      aria-label={`Open ${entry.file.path}`}
      className="artifact-tree-file workspace-file-tree-leaf"
      onClick={() => onOpen(entry.file)}
      title={entry.file.path}
      type="button"
    >
      <span className="artifact-tree-spacer" aria-hidden="true" />
      <TreeFileIcon kind={workspaceFileTreeIconKind(entry.file)} />
      <span className="artifact-tree-label">{entry.name}</span>
    </button>}
  />;
}

export interface ModelDraft {
  baseUrl: string;
  model: string;
  name: string;
  proxyPolicy: ProxyPolicy;
  vision: boolean;
}

function preserveEqualSnapshot<T>(current: T, next: T): T {
  return JSON.stringify(current) === JSON.stringify(next) ? current : next;
}

interface ResourceTarget {
  id: string;
  kind: "project" | "session";
  label: string;
}

interface InlineRenameTarget extends ResourceTarget {
  location: "sidebar" | "main";
  revision: number;
}

export interface VersionedSessionSummary {
  revision: number;
  summary: Session;
}

export function permissionRequestFromConflict(reason: unknown): PermissionRequest | undefined {
  if (!(reason instanceof ApiRequestError) || reason.code !== "PERMISSION_ALREADY_RESOLVED") return undefined;
  const request = reason.details?.request;
  if (!request || typeof request !== "object") return undefined;
  const candidate = request as Partial<PermissionRequest>;
  if (typeof candidate.id !== "string"
    || typeof candidate.resource !== "string"
    || typeof candidate.summary !== "string"
    || !new Set(["allowed", "cancelled", "denied", "pending"]).has(candidate.state ?? "")) return undefined;
  return request as PermissionRequest;
}

export function resourceLabelWithDraft(
  target: { id: string; kind: "project" | "session" } | undefined,
  draft: string,
  kind: "project" | "session",
  id: string,
  fallback: string,
): string {
  return target?.kind === kind && target.id === id ? draft : fallback;
}

function resourceTargetKey(target: Pick<ResourceTarget, "id" | "kind">): string {
  return `${target.kind}:${target.id}`;
}

export function sessionSummaryFrom(value: Session | SessionDetail): Session {
  const { messages: _messages, ...summary } = value as SessionDetail;
  return summary;
}

export function mergeSessionDetailWithSummary(detail: SessionDetail, summary: Session): SessionDetail {
  return { ...summary, messages: detail.messages };
}

export function mergeRefreshedSessionDetail(
  detail: SessionDetail,
  refreshRevision: number,
  latest: VersionedSessionSummary | undefined,
): SessionDetail {
  if (!latest
    || latest.revision <= refreshRevision
    || latest.summary.id !== detail.id
    || latest.summary.updatedAt < detail.updatedAt) return detail;
  return mergeSessionDetailWithSummary(detail, latest.summary);
}

export type SystemSettingsGroup =
  | "connection"
  | "environments"
  | "global"
  | "language"
  | "memory-graph"
  | "models"
  | "permissions"
  | "proxies"
  | "quotas"
  | "remote"
  | "runtime"
  | "skills"
  | "specialists"
  | "timeouts"
  | "web";

const SYSTEM_SETTINGS_GROUPS: Array<{
  id: SystemSettingsGroup;
}> = [
  { id: "global" },
  { id: "language" },
  { id: "timeouts" },
  { id: "quotas" },
  { id: "runtime" },
  { id: "models" },
  { id: "proxies" },
  { id: "web" },
  { id: "memory-graph" },
  { id: "environments" },
  { id: "skills" },
  { id: "specialists" },
  { id: "permissions" },
  { id: "remote" },
  { id: "connection" },
];

function isSystemSettingsGroup(value: string | undefined): value is SystemSettingsGroup {
  return SYSTEM_SETTINGS_GROUPS.some((group) => group.id === value);
}

function proxyMcpServers(sources: McpSourceManifest[]): Array<{ id: string; label: string }> {
  const labels = new Map<string, string[]>();
  for (const source of sources) {
    const id = source.transport.mcpServerId;
    const current = labels.get(id) ?? [];
    current.push(source.displayName);
    labels.set(id, current);
  }
  return [...labels.entries()]
    .map(([id, names]) => ({ id, label: `${id} · ${names.toSorted().join(", ")}` }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

/** Look up a scoped-settings target in the loaded lists, for URL hydration. */
function findResourceTarget(
  kind: "project" | "session",
  id: string,
  projects: Project[],
  sessions: Session[],
): ResourceTarget | undefined {
  if (kind === "project") {
    const project = projects.find((item) => item.id === id);
    return project ? { id: project.id, kind, label: project.name } : undefined;
  }
  const session = sessions.find((item) => item.id === id);
  return session ? { id: session.id, kind, label: session.title } : undefined;
}

export function SystemSettingsLayout({
  activeGroup,
  children,
  onSelect,
}: {
  activeGroup: SystemSettingsGroup;
  children: ReactNode;
  onSelect: (group: SystemSettingsGroup) => void;
}) {
  const { t } = useLocale();
  return <div className="system-config-layout">
    <nav aria-label={t("settings.groups")} className="settings-group-nav">
      {SYSTEM_SETTINGS_GROUPS.map((group) => <button
        aria-current={activeGroup === group.id ? "page" : undefined}
        className={activeGroup === group.id ? "active" : ""}
        key={group.id}
        onClick={() => onSelect(group.id)}
        type="button"
      >
        <strong>{t(`settings.groups.${group.id}.label` as MessageKey)}</strong>
        <small>{t(`settings.groups.${group.id}.description` as MessageKey)}</small>
      </button>)}
    </nav>
    <div className="settings-group-detail">{children}</div>
  </div>;
}

export function SystemSettingsFooter({
  busy,
  onCancel,
  onSave,
  onSaveAndClose,
}: {
  busy: boolean;
  onCancel: () => void;
  onSave: () => void;
  onSaveAndClose: () => void;
}) {
  const { t } = useLocale();
  return <div className="system-config-footer">
    <button className="secondary-button" disabled={busy} onClick={onCancel} type="button">{t("settings.cancelAndClose")}</button>
    <button className="secondary-button" disabled={busy} onClick={onSave} type="button">{busy ? t("common.saving") : t("common.save")}</button>
    <button className="primary-button" disabled={busy} onClick={onSaveAndClose} type="button">{busy ? t("common.saving") : t("settings.saveAndClose")}</button>
  </div>;
}

export const EMPTY_MODEL_DRAFT: ModelDraft = {
  baseUrl: "",
  model: "",
  name: "",
  proxyPolicy: "inherit",
  vision: false,
};

export function modelDraftFromProfile(profile: ModelProfile): ModelDraft {
  return {
    baseUrl: profile.baseUrl,
    model: profile.model,
    name: profile.name,
    proxyPolicy: profile.proxyPolicy,
    vision: profile.vision,
  };
}

export function ModelDraftFields({
  draft,
  onChange,
}: {
  draft: ModelDraft;
  onChange: (update: Partial<ModelDraft>) => void;
}) {
  const { t } = useLocale();
  return <>
    <label><span>{t("settings.displayName")}</span><input required value={draft.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="Fast analysis" /></label>
    <label><span>{t("settings.baseUrl")}</span><input required value={draft.baseUrl} onChange={(event) => onChange({ baseUrl: event.target.value })} placeholder={t("settings.baseUrlHint")} /></label>
    <label><span>{t("settings.modelId")}</span><input required value={draft.model} onChange={(event) => onChange({ model: event.target.value })} /></label>
  </>;
}














/** How long the server gets to close a cancelled stream before the client drops it. */

function measureWorkspaceMaxWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WORKSPACE_WIDTH;
  const sidebarWidth = typeof document === "undefined"
    ? fallbackSidebarWidth(window.innerWidth)
    : document.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect().width
      ?? fallbackSidebarWidth(window.innerWidth);
  return workspaceMaxWidth(window.innerWidth, sidebarWidth);
}



function formatByteLimit(bytes: number): string {
  if (bytes === 0) return "unlimited";
  if (bytes >= 1_073_741_824 && bytes % 1_073_741_824 === 0) return `${bytes / 1_073_741_824} GiB`;
  if (bytes >= 1_048_576 && bytes % 1_048_576 === 0) return `${bytes / 1_048_576} MiB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function previewMarkdownFile(files: WorkspaceFile[]): WorkspaceFile | undefined {
  return files.find((file) => file.path.endsWith("_evidence_brief.md"))
    ?? files.find((file) => file.path.endsWith("_report.md"))
    ?? files.find((file) => (
      file.previewKind === "markdown" || file.path.endsWith(".md") || file.path.endsWith(".markdown")
    ) && !file.path.includes("/"));
}

function SessionUsageChip({
  breakdown,
  sessionTokens,
}: {
  breakdown: string;
  sessionTokens: number | null | undefined;
}) {
  const hasReportedTokens = sessionTokens !== null && sessionTokens !== undefined;
  return (
    <div
      className={hasReportedTokens ? "session-usage-chip" : "session-usage-chip muted"}
      aria-label="Model usage"
      title={hasReportedTokens
        ? `${formatCompactTokenValue(sessionTokens)} session tokens${breakdown ? `; ${breakdown}` : ""}`
        : "No reported usage yet"}
    >
      <span>Usage</span>
      <strong>{formatCompactTokenValue(sessionTokens)}</strong>
      {breakdown ? <small className="session-usage-chip-breakdown">{breakdown}</small> : null}
    </div>
  );
}

export function QueuedRunsPanel({
  cancellingRunIds = new Set<string>(),
  onCancel,
  runs,
}: {
  cancellingRunIds?: ReadonlySet<string>;
  onCancel?: (run: SessionRun) => void;
  runs: SessionRun[];
}) {
  if (!runs.length) return null;
  return (
    <section aria-label="Queued runs" className="queued-runs-panel">
      <div><strong>Queued</strong><span>{runs.length}</span></div>
      <ul>
        {runs.map((run) => {
          const cancelling = cancellingRunIds.has(run.id);
          return (
            <li key={run.id}>
              <p title={run.prompt}>{run.prompt}</p>
              {onCancel ? <button
                aria-label="Cancel queued run"
                disabled={cancelling}
                onClick={() => onCancel(run)}
                title="Cancel queued run"
                type="button"
              >
                <CloseIcon size={14} />
              </button> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Files the result preview knows how to render; also the set bucketed per run. */
export function isArtifactPreviewFile(file: WorkspaceFile): boolean {
  return file.path === "analysis_chart.svg"
    || file.path === "analysis_summary.csv"
    || file.previewKind === "markdown"
    || file.path.endsWith(".md")
    || file.path.endsWith(".markdown");
}

/** The document a preview card renders: report-like names first, then any markdown. */
function previewDocumentFile(files: WorkspaceFile[]): WorkspaceFile | undefined {
  return previewMarkdownFile(files)
    ?? files.find((file) => file.path.endsWith(".md") || file.path.endsWith(".markdown"));
}

function ArtifactPreview({
  client,
  expanded,
  files,
  onChipClick,
  onToggle,
  sessionId,
}: {
  client: ApiClient;
  expanded: boolean;
  files: WorkspaceFile[];
  onChipClick?: (reference: ComposerReference) => void;
  onToggle: (expanded: boolean) => void;
  sessionId: string;
}) {
  const [chartUrl, setChartUrl] = useState<string>();
  const [table, setTable] = useState<string[][]>([]);
  const [document, setDocument] = useState<string>();
  const [loadFailed, setLoadFailed] = useState(false);
  // Chip references resolved from the report artifact's latest version, so
  // [alias] tokens in the preview render as clickable chips.
  const [references, setReferences] = useState<ComposerReference[] | undefined>();

  const chart = files.find((file) => file.path === "analysis_chart.svg");
  const summary = files.find((file) => file.path === "analysis_summary.csv");
  const markdownFile = previewDocumentFile(files);

  // Contents load lazily once the card is expanded; collapsed cards only list
  // the files they would preview, so a folded history costs no file reads.
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    let objectUrl: string | undefined;
    setLoadFailed(false);

    void (async () => {
      if (chart) {
        objectUrl = URL.createObjectURL(await client.readFile(sessionId, chart.path));
        if (active) setChartUrl(objectUrl);
      } else setChartUrl(undefined);
      if (summary) {
        const text = await (await client.readFile(sessionId, summary.path)).text();
        if (active) setTable(text.trim().split("\n").map((line) => line.split(",")));
      } else setTable([]);
      if (markdownFile) {
        const text = await (await client.readFile(sessionId, markdownFile.path)).text();
        if (active) setDocument(text);
        // readFile gives the blob only; resolve the report's version references
        // so chips render. Best-effort — a lookup miss leaves plain text.
        try {
          const artifacts = await client.listArtifacts(sessionId);
          // See reportReferences effect: declaredPath is the stable file path;
          // logicalName may be an LLM-chosen display name that won't match.
          const artifact = artifacts.find((item) => item.originMeta?.declaredPath === markdownFile.path
            || item.logicalName === markdownFile.path);
          if (artifact) {
            const versions = await client.listArtifactVersions(sessionId, artifact.id);
            const latest = [...versions].sort((left, right) => right.version - left.version)[0];
            if (active && latest?.references?.length) setReferences(latest.references);
          }
        } catch {
          /* lookup is advisory; the document still renders without chips */
        }
      } else {
        if (active) setDocument(undefined);
        setReferences(undefined);
      }
    })().catch(() => {
      if (active) setLoadFailed(true);
    });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [chart, client, expanded, markdownFile, sessionId, summary]);

  if (!chart && !summary && !markdownFile) return null;
  const previewedNames = [
    chart?.path,
    summary?.path,
    ...files.filter((file) => file.path.endsWith(".md") || file.path.endsWith(".markdown")).map((file) => file.path),
  ].filter(Boolean).join(" · ");
  return (
    <details
      aria-label="Analysis results"
      className="result-preview"
      open={expanded}
      onToggle={(event) => {
        if (event.currentTarget.open !== expanded) onToggle(event.currentTarget.open);
      }}
    >
      <summary>
        <span className="card-chevron"><ChevronRightIcon size={15} /></span>
        <span className="result-preview-heading">
          <span><span className="eyebrow">Generated result</span><strong>{markdownFile ? "Research report" : "Workspace analysis"}</strong></span>
          <small>{previewedNames}</small>
          <small className="result-preview-attribution">Grouped with the latest run by file modified time</small>
        </span>
        <span className="status-dot">Ready</span>
      </summary>
      {expanded ? <div className="result-preview-body">
        {loadFailed ? <p className="muted">Some preview files could not be read. The workspace file list may still open them directly.</p> : null}
        {chartUrl ? <img src={chartUrl} alt="Bar chart of numeric column means" /> : null}
        {table.length ? (
          <div className="table-scroll">
            <table>
              <thead><tr>{table[0]?.map((cell) => <th key={cell}>{cell}</th>)}</tr></thead>
              <tbody>
                {table.slice(1).map((row, rowIndex) => (
                  <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {document ? <MarkdownRenderer className="paper-preview" content={document} onChipClick={onChipClick} references={references} /> : null}
      </div> : null}
    </details>
  );
}

function SkeletonRows({ className, count }: { className: string; count: number }) {
  return <div aria-hidden="true" className={className}>{Array.from({ length: count }, (_, index) => <span className="skeleton" key={index} />)}</div>;
}

export async function runSessionCreationOnce<T>({
  create,
  fallbackError,
  isInFlight,
  onCreated,
  onError,
  setInFlight,
  setPending,
}: {
  create: () => Promise<T>;
  fallbackError: string;
  isInFlight: () => boolean;
  onCreated: (created: T) => Promise<void> | void;
  onError: (message: string) => void;
  setInFlight: (value: boolean) => void;
  setPending: (value: boolean) => void;
}): Promise<boolean> {
  if (isInFlight()) return false;
  setInFlight(true);
  setPending(true);
  try {
    await onCreated(await create());
  } catch (reason) {
    onError(reason instanceof Error ? reason.message : fallbackError);
  } finally {
    setInFlight(false);
    setPending(false);
  }
  return true;
}

export function App() {
  const { locale, setLocale, t } = useLocale();
  // No built-in fallback token: the server generates one on its first start and
  // prints it, so a browser that has never been given a token starts empty, is
  // rejected with 401, and is handed the Connection settings dialog.
  const [token, setToken] = useState(() => localStorage.getItem("science-agent-token") ?? "");
  const [models, setModels] = useState<ModelProfile[]>([]);
  const [connectors, setConnectors] = useState<ConnectorManifest[]>([]);
  const [skills, setSkills] = useState<SkillDescriptor[]>([]);
  const [editingModelId, setEditingModelId] = useState<string>();
  const [modelDraft, setModelDraft] = useState<ModelDraft>(EMPTY_MODEL_DRAFT);
  const [draftToken, setDraftToken] = useState("");
  const [removeStoredToken, setRemoveStoredToken] = useState(false);
  const [modelSettingsDirty, setModelSettingsDirty] = useState(false);
  const [papers, setPapers] = useState<PaperAcquisition[]>([]);
  const [paperVisionRuns, setPaperVisionRuns] = useState<PaperVisionRun[]>([]);
  const [visionModelId, setVisionModelId] = useState<string>();
  const [paperBusy, setPaperBusy] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  // The URL is parsed once at mount: it seeds the initial view and queues the
  // Project/Session selection until the lists arrive (see the load effects).
  const [initialView] = useState(() => parseViewState(window.location.pathname, window.location.search));
  const [sessionListState, setSessionListState] = useState<SessionListState>(() => initialView.sessionFilter ?? "active");
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [session, setSession] = useState<SessionDetail>();
  const [artifacts, setArtifacts] = useState<ScientificArtifact[]>([]);
  const [artifactSessions, setArtifactSessions] = useState<Session[]>([]);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [workspaceCapabilities, setWorkspaceCapabilities] = useState<WorkspaceCapabilities>();
  const [permissionEpoch, setPermissionEpoch] = useState<PermissionEpoch>();
  const [permissionGrants, setPermissionGrants] = useState<PermissionGrant[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<PermissionRequest[]>([]);
  const [executionRuns, setExecutionRuns] = useState<ExecutionRun[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentRevisions, setEnvironmentRevisions] = useState<EnvironmentRevision[]>([]);
  const [derivations, setDerivations] = useState<ArtifactDerivation[]>([]);
  const [promptManifests, setPromptManifests] = useState<PromptManifest[]>([]);
  const [artifactReviews, setArtifactReviews] = useState<ArtifactReviewRun[]>([]);
  const [downloadCandidates, setDownloadCandidates] = useState<GovernedDownloadCandidate[]>([]);
  const [downloadJobs, setDownloadJobs] = useState<ArtifactJob[]>([]);
  const [downloadPlans, setDownloadPlans] = useState<ArtifactPlan[]>([]);
  const [reviewerSpecialistSettings, setReviewerSpecialistSettings] = useState<ReviewerSpecialistSettings>();
  /** Manual Reviewer activity is isolated per Session, matching the API queue. */
  const [manualReviewerBusyBySession, setManualReviewerBusyBySession] = useState<Record<string, true>>({});
  const [plans, setPlans] = useState<SessionPlan[]>([]);
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  const [remoteJobs, setRemoteJobs] = useState<RemoteJob[]>([]);
  const [specialists, setSpecialists] = useState<Specialist[]>([]);
  const [mcpInvocations, setMcpInvocations] = useState<McpInvocation[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [evidenceLinks, setEvidenceLinks] = useState<EvidenceLink[]>([]);
  const [sessionUsage, setSessionUsage] = useState<SessionUsageSummary>();
  const [globalUsage, setGlobalUsage] = useState<GlobalModelUsageSummary>();
  const [workspaceView, setWorkspaceView] = useState<"session" | "usage">(() => initialView.view === "usage" ? "usage" : "session");
  // A graph node a report chip asked to open; MemoryGraphView selects it on
  // change, then clears the pending state. Set by handleChipClick (paper chips).
  const [pendingMemoryNode, setPendingMemoryNode] = useState<{ label: MemoryGraphNodeLabel; id: string } | undefined>();
  // An Evidence chip asked to open its detail modal (shows the evidence + its
  // source Paper). Set by handleChipClick (evidence chips).
  const [evidenceDetailId, setEvidenceDetailId] = useState<string | undefined>();
  // Chip references resolved from the session's latest report artifact
  // version, so [evidence1]/[artifact1] tokens in RunTimeline report messages render as
  // clickable chips. Refreshed when files change (a report lands).
  const [reportReferences, setReportReferences] = useState<ComposerReference[] | undefined>();
  const [cancellingQueuedRunIds, setCancellingQueuedRunIds] = useState<ReadonlySet<string>>(() => new Set());
  // Timelines are buffered per Session so a run that keeps streaming while the
  // user is elsewhere still has its steps to show when they switch back.
  const [runTimelines, setRunTimelines] = useState<SessionRunTimelines>({});
  // Activity card expansion lives here, not inside the cards: a card group
  // moves between a conversation block and the tail of the flow as runs start
  // and finish, and component-local state would reset on every such move.
  const [activityCardExpansion, setActivityCardExpansion] = useState<ActivityCardExpansion>({});
  // Workspace paths each run reported as changed (from persisted
  // `workspace.changed` events plus the live stream), used to attribute
  // result-preview files to every run that touched them.
  const [runChangedPaths, setRunChangedPaths] = useState<Readonly<Record<string, Record<string, string[]>>>>({});
  const [replayTimelines, setReplayTimelines] = useState<Readonly<Record<string, Record<string, SessionRunTimeline>>>>({});
  const [timelineMessageIds, setTimelineMessageIds] = useState<Readonly<Record<string, string>>>({});
  const [sessionRuns, setSessionRuns] = useState<SessionRun[]>([]);
  const [message, setMessage] = useState("");
  const [composerReferences, setComposerReferences] = useState<ComposerReference[]>([]);
  const [pendingAnnotations, setPendingAnnotations] = useState<ArtifactAnnotation[]>([]);
  const [workbenchIndex, setWorkbenchIndex] = useState<WorkbenchSearchResult[]>([]);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [showConfig, setShowConfig] = useState(() => initialView.settingsKind === "system");
  const [systemSettingsGroup, setSystemSettingsGroup] = useState<SystemSettingsGroup>(() => isSystemSettingsGroup(initialView.settingsGroup) ? initialView.settingsGroup : "global");
  const [globalSettings, setGlobalSettings] = useState<RuntimeSettingsDetails>();
  const [timeoutSettings, setTimeoutSettings] = useState<SystemTimeoutSettings>();
  const [quotaSettings, setQuotaSettings] = useState<SystemQuotaSettings>();
  const [proxySettings, setProxySettings] = useState<ProxySettingsDetails>();
  const [mcpProxyPolicies, setMcpProxyPolicies] = useState<McpProxyPolicies>({});
  const [mcpSources, setMcpSources] = useState<McpSourceManifest[]>([]);
  const [webSettings, setWebSettings] = useState<WebSettingsDetails>();
  const [memoryGraphSettings, setMemoryGraphSettings] = useState<MemoryGraphSettingsDetails>();
  // Configuration editors write only to these dialog-scoped drafts. They are
  // deliberately owned here so changing the left-hand section cannot unmount
  // and lose a draft, or accidentally persist it.
  const [globalSettingsEdit, setGlobalSettingsEdit] = useState<RuntimeSettingsOverrides>();
  const [timeoutSettingsEdit, setTimeoutSettingsEdit] = useState<SystemTimeoutSettings>();
  const [quotaSettingsEdit, setQuotaSettingsEdit] = useState<SystemQuotaSettings>();
  const [webSettingsEdit, setWebSettingsEdit] = useState<WebSettingsDraft>();
  const [memoryGraphSettingsEdit, setMemoryGraphSettingsEdit] = useState<MemoryGraphSettingsDraft>();
  const [localeEdit, setLocaleEdit] = useState<"en" | "zh-CN">();
  const [tokenEdit, setTokenEdit] = useState<string>();
  // Set when the server rejected the current token, so the Connection panel can
  // say why it opened instead of looking like an ordinary settings visit.
  const [tokenRejected, setTokenRejected] = useState(false);
  const [systemSettingsSaving, setSystemSettingsSaving] = useState(false);
  const [projectSettings, setProjectSettings] = useState<RuntimeSettingsDetails>();
  const [settingsTarget, setSettingsTarget] = useState<ResourceTarget>();
  const [scopedSettings, setScopedSettings] = useState<RuntimeSettingsDetails>();
  const [renameTarget, setRenameTarget] = useState<InlineRenameTarget>();
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSavingKeys, setRenameSavingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [deletionTarget, setDeletionTarget] = useState<ResourceTarget>();
  const [deletionImpact, setDeletionImpact] = useState<DeletionImpact>();
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string>();
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string>();
  const [sessionFilterOpen, setSessionFilterOpen] = useState(false);
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [sessionsExpanded, setSessionsExpanded] = useState(true);
  const [sidebarSplit, setSidebarSplit] = useState(36);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [projectCreationOpen, setProjectCreationOpen] = useState(false);
  const [sessionCreationPending, setSessionCreationPending] = useState(false);
  const [markdownDocument, setMarkdownDocument] = useState<{ content: string; path: string }>();
  const [artifactModalName, setArtifactModalName] = useState<string | undefined>(() => initialView.artifact);
  // The version a chip pinned (the one its claim cited) so the ArtifactModal
  // opens that version instead of the drifted-latest. Cleared on navigation.
  const [artifactModalVersion, setArtifactModalVersion] = useState<number>();
  // Run state is per Session: the server already isolates runs by Session, and a
  // single global flag left every Session unusable whenever one stream hung.
  const [runningSessionIds, setRunningSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [stoppingSessionIds, setStoppingSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const runAbortControllers = useRef(new Map<string, AbortController>());
  const [error, setErrorState] = useState<string>();
  const [systemSettingsErrors, setSystemSettingsErrors] = useState<string[]>([]);
  const [scopedSettingsErrors, setScopedSettingsErrors] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [isFollowingOutput, setIsFollowingOutput] = useState(true);
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(() => initialView.workspaceOpen !== undefined
    ? !initialView.workspaceOpen
    : localStorage.getItem("science-agent-workspace-collapsed") === "1");
  const [showPhysicalFiles, setShowPhysicalFiles] = useState(() =>
    localStorage.getItem("science-agent-show-physical-files") === "1");
  const [artifactSelectionMode, setArtifactSelectionMode] = useState(false);
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<ReadonlySet<string>>(() => new Set());
  const [artifactArchiveBusy, setArtifactArchiveBusy] = useState(false);
  const [workspaceFileSelectionMode, setWorkspaceFileSelectionMode] = useState(false);
  const [selectedWorkspaceFilePaths, setSelectedWorkspaceFilePaths] = useState<ReadonlySet<string>>(() => new Set());
  const [workspaceResizing, setWorkspaceResizing] = useState(false);
  const [workspaceMaxWidth, setWorkspaceMaxWidth] = useState(() => measureWorkspaceMaxWidth());
  const [workspaceWidth, setWorkspaceWidth] = useState(() => {
    const stored = Number(localStorage.getItem("science-agent-workspace-width"));
    const maxWidth = measureWorkspaceMaxWidth();
    return clampWorkspaceWidth(stored > 0 ? stored : DEFAULT_WORKSPACE_WIDTH, maxWidth);
  });
  const messagesViewport = useRef<HTMLDivElement>(null);
  const composerTextarea = useRef<HTMLTextAreaElement>(null);
  const focusComposerSessionId = useRef<string | undefined>(undefined);
  const workspacePanel = useRef<HTMLElement>(null);
  const sessionActivity = useRef(createSessionActivity());
  const sessionRunSnapshots = useRef(new Map<string, SessionRun[]>());
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const latestSessionSummaries = useRef(new Map<string, VersionedSessionSummary>());
  const renameRevision = useRef(0);
  const renameSavesInFlight = useRef(new Set<string>());
  const sessionCreationInFlight = useRef(false);
  const activeProjectIdRef = useRef<string | undefined>(undefined);
  // Project/Session requested by the URL but not yet validated against the
  // loaded lists; consumed by the list-load effects below.
  const pendingSelectionRef = useRef<{ projectId?: string; sessionId?: string } | null>(
    initialView.projectId || initialView.sessionId
      ? { projectId: initialView.projectId, sessionId: initialView.sessionId }
      : null,
  );
  // Scoped settings requested by the URL, resolved once the lists are in.
  const pendingSettingsRef = useRef<{ id?: string; kind: "project" | "session" } | null>(
    initialView.settingsKind === "project" || initialView.settingsKind === "session"
      ? { id: initialView.settingsTargetId, kind: initialView.settingsKind }
      : null,
  );
  // Set while a popstate-driven state application is in flight, so the URL
  // sync normalizes with replaceState instead of pushing a new entry.
  const applyingUrlRef = useRef(false);
  // The last App-side ViewState written or applied, for push/replace decisions.
  const lastViewRef = useRef<ViewState | null>(null);
  // Bumped by the popstate handler so the URL-sync effect re-runs (and
  // normalizes the address bar) even when back/forward changed no state.
  const [urlEpoch, setUrlEpoch] = useState(0);
  // Survives token changes and re-renders, so the "one dialog per rejected
  // token" rule holds across the whole session rather than per client instance.
  const authPromptGate = useRef(createAuthTokenPromptGate());
  const promptForToken = useCallback(() => {
    setTokenRejected(true);
    if (!authPromptGate.current.shouldPrompt(token)) return;
    setSystemSettingsGroup("connection");
    setShowConfig(true);
  }, [token]);
  const client = useMemo(() => new ApiClient(token, promptForToken), [promptForToken, token]);
  const loadMarkdownImage = useCallback(async (path: string, signal: AbortSignal): Promise<Blob> => {
    const sessionId = session?.id;
    if (!sessionId) throw new Error("No active Session is available for this image");
    try {
      return await client.readFile(sessionId, path, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      const artifact = findMarkdownFigureArtifact(artifacts, path, sessionId);
      if (!artifact) throw error;
      const versions = await client.listArtifactVersions(sessionId, artifact.id);
      if (signal.aborted) throw new DOMException("Image load aborted", "AbortError");
      const latest = [...versions].sort((left, right) => right.version - left.version)[0];
      if (!latest) throw error;
      return await client.readArtifactVersion(sessionId, latest.id, signal);
    }
  }, [artifacts, client, session?.id]);
  const openMarkdownImageArtifacts = useCallback(() => {
    setWorkspaceView("session");
    setWorkspaceCollapsed(false);
    window.requestAnimationFrame(() => workspacePanel.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);
  const { dismiss: dismissToast, push: pushToast, toasts } = useToasts();
  const reportSystemSettingsError = useCallback((message?: string) => {
    setSystemSettingsErrors((current) => updateInlineErrors(current, message));
  }, []);
  const reportScopedSettingsError = useCallback((message?: string) => {
    setScopedSettingsErrors((current) => updateInlineErrors(current, message));
  }, []);
  const settingsErrorRouter = useMemo(() => createSettingsErrorRouter({
    scoped: reportScopedSettingsError,
    system: reportSystemSettingsError,
  }), [reportScopedSettingsError, reportSystemSettingsError]);
  /** Everything the composer and Session-scoped controls read: is *this* Session busy. */
  const isRunning = Boolean(activeSessionId && runningSessionIds.has(activeSessionId));
  /** Persisted Reviewer checkpoints survive a browser refresh; do not rely only on local request state. */
  const reviewerCheckpointRunning = Boolean(session?.messages.some((message) =>
    message.kind === "reviewer_checkpoint" && message.reviewerCheckpoint?.status === "running"));
  /**
   * The timeline and folded-in message of the Session whose messages are on
   * screen, so the two always describe the same Session.
   */
  const runTimeline = (session?.id ? runTimelines[session.id]?.entries : undefined) ?? EMPTY_TIMELINE;
  const timelineMessageId = session?.id ? timelineMessageIds[session.id] : undefined;

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!session || focusComposerSessionId.current !== session.id) return;
    focusComposerSessionId.current = undefined;
    composerTextarea.current?.focus();
  }, [session?.id]);

  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);

  useEffect(() => {
    void client.getWorkspaceCapabilities()
      .then(setWorkspaceCapabilities)
      .catch(() => setWorkspaceCapabilities({
        maxFileBytes: 1_073_741_824,
        maxRequestBytes: 10_737_418_240,
        maxWorkspaceBytes: 10_737_418_240,
      }));
  }, [client]);

  // Opening System settings starts a dialog-owned refresh. Failures from this
  // operation stay in the dialog instead of being inferred from whichever
  // overlay happens to be open when an unrelated background request fails.
  useEffect(() => {
    if (!showConfig) return;
    let active = true;
    void Promise.all([
      client.listModels(),
      client.listConnectors(),
      client.listSkills(),
      client.getGlobalSettings(),
      client.getTimeoutSettings(),
      client.getQuotaSettings(),
      client.getWebSettings(),
      client.getMemoryGraphSettings(),
    ]).then(([modelItems, connectorItems, skillItems, settings, timeouts, quotas, web, memoryGraph]) => {
      if (!active) return;
      setModels(modelItems);
      setConnectors(connectorItems);
      setSkills(skillItems);
      setGlobalSettings(settings);
      setTimeoutSettings(timeouts);
      setQuotaSettings(quotas);
      setWebSettings(web);
      setMemoryGraphSettings(memoryGraph);
      setWorkspaceCapabilities({
        maxFileBytes: quotas.uploadMaxFileBytes,
        maxRequestBytes: quotas.uploadMaxRequestBytes,
        maxWorkspaceBytes: quotas.runnerMaxWorkspaceBytes,
      });
    }).catch((reason: Error) => {
      if (active) reportSystemSettingsError(reason.message);
    });
    return () => { active = false; };
  }, [client, reportSystemSettingsError, showConfig]);

  useEffect(() => {
    let active = true;
    void client.getReviewerSpecialistSettings()
      .then((settings) => { if (active) setReviewerSpecialistSettings(settings); })
      .catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [client, showConfig]);

  useEffect(() => {
    const controllers = runAbortControllers.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
    };
  }, []);

  function setSessionActivity(sessionId: string, active: boolean): void {
    sessionActivity.current.setRunActivity(sessionId, active);
    setRunningSessionIds(sessionActivity.current.runningSessionIds());
  }

  function syncSessionRunActivity(sessionId: string, runs: SessionRun[]): SessionRun[] {
    const sorted = sortSessionRuns(runs);
    sessionRunSnapshots.current.set(sessionId, sorted);
    setSessionActivity(sessionId, sorted.some((run) => isActiveRunStatus(run.status)));
    return sorted;
  }

  function upsertSessionRunSnapshot(sessionId: string, run: SessionRun): SessionRun[] {
    const current = sessionRunSnapshots.current.get(sessionId) ?? [];
    const next = sortSessionRuns(current.some((item) => item.id === run.id)
      ? current.map((item) => item.id === run.id ? run : item)
      : [...current, run]);
    sessionRunSnapshots.current.set(sessionId, next);
    setSessionActivity(sessionId, next.some((item) => isActiveRunStatus(item.status)));
    return next;
  }


  // Request errors surface as top-right notification toasts. The state is kept
  // for the connection indicator. Identical concurrent failures — every startup
  // call answering "Unauthorized" to a rejected token, say — collapse into one
  // toast in the queue, so the notification column cannot grow past the dialog
  // the user needs to fix the problem with.
  const setError = useCallback((message?: string) => {
    setErrorState(message);
    if (message) pushToast("error", t("error.request"), message);
  }, [pushToast]);

  // The artifact named by the URL (or an old shared link) no longer exists:
  // tell the user, close the modal and let the URL sync drop the stale key.
  // That is URL normalization, not a navigation, so it must not push a
  // history entry.
  const closeMissingArtifact = useCallback((logicalName: string) => {
    applyingUrlRef.current = true;
    setArtifactModalName(undefined);
    setArtifactModalVersion(undefined);
    pushToast("info", t("error.artifactNotFound"), `“${logicalName}” is not available in this Session`);
  }, [pushToast]);

  // Long-lived panels keep these in effect dependencies, so they must not be
  // re-created on every render of this component.
  const reportError = useCallback((message: string) => setError(message || undefined), [setError]);

  const refreshGovernedDownloads = useCallback(async (sessionId: string): Promise<void> => {
    const [candidates, jobs, plans, invocations] = await Promise.all([
      client.listMcpArtifactCandidates(sessionId),
      client.listMcpArtifactJobs(sessionId),
      client.listMcpArtifactPlans(sessionId),
      client.listMcpInvocations(sessionId),
    ]);
    if (!shouldApplySessionScopedUpdate(sessionId, activeSessionIdRef.current)) return;
    // Polling keeps long downloads current after the Agent turn finishes. Keep
    // object identity when nothing changed so a quiet poll neither rerenders
    // the timeline nor pulls a following message viewport to the bottom.
    setDownloadCandidates((current) => preserveEqualSnapshot(current, candidates));
    setDownloadJobs((current) => preserveEqualSnapshot(current, jobs));
    setDownloadPlans((current) => preserveEqualSnapshot(current, plans));
    setMcpInvocations((current) => preserveEqualSnapshot(current, invocations));
  }, [client]);

  useEffect(() => {
    setDownloadCandidates([]);
    setDownloadJobs([]);
    setDownloadPlans([]);
    if (!activeSessionId) return;
    let active = true;
    const refresh = () => refreshGovernedDownloads(activeSessionId).catch((reason: Error) => {
      if (active) reportError(reason.message);
    });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeSessionId, refreshGovernedDownloads, reportError]);
  const addPendingAnnotation = useCallback((annotation: ArtifactAnnotation) => {
    setPendingAnnotations((current) => [...current.filter((item) => item.id !== annotation.id), annotation]);
  }, []);

  useEffect(() => {
    localStorage.setItem("science-agent-token", token);
    // A new token deserves a fresh verdict; the next 401 (if any) re-arms both
    // the rejection notice and the automatic prompt.
    setTokenRejected(false);
  }, [token]);

  useEffect(() => {
    localStorage.setItem("science-agent-workspace-collapsed", workspaceCollapsed ? "1" : "0");
  }, [workspaceCollapsed]);

  useEffect(() => {
    localStorage.setItem("science-agent-workspace-width", String(workspaceWidth));
  }, [workspaceWidth]);

  useEffect(() => {
    localStorage.setItem("science-agent-show-physical-files", showPhysicalFiles ? "1" : "0");
  }, [showPhysicalFiles]);

  useEffect(() => {
    setArtifactSelectionMode(false);
    setSelectedArtifactIds(new Set());
  }, [activeProjectId]);

  useEffect(() => {
    setWorkspaceFileSelectionMode(false);
    setSelectedWorkspaceFilePaths(new Set());
  }, [activeSessionId]);

  useEffect(() => {
    const updateWorkspaceBounds = () => {
      const maxWidth = measureWorkspaceMaxWidth();
      setWorkspaceMaxWidth(maxWidth);
      setWorkspaceWidth((current) => clampWorkspaceWidth(current, maxWidth));
    };
    updateWorkspaceBounds();
    window.addEventListener("resize", updateWorkspaceBounds);
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    const sidebarObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(updateWorkspaceBounds);
    if (sidebar) sidebarObserver?.observe(sidebar);
    return () => {
      window.removeEventListener("resize", updateWorkspaceBounds);
      sidebarObserver?.disconnect();
    };
  }, []);

  // Main view → URL: the address bar is a shareable, reload-safe projection of
  // where the user is. The path carries the resource identity (Project /
  // Session / Usage / settings layer), the query carries overlay and filter
  // state (filter, panel, artifact). Crossing to another main view pushes a
  // history entry; in-view refinements (settings group, list filter, panel)
  // and popstate-driven normalization replace it. `urlEpoch` is bumped by the
  // popstate handler so this effect re-runs — and normalizes the URL — even
  // when the navigation changed no state at all.
  useEffect(() => {
    if (!projectsLoaded || !sessionsLoaded) return;
    const view: ViewState = {
      artifact: artifactModalName,
      projectId: activeProjectId,
      sessionFilter: sessionListState,
      sessionId: activeSessionId,
      settingsGroup: showConfig ? systemSettingsGroup : undefined,
      settingsKind: showConfig ? "system" : settingsTarget?.kind,
      settingsTargetId: showConfig ? undefined : settingsTarget?.id,
      view: workspaceView === "usage" ? "usage" : undefined,
      workspaceOpen: !workspaceCollapsed,
    };
    const { pathname, search } = serializeViewState(view);
    const next = `${pathname}${search}`;
    const current = `${window.location.pathname}${window.location.search}`;
    if (next === current) {
      lastViewRef.current = view;
      applyingUrlRef.current = false;
      return;
    }
    const fromUrl = applyingUrlRef.current;
    applyingUrlRef.current = false;
    // Compare App-side views, not parsed URLs: the path cannot represent
    // every field combination (e.g. Session + open settings share no path),
    // so parsing the previous URL back would invent phantom field changes.
    const previous = lastViewRef.current;
    lastViewRef.current = view;
    const replace = fromUrl || previous === null || !isPrimaryViewChange(previous, view);
    const url = `${next}${window.location.hash}`;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }, [activeProjectId, activeSessionId, artifactModalName, projectsLoaded, sessionListState, sessionsLoaded, settingsTarget, showConfig, systemSettingsGroup, urlEpoch, workspaceCollapsed, workspaceView]);

  // URL → main view: browser back/forward re-applies the encoded view. Invalid
  // ids degrade to the loaded lists' defaults instead of a blank screen.
  useEffect(() => {
    const handlePopState = () => {
      const view = parseViewState(window.location.pathname, window.location.search);
      applyingUrlRef.current = true;
      // A pending scoped-settings target belongs to the entry it was parsed
      // from; never let an older one be resolved by this navigation's reloads.
      pendingSettingsRef.current = null;
      if (view.workspaceOpen !== undefined) setWorkspaceCollapsed(!view.workspaceOpen);
      setArtifactModalName(view.artifact);
      setArtifactModalVersion(undefined);
      if (view.settingsKind === "system") openSystemSettings();
      else cancelSystemSettings();
      setWorkspaceView(view.view === "usage" ? "usage" : "session");
      const projectId = view.projectId && projects.some((project) => project.id === view.projectId)
        ? view.projectId
        : projects[0]?.id;
      const nextFilter = view.sessionFilter ?? "active";
      // The on-screen Session list only matches the URL when neither the
      // Project nor the filter changes; otherwise the reload reconciles.
      const listWillReload = projectId !== activeProjectIdRef.current || nextFilter !== sessionListState;
      if (view.settingsKind === "system") {
        if (isSystemSettingsGroup(view.settingsGroup)) setSystemSettingsGroup(view.settingsGroup);
        setSettingsTarget(undefined);
      } else if (view.settingsKind === "project" || view.settingsKind === "session") {
        const kind = view.settingsKind;
        const id = view.settingsTargetId ?? (kind === "project" ? activeProjectIdRef.current : activeSessionIdRef.current);
        const target = id ? findResourceTarget(kind, id, projects, sessions) : undefined;
        if (target) {
          // A found target opens right away; the dialog talks to the API by
          // id, so an imminent list reload does not invalidate it.
          void openScopedSettings(target);
        } else {
          setSettingsTarget(undefined);
          // Only queue the resolution when this navigation actually reloads
          // the list that could contain the target (Session kind only — the
          // Project list is already fully loaded, so a miss there is final).
          pendingSettingsRef.current = kind === "session" && listWillReload && id ? { id, kind } : null;
        }
      } else {
        setSettingsTarget(undefined);
      }
      setActiveProjectId(projectId);
      setSessionListState(nextFilter);
      if (!view.sessionId) {
        setActiveSessionId(undefined);
      } else if (!listWillReload) {
        // The Session list on screen matches the URL's Project, so validate now.
        setActiveSessionId(sessions.some((item) => item.id === view.sessionId) ? view.sessionId : sessions[0]?.id);
      } else {
        // The new Project/filter Session list is still loading; the list-load
        // reconciliation keeps this id when it exists and falls back otherwise.
        setActiveSessionId(view.sessionId);
      }
      // Force the URL-sync effect to re-run even if every set above was a
      // no-op, so the address bar is normalized and applyingUrlRef resets.
      setUrlEpoch((epoch) => epoch + 1);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [projects, sessionListState, sessions]);

  useEffect(() => {
    const handleGlobalSearchShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        void openGlobalSearch();
      }
      if (event.key === "Escape") setGlobalSearchOpen(false);
    };
    window.addEventListener("keydown", handleGlobalSearchShortcut);
    return () => window.removeEventListener("keydown", handleGlobalSearchShortcut);
  }, [client]);

  useEffect(() => {
    if (!openProjectMenuId && !openSessionMenuId && !sessionFilterOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".resource-menu, .session-filter")) return;
      setOpenProjectMenuId(undefined);
      setOpenSessionMenuId(undefined);
      setSessionFilterOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenProjectMenuId(undefined);
      setOpenSessionMenuId(undefined);
      setSessionFilterOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openProjectMenuId, openSessionMenuId, sessionFilterOpen]);

  useEffect(() => {
    setError(undefined);
    void Promise.all([
      client.listProjects(),
      client.listModels(),
      client.listConnectors(),
      client.listSkills(),
      client.getGlobalSettings(),
      client.getTimeoutSettings(),
      client.getQuotaSettings(),
      client.getProxySettings(),
      client.getMcpProxyPolicies(),
      client.listMcpSources(),
      client.getWebSettings(),
      client.getMemoryGraphSettings(),
    ]).then(([projectItems, modelItems, connectorItems, skillItems, settings, timeouts, quotas, proxies, mcpPolicyDetails, mcpSourceDetails, web, memoryGraph]) => {
      setProjects(projectItems);
      setModels(modelItems);
      setConnectors(connectorItems);
      setSkills(skillItems);
      setGlobalSettings(settings);
      setTimeoutSettings(timeouts);
      setQuotaSettings(quotas);
      setProxySettings(proxies);
      setMcpProxyPolicies(mcpPolicyDetails.policies);
      setMcpSources(mcpSourceDetails.map((item) => item.manifest));
      setWebSettings(web);
      setMemoryGraphSettings(memoryGraph);
      setWorkspaceCapabilities({
        maxFileBytes: quotas.uploadMaxFileBytes,
        maxRequestBytes: quotas.uploadMaxRequestBytes,
        maxWorkspaceBytes: quotas.runnerMaxWorkspaceBytes,
      });
      // A Project named by the URL wins over the "first item" default.
      const pending = pendingSelectionRef.current;
      const pendingProjectId = pending?.projectId && projectItems.some((item) => item.id === pending.projectId) ? pending.projectId : undefined;
      if (pending?.projectId && !pendingProjectId) pendingSelectionRef.current = null; // URL Project is gone: drop its Session preference too
      const nextProjectId = projectItems.some((item) => item.id === activeProjectIdRef.current) ? activeProjectIdRef.current : pendingProjectId ?? projectItems[0]?.id;
      setActiveProjectId(nextProjectId);
      // Project-scoped settings named by the URL open against this fresh list;
      // a target that is not in it degrades to "dialog closed".
      const pendingSettings = pendingSettingsRef.current;
      if (pendingSettings?.kind === "project") {
        pendingSettingsRef.current = null;
        const target = findResourceTarget("project", pendingSettings.id ?? nextProjectId ?? "", projectItems, []);
        if (target) void openScopedSettings(target);
      }
      const selected = modelItems.find((item) => item.id === editingModelId) ?? modelItems[0];
      if (selected) {
        setEditingModelId(selected.id);
        setModelDraft(modelDraftFromProfile(selected));
        setDraftToken("");
        setRemoveStoredToken(false);
      }
      setVisionModelId((current) => modelItems.some((item) => item.id === current && item.vision)
        ? current
        : modelItems.find((item) => item.vision)?.id);
    }).catch((reason: Error) => {
      // A cold start directly into System settings is an explicit settings
      // load operation, so its failure belongs to that dialog. Other startup
      // failures remain global even if a dialog opens later.
      if (initialView.settingsKind === "system") reportSystemSettingsError(reason.message);
      else setError(reason.message);
    }).finally(() => setProjectsLoaded(true));
  }, [client, initialView.settingsKind, reportSystemSettingsError]);

  useEffect(() => {
    void client.searchWorkbench().then(setWorkbenchIndex).catch((reason: Error) => setError(reason.message));
    void client.listSpecialists().then(setSpecialists).catch((reason: Error) => setError(reason.message));
    void client.listPermissionGrants().then(setPermissionGrants).catch((reason: Error) => setError(reason.message));
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    if (!activeProjectId) {
      setSessions([]);
      setArtifacts([]);
      setArtifactSessions([]);
      setActiveSessionId(undefined);
      setProjectSettings(undefined);
      // Only settled once the Project list has resolved (and stayed empty).
      // Marking it loaded at mount would ungate the URL sync with a stale
      // empty Session list, splitting cold-start normalization into a
      // session-less replace followed by a phantom push.
      setSessionsLoaded(projectsLoaded);
      return () => { cancelled = true; };
    }
    setSessionsLoaded(false);
    void Promise.all([
      client.listSessions(activeProjectId, sessionListState),
      client.listSessions(activeProjectId, "all"),
      client.listProjectArtifacts(activeProjectId),
      client.getProjectSettings(activeProjectId),
    ]).then(([items, allSessions, projectArtifacts, settings]) => {
      if (cancelled) return;
      setSessions(items);
      setArtifactSessions(allSessions);
      setArtifacts(projectArtifacts);
      setProjectSettings(settings);
      // A Session named by the URL wins over the "first item" default, but
      // only once the list of the Project it was paired with has loaded.
      const pending = pendingSelectionRef.current;
      const pendingApplies = Boolean(pending && (!pending.projectId || pending.projectId === activeProjectId));
      const pendingSessionId = pendingApplies && pending?.sessionId && items.some((item) => item.id === pending.sessionId) ? pending.sessionId : undefined;
      if (pendingApplies) pendingSelectionRef.current = null;
      const nextSessionId = items.some((item) => item.id === activeSessionIdRef.current) ? activeSessionIdRef.current : pendingSessionId ?? items[0]?.id;
      setActiveSessionId(nextSessionId);
      // Session-scoped settings named by the URL open against this fresh list;
      // a target that is not in it degrades to "dialog closed".
      const pendingSettings = pendingSettingsRef.current;
      if (pendingSettings?.kind === "session") {
        pendingSettingsRef.current = null;
        const target = findResourceTarget("session", pendingSettings.id ?? nextSessionId ?? "", [], items);
        if (target) void openScopedSettings(target);
      }
    }).catch((reason: Error) => {
      if (!cancelled) setError(reason.message);
    }).finally(() => {
      if (!cancelled) setSessionsLoaded(true);
    });
    return () => { cancelled = true; };
  }, [activeProjectId, client, projectsLoaded, sessionListState]);

  async function refreshSession(sessionId = activeSessionId): Promise<void> {
    if (!sessionId) {
      setSession(undefined);
      setFiles([]);
      setPermissionEpoch(undefined);
      setPermissionRequests([]);
      setSessionUsage(undefined);
      setSessionRuns([]);
      setExecutionRuns([]);
      setEnvironments([]);
      setEnvironmentRevisions([]);
      setDerivations([]);
      setPromptManifests([]);
      setArtifactReviews([]);
      setPlans([]);
      setSubagents([]);
      setRemoteJobs([]);
      setMcpInvocations([]);
      setClaims([]);
      setEvidenceLinks([]);
      setPapers([]);
      setPaperVisionRuns([]);
      setPendingAnnotations([]);
      return;
    }
    const refreshSummaryRevision = latestSessionSummaries.current.get(sessionId)?.revision ?? 0;
    const [detail, workspaceFiles, epoch, permissionRequestItems, permissionGrantItems, usageSummary, sessionRunItems, executionRunItems, artifactDerivations, manifests, artifactReviewRuns, invocations, claimItems, linkItems, paperItems, visionItems, environmentItems, revisionItems, planItems, subagentItems, remoteJobItems] = await Promise.all([
      client.getSession(sessionId),
      client.listFiles(sessionId),
      client.getPermissionEpoch(sessionId),
      client.listPermissionRequests(sessionId),
      client.listPermissionGrants(),
      client.getSessionUsage(sessionId),
      client.listRuns(sessionId),
      client.listExecutionRuns(sessionId),
      client.listArtifactDerivations(sessionId),
      client.listPromptManifests(sessionId),
      client.listArtifactReviews(sessionId),
      client.listMcpInvocations(sessionId),
      client.listClaims(sessionId),
      client.listEvidenceLinks(sessionId),
      client.listPapers(sessionId),
      client.listPaperVisionRuns(sessionId),
      client.listEnvironments().catch(() => []),
      client.listEnvironmentRevisions().catch(() => []),
      client.listSessionPlans(sessionId),
      client.listSubagents(sessionId),
      client.listRemoteJobs(sessionId),
    ]);
    const activeRun = selectSessionReplayRun(sessionRunItems.filter((run) => isActiveRunStatus(run.status)));
    const replayEvents = activeRun ? await client.listRunEvents(sessionId, activeRun.id) : [];
    const terminalRuns = sessionRunItems.filter((run) => isTerminalRunStatus(run.status));
    const terminalEvents = await Promise.all(terminalRuns.map(async (run) => {
      try {
        return [run.id, await client.listRunEvents(sessionId, run.id)] as const;
      } catch {
        return [run.id, []] as const; // legacy runs recorded before event persistence
      }
    }));
    const projectArtifacts = await client.listProjectArtifacts(detail.projectId);
    const eventsByRun = Object.fromEntries(terminalEvents);
    if (!shouldApplySessionScopedUpdate(sessionId, activeSessionIdRef.current)) return;
    const refreshedDetail = mergeRefreshedSessionDetail(
      detail,
      refreshSummaryRevision,
      latestSessionSummaries.current.get(sessionId),
    );
    setSession(refreshedDetail);
    setFiles(workspaceFiles);
    setArtifacts(projectArtifacts);
    setPermissionEpoch(epoch);
    setPermissionRequests(permissionRequestItems);
    setPermissionGrants(permissionGrantItems);
    setSessionUsage(usageSummary);
    setExecutionRuns(executionRunItems);
    setSessionRuns(sessionRunItems);
    syncSessionRunActivity(sessionId, sessionRunItems);
    setEnvironments(environmentItems);
    setEnvironmentRevisions(revisionItems);
    setDerivations(artifactDerivations);
    setPromptManifests(manifests);
    setArtifactReviews(artifactReviewRuns);
    setPlans(planItems);
    setSubagents(subagentItems);
    setRemoteJobs(remoteJobItems);
    setMcpInvocations(invocations);
    setClaims(claimItems);
    setEvidenceLinks(linkItems);
    setPapers(paperItems);
    setPaperVisionRuns(visionItems);
    setReplayTimelines((current) => ({
      ...current,
      [sessionId]: hydrateTerminalRunTimelines(current[sessionId] ?? {}, terminalRuns, eventsByRun),
    }));
    const changedPathsByRun: Record<string, string[]> = {};
    for (const [runId, events] of terminalEvents) {
      changedPathsByRun[runId] = collectRunChangedPaths(events.map((record) => record.event));
    }
    if (activeRun) changedPathsByRun[activeRun.id] = collectRunChangedPaths(replayEvents.map((record) => record.event));
    setRunChangedPaths((current) => ({ ...current, [sessionId]: changedPathsByRun }));
    if (activeRun) {
      setRunTimelines((current) => hydrateSessionRunTimeline(current, sessionId, activeRun, replayEvents));
      if (sessionActivity.current.streamCount(sessionId) === 0) {
        resumeSessionRun(sessionId, refreshedDetail.title, activeRun, replayEvents.at(-1)?.sequence ?? 0);
      }
    } else {
      // A finished run renders in place through its terminal block; keep the
      // trailing live buffer from showing the same steps twice.
      setRunTimelines((current) => clearSessionTimeline(current, sessionId));
      setTimelineMessageIds((current) => forgetSession(current, sessionId));
    }
  }

  // A manual review keeps running on the server after a browser refresh. Poll
  // only its small persisted state until it reaches a terminal result, without
  // replacing active main-agent messages or timelines.
  useEffect(() => {
    const sessionId = session?.id;
    if (!sessionId || !reviewerCheckpointRunning) return;
    let active = true;
    const refreshReviewerCheckpoint = () => {
      void Promise.all([client.getSession(sessionId), client.listArtifactReviews(sessionId)])
        .then(([detail, reviews]) => {
          if (!active || !shouldApplySessionScopedUpdate(sessionId, activeSessionIdRef.current)) return;
          const remoteById = new Map(detail.messages.map((message) => [message.id, message]));
          setSession((current) => current?.id === sessionId ? {
            ...current,
            messages: current.messages.map((message) => message.kind === "reviewer_checkpoint"
              ? remoteById.get(message.id) ?? message
              : message),
          } : current);
          setArtifactReviews(reviews);
        })
        .catch(() => undefined);
    };
    refreshReviewerCheckpoint();
    const timer = window.setInterval(refreshReviewerCheckpoint, 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client, reviewerCheckpointRunning, session?.id]);

  useEffect(() => {
    const visibleSessionId = activeSessionId;
    // The timeline is not reset here: switching Sessions only changes which
    // buffer is rendered, so a run left streaming in the background still has
    // its steps on screen when the user returns to it.
    setIsFollowingOutput(true);
    setMarkdownDocument(undefined);
    void refreshSession(visibleSessionId).catch((reason: Error) => {
      if (shouldApplySessionScopedUpdate(visibleSessionId, activeSessionIdRef.current)) setError(reason.message);
    });
  }, [activeSessionId, client]);

  // Resolve the latest report artifact version's chip references so [evidence1]/
  // [artifact1] tokens in RunTimeline report messages render as clickable chips.
  // Re-runs when files change (a new report lands) or the active session does.
  useEffect(() => {
    if (!activeSessionId) { setReportReferences(undefined); return; }
    let active = true;
    void (async () => {
      const reportFile = previewMarkdownFile(files);
      if (!reportFile) { if (active) setReportReferences(undefined); return; }
      try {
        const artifacts = await client.listArtifacts(activeSessionId);
        // Match on originMeta.declaredPath (the file path LLM passed to
        // declare_artifact) rather than logicalName (which carries the LLM-chosen
        // display name, e.g. a Chinese title — never equals a filename). Falls
        // back to logicalName for old artifacts lacking originMeta.
        const artifact = artifacts.find((item) => item.originMeta?.declaredPath === reportFile.path
          || item.logicalName === reportFile.path);
        if (!artifact) { if (active) setReportReferences(undefined); return; }
        const versions = await client.listArtifactVersions(activeSessionId, artifact.id);
        const latest = [...versions].sort((left, right) => right.version - left.version)[0];
        if (active && latest?.references?.length) setReportReferences(latest.references);
        else if (active) setReportReferences(undefined);
      } catch {
        if (active) setReportReferences(undefined);
      }
    })();
    return () => { active = false; };
  }, [activeSessionId, client, files]);

  useEffect(() => {
    if (!markdownDocument) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMarkdownDocument(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [markdownDocument]);

  useEffect(() => {
    if (!isFollowingOutput) return;
    const messageContainer = messagesViewport.current;
    messageContainer?.scrollTo({ top: messageContainer.scrollHeight });
  }, [artifactReviews, downloadCandidates, downloadJobs, downloadPlans, files, isFollowingOutput, replayTimelines, runTimeline, session?.messages]);

  useEffect(() => {
    const textarea = composerTextarea.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    // Only grow to the content here; the cap lives in CSS
    // (`max-height: min(200px, 20vh)`, lower while running) so window
    // resizes and the running-compact state apply without re-running this.
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [message]);

  // Open a report chip's referenced graph node. Evidence chips open a dedicated
  // detail modal (evidence content + the Paper it was extracted from); artifact
  // chips open the ArtifactModal directly (so an [artifact1] chip shows the
  // figure/data itself); paper/claim chips switch the memory view to the node.
  async function handleChipClick(reference: ComposerReference): Promise<void> {
    // Evidence chips open a dedicated detail modal (evidence content + the
    // Paper it was extracted from), not the workspace memory panel.
    if (reference.kind === "evidence") {
      setEvidenceDetailId(reference.id);
      return;
    }
    // Artifact chips open the figure/data itself: the chip carries the
    // artifact_id (UUID), so reverse-resolve it to the logicalName the
    // ArtifactModal opens by. The chip may also carry a ``version`` (the one
    // its claim cited) — pin the modal to that version instead of the latest.
    // Falls back to the memory panel if not found.
    if (reference.kind === "artifact") {
      try {
        const hit = artifacts.find((item) => item.id === reference.id)
          ?? (activeProjectId
            ? (await client.listProjectArtifacts(activeProjectId)).find((item) => item.id === reference.id)
            : undefined);
        if (hit) {
          setArtifactModalVersion(reference.version);
          setArtifactModalName(hit.name);
          return;
        }
        console.warn("[chip] artifact chip did not resolve: id=", reference.id);
      } catch (error) {
        console.warn("[chip] artifact chip listArtifacts failed: id=", reference.id,
          "activeSessionId=", activeSessionId, "error=", error);
        // fall through to the memory-panel path below.
      }
    }
    const label = KIND_TO_LABEL[reference.kind];
    if (!label) return; // session/skill chips have no graph node label.
    setPendingMemoryNode({ label, id: reference.id });
    setArtifactModalName(undefined);
    if (workspaceCollapsed) setWorkspaceCollapsed(false);
    else workspacePanel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handleMessagesScroll(): void {
    const messageContainer = messagesViewport.current;
    if (!messageContainer) return;
    const distanceFromBottom = messageContainer.scrollHeight - messageContainer.scrollTop - messageContainer.clientHeight;
    const shouldFollow = distanceFromBottom < 96;
    setIsFollowingOutput((current) => current === shouldFollow ? current : shouldFollow);
  }

  function scrollToLatest(): void {
    setIsFollowingOutput(true);
    const messageContainer = messagesViewport.current;
    messageContainer?.scrollTo({ behavior: "smooth", top: messageContainer.scrollHeight });
  }

  function syncSessionSummary(updated: Session): void {
    const summary = sessionSummaryFrom(updated);
    const previousRevision = latestSessionSummaries.current.get(summary.id)?.revision ?? 0;
    latestSessionSummaries.current.set(summary.id, {
      revision: previousRevision + 1,
      summary,
    });
    setSessions((current) => current.map((item) => item.id === summary.id ? summary : item));
    setSession((current) => current?.id === summary.id ? mergeSessionDetailWithSummary(current, summary) : current);
  }

  async function createProject(name: string, settingsOverrides: RuntimeSettingsOverrides): Promise<void> {
    try {
      const { firstSession, project } = await client.createProject({ name, settingsOverrides });
      setProjects((current) => [...current, project]);
      setSessionListState("active");
      setSessions([firstSession]);
      setActiveProjectId(project.id);
      setActiveSessionId(firstSession.id);
      focusComposerSessionId.current = firstSession.id;
      setWorkspaceView("session");
      setProjectCreationOpen(false);
      setProjectsExpanded(false);
      setSessionsExpanded(true);
      pushToast("success", "Project created", project.name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("error.createProject"));
    }
  }

  async function createSession(): Promise<void> {
    if (!activeProjectId) {
      setError(t("error.selectProject"));
      return;
    }
    const projectId = activeProjectId;
    await runSessionCreationOnce({
      create: () => client.createSession(projectId, buildCreateSessionRequest("")),
      fallbackError: t("error.createSession"),
      isInFlight: () => sessionCreationInFlight.current,
      onCreated: (created) => {
        if (activeProjectIdRef.current !== projectId) {
          pushToast("success", "Session created", created.title);
          return;
        }
        setSessions((current) => sessionListState === "archived" ? [created] : [created, ...current]);
        if (sessionListState === "archived") setSessionListState("active");
        setActiveSessionId(created.id);
        focusComposerSessionId.current = created.id;
        setWorkspaceView("session");
        pushToast("success", "Session created", created.title);
      },
      onError: setError,
      setInFlight: (value) => { sessionCreationInFlight.current = value; },
      setPending: setSessionCreationPending,
    });
  }

  function beginInlineRename(target: ResourceTarget, location: InlineRenameTarget["location"]): void {
    if (renameSavesInFlight.current.has(resourceTargetKey(target))) return;
    setRenameDraft(target.label);
    setRenameTarget({ ...target, location, revision: ++renameRevision.current });
  }

  async function commitInlineRename(target: InlineRenameTarget, draft: string): Promise<void> {
    const name = normalizedInlineRename(draft, target.label);
    if (!name) {
      setRenameTarget((current) => current?.revision === target.revision ? undefined : current);
      return;
    }

    const key = resourceTargetKey(target);
    if (renameSavesInFlight.current.has(key)) return;
    renameSavesInFlight.current.add(key);
    setRenameSavingKeys((current) => new Set(current).add(key));
    let saved = false;
    try {
      if (target.kind === "project") {
        const updated = await client.updateProject(target.id, { name });
        setProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
      } else {
        const updated = await client.updateSession(target.id, { title: name });
        syncSessionSummary(updated);
      }
      saved = true;
      setError(undefined);
      pushToast("success", target.kind === "project" ? "Project renamed" : "Session renamed", name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Could not rename ${target.kind}`);
    } finally {
      renameSavesInFlight.current.delete(key);
      setRenameSavingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      if (saved) {
        setRenameTarget((current) => current?.revision === target.revision ? undefined : current);
      }
    }
  }

  function editModel(profile: ModelProfile): void {
    setEditingModelId(profile.id);
    setModelDraft(modelDraftFromProfile(profile));
    setDraftToken("");
    setRemoveStoredToken(false);
    setModelSettingsDirty(false);
  }

  function startNewModel(): void {
    setEditingModelId(undefined);
    setModelDraft(EMPTY_MODEL_DRAFT);
    setDraftToken("");
    setRemoveStoredToken(false);
    setModelSettingsDirty(false);
  }

  function updateModelDraft(update: Partial<ModelDraft>): void {
    setModelDraft((current) => ({ ...current, ...update }));
    setModelSettingsDirty(true);
  }

  async function saveModel(): Promise<void> {
    reportSystemSettingsError();
    try {
      const saved = editingModelId
        ? await client.updateModel(editingModelId, {
            ...modelDraft,
            ...(removeStoredToken ? { apiToken: null } : draftToken.trim() ? { apiToken: draftToken.trim() } : {}),
          })
        : await client.createModel({ ...modelDraft, apiToken: draftToken.trim() });
      setModels((current) => [...current.filter((item) => item.id !== saved.id), saved]
        .toSorted((left, right) => left.name.localeCompare(right.name)));
      setEditingModelId(saved.id);
      setDraftToken("");
      setRemoveStoredToken(false);
      setModelSettingsDirty(false);
      pushToast("success", editingModelId ? "Model updated" : "Model added", saved.name);
    } catch (reason) {
      reportSystemSettingsError(reason instanceof Error ? reason.message : t("error.saveModel"));
      throw reason;
    }
  }

  async function createProxyServer(input: CreateProxyServerRequest): Promise<void> {
    try {
      await client.createProxyServer(input);
      setProxySettings(await client.getProxySettings());
      setError(undefined);
      pushToast("success", "Proxy server added", input.name.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add proxy server");
      throw reason;
    }
  }

  async function updateProxyServer(serverId: string, input: UpdateProxyServerRequest): Promise<void> {
    try {
      const saved = await client.updateProxyServer(serverId, input);
      // Reload the display projection because environment runtime details are
      // intentionally computed on GET and are not part of mutation responses.
      setProxySettings(await client.getProxySettings());
      setError(undefined);
      pushToast("success", "Proxy server updated", saved.name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update proxy server");
      throw reason;
    }
  }

  async function deleteProxyServer(server: ProxyServer): Promise<void> {
    if (!window.confirm(`Delete proxy server “${server.name}”?`)) return;
    try {
      await client.deleteProxyServer(server.id);
      setProxySettings((current) => current ? {
        ...current,
        servers: current.servers.filter((item) => item.id !== server.id),
      } : current);
      setError(undefined);
      pushToast("success", "Proxy server deleted", server.name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete proxy server");
    }
  }

  async function updateDefaultProxyPolicy(defaultPolicy: Exclude<ProxyPolicy, "inherit">): Promise<void> {
    try {
      setProxySettings(await client.updateProxySettings({ defaultPolicy }));
      setError(undefined);
      pushToast("success", "Global proxy default updated");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update the global proxy default");
    }
  }

  async function updateMcpProxyPolicy(serverId: string, policy: ProxyPolicy): Promise<void> {
    const policies = { ...mcpProxyPolicies, [serverId]: policy };
    if (policy === "inherit") delete policies[serverId];
    try {
      const saved = await client.updateMcpProxyPolicies({ policies });
      setMcpProxyPolicies(saved.policies);
      setError(undefined);
      pushToast("success", "MCP proxy policy updated", serverId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update MCP proxy policy");
    }
  }

  function updateWebProxyPolicy(policy: ProxyPolicy): void {
    if (!webSettings) return;
    setWebSettingsEdit((current) => {
      const draft = current ?? createWebSettingsDraft(webSettings);
      return { ...draft, values: { ...draft.values, proxyPolicy: policy } };
    });
  }

  async function saveWebSettings(input: UpdateWebSettingsRequest): Promise<void> {
    reportSystemSettingsError();
    try {
      const saved = await client.updateWebSettings(input);
      setWebSettings(saved);
      pushToast("success", "Web settings updated");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t("error.saveWeb");
      reportSystemSettingsError(message);
      throw reason;
    }
  }

  async function saveMemoryGraphSettings(input: UpdateMemoryGraphSettingsRequest): Promise<void> {
    reportSystemSettingsError();
    try {
      const saved = await client.updateMemoryGraphSettings(input);
      setMemoryGraphSettings(saved);
      pushToast("success", "Science Memory settings updated");
    } catch (reason) {
      reportSystemSettingsError(reason instanceof Error ? reason.message : "Could not save Science Memory settings");
      throw reason;
    }
  }

  function clearSystemSettingsDrafts(discardModel = true): void {
    setGlobalSettingsEdit(undefined);
    setTimeoutSettingsEdit(undefined);
    setQuotaSettingsEdit(undefined);
    setWebSettingsEdit(undefined);
    setMemoryGraphSettingsEdit(undefined);
    setLocaleEdit(undefined);
    setTokenEdit(undefined);
    if (discardModel) {
      const savedModel = models.find((item) => item.id === editingModelId);
      if (savedModel) {
        setModelDraft(modelDraftFromProfile(savedModel));
      } else {
        setModelDraft(EMPTY_MODEL_DRAFT);
      }
    }
    setDraftToken("");
    setRemoveStoredToken(false);
    setModelSettingsDirty(false);
  }

  function openSystemSettings(group?: SystemSettingsGroup): void {
    reportSystemSettingsError();
    if (group) setSystemSettingsGroup(group);
    setShowConfig(true);
  }

  function cancelSystemSettings(): void {
    clearSystemSettingsDrafts();
    reportSystemSettingsError();
    setShowConfig(false);
  }

  async function saveSystemSettings(closeAfterSave: boolean): Promise<void> {
    if (systemSettingsSaving) return;
    reportSystemSettingsError();
    setSystemSettingsSaving(true);
    const validationError = modelSettingsDirty && (!modelDraft.name.trim() || !modelDraft.baseUrl.trim() || !modelDraft.model.trim())
      ? "Display name, base URL, and model ID are required"
      : modelSettingsDirty && !editingModelId && !draftToken.trim()
        ? "API token is required for a new model"
        : undefined;
    if (validationError) {
      reportSystemSettingsError(validationError);
      setSystemSettingsSaving(false);
      return;
    }
    try {
      // The footer saves every edited section retained while navigating.
      // Persist every edited section, including drafts retained while the user
      // navigated elsewhere in the dialog. A failed request keeps the dialog
      // and remaining drafts open so the user can retry.
      if (globalSettingsEdit) await saveGlobalSettings(globalSettingsEdit);
      if (timeoutSettingsEdit) await saveTimeoutSettings(timeoutSettingsEdit);
      if (quotaSettingsEdit) await saveQuotaSettings(quotaSettingsEdit);
      if (webSettingsEdit) await saveWebSettings(webSettingsRequest(webSettingsEdit));
      if (memoryGraphSettingsEdit) await saveMemoryGraphSettings(memoryGraphSettingsRequest(memoryGraphSettingsEdit));
      if (modelSettingsDirty) await saveModel();
      if (localeEdit) setLocale(localeEdit);
      if (tokenEdit !== undefined) setToken(tokenEdit);
      clearSystemSettingsDrafts(false);
      if (closeAfterSave) {
        reportSystemSettingsError();
        setShowConfig(false);
      }
    } catch {
      // Individual save functions report a specific error. Keep all drafts so
      // Save can be retried without reconstructing edits from other sections.
    } finally {
      setSystemSettingsSaving(false);
    }
  }

  async function deleteModel(): Promise<void> {
    if (!editingModelId) return;
    reportSystemSettingsError();
    try {
      await client.deleteModel(editingModelId);
      const remaining = models.filter((item) => item.id !== editingModelId);
      setModels(remaining);
      const next = remaining[0];
      if (next) editModel(next);
      else startNewModel();
      pushToast("success", "Model deleted");
    } catch (reason) {
      reportSystemSettingsError(reason instanceof Error ? reason.message : t("error.deleteModel"));
    }
  }

  async function updateSessionSettings(changes: UpdateSessionRequest): Promise<void> {
    const approvalOnly = Object.keys(changes).every((key) => key === "approvalMode");
    if (!activeSessionId || (isRunning && !approvalOnly) || session?.archivedAt) return;
    try {
      const updated = await client.updateSession(activeSessionId, changes);
      syncSessionSummary(updated);
      if (approvalOnly) {
        const [requests, grants, jobs] = await Promise.all([
          client.listPermissionRequests(activeSessionId),
          client.listPermissionGrants(),
          client.listRemoteJobs(activeSessionId),
        ]);
        setPermissionRequests(requests);
        setPermissionGrants(grants);
        setRemoteJobs(jobs);
      }
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("error.updateSession"));
    }
  }

  function reconcilePermissionSnapshots(
    sessionId: string | undefined,
    snapshots: readonly PermissionRequest[],
    replaceList = false,
  ): void {
    if (!sessionId) return;
    const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    if (shouldApplySessionScopedUpdate(sessionId, activeSessionIdRef.current)) {
      setPermissionRequests((current) => {
        if (replaceList) return [...snapshots];
        const known = new Set(current.map((candidate) => candidate.id));
        return [
          ...current.map((candidate) => byId.get(candidate.id) ?? candidate),
          ...snapshots.filter((snapshot) => !known.has(snapshot.id)),
        ];
      });
    }
    setRunTimelines((current) => reconcileSessionTimelinePermissions(current, sessionId, snapshots));
    setReplayTimelines((current) => {
      const sessionTimelines = current[sessionId];
      if (!sessionTimelines) return current;
      let changed = false;
      const reconciled = Object.fromEntries(Object.entries(sessionTimelines).map(([runId, timeline]) => {
        const next = reconcilePermissionTimeline(timeline, snapshots);
        if (next !== timeline) changed = true;
        return [runId, next];
      }));
      return changed ? { ...current, [sessionId]: reconciled } : current;
    });
  }

  async function refreshPermissionState(sessionId: string): Promise<void> {
    const [requests, grants, epoch] = await Promise.all([
      client.listPermissionRequests(sessionId),
      client.listPermissionGrants(),
      client.getPermissionEpoch(sessionId),
    ]);
    reconcilePermissionSnapshots(sessionId, requests, true);
    if (!shouldApplySessionScopedUpdate(sessionId, activeSessionIdRef.current)) return;
    setPermissionGrants(grants);
    setPermissionEpoch(epoch);
  }

  async function decidePermission(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    try {
      const result = await client.decidePermissionRequest(request.id, { decision });
      reconcilePermissionSnapshots(request.sessionId, result.resolvedRequests);
      if (result.grant) setPermissionGrants((current) => [...current.filter((grant) => grant.id !== result.grant!.id), result.grant!]);
      if (result.permissionEpoch) setPermissionEpoch(result.permissionEpoch);
      setError(undefined);
      pushToast(
        decision === "deny" ? "info" : "success",
        decision === "allow_matching" && result.resolvedRequests.length > 1
          ? `${result.resolvedRequests.length} matching permissions granted`
          : decision === "deny" ? "Permission denied" : "Permission granted",
      );
    } catch (reason) {
      const conflict = permissionRequestFromConflict(reason);
      if (conflict) {
        reconcilePermissionSnapshots(request.sessionId, [conflict]);
        setError(undefined);
        pushToast("info", conflict.state === "allowed"
          ? "Permission was already granted"
          : conflict.state === "denied"
            ? "Permission was already denied"
            : "Permission was cancelled");
        return;
      }
      if (request.sessionId) await refreshPermissionState(request.sessionId).catch(() => undefined);
      setError(reason instanceof Error ? reason.message : t("error.permission"));
    }
  }

  async function revokePermission(grant: PermissionGrant): Promise<void> {
    await settingsErrorRouter.run("revokePermission", async () => {
      await client.revokePermissionGrant(grant.id);
      setPermissionGrants((current) => current.filter((candidate) => candidate.id !== grant.id));
      pushToast("success", "Permission grant revoked");
    }, t("error.revokePermission"));
  }

  async function runManualReviewerSpecialist(): Promise<void> {
    const targetSessionId = activeSessionId;
    if (!targetSessionId
      || manualReviewerBusyBySession[targetSessionId]
      || reviewerCheckpointRunning
      || !reviewerSpecialistSettings?.enabled
      || session?.archivedAt) return;
    const messageId = crypto.randomUUID();
    const toolCallId = `manual-review:${messageId}`;
    const optimisticMessage: ChatMessage = {
      content: "Reviewer Specialist review",
      createdAt: new Date().toISOString(),
      id: messageId,
      kind: "reviewer_checkpoint",
      reviewerCheckpoint: { status: "running", toolCallId },
      role: "assistant",
    };
    setSession((current) => current?.id === targetSessionId
      ? { ...current, messages: [...current.messages, optimisticMessage] }
      : current);
    setManualReviewerBusyBySession((current) => ({ ...current, [targetSessionId]: true }));
    try {
      const result = await client.runReviewerSpecialist(targetSessionId, messageId);
      if (shouldApplySessionScopedUpdate(targetSessionId, activeSessionIdRef.current)) {
        setSession((current) => current?.id === targetSessionId ? {
          ...current,
          messages: current.messages.map((item) => item.id === messageId ? result.message : item),
        } : current);
        setArtifactReviews((current) => {
          const returnedIds = new Set(result.reviews.map((review) => review.id));
          return [...current.filter((review) => !returnedIds.has(review.id)), ...result.reviews];
        });
      }
      setError(undefined);
      if (result.error) {
        pushToast("error", "Review failed", result.error);
        return;
      }
      pushToast(
        "success",
        "Review finished",
        `${result.reviews.length} Artifact${result.reviews.length === 1 ? "" : "s"} reviewed`,
      );
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : "Could not run Reviewer Specialist";
      if (shouldApplySessionScopedUpdate(targetSessionId, activeSessionIdRef.current)) {
        setSession((current) => current?.id === targetSessionId ? {
          ...current,
          messages: current.messages.map((item) => item.id === messageId ? {
            ...item,
            content: `Reviewer Specialist feedback (internal review record)\nStatus: FAILED\nFailure: ${detail}`,
            reviewerCheckpoint: { status: "failed", toolCallId, error: detail },
          } : item),
        } : current);
      }
      setError(undefined);
      pushToast("error", "Review failed", detail);
    } finally {
      setManualReviewerBusyBySession((current) => {
        const { [targetSessionId]: _completed, ...remaining } = current;
        return remaining;
      });
    }
  }

  async function decideRemoteJob(job: RemoteJob, decision: PermissionDecision): Promise<void> {
    if (!activeSessionId || session?.archivedAt) return;
    try {
      const updated = await client.decideRemoteJob(activeSessionId, job.id, { decision, expectedVersion: job.version });
      const jobs = await client.listRemoteJobs(activeSessionId);
      setRemoteJobs(jobs);
      if (updated.outputRecords.some((output) => output.localPath)) setFiles(await client.listFiles(activeSessionId));
      setError(updated.error);
      if (!updated.error) pushToast(decision === "deny" ? "info" : "success", decision === "deny" ? "Remote job declined" : "Remote job approved");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not decide remote job");
    }
  }

  async function refreshRemoteJob(job: RemoteJob): Promise<void> {
    if (!activeSessionId || isRunning || session?.archivedAt) return;
    try {
      const updated = await client.refreshRemoteJob(activeSessionId, job.id);
      setRemoteJobs((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
      if (updated.outputRecords.some((output) => output.localPath)) setFiles(await client.listFiles(activeSessionId));
      setError(updated.error);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not refresh remote job");
    }
  }

  async function refreshVisibleSessions(preferredSessionId = activeSessionId): Promise<void> {
    if (!activeProjectId) return;
    const items = await client.listSessions(activeProjectId, sessionListState);
    setSessions(items);
    const nextId = items.some((item) => item.id === preferredSessionId) ? preferredSessionId : items[0]?.id;
    setActiveSessionId(nextId);
    if (nextId === activeSessionId) await refreshSession(nextId);
  }

  async function saveGlobalSettings(overrides: RuntimeSettingsOverrides): Promise<void> {
    await settingsErrorRouter.run("saveGlobalSettings", async () => {
      setGlobalSettings(await client.replaceGlobalSettings(overrides));
      if (activeProjectId) {
        setProjectSettings(await client.getProjectSettings(activeProjectId));
        await refreshVisibleSessions();
      }
      pushToast("success", "Global defaults saved");
    }, "Could not save global settings");
  }

  async function saveTimeoutSettings(settings: SystemTimeoutSettings): Promise<void> {
    await settingsErrorRouter.run("saveTimeoutSettings", async () => {
      setTimeoutSettings(await client.replaceTimeoutSettings(settings));
      pushToast("success", "Timeout settings saved");
    }, "Could not save timeout settings");
  }

  async function saveQuotaSettings(settings: SystemQuotaSettings): Promise<void> {
    await settingsErrorRouter.run("saveQuotaSettings", async () => {
      const saved = await client.replaceQuotaSettings(settings);
      setQuotaSettings(saved);
      setWorkspaceCapabilities({
        maxFileBytes: saved.uploadMaxFileBytes,
        maxRequestBytes: saved.uploadMaxRequestBytes,
        maxWorkspaceBytes: saved.runnerMaxWorkspaceBytes,
      });
      pushToast("success", "Quota settings saved");
    }, "Could not save quota settings");
  }

  async function openScopedSettings(target: ResourceTarget): Promise<void> {
    setSettingsTarget(target);
    setScopedSettings(undefined);
    await settingsErrorRouter.run("loadScopedSettings", async () => {
      setScopedSettings(target.kind === "project"
        ? await client.getProjectSettings(target.id)
        : await client.getSessionSettings(target.id));
    }, "Could not load settings");
  }

  async function saveScopedSettings(overrides: RuntimeSettingsOverrides): Promise<void> {
    if (!settingsTarget) return;
    await settingsErrorRouter.run("saveScopedSettings", async () => {
      const updated = settingsTarget.kind === "project"
        ? await client.replaceProjectSettings(settingsTarget.id, overrides)
        : await client.replaceSessionSettings(settingsTarget.id, overrides);
      setScopedSettings(updated);
      if (settingsTarget.kind === "project") {
        setProjects(await client.listProjects());
        if (settingsTarget.id === activeProjectId) setProjectSettings(updated);
      }
      await refreshVisibleSessions();
      pushToast("success", settingsTarget.kind === "project" ? "Project overrides saved" : "Session overrides saved");
    }, "Could not save scoped settings");
  }

  function closeScopedSettings(): void {
    reportScopedSettingsError();
    setSettingsTarget(undefined);
    setScopedSettings(undefined);
  }

  async function changeSessionArchiveState(action: "archive" | "restore", sessionId = activeSessionId): Promise<void> {
    if (!sessionId || runningSessionIds.has(sessionId)) return;
    setLifecycleBusy(true);
    try {
      const updated = action === "archive"
        ? await client.archiveSession(sessionId)
        : await client.restoreSession(sessionId);
      const items = activeProjectId ? await client.listSessions(activeProjectId, sessionListState) : [];
      setSessions(items);
      const nextSessionId = items.some((item) => item.id === activeSessionId)
        ? activeSessionId
        : items.some((item) => item.id === updated.id) ? updated.id : items[0]?.id;
      setActiveSessionId(nextSessionId);
      if (session?.id === updated.id && nextSessionId === updated.id) {
        syncSessionSummary(updated);
      }
      setError(undefined);
      pushToast("success", action === "archive" ? "Session archived" : "Session restored");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Could not ${action} Session`);
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function openDeletion(target: ResourceTarget): Promise<void> {
    setDeletionTarget(target);
    setDeletionImpact(undefined);
    setDeletionConfirmation("");
    try {
      setDeletionImpact(target.kind === "project"
        ? await client.getProjectDeletionImpact(target.id)
        : await client.getSessionDeletionImpact(target.id));
    } catch (reason) {
      setDeletionTarget(undefined);
      setError(reason instanceof Error ? reason.message : "Could not preview deletion");
    }
  }

  async function confirmDeletion(): Promise<void> {
    if (!deletionTarget || deletionConfirmation !== deletionTarget.label) return;
    setLifecycleBusy(true);
    try {
      if (deletionTarget.kind === "project") {
        await client.deleteProject(deletionTarget.id);
        const remaining = projects.filter((project) => project.id !== deletionTarget.id);
        setProjects(remaining);
        setActiveProjectId(selectAfterRemoval(projects, deletionTarget.id, activeProjectId));
      } else {
        await client.deleteSession(deletionTarget.id);
        latestSessionSummaries.current.delete(deletionTarget.id);
        const remaining = sessions.filter((item) => item.id !== deletionTarget.id);
        setSessions(remaining);
        setActiveSessionId(selectAfterRemoval(sessions, deletionTarget.id, activeSessionId));
        setRunTimelines((current) => forgetSession(current, deletionTarget.id));
        setTimelineMessageIds((current) => forgetSession(current, deletionTarget.id));
        if (activeProjectId) {
          setArtifactSessions(await client.listSessions(activeProjectId, "all"));
          setArtifacts(await client.listProjectArtifacts(activeProjectId));
        }
      }
      setDeletionTarget(undefined);
      setDeletionImpact(undefined);
      setDeletionConfirmation("");
      setError(undefined);
      pushToast("success", deletionTarget.kind === "project" ? "Project deleted" : "Session deleted", deletionTarget.label);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete resource");
    } finally {
      setLifecycleBusy(false);
    }
  }

  function toggleConnector(connectorId: ConnectorId): void {
    if (!session) return;
    const enabledConnectorIds = session.enabledConnectorIds.includes(connectorId)
      ? session.enabledConnectorIds.filter((id) => id !== connectorId)
      : [...session.enabledConnectorIds, connectorId];
    void updateSessionSettings({ enabledConnectorIds });
  }

  async function upload(fileList: FileList | File[]): Promise<void> {
    if (!activeSessionId || session?.archivedAt) return;
    const filesToUpload = [...fileList];
    if (!filesToUpload.length) return;
    const maxFileBytes = workspaceCapabilities?.maxFileBytes ?? 1_073_741_824;
    const oversized = maxFileBytes > 0
      ? filesToUpload.filter((file) => file.size > maxFileBytes)
      : [];
    const accepted = maxFileBytes > 0
      ? filesToUpload.filter((file) => file.size <= maxFileBytes)
      : filesToUpload;
    for (const file of oversized) {
      pushToast("error", "Upload skipped", `${file.name} exceeds the ${formatByteLimit(maxFileBytes)} limit`);
    }
    if (!accepted.length) return;
    const result = await client.uploadWorkspaceFiles(activeSessionId, accepted);
    setFiles(result.files);
    if (activeProjectId) setArtifacts(await client.listProjectArtifacts(activeProjectId));
    for (const item of result.uploaded) {
      if (item.status === "failed") {
        pushToast("error", "Upload failed", `${item.originalName}: ${item.error ?? "unknown error"}`);
      } else {
        pushToast("success", "File uploaded", item.path ?? item.originalName);
      }
    }
  }

  async function uploadPaper(file: File): Promise<void> {
    if (!activeSessionId || session?.archivedAt) return;
    if (file.size > 50 * 1024 * 1024) throw new Error("PDF uploads are limited to 50 MiB");
    setPaperBusy(true);
    try {
      const paper = await client.uploadPaper(activeSessionId, file);
      setPapers((current) => [...current, paper]);
      setFiles(await client.listFiles(activeSessionId));
      setError(undefined);
      pushToast("success", "PDF uploaded", file.name);
    } finally {
      setPaperBusy(false);
    }
  }

  async function openWorkspacePath(path: string, targetSessionId = activeSessionId): Promise<void> {
    if (!targetSessionId) return;
    const file = await client.readFile(targetSessionId, path);
    if (path.toLowerCase().endsWith(".md")) {
      setMarkdownDocument({ content: await file.text(), path });
      return;
    }
    const url = URL.createObjectURL(file);
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function analyzePaperVision(paper: PaperAcquisition): Promise<void> {
    if (session?.archivedAt) return;
    if (!activeSessionId || !visionModelId) {
      setError("Configure and select a vision-capable model first");
      return;
    }
    const model = models.find((item) => item.id === visionModelId);
    if (!model?.hasApiToken) {
      setError(`Save an API token for ${model?.name ?? "the vision model"} in Model settings`);
      return;
    }
    setPaperBusy(true);
    setError(undefined);
    try {
      const run = await client.analyzePaperVision(activeSessionId, paper.id, {
        modelId: visionModelId,
      });
      setPaperVisionRuns((current) => [...current, run]);
      setFiles(await client.listFiles(activeSessionId));
      pushToast("success", "Vision analysis finished");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Vision analysis failed");
    } finally {
      setPaperBusy(false);
    }
  }

  function updateSessionStreamCount(sessionId: string, delta: 1 | -1): void {
    let count: number;
    if (delta === 1) {
      sessionActivity.current.addStream(sessionId);
      count = sessionActivity.current.streamCount(sessionId);
    } else {
      count = sessionActivity.current.removeStream(sessionId);
    }
    setRunningSessionIds(sessionActivity.current.runningSessionIds());
    if (!count) {
      setStoppingSessionIds((current) => {
        if (!current.has(sessionId)) return current;
        const updated = new Set(current);
        updated.delete(sessionId);
        return updated;
      });
    }
  }

  function applySessionRunEvent(
    sessionId: string,
    sessionTitle: string | undefined,
    runId: string | undefined,
    streamEvent: RunStreamEvent,
    sequence: number,
  ): void {
    setRunTimelines((current) => recordSessionTimelineEvent(
      current,
      sessionId,
      streamEvent,
      { ...(runId ? { runId } : {}), sequence },
    ));
    if (streamEvent.type === "run.completed") {
      setTimelineMessageIds((current) => ({ ...current, [sessionId]: streamEvent.message.id }));
    }
    if (streamEvent.type === "run.status" && streamEvent.status === "running") {
      setTimelineMessageIds((current) => forgetSession(current, sessionId));
    }
    if (streamEvent.type === "run.queued" || streamEvent.type === "run.status") {
      const nextRuns = upsertSessionRunSnapshot(sessionId, streamEvent.run);
      if (shouldApplySessionScopedUpdate(sessionId, activeSessionIdRef.current)) setSessionRuns(nextRuns);
    }
    if (streamEvent.type === "session.updated") {
      syncSessionSummary(streamEvent.session);
    }
    const routing = routeRunStreamEvent(streamEvent, {
      isDisplayed: shouldApplySessionScopedUpdate(sessionId, activeSessionIdRef.current),
      sessionTitle,
    });
    if (routing.toast) pushToast(routing.toast.tone, routing.toast.title, routing.toast.detail);
    if (!routing.updatesSessionView) return;
    if (streamEvent.type === "artifact_review.completed") {
      setArtifactReviews((current) => [
        ...current.filter((item) => item.id !== streamEvent.review.id),
        streamEvent.review,
      ]);
    }
    if (streamEvent.type === "reviewer_checkpoint.updated") {
      setSession((current) => {
        if (!current || current.id !== sessionId) return current;
        const alreadyPresent = current.messages.some((message) => message.id === streamEvent.message.id);
        return {
          ...current,
          messages: alreadyPresent
            ? current.messages.map((message) => message.id === streamEvent.message.id ? streamEvent.message : message)
            : [...current.messages, streamEvent.message],
        };
      });
    }
    if (streamEvent.type === "permission.required" || streamEvent.type === "permission.resolved") {
      setPermissionRequests((current) => {
        const existing = current.find((item) => item.id === streamEvent.request.id);
        const request = existing
          ? mergePermissionRequestSnapshot(existing, streamEvent.request)
          : streamEvent.request;
        return [...current.filter((item) => item.id !== request.id), request];
      });
    }
    if (streamEvent.type === "plan.proposed") {
      setPlans((current) => [...current.filter((item) => item.id !== streamEvent.plan.id), streamEvent.plan]);
    }
    if (streamEvent.type === "subagent.updated") {
      setSubagents((current) => [...current.filter((item) => item.id !== streamEvent.subagent.id), streamEvent.subagent]
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)));
    }
    if (streamEvent.type === "remote_job.proposed") {
      setRemoteJobs((current) => [...current.filter((item) => item.id !== streamEvent.job.id), streamEvent.job]
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)));
    }
    if (streamEvent.type === "run.completed") setFiles(streamEvent.files);
    if (streamEvent.type === "artifact.upserted") {
      setArtifacts((current) => [streamEvent.artifact, ...current.filter((item) => item.id !== streamEvent.artifact.id)]
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
    }
    if (streamEvent.type === "workspace.changed") {
      setFiles(streamEvent.files);
      if (runId) {
        setRunChangedPaths((current) => {
          const forSession = current[sessionId] ?? {};
          const merged = new Set([...(forSession[runId] ?? []), ...streamEvent.changedPaths]);
          return { ...current, [sessionId]: { ...forSession, [runId]: [...merged] } };
        });
      }
    }
    if (streamEvent.type === "run.failed") setError(streamEvent.error);
  }

  async function loadToolOutput(
    sessionId: string,
    runId: string | undefined,
    trace: ToolTrace,
  ): Promise<string | undefined> {
    if (!runId || !trace.outputStream) return undefined;
    const records = await client.listRunStreamEvents(sessionId, runId, trace.outputStream);
    return records
      .flatMap((record) => record.event.type === "tool.output" ? [record.event.chunk] : [])
      .join("") || undefined;
  }

  function resumeSessionRun(
    sessionId: string,
    sessionTitle: string,
    run: SessionRun,
    after: number,
  ): void {
    if (sessionActivity.current.streamCount(sessionId) > 0) return;
    const controller = new AbortController();
    runAbortControllers.current.set(sessionId, controller);
    updateSessionStreamCount(sessionId, 1);
    void client.subscribeRunEvents(
      sessionId,
      run.id,
      after,
      (streamEvent, sequence) => applySessionRunEvent(
        sessionId,
        sessionTitle,
        run.id,
        streamEvent,
        sequence,
      ),
      controller.signal,
    ).then(async () => {
      if (shouldApplySessionScopedUpdate(sessionId, activeSessionIdRef.current)) await refreshSession(sessionId);
    }).catch((reason) => {
      if (!isAbortError(reason) && shouldApplySessionScopedUpdate(sessionId, activeSessionIdRef.current)) {
        setError(reason instanceof Error ? reason.message : "Could not resume run events");
      }
    }).finally(() => {
      if (runAbortControllers.current.get(sessionId) === controller) {
        runAbortControllers.current.delete(sessionId);
      }
      updateSessionStreamCount(sessionId, -1);
    });
  }

  async function submitMessage(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!activeSessionId || !session || !message.trim() || session.archivedAt) return;
    if (message.trim() === "/web-usage") {
      try {
        const usage = await client.getWebUsage();
        pushToast(
          "success",
          "Web usage",
          `${usage.searches} searches · ${usage.fetches} fetches · ${usage.cacheHits} cache hits · ${usage.fallbacks} fallbacks · ${usage.failures} failures`,
        );
        setMessage("");
        setError(undefined);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not load web usage");
      }
      return;
    }
    const submittedSessionId = activeSessionId;
    const selectedModel = models.find((item) => item.id === session.modelId);
    if (!selectedModel) {
      setError("Assign an available model to this task before running it");
      return;
    }
    if (!selectedModel.hasApiToken) {
      setError(`Save an API token for ${selectedModel.name} in Model settings`);
      return;
    }
    const content = message.trim();
    const autoNameFirstMessage = session.title === UNTITLED_SESSION_TITLE
      && !session.messages.some((item) => item.role === "user");
    const titleRefinementStartedAt = Date.now();
    const provisionalTitle = autoNameFirstMessage
      ? createLocalSessionTitle(messageForSessionTitle(content), session.createdAt)
      : session.title;
    const runSessionTitle = provisionalTitle;
    const references = composerReferences.filter((reference) => content.includes(composerReferenceToken(reference)));
    const annotations = [...pendingAnnotations];
    const controller = new AbortController();
    const submittedSessionRuns = sessionRunSnapshots.current.get(submittedSessionId) ?? sessionRuns;
    const queuedBehindActiveRun = Boolean(
      runningSessionIds.has(submittedSessionId)
      || submittedSessionRuns.some((run) => run.sessionId === submittedSessionId && isActiveRunStatus(run.status)),
    );
    if (!queuedBehindActiveRun) runAbortControllers.current.set(submittedSessionId, controller);

    setMessage("");
    setComposerReferences([]);
    setPendingAnnotations([]);
    setError(undefined);
    if (autoNameFirstMessage) {
      syncSessionSummary({ ...session, title: provisionalTitle, updatedAt: new Date().toISOString() });
    }
    if (!queuedBehindActiveRun) {
      // A new run starts this Session's timeline over; other Sessions keep
      // theirs, and a run queued behind an active one keeps the steps the
      // active run is still streaming.
      setRunTimelines((current) => clearSessionTimeline(current, submittedSessionId));
      setTimelineMessageIds((current) => forgetSession(current, submittedSessionId));
    }
    setIsFollowingOutput(true);
    if (!queuedBehindActiveRun) updateSessionStreamCount(submittedSessionId, 1);
    if (!queuedBehindActiveRun) {
      setSession((current) => current ? {
        ...current,
        messages: [...current.messages, {
          content,
          createdAt: new Date().toISOString(),
          id: `optimistic-${Date.now()}`,
          ...(references.length ? { references } : {}),
          ...(annotations.length ? { annotations } : {}),
          role: "user",
        }],
      } : current);
    }

    try {
      let streamRunId: string | undefined;
      await client.streamMessage(submittedSessionId, {
        annotationIds: annotations.map((annotation) => annotation.id),
        content,
        ...(references.length ? { references } : {}),
      }, (streamEvent: RunStreamEvent, sequence: number) => {
        if (streamEvent.type === "run.queued" || streamEvent.type === "run.status") {
          streamRunId = streamEvent.run.id;
        }
        if (streamEvent.type === "run.started") {
          runAbortControllers.current.set(submittedSessionId, controller);
          streamRunId = streamEvent.runId;
        }
        applySessionRunEvent(submittedSessionId, runSessionTitle, streamRunId, streamEvent, sequence);
      }, controller.signal);
      if (shouldApplySessionScopedUpdate(submittedSessionId, activeSessionIdRef.current)) await refreshSession(submittedSessionId);
    } catch (reason) {
      if (!isAbortError(reason) && shouldApplySessionScopedUpdate(submittedSessionId, activeSessionIdRef.current)) {
        setError(reason instanceof Error ? reason.message : "Run failed");
        if (autoNameFirstMessage) {
          void refreshSession(submittedSessionId).catch(() => undefined);
        }
      }
    } finally {
      if (runAbortControllers.current.get(submittedSessionId) === controller) {
        runAbortControllers.current.delete(submittedSessionId);
      }
      if (!queuedBehindActiveRun) updateSessionStreamCount(submittedSessionId, -1);
      if (autoNameFirstMessage) {
        void followSessionTitleRefinement({
          loadSession: (sessionId) => client.getSession(sessionId),
          onUpdate: syncSessionSummary,
          provisionalTitle,
          sessionId: submittedSessionId,
          startedAt: titleRefinementStartedAt,
        });
      }
    }
  }

  async function cancelQueuedRun(run: SessionRun): Promise<void> {
    if (!session || run.status !== "queued" || cancellingQueuedRunIds.has(run.id)) return;
    setCancellingQueuedRunIds((current) => new Set(current).add(run.id));
    try {
      const cancelled = await client.cancelRun(run.sessionId, run.id);
      const nextRuns = upsertSessionRunSnapshot(run.sessionId, cancelled);
      if (shouldApplySessionScopedUpdate(run.sessionId, activeSessionIdRef.current)) setSessionRuns(nextRuns);
      setError(undefined);
      const toast = queuedCancelToast(cancelled.status);
      pushToast(toast.tone, toast.title, toast.detail);
      if (shouldApplySessionScopedUpdate(run.sessionId, activeSessionIdRef.current)) {
        void refreshSession(run.sessionId).catch((reason: Error) => {
          if (shouldApplySessionScopedUpdate(run.sessionId, activeSessionIdRef.current)) setError(reason.message);
        });
      }
    } catch (reason) {
      if (shouldApplySessionScopedUpdate(run.sessionId, activeSessionIdRef.current)) {
        setError(reason instanceof Error ? reason.message : "Could not cancel queued run");
      }
    } finally {
      setCancellingQueuedRunIds((current) => {
        if (!current.has(run.id)) return current;
        const next = new Set(current);
        next.delete(run.id);
        return next;
      });
    }
  }

  async function stopRun(sessionId = activeSessionId): Promise<void> {
    const hasAgentRun = Boolean(sessionId && runningSessionIds.has(sessionId));
    const hasReviewerCheckpoint = Boolean(sessionId === activeSessionId && reviewerCheckpointRunning);
    if (!sessionId || (!hasAgentRun && !hasReviewerCheckpoint) || stoppingSessionIds.has(sessionId)) return;
    setStoppingSessionIds((current) => new Set(current).add(sessionId));
    try {
      await requestRunStop({
        cancelRun: (target) => client.cancelCurrentRun(target),
        controllers: runAbortControllers.current,
        sessionId,
      });
    } finally {
      // A manual Reviewer has no Agent stream to clear this state. Its persisted
      // checkpoint is refreshed separately and will render the cancellation.
      if (!hasAgentRun) {
        setStoppingSessionIds((current) => {
          const next = new Set(current);
          next.delete(sessionId);
          return next;
        });
      }
    }
  }

  async function openWorkspaceFile(file: WorkspaceFile): Promise<void> {
    if (!activeSessionId) return;
    // Source identity comes from this workspace-tree entry, not from preview metadata.
    try {
      await openWorkspacePath(file.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open file");
    }
  }

  function openArtifact(artifact: ScientificArtifact): void {
    if (!activeSessionId) {
      pushToast("info", "Artifact retained", "Create or select a Session to open this Project artifact.");
      return;
    }
    setArtifactModalVersion(undefined);
    setArtifactModalName(artifact.name);
  }

  function changeArtifactSelection(items: readonly ScientificArtifact[], selected: boolean): void {
    setSelectedArtifactIds((current) => {
      const next = new Set(current);
      for (const item of items) {
        if (selected) next.add(item.id);
        else next.delete(item.id);
      }
      return next;
    });
  }

  function exitArtifactSelection(): void {
    setArtifactSelectionMode(false);
    setSelectedArtifactIds(new Set());
  }

  function changeWorkspaceFileSelection(items: readonly WorkspaceFile[], selected: boolean): void {
    setSelectedWorkspaceFilePaths((current) => {
      const next = new Set(current);
      for (const item of items) {
        if (selected) next.add(item.path);
        else next.delete(item.path);
      }
      return next;
    });
  }

  function exitWorkspaceFileSelection(): void {
    setWorkspaceFileSelectionMode(false);
    setSelectedWorkspaceFilePaths(new Set());
  }

  async function downloadSelectedArtifacts(): Promise<void> {
    if (!activeProjectId || artifactArchiveBusy) return;
    const selected = artifacts.filter((artifact) => selectedArtifactIds.has(artifact.id));
    const countLimitError = artifactArchiveLimitError(selected.length, 0);
    if (!selected.length || countLimitError) {
      if (countLimitError) pushToast("error", t("artifact.archiveFailed"), countLimitError);
      return;
    }

    setArtifactArchiveBusy(true);
    try {
      const metadataResults = await Promise.allSettled(selected.map(async (artifact) => {
        const name = normalizeArtifactArchivePath(artifact.name);
        const versions = await client.listProjectArtifactVersions(activeProjectId, artifact.id);
        const version = versions.find((item) => item.version === artifact.currentVersion) ?? versions.at(-1);
        if (!version) throw new Error("Artifact has no version");
        return { artifact, name, version };
      }));
      const metadata = metadataResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      let skipped = metadataResults.length - metadata.length;
      const archiveNames = new Set<string>();
      const uniqueMetadata = metadata.filter((item) => {
        if (archiveNames.has(item.name)) {
          skipped += 1;
          return false;
        }
        archiveNames.add(item.name);
        return true;
      });
      const sizeLimitError = artifactArchiveLimitError(
        selected.length,
        uniqueMetadata.reduce((total, item) => total + item.version.content.size, 0),
      );
      if (sizeLimitError) {
        pushToast("error", t("artifact.archiveFailed"), sizeLimitError);
        return;
      }

      const contentResults = await Promise.allSettled(uniqueMetadata.map(async ({ name, version }) => {
        const blob = await client.readProjectArtifactVersion(activeProjectId, version.id);
        return { content: new Uint8Array(await blob.arrayBuffer()), name };
      }));
      const entries = contentResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      skipped += contentResults.length - entries.length;
      if (!entries.length) {
        pushToast("error", t("artifact.archiveFailed"), t("artifact.archiveSkipped", { count: skipped }));
        return;
      }
      const contentSizeLimitError = artifactArchiveLimitError(
        entries.length,
        entries.reduce((total, entry) => total + entry.content.byteLength, 0),
      );
      if (contentSizeLimitError) {
        pushToast("error", t("artifact.archiveFailed"), contentSizeLimitError);
        return;
      }

      const archive = await createArtifactArchive(entries);
      downloadBlob(artifactArchiveBlob(archive), "artifacts.zip");
      if (skipped) pushToast("info", t("artifact.archiveReady"), t("artifact.archiveSkipped", { count: skipped }));
      else pushToast("success", t("artifact.archiveReady"), t("app.selectedArtifacts", { count: entries.length }));
    } catch (reason) {
      pushToast("error", t("artifact.archiveFailed"), reason instanceof Error ? reason.message : undefined);
    } finally {
      setArtifactArchiveBusy(false);
    }
  }

  async function openGlobalSearch(): Promise<void> {
    setGlobalSearchOpen(true);
    setGlobalSearchQuery("");
    try {
      setWorkbenchIndex(await client.searchWorkbench());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not search the workbench");
    }
  }

  function openUsageView(): void {
    setWorkspaceView("usage");
  }

  // Usage data follows the view: opening the Usage page from the sidebar, from
  // a URL (`/usage`) or via back/forward all load through this one effect.
  useEffect(() => {
    if (workspaceView !== "usage") return;
    let active = true;
    void client.getGlobalModelUsage().then((usage) => {
      if (!active) return;
      setGlobalUsage(usage);
      setError(undefined);
    }).catch((reason: Error) => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not load model usage");
    });
    return () => { active = false; };
  }, [client, workspaceView]);

  async function openSessionFromUsage(sessionId: string): Promise<void> {
    const match = workbenchIndex.find((item) => item.sessionId === sessionId)
      ?? (await client.searchWorkbench()).find((item) => item.sessionId === sessionId);
    setWorkspaceView("session");
    if (!match?.projectId) {
      setActiveSessionId(sessionId);
      await refreshSession(sessionId);
      return;
    }
    setActiveProjectId(match.projectId);
    setSessionListState("all");
    try {
      const items = await client.listSessions(match.projectId, "all");
      setSessions(items);
      setActiveSessionId(sessionId);
      await refreshSession(sessionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open Session from usage");
    }
  }

  async function navigateToSearchResult(result: WorkbenchSearchResult): Promise<void> {
    setGlobalSearchOpen(false);
    setWorkspaceView("session");
    setActiveProjectId(result.projectId);
    if (result.kind === "project") return;
    setSessionListState("all");
    try {
      const items = await client.listSessions(result.projectId, "all");
      setSessions(items);
      const targetSessionId = result.sessionId && items.some((item) => item.id === result.sessionId)
        ? result.sessionId
        : items[0]?.id;
      setActiveSessionId(targetSessionId);
      if (result.kind === "artifact" && result.path) {
        setArtifactModalVersion(undefined);
        setArtifactModalName(result.path);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open search result");
    }
  }

  function selectComposerSuggestion(suggestion: ComposerSuggestion): void {
    const cursor = composerTextarea.current?.selectionStart ?? message.length;
    const trigger = getComposerTrigger(message, cursor);
    if (!trigger) return;
    setMessage(insertComposerReference(message, trigger, suggestion.reference, cursor));
    setComposerReferences((current) => current.some((reference) =>
      reference.kind === suggestion.reference.kind && reference.id === suggestion.reference.id)
      ? current
      : [...current, suggestion.reference]);
    requestAnimationFrame(() => composerTextarea.current?.focus());
  }

  function removeComposerReference(reference: ComposerReference): void {
    const token = composerReferenceToken(reference);
    setComposerReferences((current) => current.filter((candidate) =>
      candidate.kind !== reference.kind || candidate.id !== reference.id));
    setMessage((current) => current.replace(`${token} `, "").replace(token, ""));
  }

  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeModel = models.find((item) => item.id === session?.modelId);
  const visionModels = models.filter((item) => item.vision);
  const latestExecution = executionRuns.at(-1);
  const latestEnvironmentRevision = environmentRevisions.find((revision) => revision.id === latestExecution?.environmentRevisionId);
  const latestEnvironment = environments.find((environment) => environment.id === latestEnvironmentRevision?.environmentId);
  const sessionUsageBreakdown = sessionUsage
    ? usageInOutLabel(sessionUsage.totals)
    : "";
  const runUsageByRunId = useMemo(() => {
    const byRun = new Map<string, { bucket: ModelUsageBucket; runId: string }>();
    if (!sessionUsage) return byRun;
    for (const bucket of sessionUsage.byRun) {
      byRun.set(bucket.key, { bucket, runId: bucket.key });
    }
    return byRun;
  }, [sessionUsage]);
  const messageUsageByMessageId = useMemo(() => {
    const byMessage = new Map<string, { bucket: ModelUsageBucket; runId: string }>();
    for (const run of sessionRuns) {
      if (!run.assistantMessageId) continue;
      const usage = runUsageByRunId.get(run.id);
      if (usage) byMessage.set(run.assistantMessageId, usage);
    }
    return byMessage;
  }, [runUsageByRunId, sessionRuns]);
  const displayedMessages = session?.messages.filter((item) => item.id !== timelineMessageId) ?? [];
  const sessionReplayTimelines = (session?.id ? replayTimelines[session.id] : undefined) ?? {};
  const activeTimelineRunId = session?.id ? runTimelines[session.id]?.runId : undefined;
  const replayedRunIds = new Set(Object.keys(sessionReplayTimelines).filter((runId) => runId !== activeTimelineRunId));
  const conversationBlocks = buildConversationBlocks(displayedMessages, sessionRuns, replayedRunIds);
  const timelinePermissionRequestIds = collectTimelinePermissionRequestIds([
    ...runTimeline,
    ...Object.values(sessionReplayTimelines).flatMap((timeline) => timeline.entries),
  ]);
  const queuedRuns = sessionRuns.filter((run) => run.status === "queued");
  // Activity cards (plans, subagents, remote jobs, permission prompts, result
  // previews) are attributed to the run that produced them and rendered right
  // after that run's conversation block instead of piling up below the whole
  // flow. The run currently streaming or replaying keeps its cards right
  // after its timeline, which is already the chronological end of the flow.
  const runActivityGroups = groupRunActivity(sessionRuns, {
    downloadCandidates,
    downloadJobs,
    downloadPlans,
    permissionRequests: permissionRequests.filter((request) => !timelinePermissionRequestIds.has(request.id)),
    plans,
    previewFiles: files.filter(isArtifactPreviewFile),
    remoteJobs,
    subagents,
  }, session?.id ? runChangedPaths[session.id] ?? {} : {}, mcpInvocations);
  const displayedMessageIds = new Set(displayedMessages.map((item) => item.id));
  const activityGroupsByTimelineRun = new Map<string, RunActivityGroup[]>();
  const activityGroupsByMessage = new Map<string, RunActivityGroup[]>();
  const tailActivityGroups: RunActivityGroup[] = [];
  for (const group of runActivityGroups) {
    if (group.runId && group.runId === activeTimelineRunId) {
      tailActivityGroups.push(group);
    } else if (group.runId && replayedRunIds.has(group.runId)) {
      const anchored = activityGroupsByTimelineRun.get(group.runId) ?? [];
      anchored.push(group);
      activityGroupsByTimelineRun.set(group.runId, anchored);
    } else if (group.anchorMessageId && displayedMessageIds.has(group.anchorMessageId)) {
      const anchored = activityGroupsByMessage.get(group.anchorMessageId) ?? [];
      anchored.push(group);
      activityGroupsByMessage.set(group.anchorMessageId, anchored);
    } else {
      // Historical items without a usable anchor degrade to the tail.
      tailActivityGroups.push(group);
    }
  }
  const sessionArchived = Boolean(session?.archivedAt);
  const sessionPending = Boolean(activeSessionId) && session?.id !== activeSessionId;
  const artifactGroups = [...artifacts.reduce((groups, artifact) => {
    const liveSession = artifactSessions.find((item) => item.id === artifact.createdInSessionId);
    const key = liveSession?.id ?? "deleted";
    const group = groups.get(key) ?? {
      id: key,
      items: [] as ScientificArtifact[],
      label: liveSession?.title ?? t("app.deletedSession"),
    };
    group.items.push(artifact);
    groups.set(key, group);
    return groups;
  }, new Map<string, { id: string; items: ScientificArtifact[]; label: string }>()).values()];
  const visibleProjects = getVisibleProjects(projects, activeProjectId, projectsExpanded);
  const activeProjectLabel = activeProject
    ? resourceLabelWithDraft(renameTarget, renameDraft, "project", activeProject.id, activeProject.name)
    : "Workspace";
  const activeSessionLabel = session
    ? resourceLabelWithDraft(renameTarget, renameDraft, "session", session.id, session.title)
    : "Start a research session";
  const mainProjectRenameTarget = activeProject
    && renameTarget?.kind === "project"
    && renameTarget.id === activeProject.id
    && renameTarget.location === "main"
    ? renameTarget
    : undefined;
  const mainSessionRenameTarget = session
    && renameTarget?.kind === "session"
    && renameTarget.id === session.id
    && renameTarget.location === "main"
    ? renameTarget
    : undefined;
  const composerRunAction = resolveComposerRunAction({
    activeSessionId,
    hasModel: Boolean(activeModel),
    message,
    modelsAvailable: models.length > 0,
    reviewerCheckpointRunning,
    runningSessionIds,
    sessionArchived,
    stoppingSessionIds,
  });
  const composerTrigger = getComposerTrigger(message, composerTextarea.current?.selectionStart ?? message.length);
  const composerSuggestions: ComposerSuggestion[] = !composerTrigger ? [] : composerTrigger.symbol === "@"
    ? artifacts.map((artifact) => ({
      detail: `${artifact.kind} · ${artifact.origin} · v${artifact.currentVersion}`,
      reference: {
        createdInSessionTitle: artifact.createdInSessionTitle,
        id: artifact.id,
        kind: "artifact",
        label: artifact.name,
        origin: artifact.origin,
        path: artifact.name,
        projectId: artifact.projectId,
        sessionId: artifact.createdInSessionId,
      },
    }))
    : composerTrigger.symbol === "#"
      ? workbenchIndex.filter((result) => result.kind === "session" && result.sessionId).map((result) => ({
        detail: result.detail,
        reference: {
          id: result.sessionId!,
          kind: "session",
          label: result.label,
          projectId: result.projectId,
          sessionId: result.sessionId,
        },
      }))
      : composerSkillSuggestions(skills, session?.enabledSkillIds);
  const sidebarResourceClass = !activeProject
    ? "sidebar-resources"
    : projectsExpanded && sessionsExpanded
      ? "sidebar-resources both-expanded"
      : projectsExpanded
        ? "sidebar-resources projects-expanded"
        : sessionsExpanded
          ? "sidebar-resources sessions-expanded"
          : "sidebar-resources both-collapsed";

  function toggleActivityCard(id: string, expanded: boolean): void {
    setActivityCardExpansion((current) => setActivityCardExpanded(current, id, expanded));
  }

  function resizeWorkspace(value: number): void {
    const maxWidth = measureWorkspaceMaxWidth();
    setWorkspaceMaxWidth(maxWidth);
    setWorkspaceWidth(clampWorkspaceWidth(value, maxWidth));
  }

  async function prepareGovernedDownload(item: GovernedDownloadCandidate): Promise<void> {
    if (!session) return;
    try {
      await client.createMcpArtifactPlan(session.id, {
        candidateId: item.candidate.id,
        destination: { path: `downloads/${item.candidate.logicalName}`, type: "workspace" },
        mcpInvocationId: item.invocationId,
      });
      await refreshGovernedDownloads(session.id);
    } catch (error) {
      reportError(error instanceof Error ? error.message : "Could not prepare artifact download");
    }
  }

  async function actOnGovernedDownload(job: ArtifactJob, action: "cancel" | "retry"): Promise<void> {
    if (!session) return;
    try {
      if (action === "cancel") await client.cancelMcpArtifactJob(session.id, job.id);
      else await client.retryMcpArtifactJob(session.id, job.id);
      await refreshGovernedDownloads(session.id);
    } catch (error) {
      reportError(error instanceof Error ? error.message : `Could not ${action} artifact job`);
    }
  }

  function renderRunActivityGroup(group: RunActivityGroup) {
    if (!session) return null;
    const artifactCardId = activityCardId("artifacts", group.runId ?? "unattributed");
    return (
      <div className="run-activity-group" key={group.runId ?? "unattributed"}>
        <OrchestrationPanel expandedCards={activityCardExpansion} onToggleCard={toggleActivityCard} plans={group.plans} />
        <SubagentCards expandedCards={activityCardExpansion} onToggleCard={toggleActivityCard} specialists={specialists} subagents={group.subagents} />
        <PermissionCards expandedCards={activityCardExpansion} onDecision={decidePermission} onToggleCard={toggleActivityCard} requests={group.permissionRequests} />
        <RemoteJobsPanel busy={lifecycleBusy} expandedCards={activityCardExpansion} jobs={group.remoteJobs} onDecision={(job, decision) => void decideRemoteJob(job, decision)} onRefresh={(job) => void refreshRemoteJob(job)} onToggleCard={toggleActivityCard} />
        <GovernedDownloadCards
          candidates={group.downloadCandidates}
          expandedCards={activityCardExpansion}
          groupId={group.runId ?? "unattributed"}
          jobs={group.downloadJobs}
          onAction={actOnGovernedDownload}
          onPrepare={prepareGovernedDownload}
          onToggleCard={toggleActivityCard}
          plans={group.downloadPlans}
        />
        <ArtifactPreview client={client} expanded={Boolean(activityCardExpansion[artifactCardId])} files={group.previewFiles} onChipClick={handleChipClick} onToggle={(expanded) => toggleActivityCard(artifactCardId, expanded)} sessionId={session.id} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><BrandIcon size={24} /></div>
          <div><strong>ScienceDiscovery</strong><span>{t("app.localRuntime")}</span></div>
        </div>

        <div className={sidebarResourceClass} style={{ "--sidebar-split": `${sidebarSplit}%` } as CSSProperties}>
          <div className={projectsExpanded ? "sidebar-section projects" : "sidebar-section projects collapsed"}>
            <SidebarSectionHeader
              addLabel={t("sidebar.addProject")}
              count={projects.length}
              expanded={projectsExpanded}
              label={t("sidebar.projects")}
              onAdd={() => { setProjectsExpanded(true); setProjectCreationOpen(true); }}
              onToggle={() => { setOpenProjectMenuId(undefined); setProjectsExpanded((current) => !current); }}
              panelId="projects-panel-content"
            />
            <div className="sidebar-panel-content" id="projects-panel-content">
              <div className="nav-list">
              {!projectsLoaded ? <SkeletonRows className="nav-skeleton" count={3} /> : visibleProjects.map((project) => {
                const target = { id: project.id, kind: "project" as const, label: project.name };
                const inlineTarget = renameTarget?.kind === "project"
                  && renameTarget.id === project.id
                  && renameTarget.location === "sidebar"
                  ? renameTarget
                  : undefined;
                const label = resourceLabelWithDraft(renameTarget, renameDraft, "project", project.id, project.name);
                return <div className="nav-resource" key={project.id}>
                  {inlineTarget ? <div className={project.id === activeProjectId ? "nav-item nav-item-inline-editor active" : "nav-item nav-item-inline-editor"}>
                    <span className="nav-icon"><ProjectIcon size={16} /></span>
                    <InlineRenameInput
                      ariaLabel={`Rename Project ${project.name}`}
                      className="nav-inline-rename"
                      disabled={renameSavingKeys.has(resourceTargetKey(inlineTarget))}
                      onChange={setRenameDraft}
                      onCommit={(value) => void commitInlineRename(inlineTarget, value)}
                      value={renameDraft}
                    />
                  </div> : <button
                    className={project.id === activeProjectId ? "nav-item active" : "nav-item"}
                    onClick={() => {
                      setActiveProjectId(project.id);
                      setOpenProjectMenuId(undefined);
                      setOpenSessionMenuId(undefined);
                      setSessionFilterOpen(false);
                    }}
                    onDoubleClick={() => beginInlineRename(target, "sidebar")}
                    title={`${project.name} · Double-click to rename Project`}
                    type="button"
                  >
                    <span className="nav-icon"><ProjectIcon size={16} /></span><span title={project.name}>{label}</span>
                  </button>}
                  <ProjectOverflowMenu
                    label={label}
                    onDelete={() => { setOpenProjectMenuId(undefined); void openDeletion({ id: project.id, kind: "project", label: project.name }); }}
                    onRename={() => { setOpenProjectMenuId(undefined); beginInlineRename(target, "sidebar"); }}
                    onSettings={() => { setOpenProjectMenuId(undefined); void openScopedSettings({ id: project.id, kind: "project", label: project.name }); }}
                    onToggle={() => {
                      setOpenSessionMenuId(undefined);
                      setSessionFilterOpen(false);
                      setOpenProjectMenuId((current) => current === project.id ? undefined : project.id);
                    }}
                    open={openProjectMenuId === project.id}
                    projectId={project.id}
                  />
                </div>
              })}
              </div>
            </div>
          </div>
          {activeProject ? <>
            <SidebarPanelResizer
              onChange={setSidebarSplit}
              onResizeEnd={() => setSidebarResizing(false)}
              onResizeStart={() => { setProjectsExpanded(true); setSessionsExpanded(true); setSidebarResizing(true); }}
              resizing={sidebarResizing}
              value={sidebarSplit}
            />
            <div className={sessionsExpanded ? "sidebar-section sessions" : "sidebar-section sessions collapsed"}>
              <SidebarSectionHeader
                addDisabled={sessionCreationPending}
                addLabel={t("sidebar.addSession")}
                count={sessions.length}
                expanded={sessionsExpanded}
                headerAction={<SessionFilterMenu
                  onChange={(state) => { setSessionListState(state); setSessionFilterOpen(false); setSessionsExpanded(true); }}
                  onToggle={() => {
                    setOpenProjectMenuId(undefined);
                    setOpenSessionMenuId(undefined);
                    setSessionFilterOpen((current) => !current);
                  }}
                  open={sessionFilterOpen}
                  value={sessionListState}
                />}
                label={t("sidebar.sessions")}
                onAdd={() => {
                  setSessionsExpanded(true);
                  setOpenProjectMenuId(undefined);
                  setOpenSessionMenuId(undefined);
                  setSessionFilterOpen(false);
                  void createSession();
                }}
                onToggle={() => { setOpenSessionMenuId(undefined); setSessionsExpanded((current) => !current); }}
                panelId="sessions-panel-content"
              />
              {sessionsExpanded ? <div className="sidebar-panel-content" id="sessions-panel-content">
              <div className="nav-list">
                {!sessionsLoaded ? <SkeletonRows className="nav-skeleton" count={4} /> : sessions.map((item) => {
                  const target = { id: item.id, kind: "session" as const, label: item.title };
                  const inlineTarget = renameTarget?.kind === "session"
                    && renameTarget.id === item.id
                    && renameTarget.location === "sidebar"
                    ? renameTarget
                    : undefined;
                  const label = resourceLabelWithDraft(renameTarget, renameDraft, "session", item.id, item.title);
                  return <div className="nav-resource" key={item.id}>
                    {inlineTarget && !item.archivedAt ? <div className={item.id === activeSessionId ? "nav-item nav-item-inline-editor active" : "nav-item nav-item-inline-editor"}>
                      <span className="nav-icon"><SessionIcon size={15} /></span>
                      <InlineRenameInput
                        ariaLabel={`Rename Session ${item.title}`}
                        className="nav-inline-rename"
                        disabled={renameSavingKeys.has(resourceTargetKey(inlineTarget))}
                        onChange={setRenameDraft}
                        onCommit={(value) => void commitInlineRename(inlineTarget, value)}
                        value={renameDraft}
                      />
                    </div> : <button
                      className={item.id === activeSessionId ? "nav-item active" : "nav-item"}
                      onClick={() => { setWorkspaceView("session"); setActiveSessionId(item.id); setOpenSessionMenuId(undefined); }}
                      onDoubleClick={() => { if (!item.archivedAt) beginInlineRename(target, "sidebar"); }}
                      title={`${item.title}${item.archivedAt ? " · Archived" : " · Double-click to rename Session"}`}
                      type="button"
                    >
                      <span className="nav-icon">{item.archivedAt ? <ArchiveIcon size={15} /> : <SessionIcon size={15} />}</span><span title={`${item.title}${item.archivedAt ? " · Archived" : ""}`}>{label}{item.archivedAt ? " · Archived" : ""}</span>
                    </button>}
                    <SessionOverflowMenu
                      archived={Boolean(item.archivedAt)}
                      busy={runningSessionIds.has(item.id) || lifecycleBusy}
                      label={label}
                      onArchive={() => { setOpenSessionMenuId(undefined); void changeSessionArchiveState("archive", item.id); }}
                      onDelete={() => { setOpenSessionMenuId(undefined); void openDeletion({ id: item.id, kind: "session", label: item.title }); }}
                      onRename={() => { setOpenSessionMenuId(undefined); beginInlineRename(target, "sidebar"); }}
                      onRestore={() => { setOpenSessionMenuId(undefined); void changeSessionArchiveState("restore", item.id); }}
                      onSettings={() => { setOpenSessionMenuId(undefined); void openScopedSettings({ id: item.id, kind: "session", label: item.title }); }}
                      onToggle={() => {
                        setOpenProjectMenuId(undefined);
                        setSessionFilterOpen(false);
                        setOpenSessionMenuId((current) => current === item.id ? undefined : item.id);
                      }}
                      open={openSessionMenuId === item.id}
                      sessionId={item.id}
                    />
                  </div>
                })}
              </div>
              </div> : null}
            </div>
          </> : null}
        </div>

        <div className="sidebar-quick-actions" aria-label="Workbench navigation">
          <button type="button" onClick={() => void openGlobalSearch()}><span><SearchIcon size={16} /></span><span>{t("app.search")}</span><kbd>Ctrl K</kbd></button>
          <button type="button" className={workspaceView === "usage" ? "active" : undefined} onClick={() => void openUsageView()}><span><SparkleIcon size={16} /></span><span>{t("app.usage")}</span></button>
          <button type="button" disabled={!activeProjectId} onClick={() => { setWorkspaceView("session"); if (workspaceCollapsed) setWorkspaceCollapsed(false); else workspacePanel.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}><span><FileIcon size={16} /></span><span>{t("app.files")}</span><i>{artifacts.length}</i></button>
        </div>
        <button className="settings-button" onClick={() => { if (showConfig) cancelSystemSettings(); else openSystemSettings(); }}>
          <span><SettingsIcon size={17} /></span><span>{t("app.systemConfiguration")}</span><span className="mode-chip">{models.length}</span>
        </button>
      </aside>

      <main className="main-area">
        {workspaceView === "usage" ? (
          <UsagePage summary={globalUsage} onOpenSession={(sessionId) => void openSessionFromUsage(sessionId)} />
        ) : (
          <>
        {sessionArchived ? <div className="archived-banner"><strong>Archived Session</strong><span>Historical messages, files, and audit records remain available. Restore this Session to make changes or start a run.</span></div> : null}

        <div className={workspaceCollapsed ? "content-grid workspace-collapsed" : "content-grid"} style={workspaceCollapsed ? undefined : { gridTemplateColumns: `minmax(0, 1fr) ${workspaceWidth}px` }}>
          <section className="conversation">
            {activeProject || session ? <div className="session-bar">
              <div className="session-bar-title">
                {mainProjectRenameTarget ? <InlineRenameInput
                  ariaLabel={`Rename Project ${mainProjectRenameTarget.label}`}
                  className="session-bar-project-rename"
                  disabled={renameSavingKeys.has(resourceTargetKey(mainProjectRenameTarget))}
                  onChange={setRenameDraft}
                  onCommit={(value) => void commitInlineRename(mainProjectRenameTarget, value)}
                  value={renameDraft}
                /> : activeProject ? <button
                  className="session-bar-project"
                  onDoubleClick={() => beginInlineRename({ id: activeProject.id, kind: "project", label: activeProject.name }, "main")}
                  title="Double-click to rename Project"
                  type="button"
                >{activeProjectLabel}</button> : <span className="session-bar-project">{activeProjectLabel}</span>}
                {session ? <span aria-hidden="true" className="session-bar-sep">›</span> : null}
                {mainSessionRenameTarget ? <InlineRenameInput
                  ariaLabel={`Rename Session ${mainSessionRenameTarget.label}`}
                  className="session-bar-session-rename"
                  disabled={renameSavingKeys.has(resourceTargetKey(mainSessionRenameTarget))}
                  onChange={setRenameDraft}
                  onCommit={(value) => void commitInlineRename(mainSessionRenameTarget, value)}
                  size={inlineRenameInputColumns(renameDraft)}
                  value={renameDraft}
                /> : session ? (
                  <h1 className="session-bar-session">{!session.archivedAt ? (
                    <button
                      className="session-bar-session-title"
                      onClick={() => {
                        beginInlineRename({ id: session.id, kind: "session", label: session.title }, "main");
                      }}
                      title="Rename session"
                      type="button"
                    ><span>{activeSessionLabel}</span><EditIcon size={13} /></button>
                  ) : <span>{activeSessionLabel}</span>}</h1>
                ) : null}
              </div>
              <div className="session-bar-meta">
                {session ? (
                  <SessionUsageChip
                    breakdown={sessionUsageBreakdown}
                    sessionTokens={sessionUsage?.totals.totalTokens}
                  />
                ) : null}
                <span className={error ? "connection bad" : "connection"} title={error ? `Needs attention: ${error}` : "Local API connected"}><i />{error ? "Needs attention" : null}</span>
              </div>
            </div> : null}
            {sessionPending ? (
              <div className="messages"><SkeletonRows className="message-skeleton" count={3} /></div>
            ) : !session ? (
              <div className="empty-state">
                <div className="empty-orbit"><BrandIcon size={30} /></div>
                <span className="eyebrow">{t("empty.eyebrow")}</span>
                <h2>{t("empty.title")}</h2>
                <p>{t("empty.description")}</p>
                <ol className="empty-steps">
                  <li><span className="empty-step-icon"><SettingsIcon size={16} /></span><div><strong>{t("empty.configureModel")}</strong><small>{t("empty.configureModelHelp")}</small></div></li>
                  <li><span className="empty-step-icon"><ProjectIcon size={16} /></span><div><strong>{t("empty.createProject")}</strong><small>{t("empty.createProjectHelp")}</small></div></li>
                  <li><span className="empty-step-icon"><UploadIcon size={16} /></span><div><strong>{t("empty.dropCsv")}</strong><small>{t("empty.dropCsvHelp")}</small></div></li>
                </ol>
              </div>
            ) : (
              <>
                <div className="messages" ref={messagesViewport} onScroll={handleMessagesScroll}>
                  {session.messages.length === 0 ? (
                    <div className="session-intro">
                      <span className="eyebrow">{t("empty.sessionReady")}</span>
                      <h2>{t("empty.investigate")}</h2>
                      <p>{session.enabledConnectorIds.includes("pubmed") && session.enabledConnectorIds.includes("uniprot")
                        ? "Try “Research human TP53 and create a cited evidence brief.”"
                        : t("empty.sessionCsvHelp")}</p>
                    </div>
                  ) : null}
                  {conversationBlocks.map((block) => block.kind === "message" ? (
                    <Fragment key={block.message.id}>
                      {block.message.kind === "reviewer_checkpoint" && block.message.reviewerCheckpoint ? (
                        <ReviewerPanel
                          checkpointError={block.message.reviewerCheckpoint.error}
                          checkpointProgress={block.message.reviewerCheckpoint.progress}
                          checkpointStatus={block.message.reviewerCheckpoint.status}
                          reviewLevel={reviewerSpecialistSettings?.level}
                          reviews={artifactReviews}
                          toolCallId={block.message.reviewerCheckpoint.toolCallId}
                        />
                      ) : (
                        <article className={`message ${block.message.role}${block.message.kind === "review_notice" ? " review-notice" : block.message.kind === "timeout_notice" ? " timeout-notice" : ""}`}>
                          <div className="avatar">{block.message.role === "user" ? "You" : block.message.kind === "review_notice" ? <CheckIcon size={16} /> : <BrandIcon size={19} />}</div>
                          <div><span className="message-role">{block.message.role === "user" ? "Researcher" : block.message.kind === "review_notice" ? "Reviewer notice" : "ScienceDiscovery"}{block.message.modelName ? ` · ${block.message.modelName}` : ""}</span><MarkdownRenderer
                            className="message-content"
                            content={block.message.content}
                            loadWorkspaceImage={block.message.role === "assistant" ? loadMarkdownImage : undefined}
                            onChipClick={block.message.role === "assistant" ? handleChipClick : undefined}
                            onOpenArtifacts={block.message.role === "assistant" ? openMarkdownImageArtifacts : undefined}
                            references={block.message.role === "assistant" ? block.message.references : undefined}
                            workspaceSessionId={block.message.role === "assistant" ? session.id : undefined}
                          /></div>
                          <RunUsageInline run={messageUsageByMessageId.get(block.message.id)} />
                          {block.message.role === "assistant" && block.message.kind !== "review_notice" ? <CopyButton className="message-copy" getText={() => block.message.content} label="Copy message as Markdown" /> : null}
                        </article>
                      )}
                      {(activityGroupsByMessage.get(block.message.id) ?? []).map((group) => renderRunActivityGroup(group))}
                    </Fragment>
                  ) : (
                    <Fragment key={`run-${block.runId}`}>
                      <RunTimeline
                        artifactReviews={artifactReviews}
                        entries={sessionReplayTimelines[block.runId]?.entries ?? EMPTY_TIMELINE}
                        isRunning={false}
                        loadWorkspaceImage={loadMarkdownImage}
                        modelName={activeModel?.name}
                        onChipClick={handleChipClick}
                        onLoadToolOutput={(trace) => loadToolOutput(session.id, block.runId, trace)}
                        onOpenArtifacts={openMarkdownImageArtifacts}
                        references={reportReferences}
                        onToggle={(id, expanded) => setReplayTimelines((current) => {
                          const forSession = current[session.id] ?? {};
                          const timeline = forSession[block.runId];
                          if (!timeline) return current;
                          return {
                            ...current,
                            [session.id]: {
                              ...forSession,
                              [block.runId]: { ...timeline, entries: setTimelineEntryExpanded(timeline.entries, id, expanded) },
                            },
                          };
                        })}
                        reviewerLevel={reviewerSpecialistSettings?.level}
                        workspaceSessionId={session.id}
                      />
                      <RunUsageInline run={runUsageByRunId.get(block.runId)} />
                      {(activityGroupsByTimelineRun.get(block.runId) ?? []).map((group) => renderRunActivityGroup(group))}
                    </Fragment>
                  ))}
                  <RunTimeline
                    artifactReviews={artifactReviews}
                    entries={runTimeline}
                    isRunning={isRunning}
                    loadWorkspaceImage={loadMarkdownImage}
                    modelName={activeModel?.name}
                    onChipClick={handleChipClick}
                    onLoadToolOutput={(trace) => loadToolOutput(session.id, runTimelines[session.id]?.runId, trace)}
                    onOpenArtifacts={openMarkdownImageArtifacts}
                    onPermissionDecision={decidePermission}
                    references={reportReferences}
                    onToggle={(id, expanded) => setRunTimelines((current) => ({
                      ...current,
                      [session.id]: {
                        entries: setTimelineEntryExpanded(
                          current[session.id]?.entries ?? EMPTY_TIMELINE,
                          id,
                          expanded,
                        ),
                        lastSequence: current[session.id]?.lastSequence ?? 0,
                        ...(current[session.id]?.runId ? { runId: current[session.id]!.runId } : {}),
                      },
                    }))}
                    reviewerLevel={reviewerSpecialistSettings?.level}
                    workspaceSessionId={session.id}
                  />
                  <RunUsageInline run={activeTimelineRunId ? runUsageByRunId.get(activeTimelineRunId) : undefined} />
                  {tailActivityGroups.map((group) => renderRunActivityGroup(group))}
                  <QueuedRunsPanel cancellingRunIds={cancellingQueuedRunIds} onCancel={(run) => void cancelQueuedRun(run)} runs={queuedRuns} />
                  {!isFollowingOutput ? <div className="follow-output-dock"><button className="follow-output-button" type="button" onClick={scrollToLatest}>Latest activity <ChevronDownIcon size={15} /></button></div> : null}
                </div>
                <form className={isRunning ? "composer composer-compact" : "composer"} onSubmit={(event) => void submitMessage(event)}>
                  {composerTrigger ? <ComposerReferenceMenu trigger={composerTrigger} suggestions={composerSuggestions} onSelect={selectComposerSuggestion} /> : null}
                  <ComposerReferenceChips references={composerReferences} onRemove={removeComposerReference} />
                  {pendingAnnotations.length ? <div className="annotation-chips">{pendingAnnotations.map((annotation) => <button key={annotation.id} onClick={() => setPendingAnnotations((current) => current.filter((item) => item.id !== annotation.id))} title={`Remove annotation: ${annotation.artifactLogicalName}: ${annotation.note}`} type="button"><TargetIcon size={12} /> {annotation.artifactLogicalName}: {annotation.note} <CloseIcon size={12} /></button>)}</div> : null}
                  <textarea ref={composerTextarea} disabled={sessionArchived} value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                    if (composerTrigger) return;
                    event.preventDefault();
                    if (!message.trim() || sessionArchived || !activeModel) return;
                    event.currentTarget.form?.requestSubmit();
                  }} placeholder={sessionArchived ? t("composer.restorePlaceholder") : artifacts.length ? t("composer.askPlaceholder") : t("composer.uploadPlaceholder")} rows={1} />
                  {composerRunAction.noModelReason ? <ComposerNoModelNotice
                    onOpenModelSettings={() => openSystemSettings("models")}
                    reason={composerRunAction.noModelReason}
                  /> : null}
                  <div className="composer-footer">
                    <label className="task-model-picker">
                      <span><i className="live-dot" />{t("composer.taskModel")}</span>
                      <select value={session.modelId ?? ""} onChange={(event) => void updateSessionSettings({ modelId: event.target.value })} disabled={isRunning || sessionArchived || !models.length} aria-label={t("composer.modelAria")}>
                        {!session.modelId ? <option value="">{t("composer.noModel")}</option> : null}
                        {models.map((item) => <option key={item.id} value={item.id}>{modelOptionLabel(item, models)}</option>)}
                      </select>
                    </label>
                    <span className="composer-hint" title={t("composer.keyboardHint")}>{t("composer.keyboardHint")}</span>
                    <div className="orchestration-controls">
                      <ConnectorPicker
                        connectors={connectors}
                        disabled={isRunning || sessionArchived}
                        enabledIds={session.enabledConnectorIds}
                        onToggle={toggleConnector}
                      />
                      <label><span>{t("composer.approvals")}</span><select value={session.approvalMode} disabled={sessionArchived} onChange={(event) => void updateSessionSettings({ approvalMode: event.target.value as "always_allow" | "ask_for_dangerous" })}><option value="ask_for_dangerous">{t("composer.askDangerous")}</option><option value="always_allow">{t("composer.alwaysAllow")}</option></select></label>
                      <label><span>{t("composer.specialist")}</span><select value={session.specialistId ?? ""} disabled={isRunning || sessionArchived} onChange={(event) => void updateSessionSettings({ specialistId: event.target.value || null })}><option value="">{t("composer.coordinator")}</option>{specialists.map((specialist) => <option key={specialist.id} value={specialist.id}>{specialist.name}</option>)}</select></label>
                    </div>
                    <ComposerRunButton action={composerRunAction} onStop={() => void stopRun()} />
                  </div>
                </form>
              </>
            )}
          </section>

          {workspaceCollapsed ? null : <aside className="workspace-panel" ref={workspacePanel}>
            <div
              aria-label="Resize workspace panel"
              aria-orientation="vertical"
              aria-valuemax={workspaceMaxWidth}
              aria-valuemin={MIN_WORKSPACE_WIDTH}
              aria-valuenow={Math.round(workspaceWidth)}
              className={workspaceResizing ? "workspace-resizer resizing" : "workspace-resizer"}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                if (event.key === "Home") resizeWorkspace(MIN_WORKSPACE_WIDTH);
                else if (event.key === "End") resizeWorkspace(Number.POSITIVE_INFINITY);
                else resizeWorkspace(workspaceWidth + (event.key === "ArrowLeft" ? 24 : -24));
              }}
              onPointerCancel={() => setWorkspaceResizing(false)}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                setWorkspaceResizing(true);
                resizeWorkspace(window.innerWidth - event.clientX);
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeWorkspace(window.innerWidth - event.clientX);
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                setWorkspaceResizing(false);
              }}
              role="separator"
              tabIndex={0}
            />
            <div className="section-heading">
              <div><h2>{t("app.workspace")}</h2></div>
              <div className="workspace-heading-actions">
                <button
                  aria-pressed={showPhysicalFiles}
                  className={showPhysicalFiles ? "developer-files-toggle active" : "developer-files-toggle"}
                  onClick={() => {
                    if (showPhysicalFiles) exitWorkspaceFileSelection();
                    setShowPhysicalFiles((current) => !current);
                  }}
                  title={t("app.physicalFilesHelp")}
                  type="button"
                >{t("app.physicalFiles")}</button>
                <span className="file-count">{artifacts.length}</span>
                <button aria-label={t("app.hideWorkspace")} className="icon-button workspace-collapse-button" onClick={() => setWorkspaceCollapsed(true)} title={t("app.hideWorkspace")} type="button"><PanelRightIcon size={15} /></button>
              </div>
            </div>
            {activeSessionId && !sessionArchived ? (
              <label className={dragActive ? "drop-zone active" : "drop-zone"} onDragEnter={() => setDragActive(true)} onDragLeave={() => setDragActive(false)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                if (event.dataTransfer.files.length) {
                  void upload(event.dataTransfer.files).catch((reason: Error) => setError(reason.message));
                }
              }}>
                <input multiple type="file" onChange={(event) => {
                  if (event.target.files?.length) void upload(event.target.files).catch((reason: Error) => setError(reason.message));
                  event.target.value = "";
                }} />
                <span className="upload-icon"><UploadIcon size={19} /></span>
                <strong>{t("app.dropFiles")}</strong>
                <small>single or multiple · text and binary · {formatByteLimit(workspaceCapabilities?.maxFileBytes ?? 1_073_741_824)} max each</small>
              </label>
            ) : <p className="muted">{sessionArchived ? t("app.archivedWorkspace") : t("app.createSessionWorkspace")}</p>}

            <details className="workspace-fold artifact-catalog-section" open>
              <summary><ChevronRightIcon className="fold-chevron" size={15} /><strong>{t("app.artifacts")}</strong><span className="fold-meta">{artifacts.length}</span></summary>
              <div className="artifact-catalog">
                {!projectsLoaded ? <SkeletonRows className="file-skeleton" count={3} /> : artifactGroups.map((group) => (
                  <section className="artifact-session-group" key={group.id}>
                    <header>
                      <span className="artifact-session-heading"><strong>{group.label}</strong><span>{group.items.length}</span></span>
                      <span className="artifact-session-actions">
                        <button
                          aria-label={artifactSelectionMode ? t("app.cancelArtifactSelection") : t("app.selectArtifacts")}
                          aria-pressed={artifactSelectionMode}
                          className="artifact-header-action"
                          disabled={!artifacts.length}
                          onClick={() => {
                            if (artifactSelectionMode) exitArtifactSelection();
                            else {
                              setArtifactSelectionMode(true);
                              setSelectedArtifactIds(new Set());
                            }
                          }}
                          title={artifactSelectionMode ? t("app.cancelArtifactSelection") : t("app.selectArtifacts")}
                          type="button"
                        >{artifactSelectionMode ? <CloseIcon size={14} /> : <CheckIcon size={14} />}</button>
                        <button
                          aria-label={t("app.downloadSelectedArtifacts")}
                          className="artifact-header-action"
                          disabled={!artifactSelectionMode || !selectedArtifactIds.size || artifactArchiveBusy}
                          onClick={() => void downloadSelectedArtifacts()}
                          title={artifactSelectionMode
                            ? `${t("app.downloadSelectedArtifacts")} · ${t("app.selectedArtifacts", { count: selectedArtifactIds.size })}`
                            : t("app.downloadSelectedArtifacts")}
                          type="button"
                        ><DownloadIcon size={14} /></button>
                      </span>
                    </header>
                    <div className="file-list">
                      <ArtifactTreeList
                        entries={buildArtifactTree(group.items)}
                        onOpen={openArtifact}
                        onSelectionChange={artifactSelectionMode ? changeArtifactSelection : undefined}
                        selectedArtifactIds={artifactSelectionMode ? selectedArtifactIds : undefined}
                      />
                    </div>
                  </section>
                ))}
                {activeProjectId && artifacts.length === 0 ? <p className="muted centered">{t("app.noArtifacts")}</p> : null}
              </div>
            </details>

            {showPhysicalFiles ? <details className="workspace-fold physical-files" open>
              <summary>
                <ChevronRightIcon className="fold-chevron" size={15} />
                <strong>{t("app.physicalFiles")}</strong>
                <span className="fold-meta">{files.length}</span>
                <span className="workspace-fold-actions">
                  <button
                    aria-label={workspaceFileSelectionMode ? t("app.cancelWorkspaceFileSelection") : t("app.selectWorkspaceFiles")}
                    aria-pressed={workspaceFileSelectionMode}
                    className="artifact-header-action"
                    disabled={!files.length}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (workspaceFileSelectionMode) exitWorkspaceFileSelection();
                      else {
                        setWorkspaceFileSelectionMode(true);
                        setSelectedWorkspaceFilePaths(new Set());
                      }
                    }}
                    title={workspaceFileSelectionMode ? t("app.cancelWorkspaceFileSelection") : t("app.selectWorkspaceFiles")}
                    type="button"
                  >{workspaceFileSelectionMode ? <CloseIcon size={14} /> : <CheckIcon size={14} />}</button>
                </span>
              </summary>
              <div className="workspace-fold-body file-list">
                {sessionPending ? <SkeletonRows className="file-skeleton" count={3} />
                  : <WorkspaceFileTreeList
                    entries={buildWorkspaceFileTree(files)}
                    onOpen={(file) => void openWorkspaceFile(file)}
                    onSelectionChange={workspaceFileSelectionMode ? changeWorkspaceFileSelection : undefined}
                    selectedPaths={workspaceFileSelectionMode ? selectedWorkspaceFilePaths : undefined}
                  />}
                {activeSessionId && files.length === 0 ? <p className="muted centered">{t("app.noFiles")}</p> : null}
              </div>
            </details> : null}

            {session ? <MemoryGraphView client={client} onError={reportError} refreshKey={`exec:${executionRuns.length}:msg:${session.messages.length}:plans:${plans.length}:mg:${memoryGraphSettings ? `${memoryGraphSettings.enabled ? 1 : 0}:${memoryGraphSettings.memoryGraphStatus}` : "none"}`} sessionId={session.id} /> : null}

            {session ? <ReviewerControlCard
              busy={Boolean(manualReviewerBusyBySession[session.id]) || reviewerCheckpointRunning}
              disabled={sessionArchived}
              onRun={() => void runManualReviewerSpecialist()}
              settings={reviewerSpecialistSettings}
            /> : null}

            {session ? (
              <details className="workspace-fold" aria-label="Paper search and extraction">
                <summary><ChevronRightIcon className="fold-chevron" size={15} /><strong>Paper reader</strong><span className="fold-meta">{papers.length} parsed</span></summary>
                <div className="workspace-fold-body">
                  <label className="pdf-upload">
                    <input type="file" accept="application/pdf,.pdf" disabled={paperBusy || sessionArchived} onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void uploadPaper(file).catch((reason: Error) => setError(reason.message));
                      event.target.value = "";
                    }} />
                    <span><UploadIcon size={14} /> Upload full PDF</span><small>50 MiB · 200 pages max</small>
                  </label>
                  {visionModels.length ? (
                    <label className="vision-picker"><span>Optional vision model</span><select disabled={sessionArchived} value={visionModelId ?? ""} onChange={(event) => setVisionModelId(event.target.value)}>{visionModels.map((item) => <option key={item.id} value={item.id}>{modelOptionLabel(item, visionModels)}</option>)}</select></label>
                  ) : <p className="paper-note">Mark a model as vision capable in Model settings to analyze scanned pages or extracted figures. OCR is not run.</p>}
                  <div className="paper-library">
                    {papers.map((paper) => {
                      const analysisBase = paper.manifestPath.replace(/manifest\.json$/, "");
                      const table = paper.extraction.tables[0];
                      const image = paper.extraction.images[0];
                      const visionRun = paperVisionRuns.filter((run) => run.paperId === paper.id).at(-1);
                      return (
                        <article key={paper.id}>
                          <div><strong>{paper.title}</strong><small>{paper.extraction.pageCount} pages · {paper.extraction.tables.length} tables · {paper.extraction.images.length} figures</small></div>
                          <div className="paper-actions">
                            <button type="button" onClick={() => void openWorkspacePath(paper.pdfPath).catch((reason: Error) => setError(reason.message))}>PDF</button>
                            <button type="button" onClick={() => void openWorkspacePath(`${analysisBase}${paper.extraction.textPath}`).catch((reason: Error) => setError(reason.message))}>Full text</button>
                            {table ? <button type="button" onClick={() => void openWorkspacePath(`${analysisBase}${table.csvPath}`).catch((reason: Error) => setError(reason.message))}>Table</button> : null}
                            {image ? <button type="button" onClick={() => void openWorkspacePath(`${analysisBase}${image.path}`).catch((reason: Error) => setError(reason.message))}>Figure</button> : null}
                            {visionModels.length ? <button type="button" disabled={paperBusy || sessionArchived} onClick={() => void analyzePaperVision(paper)}>Vision</button> : null}
                            {visionRun ? <button type="button" onClick={() => void openWorkspacePath(visionRun.resultPath).catch((reason: Error) => setError(reason.message))}>Vision result</button> : null}
                          </div>
                          {paper.extraction.warnings.map((warning) => <p key={warning}>{warning}</p>)}
                        </article>
                      );
                    })}
                    {!papers.length ? <p className="paper-note">Use the chat agent's MCP tools for governed literature downloads, or upload a local PDF here for extraction.</p> : null}
                  </div>
                </div>
              </details>
            ) : null}

            <details className="workspace-fold" aria-label="Provenance record">
              <summary><ChevronRightIcon className="fold-chevron" size={15} /><strong>Provenance record</strong></summary>
              <div className="workspace-fold-body">
                <div className="trust-metrics">
                  <div><strong>{executionRuns.length}</strong><span>Execution runs</span></div>
                  <div><strong>{latestExecution?.language ?? "—"}</strong><span>Language</span></div>
                  <div><strong>{latestExecution?.kernelMode ?? "—"}</strong><span>Kernel mode</span></div>
                  <div><strong>{latestEnvironment?.name ?? "—"}</strong><span>Environment</span></div>
                  <div><strong>{latestExecution?.environmentRevisionId?.slice(0, 12) ?? "—"}</strong><span>Environment revision</span></div>
                  <div><strong>{derivations.length}</strong><span>Derivations</span></div>
                  <div><strong>{promptManifests.length}</strong><span>Prompt manifests</span></div>
                  <div><strong>{mcpInvocations.length}</strong><span>MCP invocations</span></div>
                  <div><strong>{claims.length}</strong><span>Claims</span></div>
                  <div><strong>{evidenceLinks.length}</strong><span>Evidence links</span></div>
                </div>
              </div>
            </details>
            <div className="boundary-note"><span><ShieldCheckIcon size={15} /></span><p title="Python, R, and shell run in bubblewrap with an immutable Environment Revision, one writable workspace, and no network."><strong>Isolated execution</strong> · Epoch {permissionEpoch?.id.slice(0, 8) ?? "loading"}{permissionEpoch?.memoryLostReason ? ` · ${permissionEpoch.memoryLostReason}` : ""}</p></div>
          </aside>}
          {workspaceCollapsed ? (
            <button aria-label={t("app.showWorkspace")} className="workspace-expander" onClick={() => setWorkspaceCollapsed(false)} title={t("app.showWorkspace")} type="button">
              <PanelRightIcon size={16} /><span className="workspace-expander-count">{artifacts.length}</span>
            </button>
          ) : null}
        </div>
          </>
        )}
      </main>

      <ToastViewport onDismiss={dismissToast} toasts={toasts} />

      {markdownDocument ? (
        <div className="document-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setMarkdownDocument(undefined); }}>
          <section aria-label={`Rendered Markdown: ${markdownDocument.path}`} aria-modal="true" className="document-panel" role="dialog">
            <header className="document-header">
              <div><span className="eyebrow">Rendered Markdown</span><h2>{markdownDocument.path.split("/").at(-1)}</h2><small title={markdownDocument.path}>{markdownDocument.path}</small></div>
              <button aria-label="Close Markdown reader" className="icon-button" onClick={() => setMarkdownDocument(undefined)} title="Close Markdown reader"><CloseIcon size={20} /></button>
            </header>
            <MarkdownRenderer className="document-markdown" content={markdownDocument.content} />
          </section>
        </div>
      ) : null}

      {artifactModalName && activeSessionId ? (
        <ArtifactModal
          client={client}
          logicalName={artifactModalName}
          initialVersion={artifactModalVersion}
          onClose={() => {
            setArtifactModalName(undefined);
            setArtifactModalVersion(undefined);
          }}
          onMissing={closeMissingArtifact}
          onNavigateArtifact={(name) => {
            // Navigating to a different artifact via a parent link: that
            // artifact's version was not pinned by the original chip.
            setArtifactModalVersion(undefined);
            setArtifactModalName(name);
          }}
          onChipClick={handleChipClick}
          onError={reportError}
          onPendingAnnotation={addPendingAnnotation}
          sessionId={activeSessionId}
        />
      ) : null}

      {evidenceDetailId && activeSessionId ? (
        <EvidenceModal
          client={client}
          evidenceId={evidenceDetailId}
          onClose={() => setEvidenceDetailId(undefined)}
          sessionId={activeSessionId}
        />
      ) : null}

      {showConfig ? (
        <div className="config-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) cancelSystemSettings(); }}>
          <section aria-label={t("app.systemConfiguration")} aria-modal="true" className="config-panel system-config-dialog" role="dialog">
            <div className="config-header"><div><span className="eyebrow">{t("app.settings")}</span><h2>{t("app.systemConfiguration")}</h2></div><button className="icon-button" onClick={cancelSystemSettings} aria-label={t("settings.cancelAndClose")} title={t("settings.cancelAndClose")}><CloseIcon size={20} /></button></div>
            {systemSettingsErrors.map((detail) => <InlineErrorAlert
              detail={detail}
              key={detail}
              onDismiss={() => setSystemSettingsErrors((current) => current.filter((item) => item !== detail))}
            />)}
            <SystemSettingsLayout activeGroup={systemSettingsGroup} onSelect={setSystemSettingsGroup}>
              {systemSettingsGroup === "global" ? (
                globalSettings ? <ScopedSettingsEditor allowInheritance={false} connectors={connectors} details={globalSettings} draft={globalSettingsEdit ?? globalSettingsDraft(globalSettings)} models={models} onDraftChange={setGlobalSettingsEdit} onSave={saveGlobalSettings} scopeLabel={t("settings.global")} showActions={false} skillScope="global" skills={skills} /> : <p className="muted">{t("settings.loadingGlobal")}</p>
              ) : null}
              {systemSettingsGroup === "language" ? (
                <div className="settings-language-panel">
                  <div className="settings-detail-header"><span className="eyebrow">{t("settings.language.eyebrow")}</span><h3>{t("settings.language.title")}</h3><p>{t("settings.language.help")}</p></div>
                  <label><span>{t("settings.language.field")}</span><select aria-label={t("settings.language.field")} value={localeEdit ?? locale} onChange={(event) => setLocaleEdit(event.target.value as "en" | "zh-CN")}><option value="en">{t("settings.language.english")}</option><option value="zh-CN">{t("settings.language.chinese")}</option></select></label>
                </div>
              ) : null}
              {systemSettingsGroup === "timeouts" ? (
                timeoutSettings
                  ? <TimeoutSettingsEditor onChange={setTimeoutSettingsEdit} settings={timeoutSettingsEdit ?? timeoutSettings} />
                  : <p className="muted">{t("settings.loadingTimeouts")}</p>
              ) : null}
              {systemSettingsGroup === "quotas" ? (
                quotaSettings
                  ? <QuotaSettingsEditor onChange={setQuotaSettingsEdit} settings={quotaSettingsEdit ?? quotaSettings} />
                  : <p className="muted">{t("settings.loadingQuotas")}</p>
              ) : null}
              {systemSettingsGroup === "runtime" ? <RuntimeStatusPanel
                client={client}
                onError={reportSystemSettingsError}
                onNotice={(message) => pushToast("success", "Runtime updated", message)}
              /> : null}
              {systemSettingsGroup === "models" ? <>
                <div className="settings-detail-header"><span className="eyebrow">{t("settings.providerConfiguration")}</span><h3>{t("settings.modelRegistry")}</h3><p>{t("settings.modelHelp")}</p></div>
                <div className="model-list-header"><span>{t("settings.configuredModels")}</span><button type="button" onClick={startNewModel}>{t("settings.addModel")}</button></div>
                <div className="model-list">
                  {models.map((item) => {
                    const idHint = duplicateModelProfileId(item, models);
                    return <button type="button" className={item.id === editingModelId ? "model-card active" : "model-card"} key={item.id} onClick={() => editModel(item)} title={modelOptionLabel(item, models)}>
                      <span className={item.hasApiToken ? "model-status" : "model-status missing"} />
                      <span><strong>{item.name}</strong><small>{item.model}{idHint ? ` · ${idHint}` : ""}{item.vision ? " · Vision" : ""} · {item.hasApiToken ? "Key saved" : "Key missing"}</small></span>
                      <span><ChevronRightIcon size={16} /></span>
                    </button>;
                  })}
                </div>
                <form className="model-editor" onSubmit={(event) => event.preventDefault()}>
                  <div className="editor-heading"><strong>{editingModelId ? t("settings.editModel") : t("settings.newModel")}</strong><small>Profile settings and an encrypted provider credential are stored by the backend.</small></div>
                  <ModelDraftFields draft={modelDraft} onChange={updateModelDraft} />
                  {proxySettings ? <ProxyPolicySelect label="LLM proxy" onChange={(proxyPolicy) => updateModelDraft({ proxyPolicy })} settings={proxySettings} value={modelDraft.proxyPolicy} /> : null}
                  <label className="vision-capability"><input type="checkbox" checked={modelDraft.vision} onChange={(event) => updateModelDraft({ vision: event.target.checked })} /><span><strong>Vision capable</strong><small>Allow this profile to receive extracted paper page and figure images.</small></span></label>
                  <label><span>{t("settings.apiToken")}</span><input required={!editingModelId} type="password" value={draftToken} onChange={(event) => { setDraftToken(event.target.value); setRemoveStoredToken(false); setModelSettingsDirty(true); }} placeholder={models.find((item) => item.id === editingModelId)?.hasApiToken ? "Saved · enter a new token to replace it" : "Required for model runs"} /></label>
                  {editingModelId && models.find((item) => item.id === editingModelId)?.hasApiToken ? (
                    <button className={removeStoredToken ? "credential-remove pending" : "credential-remove"} type="button" onClick={() => { setDraftToken(""); setRemoveStoredToken((current) => !current); setModelSettingsDirty(true); }}>
                      {removeStoredToken ? "Saved token will be removed" : "Remove saved token"}
                    </button>
                  ) : null}
                  <div className="model-editor-actions">
                    {editingModelId ? <button className="danger-button" type="button" onClick={() => void deleteModel()}>{t("settings.delete")}</button> : <span />}
                    <span className="settings-source">Use the dialog Save action to apply this draft.</span>
                  </div>
                </form>
                <div className="config-note">Model profiles and provider tokens are stored by the local backend. Tokens are encrypted before database persistence, never returned to the browser, and resolved by model ID for chat, review, and vision runs.</div>
              </> : null}
              {systemSettingsGroup === "proxies" ? (
                proxySettings
                  ? <ProxySettingsEditor
                      mcpPolicies={mcpProxyPolicies}
                      mcpServers={proxyMcpServers(mcpSources)}
                      onCreate={createProxyServer}
                      onDefaultPolicyChange={updateDefaultProxyPolicy}
                      onDelete={deleteProxyServer}
                      onMcpPolicyChange={updateMcpProxyPolicy}
                      onUpdate={updateProxyServer}
                      onWebProxyPolicyChange={updateWebProxyPolicy}
                      settings={proxySettings}
                      webProxyPolicy={(webSettingsEdit?.values ?? webSettings)?.proxyPolicy ?? "inherit"}
                    />
                  : <p className="muted">Loading proxy settings…</p>
              ) : null}
              {systemSettingsGroup === "web" ? (
                webSettings && proxySettings
                  ? <WebSettingsEditor draft={webSettingsEdit ?? createWebSettingsDraft(webSettings)} onChange={setWebSettingsEdit} settings={webSettings} />
                  : <p className="muted">{t("settings.loadingWeb")}</p>
              ) : null}
              {systemSettingsGroup === "memory-graph" ? (
                memoryGraphSettings
                  ? <MemoryGraphSettingsEditor draft={memoryGraphSettingsEdit ?? createMemoryGraphSettingsDraft(memoryGraphSettings)} onChange={setMemoryGraphSettingsEdit} settings={memoryGraphSettings} />
                  : <p className="muted">{t("settings.loadingMemoryGraph")}</p>
              ) : null}
              {systemSettingsGroup === "skills" ? <SkillManager client={client} onCatalogChange={setSkills} onError={reportSystemSettingsError} sessionId={activeSessionId} skills={skills} /> : null}
              {systemSettingsGroup === "specialists" ? <SpecialistManager client={client} connectors={connectors} onChanged={setSpecialists} onError={reportSystemSettingsError} skills={skills} /> : null}
              {systemSettingsGroup === "permissions" ? <PermissionGrantManager grants={permissionGrants.filter((grant) => grant.scope !== "once")} onRevoke={(grant) => void revokePermission(grant)} /> : null}
              {systemSettingsGroup === "remote" ? <RemoteHostManager client={client} onError={reportSystemSettingsError} onPermissionRequest={(request) => setPermissionRequests((current) => [...current.filter((item) => item.id !== request.id), request])} sessionId={activeSessionId} /> : null}
              {systemSettingsGroup === "environments" ? <EnvironmentManager client={client} onError={reportSystemSettingsError} /> : null}
              {systemSettingsGroup === "connection" ? <>
                <div className="settings-detail-header"><span className="eyebrow">{t("settings.localAccess")}</span><h3>{t("settings.connection")}</h3><p>{t("settings.connectionHelp")}</p></div>
                {tokenRejected ? <InlineErrorAlert detail={t("settings.tokenRejected")} title={t("settings.tokenRejectedTitle")} /> : null}
                <label><span>{t("settings.localToken")}</span><input autoFocus={tokenRejected} value={tokenEdit ?? token} onChange={(event) => setTokenEdit(event.target.value)} /></label>
                <div className="config-note">The token is stored in this browser and sent with local API requests. It must match the server's configured authentication token.</div>
              </> : null}
            </SystemSettingsLayout>
            <SystemSettingsFooter
              busy={systemSettingsSaving}
              onCancel={cancelSystemSettings}
              onSave={() => void saveSystemSettings(false)}
              onSaveAndClose={() => void saveSystemSettings(true)}
            />
          </section>
        </div>
      ) : null}

      {projectCreationOpen && globalSettings ? <ProjectCreationDialog
        connectors={connectors}
        details={globalSettings}
        models={models}
        onCancel={() => setProjectCreationOpen(false)}
        onCreate={createProject}
        skills={skills}
      /> : null}
      {globalSearchOpen ? <GlobalSearchDialog
        onClose={() => setGlobalSearchOpen(false)}
        onQueryChange={setGlobalSearchQuery}
        onSelect={(result) => void navigateToSearchResult(result)}
        query={globalSearchQuery}
        results={workbenchIndex}
      /> : null}

      {settingsTarget ? (
        <div className="config-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeScopedSettings(); }}>
          <section aria-label={`${settingsTarget.kind} settings`} aria-modal="true" className="config-panel" role="dialog">
            <div className="config-header"><div><span className="eyebrow">{settingsTarget.kind} overrides</span><h2>{settingsTarget.label}</h2></div><button className="icon-button" onClick={closeScopedSettings} aria-label="Close scoped settings" title="Close scoped settings"><CloseIcon size={20} /></button></div>
            {scopedSettingsErrors.map((detail) => <InlineErrorAlert
              detail={detail}
              key={detail}
              onDismiss={() => setScopedSettingsErrors((current) => current.filter((item) => item !== detail))}
            />)}
            {scopedSettings ? <ScopedSettingsEditor
              connectors={connectors}
              details={scopedSettings}
              disabled={settingsTarget.kind === "session" && session?.id === settingsTarget.id && sessionArchived}
              key={resourceTargetKey(settingsTarget)}
              models={models}
              onSave={saveScopedSettings}
              scopeLabel={settingsTarget.kind === "project" ? "Project" : "Session"}
              skillScope={settingsTarget.kind === "project" ? "project" : "session"}
              skills={skills}
            /> : <p className="muted">Loading effective settings and sources…</p>}
          </section>
        </div>
      ) : null}

      {deletionTarget && deletionImpact ? <DeletionDialog
        confirmation={deletionConfirmation}
        impact={deletionImpact}
        label={deletionTarget.label}
        onCancel={() => { setDeletionTarget(undefined); setDeletionImpact(undefined); setDeletionConfirmation(""); }}
        onChangeConfirmation={setDeletionConfirmation}
        onConfirm={() => void confirmDeletion()}
      /> : null}

    </div>
  );
}


export {
  buildCreateSessionRequest,
  buildConversationBlocks,
  clearSessionTimeline,
  collectTimelinePermissionRequestIds,
  ComposerNoModelNotice,
  ComposerRunButton,
  followSessionTitleRefinement,
  forgetSession,
  getVisibleProjects,
  hydrateSessionRunTimeline,
  hydrateTerminalRunTimelines,
  isSessionRunning,
  messageForSessionTitle,
  queuedCancelToast,
  reconcilePermissionTimeline,
  reconcileSessionTimelinePermissions,
  recordSessionTimelineEvent,
  requestRunStop,
  resolveComposerRunAction,
  routeRunStreamEvent,
  runsRequiringEventReplay,
  selectSessionReplayRun,
  shouldApplySessionScopedUpdate,
  sortSessionRuns,
};
export type {
  ComposerRunAction,
  SessionRunTimeline,
  SessionRunTimelines,
};
