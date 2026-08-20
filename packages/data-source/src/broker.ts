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

import { createHash, randomUUID } from "node:crypto";

import {
  type JsonValue,
  type McpError,
  type McpInvocation,
  type McpRawResult,
  type McpRetryPolicy,
  type McpToolResult,
  type PermissionAction,
  type PermissionAuthorization,
  type ProxyPolicy,
  type ResolvedProxy,
  type ResolvedRuntimeSettings,
  type ResultCachePolicy,
} from "@science-agent/schema";
import type { McpSourceRegistry } from "@science-agent/mcp-sources";
import { CasStore } from "@science-agent/cas";

import type { MemoryGraphSink } from "@science-agent/memory";
import {
  ResourceRateLimiter,
  ResourceRateLimitQueueFullError,
  ResourceRateLimitQueueTimeoutError,
} from "./resource-rate-limiter.js";
import { McpResultCache } from "./result-cache.js";
import { McpSourceCatalog } from "./catalog.js";
import type { McpTransportClient } from "./transport.js";

/** Persistence and settings boundary required by the governed MCP domain. */
export interface McpBrokerStore {
  appendMcpInvocation(invocation: McpInvocation): Promise<void>;
  assertSessionWritable(sessionId: string): void;
  mcpProxyPolicy(serverId: string): ProxyPolicy;
  resolveProxy(policy?: ProxyPolicy): ResolvedProxy;
  resolveRuntimeSettings(sessionId: string): ResolvedRuntimeSettings;
}

export interface InvokeMcpToolRequest {
  allowedSourceIds?: string[];
  authorize?: (
    action: PermissionAction,
    resource: string,
    summary: string,
    signal?: AbortSignal,
  ) => Promise<PermissionAuthorization | void>;
  input: JsonValue;
  projectId: string;
  sessionId: string;
  signal?: AbortSignal;
  sourceId: string;
  /**
   * Reviewer-only read path: persist the governed invocation for audit, but
   * do not mirror search results into the Memory Graph.
   */
  suppressMemoryGraphMirror?: boolean;
  toolCallId: string;
  toolId: string;
  turnId: string;
}

export interface InvokeMcpToolResponse {
  invocation: McpInvocation;
  result: McpToolResult;
}

export class McpInvocationError extends Error {
  constructor(
    message: string,
    readonly invocation: McpInvocation,
  ) {
    super(message);
    this.name = "McpInvocationError";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function renderTemplate(template: string, input: JsonValue): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => {
    const value = input[key];
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : match;
  });
}

function cachePolicy(
  base: ResultCachePolicy,
  override: Partial<ResultCachePolicy> | undefined,
): ResultCachePolicy {
  return { ...base, ...override };
}

function cacheScopeId(policy: ResultCachePolicy, request: InvokeMcpToolRequest): string | undefined {
  if (policy.scope === "project") return request.projectId;
  if (policy.scope === "session") return request.sessionId;
  return undefined;
}

function cacheKey(options: {
  adapterVersion: string;
  input: JsonValue;
  scopeId?: string;
  sourceId: string;
  toolId: string;
}): string {
  return createHash("sha256").update(canonicalJson(options)).digest("hex");
}

function invocationError(code: McpError["code"], message: string, retryable = false): McpError {
  return { code, message: message.slice(0, 1_000), retryable };
}

