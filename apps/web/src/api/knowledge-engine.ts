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

import { EvolveApiClient } from "./evolve.js";

export interface KeKbStats {
  documents: number;
  documentsReady: number;
  documentsError: number;
  entities: number;
  edges: number;
}

export interface KeKb {
  id: string;
  name: string;
  description: string;
  engineState: unknown;
  createdAt: string;
  stats?: KeKbStats;
}

export interface KeDocument {
  id: string;
  kbId: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  abstract: string | null;
  status: "pending" | "ready" | "error";
  sourceUri: string | null;
  ingestChannel: string | null;
  extractedAt: string | null;
  createdAt: string;
}

export interface KeJob {
  id: string;
  type: string;
  status: "pending" | "running" | "succeeded" | "failed" | "dead";
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KeGraphEntity {
  id: string;
  name: string;
  type: string;
  supportCount: number;
  trustLevel: string;
  communityId: number | null;
}

export interface KeGraphEdge {
  id: string;
  srcId: string;
  dstId: string;
  type: string;
  supportCount: number;
}

export interface KeGraph {
  entities: KeGraphEntity[];
  edges: KeGraphEdge[];
}

export interface KeEntityDetail {
  entity: KeGraphEntity & {
    description: string | null;
    aliases: string[];
    hasEmbedding: boolean;
    firstSeenDoc: string | null;
    createdAt: string;
  };
  edges: Array<KeGraphEdge & { evidenceQuote: string | null }>;
  neighbors: KeGraphEntity[];
  evidence: Array<{
    edgeId: string;
    type: string;
    otherId: string;
    quote: string | null;
    docId: string | null;
    docTitle: string | null;
  }>;
}

/** `/api/knowledge-engine` — knowledge base graph, seeding and job status. */
export class KnowledgeEngineApiClient extends EvolveApiClient {

  listKeKbs(): Promise<{ kbs: KeKb[] }> {
    return this.request("/api/knowledge-engine/kbs");
  }

  createKeKb(name: string, description?: string): Promise<KeKb> {
    return this.request("/api/knowledge-engine/kbs", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    });
  }

  getKeKb(kbId: string): Promise<KeKb> {
    return this.request(`/api/knowledge-engine/kbs/${encodeURIComponent(kbId)}`);
  }

  seedKeKb(kbId: string, query: string, maxPapers = 10): Promise<{ jobId: string; enqueued: boolean }> {
    return this.request(`/api/knowledge-engine/kbs/${encodeURIComponent(kbId)}/seed`, {
      method: "POST",
      body: JSON.stringify({ query, maxPapers }),
    });
  }

  listKeDocuments(kbId: string): Promise<{ documents: KeDocument[] }> {
    return this.request(`/api/knowledge-engine/kbs/${encodeURIComponent(kbId)}/documents`);
  }

  listKeJobs(kbId: string): Promise<{ jobs: KeJob[] }> {
    return this.request(`/api/knowledge-engine/kbs/${encodeURIComponent(kbId)}/jobs`);
  }

  getKeGraph(kbId: string): Promise<KeGraph> {
    return this.request(`/api/knowledge-engine/kbs/${encodeURIComponent(kbId)}/graph`);
  }

  getKeEntity(entityId: string): Promise<KeEntityDetail> {
    return this.request(`/api/knowledge-engine/entities/${encodeURIComponent(entityId)}`);
  }
}
