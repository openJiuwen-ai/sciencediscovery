// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { BridgeEnvelope, BridgeScope, PluginManifest, PluginStatus } from "@sciencediscovery/plugin-sdk";
import type { ResearchContinuationOperation, RuntimeSettingsDetails } from "@sciencediscovery/schema";
import { ApiRequestError, AuthApiClient } from "./auth.js";
import { translateActive } from "../i18n/index.js";
import { readResearchPackageBlob, withResearchPackageIdleTimeout } from "./research-package-stream.js";

const RESEARCH_PACKAGE_HEADER_TIMEOUT_MS = 30 * 1000;
const RESEARCH_PACKAGE_BODY_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const RESEARCH_PACKAGE_RETRY_DELAYS_MS = [500, 1_500] as const;

function isAbortError(reason: unknown): boolean {
  return typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "AbortError";
}

function isRetryableResearchPackageFailure(reason: unknown): boolean {
  if (reason instanceof ApiRequestError) return reason.status === 502 || reason.status === 503 || reason.status === 504;
  // A fetch TypeError is the browser's usual signal for a connection reset or
  // a response that disappeared before headers. The timeout AbortError is
  // deliberately excluded so a large export does not restart after spending
  // the whole request budget.
  return reason instanceof TypeError && !isAbortError(reason);
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

export interface PluginComposition {
  revision: string; settings: RuntimeSettingsDetails; plugins: PluginManifest[];
  status: PluginStatus[]; applies: "nextRun" | "restart";
}
/** Browser view of the evidence package scope; package codecs remain server-side. */
export interface ResearchPackageExportProfileView {
  level: "necessary" | "complete";
  included: { messages: number; artifactVersions: number; executionRuns: number; trajectoryEvents: number; memoryNodes: number };
  capabilities: { fullTrajectory: boolean; fullMemoryGraph: boolean };
}
export interface ResearchPackageExportTaskView {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  filename: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
const pathFor = (scope: BridgeScope, suffix = "") => `/api/projects/${encodeURIComponent(scope.projectId)}/plugins${suffix}${scope.sessionId ? "?sessionId=" + encodeURIComponent(scope.sessionId) : ""}`;
export class PluginApiClient extends AuthApiClient {
  createConversationBranch(sessionId: string, messageId: string, requestId: string): Promise<ResearchContinuationOperation> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/conversation-branches`, { method: "POST", body: JSON.stringify({ messageId, requestId }) });
  }

  createResearchContinuation(sessionId: string, requestId: string): Promise<ResearchContinuationOperation> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/research-continuations`, { method: "POST", body: JSON.stringify({ requestId }) });
  }

  getResearchContinuation(sessionId: string, operationId: string): Promise<ResearchContinuationOperation> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/research-continuations/${encodeURIComponent(operationId)}`);
  }
  getPluginComposition(scope: BridgeScope): Promise<PluginComposition> {
    return this.request(pathFor(scope));
  }
  async pluginBridge<T>(envelope: BridgeEnvelope): Promise<T> {
    const response = await this.request<{result:T}>(pathFor(envelope.scope, "/bridge"), { method: "POST", body: JSON.stringify(envelope) });
    return response.result;
  }
  /** Fetch, not EventSource: the existing bearer credential stays out of URLs. */
  async subscribePlugins(scope: BridgeScope, changed: () => void, signal: AbortSignal): Promise<void> {
    const response = await fetch(pathFor(scope, "/events"), { headers: { authorization: `Bearer ${this.token}` }, signal });
    this.reportAuthStatus(response.status);
    if (!response.ok) throw new ApiRequestError("Plugin subscription unavailable", response.status);
    if (!response.body) throw new Error("Plugin subscription unavailable");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        pending += decoder.decode(result.value, { stream: true });
        if (pending.length > 64 * 1024) throw new Error("Invalid plugin event frame");
        let boundary;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          if (frame.startsWith("event: changed\n")) changed();
        }
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }

  /**
   * Returns the live response instead of a Blob: a 5 GiB archive must reach the
   * disk through `body`, not through a buffer that has to hold the whole thing.
   */
  async exportResearchPackage(projectId: string, sessionId?: string, level: "necessary" | "complete" = "necessary", filePaths?: string[], includeFullTrajectory = true, includeFullMemoryGraph = false, allowOverCap = false, signal?: AbortSignal): Promise<Response> {
    const params = new URLSearchParams({ level });
    if (allowOverCap) params.set("allowOverCap", "1");
    if (sessionId) params.set("sessionId", sessionId);
    if (!includeFullTrajectory) params.set("includeFullTrajectory", "0");
    params.set("includeFullMemoryGraph", includeFullMemoryGraph ? "1" : "0");
    if (filePaths) { params.set("customFiles", "1"); for (const path of filePaths) params.append("filePath", path); }
    const query = `?${params.toString()}`;
    return this.openResearchPackageResponse(`/api/projects/${encodeURIComponent(projectId)}/research-package${query}`, signal);
  }

  startResearchPackageExport(projectId: string, options: {
    sessionId: string; level: "necessary" | "complete"; filePaths?: string[];
    includeFullTrajectory: boolean; includeFullMemoryGraph: boolean; revision: string; allowOverCap?: boolean;
  }): Promise<ResearchPackageExportTaskView> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/research-package/exports`, {
      method: "POST", body: JSON.stringify(options),
    });
  }

  getResearchPackageExport(projectId: string, taskId: string, signal?: AbortSignal): Promise<ResearchPackageExportTaskView> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/research-package/exports/${encodeURIComponent(taskId)}`, { signal });
  }

  async downloadResearchPackageExport(projectId: string, taskId: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.openResearchPackageResponse(`/api/projects/${encodeURIComponent(projectId)}/research-package/exports/${encodeURIComponent(taskId)}/download`, signal, RESEARCH_PACKAGE_HEADER_TIMEOUT_MS);
    return readResearchPackageBlob(response);
  }

  private async openResearchPackageResponse(path: string, signal?: AbortSignal, headerTimeoutMs?: number): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RESEARCH_PACKAGE_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const timeoutController = headerTimeoutMs === undefined ? undefined : new AbortController();
        const timeout = timeoutController ? setTimeout(() => timeoutController.abort(), headerTimeoutMs) : undefined;
        let response: Response;
        try {
          const requestSignal = timeoutController
            ? signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
            : signal;
          response = await fetch(path, {
            headers: { authorization: `Bearer ${this.token}` },
            signal: requestSignal,
          });
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
        this.reportAuthStatus(response.status);
        if (response.ok) return withResearchPackageIdleTimeout(response, RESEARCH_PACKAGE_BODY_IDLE_TIMEOUT_MS);
        // The refusal carries a stable code so the over-cap dialog can retain
        // its localized explanation. Retry only transient gateway failures.
        const payload = await response.json().catch(() => undefined) as { code?: string } | undefined;
        lastError = new ApiRequestError("Research package export failed", response.status, payload?.code);
        if (!isRetryableResearchPackageFailure(lastError) || attempt === RESEARCH_PACKAGE_RETRY_DELAYS_MS.length) throw lastError;
      } catch (reason) {
        lastError = reason;
        if (!isRetryableResearchPackageFailure(reason) || attempt === RESEARCH_PACKAGE_RETRY_DELAYS_MS.length) throw reason;
      }
      await waitForRetry(RESEARCH_PACKAGE_RETRY_DELAYS_MS[attempt]!);
    }
    throw lastError instanceof Error ? lastError : new Error("Research package export failed");
  }

  async exportConversation(sessionId: string, format: "markdown" | "pdf", messageIds?: string[]): Promise<Blob> {
    const params = new URLSearchParams({ format, ...(messageIds ? { scope: "custom" } : {}) });
    for (const id of messageIds ?? []) params.append("messageId", id);
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/conversation-export?${params}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    this.reportAuthStatus(response.status);
    if (!response.ok) throw new ApiRequestError("Conversation export failed", response.status);
    return response.blob();
  }

  previewResearchPackage(projectId: string, sessionId: string, level: "necessary" | "complete", filePaths?: string[], includeFullTrajectory = true, includeFullMemoryGraph = true, signal?: AbortSignal): Promise<{ revision?: string; estimatedBytes: number; estimateKind?: "uncompressed"; files: Array<{ path: string; size: number; selected?: boolean }>; omissions: string[]; exportProfile?: ResearchPackageExportProfileView; maxBytes?: number; archiveBytes?: number }> {
    const params = new URLSearchParams({ sessionId, level });
    if (filePaths) { params.set("customFiles", "1"); for (const path of filePaths) params.append("filePath", path); }
    if (!includeFullTrajectory) params.set("includeFullTrajectory", "0");
    params.set("includeFullMemoryGraph", includeFullMemoryGraph ? "1" : "0");
    return this.requestResearchPackagePreview(`/api/projects/${encodeURIComponent(projectId)}/research-package/preview?${params}`, signal);
  }

  async getResearchPackagePreviews(projectId: string, sessionId: string, signal?: AbortSignal): Promise<{
    revision: string;
    necessary: Awaited<ReturnType<PluginApiClient["previewResearchPackage"]>>;
    complete: Awaited<ReturnType<PluginApiClient["previewResearchPackage"]>>;
    completeWithTrajectory: Awaited<ReturnType<PluginApiClient["previewResearchPackage"]>>;
    completeWithMemoryGraph: Awaited<ReturnType<PluginApiClient["previewResearchPackage"]>>;
    completeWithTrajectoryAndMemoryGraph: Awaited<ReturnType<PluginApiClient["previewResearchPackage"]>>;
  }> {
    return this.requestResearchPackagePreview(`/api/projects/${encodeURIComponent(projectId)}/research-package/preview?${new URLSearchParams({ sessionId, defaults: "1" })}`, signal);
  }

  private async requestResearchPackagePreview<T>(path: string, signal?: AbortSignal): Promise<T> {
    try {
      const result = await this.request<T | { code: "EXPORT_PREVIEW_PENDING" } | { state: "deleted" }>(path, { signal, headers: { Prefer: "respond-async" } });
      if (result && typeof result === "object" && "code" in result && result.code === "EXPORT_PREVIEW_PENDING") {
        throw new ApiRequestError(translateActive("researchPackage.previewPending"), 202, result.code);
      }
      // The Project or Session was deleted while it was being polled. The API
      // answers that as a normal end of polling rather than a resource error,
      // and polling callers stop on this error instead of asking again (#1072).
      if (result && typeof result === "object" && "state" in result && result.state === "deleted") {
        throw new ApiRequestError(translateActive("researchPackage.resourceDeleted"), 410, "EXPORT_PREVIEW_RESOURCE_DELETED");
      }
      return result as T;
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "EXPORT_PREVIEW_PENDING") {
        throw new ApiRequestError(translateActive("researchPackage.previewPending"), error.status, error.code, error.details);
      }
      throw error;
    }
  }

  inspectResearchPackage(projectId: string, bytes: Blob): Promise<unknown> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/research-package/inspect`, {
      method: "POST",
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  async importResearchPackage(projectId: string, bytes: Blob, sessionId?: string, inspectionChecksum?: string): Promise<unknown> {
    const params = new URLSearchParams();
    if (sessionId) params.set("sessionId", sessionId);
    if (inspectionChecksum) params.set("inspectionChecksum", inspectionChecksum);
    const query = params.toString() ? `?${params}` : "";
    const path = `/api/projects/${encodeURIComponent(projectId)}/research-package/import${query}`;
    try {
      return await this.request(path, { method: "POST", body: inspectionChecksum ? undefined : bytes, headers: { "content-type": "application/octet-stream" } });
    } catch (error) {
      // The short-lived server cache is only an optimization. If the API was
      // restarted or the review expired, transparently fall back to uploading
      // the original file once.
      if (!inspectionChecksum || (error as { status?: number }).status !== 409) throw error;
      return this.request(`/api/projects/${encodeURIComponent(projectId)}/research-package/import${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, {
        method: "POST", body: bytes, headers: { "content-type": "application/octet-stream" },
      });
    }
  }

  canImportResearchPackage(sessionId: string): Promise<{ canImport: boolean }> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/research-package-import-eligibility`);
  }
}
