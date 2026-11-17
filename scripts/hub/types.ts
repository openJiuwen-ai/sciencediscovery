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

export type AssetKind = "skill" | "team-skill" | "specialist" | "connector" | "session-package";

export type AssetSource = "builtin" | "mindscience" | "manual";

export interface Label {
  en: string;
  zh: string;
}

export interface DownloadRef {
  sha256?: string;
  size?: number;
  /** Companion plain-text artifact (specialists ship both JSON and Markdown). */
  text?: string;
  url: string;
}

/** Reverse relations, resolved at export time so the site never joins at runtime. */
export interface RelatedAsset {
  connectors?: string[];
  skills?: string[];
  specialists?: string[];
}

export interface SkillCategory {
  domain: string;
  subdomain: string;
}

export interface ConnectorCategory {
  function: string;
}

export interface SessionCategory {
  domain?: string;
  source: string;
  task?: string;
}

export interface CategoryNode {
  children?: CategoryNode[];
  count: number;
  id: string;
  label: Label;
}

export interface SkillResource {
  path: string;
  size: number;
}

export interface BaseAsset {
  author: string | null;
  description: string;
  download: DownloadRef;
  id: string;
  kind: AssetKind;
  name: string;
  related?: RelatedAsset;
  source: AssetSource;
  tags: string[];
  version: string | null;
}

export interface SkillAsset extends BaseAsset {
  category: SkillCategory;
  hardware: string | null;
  kind: "skill" | "team-skill";
  /** Specialist names a team skill dispatches; their skills are derived by lookup. */
  members?: string[];
  /** Full SKILL.md body served as a static file and rendered on the detail page. */
  readme: string;
  resources: SkillResource[];
  type: string | null;
}

export interface SpecialistAsset extends BaseAsset {
  connectors: string[];
  download: Required<Pick<DownloadRef, "sha256" | "size" | "text" | "url">>;
  instructions: string;
  kind: "specialist";
  runtime: Record<string, unknown> | null;
  skills: string[];
}

export interface ConnectorTool {
  description: string;
  displayName: string;
  id: string;
  kind: string;
  permission: string;
}

export interface ConnectorAsset extends BaseAsset {
  category: ConnectorCategory;
  config: Record<string, unknown>;
  governance: Record<string, unknown>;
  kind: "connector";
  kinds: string[];
  publisher: string;
  toolCount: number;
  tools: ConnectorTool[];
}

export interface SessionBenchmark {
  caseId: string;
  name: string;
  commit?: string;
  dataset?: string;
  rubric?: string;
  runAt?: string;
  score?: number;
}

/** Counts read from the package's own `manifest.exportProfile`. */
export interface SessionContents {
  artifacts: number;
  executions: number;
  files: number;
  memoryNodes: number;
  messages: number;
  trajectory: "complete" | "summary";
}

export interface SessionRun {
  durationMs?: number;
  model?: string;
  productVersion?: string;
  tokens?: number;
}

export interface SessionAsset extends BaseAsset {
  benchmark: SessionBenchmark;
  category: SessionCategory;
  contents: SessionContents;
  kind: "session-package";
  readme: string;
  run: SessionRun | null;
}

export type Asset = SkillAsset | SpecialistAsset | ConnectorAsset | SessionAsset;

export interface Catalog {
  assets: Asset[];
  categories: {
    connector: CategoryNode[];
    sessionPackage: CategoryNode[];
    skill: CategoryNode[];
  };
  generatedAt: string;
  schemaVersion: 1;
  sources: {
    externalSkills?: { commit: string; fetchedAt: string; ref: string; repo: string };
    sessions?: { count: number; updatedAt: string | null };
  };
}
