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

import type {
  ArtifactAnnotation,
  ArtifactOrigin,
  ScientificArtifact,
  ScientificArtifactKind,
  ScientificArtifactVersion,
} from "./artifact-provenance.js";
import type { ConnectorId } from "./connectors.js";
import type { EvolveRun } from "./evolution.js";
import type { ModelRunInfo, ModelThinkingEffort, ModelThinkingMode } from "./model-usage.js";
import type { PermissionRequest } from "./permission.js";
import type { ApprovalMode, PlanSnapshot } from "./plan.js";
import type { ArtifactReviewRun, PromptSkillLibraryRef } from "./provenance.js";
import type { RemoteJob } from "./remote-job.js";
import type { EffectiveRuntimeSettings, EnabledSkillLibrary, ReviewerSpecialistLevel, RuntimeSettingsOverrides, SkillSelectionMode, TimeoutKind } from "./runtime-settings.js";
import type { Subagent, SubagentStep, SubagentUsage } from "./subagent.js";

export const SESSION_TITLE_MAX_CHARACTERS = 24;
export const UNTITLED_SESSION_TITLE = "Untitled session";

export function fallbackSessionTitle(createdAt = new Date().toISOString()): string {
  const match = createdAt.match(/^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/);
  return match ? `Session ${match[1]} ${match[2]}` : UNTITLED_SESSION_TITLE;
}

