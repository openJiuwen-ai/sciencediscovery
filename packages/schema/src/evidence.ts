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

import type { CasObjectRef } from "./provenance.js";

/**
 * Evidence is global provenance state, not an MCP transport result.
 * An MCP record becomes Evidence only when a claim or review actually uses it.
 */
export type EvidenceOrigin =
  | {
      invocationId: string;
      kind: "mcp-record";
      recordIdentifier: string;
      sourceId: string;
    }
  | {
      kind: "paper";
      locator?: {
        page?: number;
        quoteHash?: string;
        section?: string;
      };
      paperId: string;
    }
  | {
      executionRunId: string;
      kind: "execution";
      outputRef?: CasObjectRef;
    }
  | {
      artifactId: string;
      artifactVersion: number;
      kind: "artifact";
      path?: string;
    }
  | {
      kind: "remote-job";
      outputPath?: string;
      remoteJobId: string;
    }
  | {
      attachmentPath?: string;
      kind: "user-input";
      messageId: string;
    };

export interface EvidenceItem {
  citation?: string;
  contentRef?: CasObjectRef;
  createdAt: string;
  id: string;
  origin: EvidenceOrigin;
  sessionId: string;
  summary?: string;
  title: string;
  turnId: string;
}

export type EvidenceRelation = "context" | "contradicts" | "supports";
