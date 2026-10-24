// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { BridgeEnvelope, BridgeScope, PluginManifest, PluginStatus } from "@sciencediscovery/plugin-sdk";
import type { ResearchContinuationOperation, RuntimeSettingsDetails } from "@sciencediscovery/schema";
import { ApiRequestError, AuthApiClient } from "./auth.js";

export interface PluginComposition {
  revision: string; settings: RuntimeSettingsDetails; plugins: PluginManifest[];
  status: PluginStatus[]; applies: "nextRun" | "restart";
}
/** Browser view of the evidence package scope; package codecs remain server-side. */
export interface ResearchPackageExportProfileView {
  level: "necessary" | "complete";
  included: { messages: number; artifactVersions: number; executionRuns: number; trajectoryEvents: number; memoryNodes: number };
  capabilities: { fullTrajectory: boolean };
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

  async exportResearchPackage(projectId: string, sessionId?: string, level: "necessary" | "complete" = "necessary", filePaths?: string[]): Promise<Blob> {
    const params = new URLSearchParams({ level });
    if (sessionId) params.set("sessionId", sessionId);
    if (filePaths) { params.set("customFiles", "1"); for (const path of filePaths) params.append("filePath", path); }
    const query = `?${params.toString()}`;
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/research-package${query}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    this.reportAuthStatus(response.status);
    if (!response.ok) throw new ApiRequestError("Research package export failed", response.status);
    return response.blob();
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

  previewResearchPackage(projectId: string, sessionId: string, level: "necessary" | "complete", filePaths?: string[]): Promise<{ estimatedBytes: number; files: Array<{ path: string; size: number; selected?: boolean }>; omissions: string[]; exportProfile?: ResearchPackageExportProfileView }> {
    const params = new URLSearchParams({ sessionId, level });
    if (filePaths) { params.set("customFiles", "1"); for (const path of filePaths) params.append("filePath", path); }
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/research-package/preview?${params}`);
  }

  inspectResearchPackage(projectId: string, bytes: Blob): Promise<unknown> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/research-package/inspect`, {
      method: "POST",
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  importResearchPackage(projectId: string, bytes: Blob, sessionId?: string): Promise<unknown> {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/research-package/import${query}`, {
      method: "POST",
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  canImportResearchPackage(sessionId: string): Promise<{ canImport: boolean }> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/research-package-import-eligibility`);
  }
}
