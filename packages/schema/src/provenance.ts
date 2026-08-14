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

import type { EvidenceIdentifierType } from "./connectors.js";
import type { ExecutionLanguage, KernelMode } from "./environment.js";
import type { ModelUsageStatus } from "./model-usage.js";
import type { EffectiveRuntimeSettings } from "./runtime-settings.js";

export interface CasObjectRef {
  hash: string;
  size: number;
}

export interface ExecutionRun {
  /** Historical runs recorded the accelerator device used, if any. */
  accelerator?: Record<string, unknown> | null;
  /** Historical runs may still record direct-v2 / systemd modes from older runners. */
  cgroupMode: "none" | "direct-v2" | "systemd-system" | "systemd-user" | "unavailable";
  code: CasObjectRef;
  createdFiles: string[];
  /** Historical runs created before managed environments may contain null. */
  environmentRevisionId: string | null;
  exitCode: number | null;
  finishedAt: string;
  id: string;
  kernelId: string;
  /** Historical runs created before persistent kernels may contain null. */
  kernelMode: KernelMode | null;
  /** Historical runs created before multi-language execution may contain null. */
  language: ExecutionLanguage | null;
  modifiedFiles: string[];
  networkPolicy: "none";
  permissionEpochId: string;
  /**
   * CAS reference to the canonical JSON snapshot (sorted keys) of the effective
   * process environment the runner reported for this execution. `null` when the
   * runner failed before reporting one; absent on historical runs recorded
   * before environment provenance landed.
   */
  envSnapshot?: CasObjectRef | null;
  /** Historical runs recorded the compute resource profile they ran under. */
  resourceProfile?: Record<string, unknown>;
  runnerVersion: string;
  sandbox: "bubblewrap";
  sessionId: string;
  startedAt: string;
  /**
   * `cancelled` records a Runner execution that was interrupted mid-flight
   * because the agent run it belonged to was aborted — a user Stop or a run
   * timeout — rather than because the execution itself failed.
   */
  status: "cancelled" | "failed" | "succeeded";
  stderr: CasObjectRef;
  stdout: CasObjectRef;
  tool: "run_python" | "run_r" | "run_shell";
  toolVersion: string;
  turnId: string;
  /**
   * Sandbox-internal working directory the runner reported (e.g.
   * `/workspace/subdir`). Historical runs recorded the placeholder
   * `workspace`; `unavailable` marks runs that failed before execution.
   */
  workingDirectory: string;
}

export interface PromptContentRef extends CasObjectRef {
  messageId?: string;
  role: "assistant" | "system" | "user";
}

export interface PromptSkillRef {
  hash: string;
  id: string;
  /** Legacy manifests created before managed skills omit this field. */
  revision?: number;
  version: string;
}

export interface PromptManifest {
  costUsd: number | null;
  createdAt: string;
  endpointHost: string;
  finishedAt: string;
  id: string;
  inputs: PromptContentRef[];
  model: string;
  modelProfileId: string;
  modelProfileName: string;
  inputTokens: number | null;
  outputTokens: number | null;
  provider: "openai-compatible";
  redactionStatus: "not-applied" | "not-required";
  response?: CasObjectRef;
  runtimeSettings: EffectiveRuntimeSettings;
  sessionId: string;
  skillRefs: PromptSkillRef[];
  specialistRef?: { id: string; name: string };
  status: "failed" | "succeeded";
  systemPrompt: CasObjectRef & { version: string };
  totalTokens: number | null;
  turnId: string;
  usageStatus: ModelUsageStatus;
}

/** @deprecated Persisted compatibility for the removed Integrity/Semantic Reviewer. */
export interface ReviewFinding {
  code: string;
  evidenceRefs: string[];
  id: string;
  message: string;
  severity: "critical" | "warning";
  status: "open";
}

