// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { ApiRequestError, type ApiClient } from "./client.js";
import { withResearchPackageIdleTimeout } from "./research-package-stream.js";
import type { ResearchContinuationOperation } from "@sciencediscovery/schema";

export interface PackagePreview {
  revision?: string; estimatedBytes: number; maxBytes?: number; archiveBytes?: number; downloadBytes?: number;
  files: Array<{ path: string; size: number; selected?: boolean }>;
  omissions: string[];
}
export interface PackageInspection {
  manifest: { source: { title: string }; omissions: string[] };
  objectCount: number; recordsBytes: number; packageChecksum?: string;
}
export type CopyOperation = ResearchContinuationOperation;
export interface ExportOperation {
  id: string; status: "queued" | "running" | "completed" | "failed" | "canceled";
  filename: string; error?: string;
}
const projectPath = (id: string) => `/api/projects/${encodeURIComponent(id)}/research-package`;
const sessionPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;
export function packagePreview(client: ApiClient, project: string, session: string, level: string, trajectory: boolean, graph: boolean, files?: string[]) {
  const params = new URLSearchParams({ sessionId: session, level, includeFullTrajectory: trajectory ? "1" : "0", includeFullMemoryGraph: graph ? "1" : "0" });
  if (files) { params.set("customFiles", "1"); files.forEach(path => params.append("filePath", path)); }
  return client.request<PackagePreview>(`${projectPath(project)}/preview?${params}`);
}
export function inspectPackage(client: ApiClient, project: string, file: Blob) {
  return client.request<PackageInspection>(`${projectPath(project)}/inspect`, { method: "POST", body: file, headers: { "content-type": "application/octet-stream" } });
}
export async function importPackage(client: ApiClient, project: string, file: Blob, inspectionChecksum?: string): Promise<{ importedSessionIds: string[]; omissions?: string[] }> {
  const query = inspectionChecksum ? `?inspectionChecksum=${encodeURIComponent(inspectionChecksum)}` : "";
  try { return await client.request(`${projectPath(project)}/import${query}`, { method: "POST", body: inspectionChecksum ? undefined : file, headers: { "content-type": "application/octet-stream" } }); }
  catch (error) {
    if (inspectionChecksum && error instanceof ApiRequestError && error.status === 409 && /inspected package expired/i.test(error.message)) return importPackage(client, project, file);
    throw error;
  }
}
export function startCopy(client: ApiClient, session: string, requestId: string, messageId?: string) {
  return client.request<CopyOperation>(`${sessionPath(session)}/${messageId ? "conversation-branches" : "research-continuations"}`, { method: "POST", body: JSON.stringify({ requestId, ...(messageId ? { messageId } : {}) }) });
}
export function readCopy(client: ApiClient, session: string, id: string) {
  return client.request<CopyOperation>(`${sessionPath(session)}/research-continuations/${encodeURIComponent(id)}`);
}
export function startExport(client: ApiClient, project: string, options: { sessionId: string; revision: string; level: string; includeFullTrajectory: boolean; includeFullMemoryGraph: boolean; filePaths?: string[]; allowOverCap?: boolean }) {
  return client.request<ExportOperation>(`${projectPath(project)}/exports`, { method: "POST", body: JSON.stringify(options) });
}
export function readExport(client: ApiClient, project: string, id: string, signal?: AbortSignal) {
  return client.request<ExportOperation>(`${projectPath(project)}/exports/${encodeURIComponent(id)}`, { signal });
}
export function cancelExport(client: ApiClient, project: string, id: string) {
  return client.request<ExportOperation>(`${projectPath(project)}/exports/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}
/** Open the completed archive as a live response. The caller decides where the
 *  body goes: the shell writes it chunk by chunk through its opaque destination
 *  token, and a plain browser falls back to a browser download. Nothing here
 *  buffers the archive. */
const EXPORT_HEADER_TIMEOUT_MS = 30 * 1000;
const EXPORT_BODY_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export class ResearchPackageDownloadStartTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for research package response headers");
    this.name = "TimeoutError";
  }
}

export async function openExportStream(client: ApiClient, project: string, task: ExportOperation, signal?: AbortSignal): Promise<Response> {
  const timeoutController = new AbortController();
  const headerTimeout = new ResearchPackageDownloadStartTimeoutError();
  const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  const timeout = setTimeout(() => timeoutController.abort(headerTimeout), EXPORT_HEADER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await client.fetchStream(`${projectPath(project)}/exports/${encodeURIComponent(task.id)}/download`, { signal: requestSignal });
  } catch (reason) {
    if (requestSignal.reason === headerTimeout) throw headerTimeout;
    throw reason;
  } finally {
    clearTimeout(timeout);
  }
  return withResearchPackageIdleTimeout(response, EXPORT_BODY_IDLE_TIMEOUT_MS);
}