function upstreamError(response: {
  attempts: Array<{ errorCode?: string; errorMessage?: string; retryAfterMs?: number; status: string }>;
  content: Array<{ text?: string; type: string }>;
}): McpError {
  const last = response.attempts.at(-1);
  const message = last?.errorMessage
    ?? response.content.find((item) => item.type === "text")?.text
    ?? "MCP tool failed";
  const code = ({
    "rate-limited": "RATE_LIMITED",
    timeout: "TIMEOUT",
    "transport-error": "UPSTREAM_UNAVAILABLE",
    "server-error": "UPSTREAM_UNAVAILABLE",
  } as const)[last?.status ?? ""] ?? "UPSTREAM_UNAVAILABLE";
  if (last?.errorCode === "RESPONSE_TOO_LARGE") {
    return { code: "RESPONSE_TOO_LARGE", message: message.slice(0, 1_000), retryable: false };
  }
  if (last?.errorCode === "UNAUTHORIZED") {
    return { code: "UNAUTHORIZED", message: message.slice(0, 1_000), retryable: false };
  }
  if (last?.errorCode === "NOT_FOUND") {
    return { code: "NOT_FOUND", message: message.slice(0, 1_000), retryable: false };
  }
  return {
    code,
    message: message.slice(0, 1_000),
    ...(last?.retryAfterMs !== undefined ? { retryAfterMs: last.retryAfterMs } : {}),
    retryable: ["rate-limited", "timeout", "transport-error", "server-error"].includes(last?.status ?? ""),
    ...(last?.errorCode ? { upstreamCode: last.errorCode } : {}),
  };
}

export class McpGovernanceBroker {
  readonly cas: CasStore;
  private readonly cache: McpResultCache;
  private readonly limiter: ResourceRateLimiter;
  private readonly memoryGraphSink: MemoryGraphSink | null;

  constructor(
    dataDir: string,
    private readonly store: McpBrokerStore,
    private readonly registry: McpSourceRegistry,
    private readonly catalog: McpSourceCatalog,
    private readonly gateway: McpTransportClient,
    options: {
      cache?: McpResultCache;
      limiter?: ResourceRateLimiter;
      memoryGraphSink?: MemoryGraphSink | null;
    } = {},
  ) {
    this.cas = new CasStore(dataDir);
    this.cache = options.cache ?? new McpResultCache(dataDir);
    this.limiter = options.limiter ?? new ResourceRateLimiter();
    this.memoryGraphSink = options.memoryGraphSink ?? null;
  }

  private async appendFailure(options: {
    attempts?: McpInvocation["attempts"];
    cacheKey: string;
    error: McpError;
    permissionAuthorizationId?: string;
    queueWaitMs?: number;
    rawResponse?: McpInvocation["rawResponse"];
    request: InvokeMcpToolRequest;
    requestRef: McpInvocation["request"];
    startedAt: string;
  }): Promise<McpInvocation> {
    const source = this.registry.get(options.request.sourceId);
    const tool = this.registry.getTool(options.request.sourceId, options.request.toolId);
    const invocation: McpInvocation = {
      adapterVersion: source.manifest.version,
      attempts: options.attempts ?? [],
      attribution: source.manifest.governance.attribution,
      cache: { hit: false, key: options.cacheKey, scope: source.manifest.cache.scope },
      error: options.error,
      finishedAt: new Date().toISOString(),
      id: randomUUID(),
      license: source.manifest.governance.license,
      ...(source.manifest.transport.mcpServerId ? { mcpServerId: source.manifest.transport.mcpServerId } : {}),
      ...(tool.mcpToolName ? { mcpToolName: tool.mcpToolName } : {}),
      ...(options.permissionAuthorizationId ? { permissionAuthorizationId: options.permissionAuthorizationId } : {}),
      projectId: options.request.projectId,
      ...(options.queueWaitMs !== undefined ? { queueWaitMs: options.queueWaitMs } : {}),
      ...(options.rawResponse ? { rawResponse: options.rawResponse } : {}),
      request: options.requestRef,
      resultCount: 0,
      sessionId: options.request.sessionId,
      sourceId: options.request.sourceId,
      startedAt: options.startedAt,
      status: "failed",
      toolCallId: options.request.toolCallId,
      toolId: options.request.toolId,
      transport: source.manifest.transport.type,
      turnId: options.request.turnId,
    };
    await this.store.appendMcpInvocation(invocation);
    return invocation;
  }

