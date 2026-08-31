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

export type SkillSource = "built-in" | "managed";

export const BUILT_IN_SKILL_LIBRARY_ID = "built-in-skills";
/** Default writable destination for user-reviewed Agent Skill drafts. */
export const DEFAULT_WRITABLE_SKILL_LIBRARY_ID = "project-skills";

export type SkillResourceKind = "asset" | "other" | "reference" | "script";

export interface SkillValidationDiagnostic {
  code: string;
  level: "info" | "warning";
  message: string;
  path?: string;
}

export interface SkillResource {
  hash: string;
  kind: SkillResourceKind;
  path: string;
  size: number;
}

export interface SkillResourceSummary {
  bytes: number;
  files: number;
  kinds: Record<SkillResourceKind, number>;
}

export interface SkillDescriptor {
  currentRevision: number;
  declaredVersion?: string;
  description: string;
  diagnostics: SkillValidationDiagnostic[];
  hash: string;
  id: string;
  name: string;
  readOnly: boolean;
  resourceSummary: SkillResourceSummary;
  source: SkillSource;
  version: string;
}

export interface ManagedSkillRevision {
  createdAt: string;
  declaredVersion?: string;
  hash: string;
  id: string;
  revision: number;
  version: string;
}

export type SkillVersionSource = "agent" | "built-in" | "git" | "local-import" | "manual" | "session-distill";

export interface SkillGitProvenance {
  /** Exact commit used to build this immutable Skill version. */
  commit: string;
  ref?: string;
  repositoryUrl: string;
  subdirectory: string;
}

export interface SkillVersionProvenance {
  git?: SkillGitProvenance;
  sessionId?: string;
  source: SkillVersionSource;
}

export interface SkillDetail extends SkillDescriptor {
  frontmatter: Record<string, unknown>;
  instructions: string;
  resources: SkillResource[];
}

export interface CreateSkillRequest {
  allowedTools?: string;
  compatibility?: string;
  description: string;
  instructions: string;
  license?: string;
  metadata?: Record<string, string>;
  name: string;
  sourceSessionId?: string;
}

export interface CreateSkillResourceRequest {
  content: string;
  path: string;
}

/** A complete UTF-8 package authored by an Agent. */
export interface CreateSkillPackageRequest extends CreateSkillRequest {
  resources?: CreateSkillResourceRequest[];
}

export interface SkillReviewFile {
  /** Binary files from a previous revision can be compared by size, but not edited as text. */
  binary?: boolean;
  content?: string;
  /** Present only for a pending binary proposal so confirmation can preserve it unchanged. */
  encodedContent?: string;
  path: string;
  size: number;
}

export interface SkillReviewDraftSummary {
  baseRevision?: number;
  comparisonSource?: "installed-revision" | "previous-agent-draft";
  createdAt: string;
  draftId: string;
  fileCount: number;
  name: string;
  /** Present for newly persisted drafts; omitted only by legacy data and older clients. */
  provenance?: SkillVersionProvenance;
  updatedAt: string;
}

export interface SkillReviewDraft extends SkillReviewDraftSummary {
  baseFiles: SkillReviewFile[];
  files: SkillReviewFile[];
}

export type SkillVersionKind = "agent-proposal" | "built-in" | "managed-revision";

export interface SkillVersionSummary {
  createdAt?: string;
  current: boolean;
  fileCount: number;
  id: string;
  kind: SkillVersionKind;
  label: string;
  /** Present for newly persisted versions; omitted only by legacy data and older clients. */
  provenance?: SkillVersionProvenance;
  revision?: number;
}

export interface SkillVersionSnapshot extends SkillVersionSummary {
  files: SkillReviewFile[];
  skillId: string;
}

export interface UpdateSkillFileRequest {
  content: string;
  expectedRevision: number;
  sourceSessionId?: string;
}