/** @deprecated Persisted compatibility for the removed Integrity/Semantic Reviewer. */
export interface ReviewRun {
  createdAt: string;
  findings: ReviewFinding[];
  finishedAt: string;
  id: string;
  kind: "integrity" | "semantic";
  modelProfileId?: string;
  promptManifestId?: string;
  sessionId: string;
  status: "failed" | "passed" | "warnings";
  turnId: string;
  trigger?: "automatic" | "manual";
}

export interface ArtifactReviewFinding {
  code: string;
  evidenceRefs: string[];
  id: string;
  message: string;
  severity: "critical" | "warning";
  status: "open";
}

export interface ArtifactReviewRun {
  artifactContentHash: string;
  artifactId: string;
  artifactLogicalName: string;
  artifactVersionId: string;
  checkpointId: string;
  /** Checks completed by this run. Older persisted MVP reviews omit it. */
  checks?: Array<"structure" | "citation" | "computation">;
  createdAt: string;
  decision: "ACCEPT_AND_PROCEED" | "REVISE_AND_RETRY" | "SKIPPED";
  finishedAt: string;
  findings: ArtifactReviewFinding[];
  id: string;
  /** Version-pinned graph references checked for this Artifact review. */
  provenanceRefs?: string[];
  /** Previous identical completed review reused without running checks again. */
  reusedFromReviewId?: string;
  /** Stable Deep input fingerprint used to avoid repeating an identical semantic review. */
  reviewFingerprint?: string;
  reviewerSpecialistVersion: string;
  /** Review capability used for this run. `smart` is retained for historical records. */
  reviewLevel?: "quick" | "smart" | "deep";
  /** Whether the Deep semantic stage completed or safely degraded to Quick. */
  smartStatus?: "completed" | "inconclusive";
  /** Safe, user-visible reason for an inconclusive Deep semantic stage. */
  smartDetail?: {
    code: "SMART_CITATION_INCONCLUSIVE" | "SMART_COMPUTATION_INCONCLUSIVE" | "SMART_SEMANTIC_INCONCLUSIVE" | "SMART_AGENT_OUTPUT_INVALID" | "SMART_EXECUTION_FAILED";
    message: string;
  };
  /** Smart-only findings retained separately so semantic conclusions can be safely reused. */
  smartFindings?: ArtifactReviewFinding[];
  /** Deep Citation runs each identifiable paper as a separately retryable task. */
  citationTasks?: Array<{
    attempts: number;
    findings: ArtifactReviewFinding[];
    key: string;
    label: string;
    message?: string;
    status: "completed" | "failed" | "inconclusive" | "reused";
  }>;
  sessionId: string;
  status: "completed" | "failed";
  toolCallId?: string;
}

export interface ReviewCheckpoint {
  candidateArtifactVersionIds: string[];
  createdAt: string;
  finishedAt?: string;
  id: string;
  kind: "explicit";
  parentRunId?: string;
  reason: string;
  reviewedArtifactVersionIds: string[];
  sessionId: string;
  skippedArtifactVersionIds: string[];
  startedAt?: string;
  status: "cancelled" | "completed" | "failed" | "queued" | "running";
  toolCallId?: string;
}

export interface ReviewCheckpointRequest {
  artifactVersionIds?: string[];
  reason: string;
}

export interface ReviewCheckpointResult {
  checkpoint: ReviewCheckpoint;
  reviews: ArtifactReviewRun[];
}

export interface Claim {
  id: string;
  reviewRunId: string;
  sessionId: string;
  text: string;
  turnId: string;
}

export interface EvidenceLink {
  claimId: string;
  /** New global evidence reference. Optional until the evidence store migration lands. */
  evidenceItemId?: string;
  /** How the material relates to the claim. Legacy links implicitly support. */
  relation?: import("./evidence.js").EvidenceRelation;
  createdAt?: string;
  /** Legacy connector-only provenance fields remain readable during migration. */
  connectorInvocationId?: string;
  evidenceIdentifier?: string;
  evidenceType?: EvidenceIdentifierType;
  id: string;
}
