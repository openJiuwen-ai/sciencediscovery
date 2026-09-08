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

export interface KeCrawlBudget {
  maxPapers: number;
  maxDepth: number;
  maxPerPaper: number;
}

export interface KeGrowHandle {
  jobId: string;
  cycleId: string;
  reused: boolean;
}

export interface KeFrontierCounts {
  total: number;
  pending: number;
  done: number;
  failed: number;
  skipped: number;
}

/** Engine state persisted at the end of each grow cycle (convergence). */
export interface KeEngineState {
  converged?: boolean;
  cycleId?: string;
  query?: string;
  updatedAt?: string;
  counts?: KeFrontierCounts;
  signals?: {
    conceptSaturation: { met: boolean; newEntities: number; newEdges: number; window: number; insufficientData: boolean };
    citationCoverage: { met: boolean; processed: number; total: number; ratio: number };
    frontierExhaustion: { met: boolean; pending: number; budgetExhausted: boolean };
    boundaryCoverage: {
      met: boolean;
      observed: number;
      f1: number;
      f2: number;
      estimatedTotal: number | null;
      coverage: number | null;
      insufficientData: boolean;
      recallEstimate: { recall: number | null; estimatedTotal: number | null; insufficientData: boolean } | null;
    };
  };
}

export interface KeGrowStatus {
  engineState: KeEngineState;
  activeCycle: { jobId: string; cycleId: string; status: string } | null;
  frontier: KeFrontierCounts | null;
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

  startKeGrow(kbId: string, query?: string, budget?: Partial<KeCrawlBudget>): Promise<KeGrowHandle> {
    return this.request(`/api/knowledge-engine/kbs/${encodeURIComponent(kbId)}/grow`, {
      method: "POST",
      body: JSON.stringify({ query, budget }),
    });
  }

  getKeGrow(kbId: string): Promise<KeGrowStatus> {
    return this.request(`/api/knowledge-engine/kbs/${encodeURIComponent(kbId)}/grow`);
  }

  getKeEntity(entityId: string): Promise<KeEntityDetail> {
    return this.request(`/api/knowledge-engine/entities/${encodeURIComponent(entityId)}`);
  }
}
