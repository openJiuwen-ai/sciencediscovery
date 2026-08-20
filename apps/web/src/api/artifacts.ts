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
  AnalyzePaperVisionRequest,
  Claim,
  ArtifactDerivation,
  ArtifactJob,
  ArtifactPlan,
  ArtifactCandidate,
  ArtifactAnnotation,
  ArtifactReviewRun,
  ChatMessage,
  ReviewCheckpoint,
  ArtifactVersionProvenance,
  MemoryGraphByEdgeResult,
  MemoryGraphChainResult,
  MemoryGraphEdgeType,
  MemoryGraphMatchResponse,
  MemoryGraphNodeLabel,
  MemorySubgraph,
  ArtifactVersionDiff,
  CreateArtifactAnnotationRequest,
  CreateArtifactPlanRequest,
  EvidenceLink,
  McpInvocation,
  PermissionRequest,
  PaperAcquisition,
  PaperVisionRun,
  Session,
  ScientificArtifact,
  ScientificArtifactVersion,
  UploadFileRequest,
  WorkspaceCapabilities,
  WorkspaceFile,
  WorkspaceUploadResult,
} from "@science-agent/schema";
import type { ArtifactDashboard, ArtifactPreviewPayload } from "../artifact-dashboard.js";

import { RunsApiClient } from "./runs.js";

export interface ManualReviewerSpecialistResult {
  checkpoint?: ReviewCheckpoint;
  error?: string;
  message: ChatMessage;
  reviews: ArtifactReviewRun[];
}