export interface ConfirmSkillReviewDraftRequest {
  expectedUpdatedAt: string;
  files: Array<{
    binary?: boolean;
    content?: string;
    encodedContent?: string;
    path: string;
  }>;
  /** Writable Skill Library that receives the reviewed package. */
  libraryId?: string;
  /** The pending Agent proposal explicitly selected by the reviewer. */
  sourceVersionId?: string;
}

export interface ConfirmSkillReviewDraftResult {
  contentHash: string;
  libraryId: string;
  skillId: string;
  versionId: string;
}

export interface MergeSkillReviewDraftsRequest {
  /** Every selected draft is converted into proposal history under the target's stable Skill name. */
  draftIds: string[];
  targetDraftId: string;
}

export interface UpdateSkillRequest extends CreateSkillRequest {
  expectedRevision: number;
}

export interface SkillDraft extends CreateSkillRequest {
  /** Drafts remain inactive until the user reviews and explicitly saves them. */
  origin: "dialogue" | "session";
  sourceSummary: string;
}

export interface CreateSkillDialogueDraftRequest {
  description: string;
}

export interface DistillSessionSkillRequest {
  name?: string;
}

export interface ImportSkillFromGitRequest {
  ref?: string;
  repositoryUrl: string;
  subdirectory?: string;
}

export interface InspectGitSkillRepositoryRequest {
  ref?: string;
  repositoryUrl: string;
  /** Restrict discovery to a package root or marketplace subtree when it is already known. */
  subdirectory?: string;
}

export interface GitSkillImportCandidate {
  currentRevision?: number;
  description?: string;
  diagnostics: string[];
  name?: string;
  packageHash?: string;
  status: "invalid" | "new" | "unchanged" | "update";
  subdirectory: string;
}

export interface GitSkillRepositoryInspection {
  candidates: GitSkillImportCandidate[];
  commit: string;
  ref?: string;
  repositoryUrl: string;
}

export interface CreateGitSkillReviewDraftsRequest {
  /** Commit returned by inspection. Import fails if the requested ref moved. */
  commit: string;
  ref?: string;
  repositoryUrl: string;
  subdirectories: string[];
}

export interface CreateGitSkillReviewDraftsResponse {
  commit: string;
  drafts: SkillReviewDraftSummary[];
}

export interface SkillDeletionReference {
  id: string;
  label: string;
  /** Only Project and Session layers whitelist skills. */
  scope: "project" | "session";
}

export interface SkillDeletionImpact {
  references: SkillDeletionReference[];
  skillId: string;
}

export interface SkillResourceContent {
  content: string;
  hash: string;
  path: string;
  revision: number;
  skillId: string;
  size: number;
}

/** One immutable file from a complete frozen Skill package; never serialize these bytes into model context. */
export interface SkillPackageFileBytes {
  bytes: Uint8Array;
  hash: string;
  path: string;
  size: number;
}

/** Stable logical locations shared by prompts, workspace adapters, and sandboxes. */
export const SANDBOX_SKILL_PACKAGES_ROOT = "/skills";
export const SANDBOX_SKILL_EXTENSIONS_ROOT = "/skill-extensions";
export const SKILL_EXTENSIONS_WORKSPACE_PATH = ".sciencediscovery/skill-extensions";
export const SKILL_PACKAGES_ENVIRONMENT_VARIABLE = "SCIENCEDISCOVERY_SKILLS_DIR";
export const SKILL_EXTENSIONS_ENVIRONMENT_VARIABLE = "SCIENCEDISCOVERY_SKILL_EXTENSIONS_DIR";

export interface SkillLibrary {
  createdAt: string;
  headVersionId?: string;
  id: string;
  name: string;
  updatedAt: string;
}

export interface SkillLibraryVersionSkill {
  declaredVersion?: string;
  description: string;
  hash: string;
  id: string;
  version: string;
}

export interface SkillLibraryVersion {
  author: {
    id?: string;
    kind: "self-evolution" | "system" | "user";
    name?: string;
  };
  baseVersionId?: string;
  contentHash: string;
  createdAt: string;
  evaluation?: Record<string, unknown>;
  id: string;
  libraryId: string;
  parentVersionId?: string;
  rollbackOfVersionId?: string;
  skills: SkillLibraryVersionSkill[];
}

