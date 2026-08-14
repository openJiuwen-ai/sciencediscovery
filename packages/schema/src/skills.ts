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

/**
 * Stable id of a registered science source (built-in or extension).
 * Built-ins: arxiv | europe-pmc | pubmed | uniprot.
 * New sources register under `packages/mcp-sources`.
 */