  async invoke(request: InvokeMcpToolRequest): Promise<InvokeMcpToolResponse> {
    this.store.assertSessionWritable(request.sessionId);
    const source = this.registry.get(request.sourceId);
    const tool = this.registry.getTool(request.sourceId, request.toolId);
    const settings = this.store.resolveRuntimeSettings(request.sessionId).effective;
    const enabledSourceIds = request.allowedSourceIds ?? settings.enabledConnectorIds;
    if (!enabledSourceIds.includes(request.sourceId)) {
      throw new Error(`MCP source ${request.sourceId} is not enabled for this session`);
    }
    const validated = source.validateInput(request.toolId, request.input);
    if (!validated.valid) {
      throw new Error(validated.issues.map((issue) => `${issue.path || "input"}: ${issue.message}`).join("; "));
    }
    const input = validated.input;
    const policy = cachePolicy(source.manifest.cache, tool.cachePolicy);
    const scopeId = cacheScopeId(policy, request);
    const key = cacheKey({
      adapterVersion: source.manifest.version,
      input,
      ...(scopeId ? { scopeId } : {}),
      sourceId: request.sourceId,
      toolId: request.toolId,
    });
    const startedAt = new Date().toISOString();
    const requestRef = await this.cas.put(canonicalJson({
      input,
      sourceId: request.sourceId,
      toolId: request.toolId,
    }));
    let permission: PermissionAuthorization | void;
    try {
      permission = await request.authorize?.(
        tool.permission.action,
        renderTemplate(tool.permission.resourceTemplate, input),
        renderTemplate(tool.permission.summaryTemplate, input),
        request.signal,
      );
    } catch (error) {
      const denied = invocationError(
        "PERMISSION_DENIED",
        error instanceof Error ? error.message : "MCP permission was denied",
        false,
      );
      const invocation = await this.appendFailure({
        cacheKey: key,
        error: denied,
        request,
        requestRef,
        startedAt,
      });
      throw new McpInvocationError(denied.message, invocation);
    }
    const permissionAuthorizationId = permission?.id;

    if (policy.enabled) {
      const cached = this.cache.get(key);
      if (cached) {
        const invocation: McpInvocation = {
          adapterVersion: source.manifest.version,
          attempts: [],
          attribution: source.manifest.governance.attribution,
          cache: { hit: true, key, scope: policy.scope },
          finishedAt: new Date().toISOString(),
          id: randomUUID(),
          license: source.manifest.governance.license,
          normalizedResult: cached.normalizedResult,
          ...(permissionAuthorizationId ? { permissionAuthorizationId } : {}),
          projectId: request.projectId,
          rawResponse: cached.rawResponse,
          request: requestRef,
          resultCount: cached.result.records.length,
          sessionId: request.sessionId,
          sourceId: request.sourceId,
          ...(cached.result.sourceVersion ? { sourceVersion: cached.result.sourceVersion } : {}),
          startedAt,
          status: "succeeded",
          toolCallId: request.toolCallId,
          toolId: request.toolId,
          transport: source.manifest.transport.type,
          turnId: request.turnId,
        };
        await this.store.appendMcpInvocation(invocation);
        // A cache hit still returns Papers the LLM will cite, so mirror it to
        // the memory graph exactly like the uncached path below — otherwise a
        // re-run of the same search produces no Paper nodes, declare_evidence
        // then 422s on source_paper_not_found, and claims lose their evidence.
        if (tool.kind === "search" && !request.suppressMemoryGraphMirror) {
          this.memoryGraphSink?.observeMcpInvocation({
            invocationId: invocation.id,
            sessionId: request.sessionId,
            turnId: request.turnId,
            source: request.sourceId,
            toolType: request.toolId,
            retrievedAt: invocation.finishedAt,
            records: cached.result.records.map((record) => ({
              url: record.url,
              title: record.title,
              identifier: record.identifier,
              identifierType: record.identifierType,
              year: record.year,
              authors: record.authors,
              abstract: record.abstract,
              source: record.source,
            })),
          });
        }
        return { invocation, result: structuredClone(cached.result) };
      }
    }

    const governance = source.manifest.governance;
    const minIntervalMs = governance.minIntervalMs
      ?? (governance.rateLimitPerSecond !== undefined
        ? Math.ceil(1_000 / governance.rateLimitPerSecond)
        : undefined);
    let lease: Awaited<ReturnType<ResourceRateLimiter["acquire"]>>;
    try {
      lease = await this.limiter.acquire(governance.rateLimitGroup, {
        maxConcurrent: governance.maxConcurrentRequests,
        maxQueueDepth: governance.maxQueueDepth,
        minIntervalMs,
        queueTimeoutMs: governance.queueTimeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      if (error instanceof ResourceRateLimitQueueFullError
        || error instanceof ResourceRateLimitQueueTimeoutError) {
        const full = error instanceof ResourceRateLimitQueueFullError;
        const rateError: McpError = {
          code: full ? "RATE_LIMIT_QUEUE_FULL" : "RATE_LIMIT_QUEUE_TIMEOUT",
          message: full
            ? `${request.sourceId} is receiving too many parallel requests and its wait queue is full. `
              + "Reduce parallel calls to this source and retry later."
            : `${request.sourceId} is rate limited and no slot became free within the wait window. `
              + "The source is busy; retry later or reduce parallel calls.",
          retryable: true,
        };
        const invocation = await this.appendFailure({
          cacheKey: key,
          error: rateError,
          ...(permissionAuthorizationId ? { permissionAuthorizationId } : {}),
          ...(error instanceof ResourceRateLimitQueueTimeoutError
            ? { queueWaitMs: error.queueWaitMs }
            : {}),
          request,
          requestRef,
          startedAt,
        });
        throw new McpInvocationError(rateError.message, invocation);
      }
      throw error;
    }
    const queueWaitMs = Math.round(lease.queueWaitMs);

    let result: McpToolResult;
    let attempts: McpInvocation["attempts"] = [];
    let rawResponse: McpInvocation["rawResponse"];
    let mcpCatalogRevision: string | undefined;

    try {
      if (!this.catalog.getCatalog()) await this.catalog.refresh(request.signal);
      const status = this.catalog.getStatus(request.sourceId);
      if (!status.availableTools.includes(request.toolId)) {
        throw new Error(status.error ?? `MCP tool is unavailable: ${request.sourceId}/${request.toolId}`);
      }
      const serverId = source.manifest.transport.mcpServerId;
      const toolName = tool.mcpToolName;
      if (!toolName) throw new Error("MCP source transport is incomplete");
      mcpCatalogRevision = this.catalog.getCatalog()?.revision;
      const response = await this.gateway.invoke({
        arguments: input,
        context: {
          projectId: request.projectId,
          sessionId: request.sessionId,
          toolCallId: request.toolCallId,
          turnId: request.turnId,
        },
        execution: {
          maxResponseBytes: source.manifest.governance.maxResponseBytes,
          retryPolicy: tool.retryPolicy as McpRetryPolicy,
          timeoutMs: tool.timeoutMs,
        },
        // Per-server policy resolved through the global registry; the gateway
        // applies it to the server's outbound transport (stdio env overlay).
        proxy: this.store.resolveProxy(this.store.mcpProxyPolicy(serverId)),
        requestId: randomUUID(),
        serverId,
        toolName,
      }, request.signal);
      attempts = response.attempts;
      // Feed upstream throttling back into the limiter so queued peers slow
      // down instead of hitting the same 429 wall.
      const throttled = attempts.findLast((attempt) => attempt.status === "rate-limited");
      if (throttled) {
        this.limiter.reportUpstreamRateLimit(governance.rateLimitGroup, throttled.retryAfterMs);
      }
      rawResponse = await this.cas.put(JSON.stringify(response));
      if (response.isError) {
        const error = upstreamError(response);
        const invocation = await this.appendFailure({
          attempts,
          cacheKey: key,
          error,
          ...(permissionAuthorizationId ? { permissionAuthorizationId } : {}),
          queueWaitMs,
          rawResponse,
          request,
          requestRef,
          startedAt,
        });
        throw new McpInvocationError(error.message, invocation);
      }
      const raw: McpRawResult = {
        content: response.content,
        isError: false,
        ...(response.structuredContent !== undefined ? { structuredContent: response.structuredContent } : {}),
      };
      result = await source.normalizeResult({
        retrievedAt: new Date().toISOString(),
        source: source.manifest,
        tool,
      }, raw);
    } catch (error) {
      if (error instanceof McpInvocationError) throw error;
      const normalizedError = invocationError(
        error instanceof DOMException && error.name === "AbortError" ? "CANCELLED" : "UPSTREAM_UNAVAILABLE",
        error instanceof Error ? error.message : String(error),
        true,
      );
      const invocation = await this.appendFailure({
        attempts,
        cacheKey: key,
        error: normalizedError,
        ...(permissionAuthorizationId ? { permissionAuthorizationId } : {}),
        queueWaitMs,
        ...(rawResponse ? { rawResponse } : {}),
        request,
        requestRef,
        startedAt,
      });
      throw new McpInvocationError(normalizedError.message, invocation);
    } finally {
      lease.release();
    }

    const normalizedResult = await this.cas.put(JSON.stringify(result));
    rawResponse ??= await this.cas.put(JSON.stringify(result));
    if (policy.enabled) {
      this.cache.put({
        cacheKey: key,
        normalizedResult,
        policy,
        rawResponse,
        result,
        ...(scopeId ? { scopeId } : {}),
      });
    }
    const invocation: McpInvocation = {
      adapterVersion: source.manifest.version,
      attempts,
      attribution: source.manifest.governance.attribution,
      cache: { hit: false, key, scope: policy.scope },
      finishedAt: new Date().toISOString(),
      id: randomUUID(),
      license: source.manifest.governance.license,
      ...(mcpCatalogRevision ? { mcpCatalogRevision } : {}),
      ...(source.manifest.transport.mcpServerId ? { mcpServerId: source.manifest.transport.mcpServerId } : {}),
      ...(tool.mcpToolName ? { mcpToolName: tool.mcpToolName } : {}),
      normalizedResult,
      ...(permissionAuthorizationId ? { permissionAuthorizationId } : {}),
      projectId: request.projectId,
      queueWaitMs,
      rawResponse,
      request: requestRef,
      resultCount: result.records.length,
      sessionId: request.sessionId,
      sourceId: request.sourceId,
      ...(result.sourceVersion ? { sourceVersion: result.sourceVersion } : {}),
      startedAt,
      status: "succeeded",
      toolCallId: request.toolCallId,
      toolId: request.toolId,
      transport: source.manifest.transport.type,
      turnId: request.turnId,
    };
    await this.store.appendMcpInvocation(invocation);
    // Mirror the search to the memory graph (fire-and-forget): one auto-inferred
    // SubTask per search + Paper nodes deduped by normalized URL + produces
    // edges. Only `search`-kind tools produce Papers — `lookup`/`prepare_*`
    // (fetch-a-single-record) and `artifact-plan`/`analysis` tools are not
    // literature searches and must not spawn a SubTask + Paper nodes. Disabled/
    // unreachable memory-graph never breaks the search (the sink no-ops).
    if (tool.kind === "search" && !request.suppressMemoryGraphMirror) {
      this.memoryGraphSink?.observeMcpInvocation({
        invocationId: invocation.id,
        sessionId: request.sessionId,
        turnId: request.turnId,
        source: request.sourceId,
        toolType: request.toolId,
        retrievedAt: result.retrievedAt,
        records: result.records.map((record) => ({
          url: record.url,
          title: record.title,
          identifier: record.identifier,
          identifierType: record.identifierType,
          year: record.year,
          authors: record.authors,
          abstract: record.abstract,
          source: record.source,
        })),
      });
    }
    return {
      invocation,
      result: structuredClone(result),
    };
  }
}