export interface SkillLibraryPackageInput {
  files: Array<{
    content: string;
    encoding?: "base64" | "utf8";
    path: string;
  }>;
}

export type CommitSkillLibraryOperation =
  | { package: SkillLibraryPackageInput; type: "upsert" }
  | { skillId: string; type: "delete" };

export interface CommitSkillLibraryVersionRequest {
  author: SkillLibraryVersion["author"];
  baseVersionId?: string;
  dryRun?: boolean;
  evaluation?: Record<string, unknown>;
  operations: CommitSkillLibraryOperation[];
}

export interface SkillLibraryDiffEntry {
  after?: SkillLibraryVersionSkill;
  before?: SkillLibraryVersionSkill;
  skillId: string;
}

export interface SkillLibraryDiff {
  added: SkillLibraryDiffEntry[];
  deleted: SkillLibraryDiffEntry[];
  modified: SkillLibraryDiffEntry[];
}

export interface SkillLibraryConflict {
  code: string;
  message: string;
  skillId?: string;
}

export interface CommitSkillLibraryVersionResult {
  conflicts: SkillLibraryConflict[];
  diagnostics: SkillValidationDiagnostic[];
  diff: SkillLibraryDiff;
  dryRun: boolean;
  version?: SkillLibraryVersion;
}

export interface SkillLibraryProposalSourceRef {
  id: string;
  kind: "artifact" | "review-finding" | "run" | "session" | "tool-call";
}

export interface ProposeSkillLibraryUpdateRequest extends CommitSkillLibraryVersionRequest {
  dryRun?: true;
  libraryId: string;
  rationale: string;
  sourceRefs: SkillLibraryProposalSourceRef[];
}

export interface SkillLibraryUpdateProposal {
  baseVersionId?: string;
  createdAt: string;
  id: string;
  libraryId: string;
  publishedVersionId?: string;
  rationale: string;
  request: CommitSkillLibraryVersionRequest;
  result: CommitSkillLibraryVersionResult;
  sourceRefs: SkillLibraryProposalSourceRef[];
  status: "pending" | "published" | "rejected";
  updatedAt: string;
}

export interface PublishSkillLibraryUpdateProposalResult {
  proposal: SkillLibraryUpdateProposal;
  result: CommitSkillLibraryVersionResult;
}

export interface PublishSkillLibraryUpdateProposalsRequest {
  proposalIds: string[];
}

export interface PublishSkillLibraryUpdateProposalsResult {
  proposals: SkillLibraryUpdateProposal[];
  result: CommitSkillLibraryVersionResult;
}

export interface RollbackSkillLibraryVersionRequest {
  author: SkillLibraryVersion["author"];
  baseVersionId?: string;
  evaluation?: Record<string, unknown>;
  targetVersionId: string;
}

export interface SkillLibrarySearchLibrary {
  contentHash?: string;
  libraryId: string;
  limit?: number;
  priority?: number;
  versionId: string;
}

export interface SkillLibrarySearchRequest {
  filters?: {
    domainTags?: string[];
  };
  libraries: SkillLibrarySearchLibrary[];
  limit?: number;
  query: string;
}

export interface SkillLibrarySearchCandidate {
  libraryId: string;
  priority: number;
  score: number;
  skill: SkillLibraryVersionSkill;
  versionId: string;
}

export interface SkillLibrarySearchResult {
  candidates: SkillLibrarySearchCandidate[];
  conflicts: SkillLibraryConflict[];
  skillLibraryRefs: import("./provenance.js").PromptSkillLibraryRef[];
}

/**
 * Stable id of a registered science source (built-in or extension).
 * Built-ins: arxiv | europe-pmc | pubmed | uniprot.
 * New sources register under `packages/mcp-sources`.
 */
