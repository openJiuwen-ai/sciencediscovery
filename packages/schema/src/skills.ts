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

/**
 * What identifies one selected frozen package. `hash` is the content hash of
 * the package's files, so this alone says which bytes a Runner needs — the
 * files themselves only have to travel when it does not have them yet.
 */
export interface SkillPackageMetadata {
  id: string;
  revision: number;
  version: string;
  hash: string;
}

/** Metadata of the whole selected set, enough to ask a Runner what it already holds. */
export interface SkillPackageManifest {
  skills: SkillPackageMetadata[];
}

/** One frozen file; `content` is base64 so binary resources survive the transfer. */
export interface SkillPackageFile {
  path: string;
  size: number;
  hash: string;
  content: string;
}

/** Complete selected frozen packages, never an Agent Workspace transfer. */
export interface SkillPackageBundle {
  skills: Array<SkillPackageMetadata & { files: SkillPackageFile[] }>;
}

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
/** Server-computed availability; never trusted from Skill frontmatter. */
  ideaTreeExecutor?: {
    authorityKey: string;
    authorityVersion: string;
    available: boolean;
    developmentOnly: boolean;
    reason?: string;
  };
  /** Normalized metadata from SKILL.md frontmatter; values may be nested objects, arrays, or strings (relaxed in https://gitcode.com/openJiuwen/sciencediscovery/pull/127 to admit SAS skill openclaw declarations). */
  metadata?: Record<string, unknown>;
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
  /** A declaration the runtime preserves: either the comma-string form or the
   *  YAML sequence some Skills use. */
  allowedTools?: string | string[];
  compatibility?: string;
  description: string;
  instructions: string;
  license?: string;
  metadata?: Record<string, unknown>;
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

/** The raw text of SKILL.md, for the editor that shows the whole document. */
export interface SkillMarkdownContent {
  content: string;
  revision: number;
  skillId: string;
}

/** Replace SKILL.md with the text the user edited, frontmatter included.
 *  The server validates the package after writing it, so a broken name or an
 *  empty description is refused rather than stored. */
export interface UpdateSkillMarkdownRequest {
  content: string;
  expectedRevision: number;
}

export interface DeleteSkillFileRequest {
  expectedRevision: number;
}

/** A file or a whole folder moved in place: `to` is the new path. */
export interface RenameSkillFileRequest {
  expectedRevision: number;
  to: string;
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

/** One package in a background Git import. The selection came from an
 *  inspection, so `overwrite`/`expectedRevision` are the same choice a single
 *  import would carry. */
export interface GitSkillImportJobItem {
  expectedRevision?: number;
  overwrite?: boolean;
  subdirectory: string;
}

/** Start a background import for a selection at the commit that was inspected.
 *  The request returns as soon as the job is queued; progress is read from the
 *  job resource. */
export interface StartGitSkillImportJobRequest {
  commit?: string;
  items: GitSkillImportJobItem[];
  ref?: string;
  repositoryUrl: string;
}

export type GitSkillImportJobStatus = "queued" | "running" | "done" | "cancelled" | "failed";

/** The observable state of one background Git import. `imported` names the
 *  packages that arrived; `created` is false for an update of an installation
 *  that already existed. */
export interface GitSkillImportJob {
  commit?: string;
  done: number;
  failures: Array<{ message: string; subdirectory: string }>;
  finishedAt?: string;
  id: string;
  imported: Array<{ created: boolean; id: string }>;
  startedAt: string;
  status: GitSkillImportJobStatus;
  total: number;
}

export interface ImportSkillFromGitRequest {
  /**
   * Commit returned by inspection. When present, the import is rejected if the
   * ref has moved, so what the user reviewed is what gets installed.
   */
  commit?: string;
  /**
   * Allow replacing an already installed managed Skill. Omitted keeps the
   * historical conflict for callers that never inspected the repository.
   */
  overwrite?: boolean;
  /**
   * Required with `overwrite`: the revision the user saw. A mismatch is a
   * conflict rather than a silent replacement of an edit made meanwhile.
   */
  expectedRevision?: number;
  ref?: string;
  repositoryUrl: string;
  subdirectory?: string;
}

export interface InspectGitSkillRepositoryRequest {
  /**
   * The commit a previous inspection returned. Required with `cursor`, so the
   * next page is read from the same tree instead of whatever the ref points
   * at now.
   */
  commit?: string;
  /**
   * Where the previous page ended: pass back the `nextCursor` it returned.
   * Discovery walks the whole checkout on every page, so a page costs the
   * `SKILL.md` files it returns, not the ones before it.
   */
  cursor?: string;
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
  /** One page of the packages the repository carries, in subdirectory order. */
  candidates: GitSkillImportCandidate[];
  commit: string;
  /**
   * Where the next page starts. Absent when this page is the last one. Pass
   * it back with `commit` (and the same repository, ref and subdirectory) to
   * read on.
   */
  nextCursor?: string;
  ref?: string;
  repositoryUrl: string;
  /** How many packages the repository carries, across every page. */
  total?: number;
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

// The bind paths above are literal only under bubblewrap. macOS Seatbelt has no
// mount namespace, so every advertised path uses the environment variable form,
// which both shells and the workspace path resolver understand on either host.
export const SKILL_PACKAGES_PORTABLE_ROOT = `$${SKILL_PACKAGES_ENVIRONMENT_VARIABLE}`;
export const SKILL_EXTENSIONS_PORTABLE_ROOT = `$${SKILL_EXTENSIONS_ENVIRONMENT_VARIABLE}`;

/** Every spelling of a mounted Skill root the model may send back to a tool. */
export function skillRootAliases(bindRoot: string, variable: string): string[] {
  return [bindRoot, `$${variable}`, `\${${variable}}`];
}

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

/**
 * A skill installed in JiuwenSwarm (the JiuwenSwarm agent backend): one imported from ScienceDiscovery
 * (`source: "sciencediscovery"`, with `skillId`, its id here), one shipped with JiuwenSwarm (`builtin`), or one
 * JiuwenSwarm installed itself (its source name).
 */
export interface JiuwenSwarmSkill {
  description: string;
  enabled: boolean;
  name: string;
  skillId?: string;
  source: string;
}

/** `GET /api/jiuwenswarm/skills`: which backend runs agents, and with JiuwenSwarm, its skills. */
export interface JiuwenSwarmSkillsResponse {
  backend: "jiuwenswarm" | "native";
  skills: JiuwenSwarmSkill[];
}

/**
 * One row of a bulk switch (`PUT /api/jiuwenswarm/skills-batch`).
 *
 * `name` is JiuwenSwarm's own name for a skill the page already lists, so the
 * common case needs no lookup; `skillId` is ScienceDiscovery's id, used to
 * resolve (and, for an enable, import) a skill JiuwenSwarm does not have yet.
 */
export interface JiuwenSwarmSkillSwitchTarget {
  name?: string;
  skillId?: string;
}

/** What became of one bulk target: one result per target, in request order. */
export interface JiuwenSwarmSkillSwitchResult extends JiuwenSwarmSkillSwitchTarget {
  /** Why this target was not switched; absent when `ok` is true. */
  error?: string;
  ok: boolean;
}

/** `PUT /api/jiuwenswarm/skills-batch`: one state applied to many skills. */
export interface JiuwenSwarmSkillsStateResponse {
  enabled: boolean;
  results: JiuwenSwarmSkillSwitchResult[];
}