export class ArtifactsApiClient extends RunsApiClient {
  listArtifactDerivations(sessionId: string): Promise<ArtifactDerivation[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/artifact-derivations`);
  }

  listMcpArtifactPlans(sessionId: string): Promise<ArtifactPlan[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/mcp/artifact-plans`);
  }

  listMcpArtifactCandidates(sessionId: string): Promise<Array<{ candidate: ArtifactCandidate; invocationId: string }>> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/mcp/artifact-candidates`);
  }

  createMcpArtifactPlan(sessionId: string, body: CreateArtifactPlanRequest): Promise<{
    job?: ArtifactJob;
    permissionRequest?: PermissionRequest;
    plan: ArtifactPlan;
  }> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/mcp/artifact-plans`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  approveMcpArtifactPlan(sessionId: string, planId: string): Promise<{ job: ArtifactJob; plan: ArtifactPlan }> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/mcp/artifact-plans/${encodeURIComponent(planId)}/approve`, {
      method: "POST",
    });
  }

  listMcpArtifactJobs(sessionId: string): Promise<ArtifactJob[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/mcp/artifact-jobs`);
  }

  cancelMcpArtifactJob(sessionId: string, jobId: string): Promise<ArtifactJob> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/mcp/artifact-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
    });
  }

  retryMcpArtifactJob(sessionId: string, jobId: string): Promise<ArtifactJob> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/mcp/artifact-jobs/${encodeURIComponent(jobId)}/retry`, {
      method: "POST",
    });
  }

  listArtifacts(sessionId: string): Promise<ScientificArtifact[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts`);
  }

  listProjectArtifacts(projectId: string): Promise<ScientificArtifact[]> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/artifacts`);
  }

  listProjectArtifactVersions(projectId: string, artifactId: string): Promise<ScientificArtifactVersion[]> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/versions`);
  }

  async readProjectArtifactVersion(projectId: string, versionId: string): Promise<Blob> {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/artifact-versions/${encodeURIComponent(versionId)}/content`,
      { headers: { authorization: `Bearer ${this.token}` } },
    );
    if (!response.ok) {
      this.reportAuthStatus(response.status);
      throw new Error("Could not load artifact version");
    }
    return await response.blob();
  }

  /** Single roundtrip aggregating the whole-session dashboard. */

  getArtifactDashboard(sessionId: string): Promise<ArtifactDashboard> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/artifact-dashboard`);
  }

  /** Per-version structured preview payload routed by `kind`. */

  getArtifactVersionPreview(
    sessionId: string,
    versionId: string,
    params: { maxRows?: number; maxChars?: number; maxCells?: number } = {},
  ): Promise<ArtifactPreviewPayload> {
    const query = new URLSearchParams();
    if (params.maxRows !== undefined) query.set("maxRows", String(params.maxRows));
    if (params.maxChars !== undefined) query.set("maxChars", String(params.maxChars));
    if (params.maxCells !== undefined) query.set("maxCells", String(params.maxCells));
    const suffix = query.toString();
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/artifact-versions/${encodeURIComponent(versionId)}/preview${suffix ? `?${suffix}` : ""}`,
    );
  }

  getMemorySubgraph(sessionId: string): Promise<MemorySubgraph> {
    return this.request(`/api/memory/subgraph?session_id=${encodeURIComponent(sessionId)}`);
  }

  /** Memory-graph health from the aggregated `/health`: "healthy" | "degraded" | "disabled" | "needs-password". */

  getMemoryHealth(): Promise<{ memoryGraph: string }> {
    return this.request("/health");
  }

  // --- Cross-session memory-graph read endpoints ---

  queryMemoryMatch(query: string, sessionId?: string): Promise<MemoryGraphMatchResponse> {
    return this.request("/api/memory/query/match", { body: JSON.stringify({ query, session_id: sessionId }), method: "POST" });
  }

  byMemoryNodeType(nodeTypes: MemoryGraphNodeLabel[], sessionId?: string): Promise<MemoryGraphMatchResponse> {
    return this.request("/api/memory/query/by-node-type", { body: JSON.stringify({ node_types: nodeTypes, session_id: sessionId }), method: "POST" });
  }

  byMemoryEdgeType(edgeTypes: MemoryGraphEdgeType[], sessionId?: string): Promise<MemoryGraphByEdgeResult> {
    return this.request("/api/memory/query/by-edge-type", { body: JSON.stringify({ edge_types: edgeTypes, session_id: sessionId }), method: "POST" });
  }

  getMemoryChain(
    nodeId: string,
    sessionId?: string,
    version?: number,
    chainKind?: "full" | "task" | "artifact",
  ): Promise<MemoryGraphChainResult> {
    return this.request("/api/memory/query/chain", {
      body: JSON.stringify({ node_id: nodeId, session_id: sessionId, version, chain_kind: chainKind ?? "full" }),
      method: "POST",
    });
  }

  listArtifactVersions(sessionId: string, artifactId: string): Promise<ScientificArtifactVersion[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/versions`);
  }

  getArtifactProvenance(sessionId: string, versionId: string): Promise<ArtifactVersionProvenance> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/artifact-versions/${encodeURIComponent(versionId)}/provenance`);
  }

  async getMemoryArtifactProvenance(
    artifactId: string,
    version: number,
    sessionId?: string,
  ): Promise<{ dependencies: Array<{ artifact: ScientificArtifact; version: ScientificArtifactVersion }>; reason?: string }> {
    const params = new URLSearchParams({ artifact_id: artifactId, version: String(version) });
    if (sessionId) params.set("session_id", sessionId);
    const body = await this.request<{
      dependencies?: Array<{
        artifact_id?: string;
        version?: number;
        logical_name?: string | null;
        media_type?: string | null;
        path?: string | null;
      }>;
      reason?: string;
    }>(`/api/memory/query/artifact-provenance?${params}`);
    const dependencies = (body.dependencies ?? []).map((dependency) => {
      const logicalName = dependency.logical_name ?? dependency.path ?? dependency.artifact_id ?? "";
      const mediaType = dependency.media_type ?? "application/octet-stream";
      const dependencyArtifactId = dependency.artifact_id ?? "";
      const dependencyVersion = dependency.version ?? 0;
      return {
        artifact: {
          createdAt: "",
          createdInSessionId: sessionId ?? "",
          createdInSessionTitle: "",
          currentVersion: dependencyVersion,
          id: dependencyArtifactId,
          kind: "dataset" as const,
          logicalName,
          name: logicalName,
          origin: "legacy_auto" as const,
          projectId: "",
          sessionId: sessionId ?? "",
          updatedAt: "",
        },
        version: {
          artifactId: dependencyArtifactId,
          content: { hash: "", size: 0 },
          createdAt: "",
          executionRunIds: [],
          id: `${dependencyArtifactId}#v${dependencyVersion}`,
          inputArtifactVersionIds: [],
          mediaType,
          projectId: "",
          sessionId: sessionId ?? "",
          version: dependencyVersion,
        },
      };
    });
    return { dependencies, ...(body.reason ? { reason: body.reason } : {}) };
  }

  listArtifactReviews(sessionId: string): Promise<ArtifactReviewRun[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/artifact-reviews`);
  }

  runReviewerSpecialist(sessionId: string, messageId: string): Promise<ManualReviewerSpecialistResult> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/reviewer-specialist/review`, {
      body: JSON.stringify({ messageId }),
      method: "POST",
    });
  }

  getArtifactDiff(sessionId: string, versionId: string, againstVersionId?: string): Promise<ArtifactVersionDiff> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/artifact-versions/${encodeURIComponent(versionId)}/diff${againstVersionId ? `?against=${encodeURIComponent(againstVersionId)}` : ""}`);
  }

  listArtifactAnnotations(sessionId: string, versionId: string): Promise<ArtifactAnnotation[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/artifact-versions/${encodeURIComponent(versionId)}/annotations`);
  }

  createArtifactAnnotation(sessionId: string, versionId: string, body: CreateArtifactAnnotationRequest): Promise<ArtifactAnnotation> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/artifact-versions/${encodeURIComponent(versionId)}/annotations`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  async readArtifactVersion(sessionId: string, versionId: string, signal?: AbortSignal): Promise<Blob> {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/artifact-versions/${encodeURIComponent(versionId)}/content`,
      { headers: { authorization: `Bearer ${this.token}` }, signal },
    );
    if (!response.ok) {
      this.reportAuthStatus(response.status);
      throw new Error("Could not load artifact version");
    }
    return await response.blob();
  }

  listPapers(sessionId: string): Promise<PaperAcquisition[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/papers`);
  }

  listMcpInvocations(sessionId: string): Promise<McpInvocation[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/mcp/invocations`);
  }

  uploadPaper(sessionId: string, file: File): Promise<PaperAcquisition> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/papers/upload?title=${encodeURIComponent(file.name)}`, {
      body: file,
      headers: { "content-type": "application/pdf" },
      method: "POST",
    });
  }

  listPaperVisionRuns(sessionId: string): Promise<PaperVisionRun[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/papers/vision-runs`);
  }

  analyzePaperVision(sessionId: string, paperId: string, body: AnalyzePaperVisionRequest): Promise<PaperVisionRun> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/papers/${encodeURIComponent(paperId)}/vision`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  listClaims(sessionId: string): Promise<Claim[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/claims`);
  }

  listEvidenceLinks(sessionId: string): Promise<EvidenceLink[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/evidence-links`);
  }

  listFiles(sessionId: string): Promise<WorkspaceFile[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/files`);
  }

  uploadFile(sessionId: string, body: UploadFileRequest): Promise<WorkspaceFile> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/files`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  uploadWorkspaceFiles(
    sessionId: string,
    files: File[],
    conflict: "reject" | "overwrite" | "rename" = "rename",
  ): Promise<WorkspaceUploadResult> {
    const body = new FormData();
    for (const file of files) body.append("files", file, file.name);
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/workspace/upload?conflict=${encodeURIComponent(conflict)}`,
      { body, method: "POST" },
    );
  }

  getWorkspaceCapabilities(): Promise<WorkspaceCapabilities> {
    return this.request<{ workspace?: WorkspaceCapabilities }>("/api/health").then((health) => ({
      maxFileBytes: health.workspace?.maxFileBytes ?? 1_073_741_824,
      maxRequestBytes: health.workspace?.maxRequestBytes ?? 10_737_418_240,
      maxWorkspaceBytes: health.workspace?.maxWorkspaceBytes ?? 10_737_418_240,
    }));
  }

  async readFile(sessionId: string, path: string, signal?: AbortSignal): Promise<Blob> {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`,
      { headers: { authorization: `Bearer ${this.token}` }, signal },
    );
    if (!response.ok) {
      this.reportAuthStatus(response.status);
      throw new Error(`Could not load ${path}`);
    }
    return await response.blob();
  }

  /** Stop the run currently streaming for this Session; 409 when nothing is running. */
}
