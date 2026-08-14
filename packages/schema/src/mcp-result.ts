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

import type { ArtifactCandidate } from "./artifact.js";
import type { McpSourceId, McpToolId } from "./mcp-source.js";

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface McpCitation {
  identifier: string;
  identifierType: string;
  label: string;
  markdown: string;
  role: "database-record" | "dataset" | "preprint" | "primary-literature" | "supporting-literature";
  source: string;
  sourceVersion?: string;
  url: string;
}

export type McpContentScope =
  | "abstract"
  | "analysis-result"
  | "curated-record"
  | "metadata"
  | "structured-record";

export interface McpRecord {
  abstract?: string;
  authors?: string[];
  citations: McpCitation[];
  contentScope: McpContentScope;
  crossReferences: Array<{
    identifier: string;
    source: string;
    url?: string;
  }>;
  fullTextRetrieved: boolean;
  identifier: string;
  identifierType: string;
  peerReviewStatus?: "not-applicable" | "peer-reviewed" | "preprint" | "unknown";
  primaryCitation: McpCitation;
  source: McpSourceId;
  structuredData: JsonValue;
  title: string;
  url: string;
  warnings: string[];
  year?: string;
}

export interface McpToolResult {
  artifacts?: ArtifactCandidate[];
  attribution: string;
  data?: JsonValue;
  license: string;
  records: McpRecord[];
  retrievedAt: string;
  sourceId: McpSourceId;
  sourceVersion?: string;
  toolId: McpToolId;
  untrusted: true;
  warnings: string[];
}