export function createLocalSessionTitle(
  message: string,
  createdAt?: string,
  maxCharacters = SESSION_TITLE_MAX_CHARACTERS,
): string {
  const normalized = message.replace(/\s+/gu, " ").trim();
  if (!normalized) return fallbackSessionTitle(createdAt);
  const characters = Array.from(normalized);
  if (characters.length <= maxCharacters) return normalized;
  if (maxCharacters <= 1) return characters.slice(0, Math.max(0, maxCharacters)).join("");
  return `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

export interface Session {
  approvalMode: ApprovalMode;
  archivedAt?: string;
  createdAt: string;
  /** Compatibility mirror of the effective enabledConnectorIds. */
  enabledConnectorIds: ConnectorId[];
  /** Compatibility mirror of the effective enabledSkillIds. */
  enabledSkillIds: string[];
  id: string;
  /** Compatibility mirror of the effective modelId. */
  modelId?: string;
  /** Compatibility mirror of the effective conversation thinking effort. */
  thinkingEffort?: ModelThinkingEffort;
  /** Compatibility mirror of the effective conversation thinking mode. */
  thinkingMode?: ModelThinkingMode;
  permissionEpochId: string;
  projectId: string;
  /** @deprecated Legacy Semantic Review catalog compatibility; no runtime reviewer consumes it. */
  reviewModelId?: string;
  /** @deprecated Legacy Semantic Review catalog compatibility. */
  reviewCriteria: string[];
  /** @deprecated Legacy Semantic Review catalog compatibility. */
  reviewMode: "auto" | "manual";
  /**
   * Independent Session selection from the global remote catalog. Absent means the
   * Session inherits the Project list; an empty array means this Session may not
   * use any remote machine. Local execution is always available either way.
   */
  remoteRunnerHostIds?: string[];
  /** Enables automatic Reviewer Specialist tasks for this Session only. */
  reviewerAutomaticReviewEnabled: boolean;
  /** Quick is the default; Deep adds semantic verification for this Session. */
  reviewerSpecialistLevel: ReviewerSpecialistLevel;
  /** @deprecated Legacy Semantic Review catalog compatibility; no runtime reviewer consumes it. */
  semanticReviewEnabled: boolean;
  settingsOverrides: RuntimeSettingsOverrides;
  specialistId?: string;
  title: string;
  updatedAt: string;
}

/**
 * Reference kind for composer/Markdown-chip links. `artifact` / `session` /
 * `skill` are the user-message composer references (an `@artifact` read into
 * context, an `@session` cross-session reference, an `@skill` activation).
 * `evidence` / `artifact` / `sourcefile` are the memory-graph chip kinds that
 * let a final report's prose cite graph nodes — `declare_claim`'s chip_map
 * produces these (a Paper is never cited directly: the report cites an Evidence
 * node that was extracted from it; an uploaded non-PDF data file is cited as a
 * SourceFile). The alias → node-id map is persisted on the report Artifact
 * version's `references` so the chips survive reloads.
 */
export type ComposerReferenceKind = "artifact" | "session" | "skill" | "evidence" | "sourcefile";

export interface ComposerReference {
  createdInSessionTitle?: string;
  id: string;
  kind: ComposerReferenceKind;
  label: string;
  origin?: ArtifactOrigin;
  path?: string;
  projectId?: string;
  sessionId?: string;
  /** For artifact chips, pins the exact version cited by the claim. */
  version?: number;
}

/** Runtime-originated records delivered with a turn: completed background
 * Executions and fired timers. `prompt` is model-facing text and is never the
 * user-visible message body; the counts let the UI summarize it without
 * parsing that text. */
export interface RuntimeNotice {
  executions: number;
  prompt: string;
  timers: number;
}

export interface ChatMessage {
  annotations?: ArtifactAnnotation[];
  content: string;
  createdAt: string;
  id: string;
  kind?: "message" | "review_notice" | "reviewer_checkpoint" | "timeout_notice" | "wake_notice";
  modelId?: string;
  modelName?: string;
  /** Canonical provider transcript for this assistant turn. It is replayed to
   * the configured model but is not used as the user-visible message body. */
  modelContext?: Array<Record<string, unknown>>;
  references?: ComposerReference[];
  /** Runtime records that rode along with this turn. The model input re-attaches
   * `prompt`; the transcript keeps it out of `content` so a runtime wake is
   * never rendered as something the user typed. */
  runtimeNotice?: RuntimeNotice;
  reviewerCheckpoint?: {
    error?: string;
    /** Persisted live progress for the current Reviewer Specialist stage. */
    progress?: {
      artifactLogicalName: string;
      artifactCompleted?: number;
      artifactTotal?: number;
      completed: number;
      failed: number;
      phase?: "quick" | "preparing" | "computation" | "citation";
      queued: number;
      running?: string;
      total: number;
    };
    status: "completed" | "failed" | "running";
    toolCallId: string;
  };
  role: "assistant" | "user";
  timeout?: {
    kind: TimeoutKind;
    reason: string;
    timeoutMs: number;
  };
}

export interface SessionDetail extends Session {
  messages: ChatMessage[];
}

export interface WorkspaceFile {
  modifiedAt: string;
  path: string;
  previewKind?: ScientificArtifactKind;
  provenance?: WorkspaceFileProvenanceSummary;
  size: number;
}

export type WorkspaceFileOrigin =
  | "agent"
  | "mcp-download"
  | "remote-compute"
  | "subagent"
  | "system"
  | "tool"
  | "unknown"
  | "upload";

export type WorkspaceFileOriginMeta = Record<string, boolean | number | string | null>;

export interface WorkspaceFileProvenanceSummary {
  fileId: string;
  origin: WorkspaceFileOrigin;
  recordedAt: string;
  revisionId: string;
}

/** Stable logical identity of one file while it remains in a Session workspace. */
export interface WorkspaceFileRecord {
  createdAt: string;
  currentRevisionId: string;
  deletedAt?: string;
  id: string;
  path: string;
  projectId: string;
  sessionId: string;
  /** Snapshot used when the source Session is later deleted. */
  sessionTitle: string;
  updatedAt: string;
}

/** Immutable attribution for one observed content state of a Workspace file. */
export interface WorkspaceFileRevision {
  publicationSequence?: number;
  artifactVersionIds: string[];
  contentHash?: string;
  createdAt: string;
  executionRunId?: string;
  fileId: string;
  id: string;
  modifiedAt: string;
  origin: WorkspaceFileOrigin;
  originMeta?: WorkspaceFileOriginMeta;
  parentRevisionId?: string;
  path: string;
  projectId: string;
  runId?: string;
  sessionId: string;
  size: number;
  subagentId?: string;
  toolCallId?: string;
  toolName?: string;
}

export interface WorkspaceFileRevisionInput {
  /** Trusted local Runner receipt. Not a user-supplied ordering number. */
  publicationVersion?: { pool: "agent-state"; digest: `sha256:${string}`; size: number; mediaType: string };
  artifactVersionId?: string;
  contentHash?: string;
  executionRunId?: string;
  mode: "link" | "observe" | "write";
  modifiedAt: string;
  origin: WorkspaceFileOrigin;
  originMeta?: WorkspaceFileOriginMeta;
  parentRevisionId?: string;
  path: string;
  runId?: string;
  size: number;
  subagentId?: string;
  toolCallId?: string;
  toolName?: string;
}

export interface WorkspaceFileSourceSession {
  deleted: boolean;
  id: string;
  title: string;
}

export interface WorkspaceFileLineageEntry {
  fileId: string;
  origin: WorkspaceFileOrigin;
  path: string;
  revisionId: string;
  session: WorkspaceFileSourceSession;
}

export interface WorkspaceFileArtifactLink {
  artifactId: string;
  name: string;
  version: number;
  versionId: string;
}

export interface WorkspaceFileProvenance {
  artifacts: WorkspaceFileArtifactLink[];
  currentRevision: WorkspaceFileRevision;
  file: WorkspaceFileRecord;
  lineage: WorkspaceFileLineageEntry[];
  revisions: WorkspaceFileRevision[];
  sourceSession: WorkspaceFileSourceSession;
}

export type WorkbenchSearchResultKind = "artifact" | "project" | "session";

export interface WorkbenchSearchResult {
  detail: string;
  id: string;
  kind: WorkbenchSearchResultKind;
  label: string;
  path?: string;
  projectId: string;
  sessionId?: string;
}

export interface WorkbenchSearchResponse {
  hasMore: boolean;
  limit: number;
  offset: number;
  results: WorkbenchSearchResult[];
  total: number;
}

export interface ToolTrace {
  /** Structured tool arguments as issued by the model. */
  args?: Record<string, unknown>;
  /** Full structured tool result details, when the tool provides them. */
  details?: unknown;
  id: string;
  /** Serialized tool arguments; carried by tool.started and kept by the timeline. */
  input?: string;
  /** Only set by pre-stream records that were truncated at emission. */
  inputTruncated?: boolean;
  name: string;
  /** Inline result text; only present on pre-stream records. New records reference a stream. */
  output?: string;
  /** Total characters of the tool result stored in the referenced stream. */
  outputChars?: number;
  /** Child stream holding the full tool output, e.g. "tool-<toolCallId>". */
  outputStream?: string;
  outputTruncated?: boolean;
  status: "completed" | "failed" | "running";
  summary?: string;
}

export type SessionRunStatus =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface SessionRun {
  /** Trusted notification context, never accepted from SendMessageRequest. */
  notificationDelivery?: {
    sessionId: string; agentId: string; epoch: number; agentEpoch: number;
    notifications: Array<{ id: string; sessionId: string; agentId: string; kind: "execution" | "timer"; sourceId: string; message: string; createdAt: number; readAt?: number }>;
  };
  automaticWake?: boolean;
  annotationIds: string[];
  assistantMessageId?: string;
  createdAt: string;
  error?: string;
  finishedAt?: string;
  id: string;
  prompt: string;
  queueOrder: number;
  references: ComposerReference[];
  retryOfRunId?: string;
  sessionId: string;
  settingsSnapshot: EffectiveRuntimeSettings;
  /** Version-pinned skill libraries declared as prompt sources for this run. */
  skillLibraryRefs?: PromptSkillLibraryRef[];
  startedAt?: string;
  status: SessionRunStatus;
  userMessageId?: string;
  webForceRefresh?: boolean;
}

export type RunStreamEvent =
  | { model: ModelRunInfo; runId: string; settings: EffectiveRuntimeSettings; type: "run.started" }
  | { session: Session; type: "session.updated" }
  /**
   * The Session's approval policy was switched while this run's timeline was the
   * one being written. Recorded only for a real change, so a replay reads back
   * when the policy moved and in which direction; the tool calls after it are
   * judged by `approvalMode`.
   */
  | {
      approvalMode: ApprovalMode;
      permissionEpochId: string;
      previousApprovalMode: ApprovalMode;
      type: "session.approval_mode.changed";
    }
  | { run: SessionRun; type: "run.queued" }
  | { reason?: string; run: SessionRun; status: SessionRunStatus; type: "run.status" }
  | { reason?: string; runId: string; type: "run.cancelled" }
  | { droppedEvents: number; type: "run.history.truncated" }
  | { phase: "thinking"; turn: number; type: "agent.phase" }
  | { delta: string; turn: number; type: "assistant.thinking.delta" }
  | { content: string; truncated?: boolean; turn: number; type: "assistant.thinking.snapshot" }
  | { delta: string; type: "assistant.delta" }
  | { content: string; truncated?: boolean; type: "assistant.snapshot" }
  | { trace: ToolTrace; type: "tool.started" }
  | { trace: ToolTrace; type: "tool.completed" }
  | { chunk: string; toolCallId: string; type: "tool.output" }
  | { changedPaths: string[]; files: WorkspaceFile[]; type: "workspace.changed" }
  | { artifact: ScientificArtifact; type: "artifact.upserted"; version?: ScientificArtifactVersion }
  | { plan: PlanSnapshot; type: "plan.updated" }
  | { subagent: Subagent; type: "subagent.updated" }
  | { step: SubagentStep; subagentId: string; type: "subagent.step" }
  | { subagentId: string; type: "subagent.usage"; usage: SubagentUsage }
  | { job: RemoteJob; type: "remote_job.proposed" }
  /** An evolution search the agent designed and started from inside the
   *  conversation. The card renders in the transcript where it was asked
   *  for, so the search sits next to the sentence that motivated it. */
  | { run: EvolveRun; type: "evolve_run.created" }
  | { request: PermissionRequest; type: "permission.required" }
  | { request: PermissionRequest; type: "permission.resolved" }
  | { review: ArtifactReviewRun; type: "artifact_review.completed" }
  /**
   * A persisted Reviewer Specialist card changed while a main-agent tool call
   * is still in progress.  This lets the conversation render the same live
   * card used by a manual review rather than a generic tool-call placeholder.
   */
  | { message: ChatMessage; type: "reviewer_checkpoint.updated" }
  | { files: WorkspaceFile[]; message: ChatMessage; type: "run.completed" }
  | { reason: string; type: "run.cancelled" }
  | { error: string; errorCode: RunFailureCode; type: "run.failed" };

/**
 * Stable failure classes for a run. The classification accompanies the original
 * error text rather than replacing it, so callers can branch on a code while
 * the user still sees what the provider actually said.
 */
export type RunFailureCode =
  | "rate-limited"
  | "semantic-error"
  | "server-error"
  | "timeout"
  | "transport-error"
  | "unauthorized";

export interface SessionRunEvent {
  createdAt: string;
  event: RunStreamEvent;
  runId: string;
  sequence: number;
  sessionId: string;
}

export interface CreateSessionRequest {
  /** Compatibility shortcut for settingsOverrides.modelId. */
  modelId?: string;
  approvalMode?: ApprovalMode;
  reviewCriteria?: string[];
  reviewMode?: "auto" | "manual";
  remoteRunnerHostIds?: string[];
  settingsOverrides?: RuntimeSettingsOverrides;
  specialistId?: string;
  title?: string;
}

export interface UpdateSessionRequest {
  approvalMode?: ApprovalMode;
  enabledConnectorIds?: ConnectorId[];
  enabledSkillLibraries?: EnabledSkillLibrary[];
  enabledSkillIds?: string[];
  modelId?: string;
  reviewCriteria?: string[];
  reviewMode?: "auto" | "manual";
  /** Set to null to drop the override and inherit the Project's allowed machines. */
  remoteRunnerHostIds?: string[] | null;
  reviewModelId?: string;
  semanticReviewEnabled?: boolean;
  skillSelectionMode?: SkillSelectionMode;
  specialistId?: string | null;
  thinkingEffort?: ModelThinkingEffort;
  thinkingMode?: ModelThinkingMode;
  title?: string;
}

export interface SendMessageRequest {
  annotationIds?: string[];
  content: string;
  references?: ComposerReference[];
  /** Version-pinned skill libraries the application used to assemble this prompt. */
  skillLibraryRefs?: PromptSkillLibraryRef[];
  webForceRefresh?: boolean;
}

export interface CreateSkillEvolutionRunRequest {
  targetLibraryId?: string;
}

/** Stop also disables automatic wakeups when no foreground run is active. */

export interface CancelRunResult {
  cancelled: boolean;
  runId?: string;
  sessionId: string;
}

export interface UploadFileRequest {
  content: string;
  path: string;
}

export type WorkspaceConflictPolicy = "reject" | "overwrite" | "rename";

export interface WorkspaceUploadItemResult {
  error?: string;
  hash?: string;
  originalName: string;
  path?: string;
  /** Byte size of the uploaded content; absent on failed entries. */
  size?: number;
  status: "created" | "overwritten" | "renamed" | "failed";
}

export interface WorkspaceUploadResult {
  errors: Array<{ error: string; name: string }>;
  files: WorkspaceFile[];
  uploaded: WorkspaceUploadItemResult[];
}

export interface WorkspaceCapabilities {
  maxFileBytes: number;
  maxRequestBytes: number;
  maxWorkspaceBytes: number;
}

export interface ApiError {
  code?: string;
  details?: Record<string, unknown>;
  error: string;
}
