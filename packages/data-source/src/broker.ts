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
  type McpRecord,
  type McpRetryPolicy,
  type McpToolResult,
  type PermissionAction,
  type PermissionAuthorization,
  type ProxyPolicy,
  type ResolvedProxy,
  type ResolvedRuntimeSettings,
  type ResultCachePolicy,
  type ToolGraphProduct,
  toolGraphSpec,
} from "@sciencediscovery/schema";
import { filterEnabledMcpSources, type McpSourceRegistry } from "@sciencediscovery/mcp-sources";
import { CasStore } from "@sciencediscovery/cas";

import type {
  MemoryGraphSink,
  MemoryGraphToolCallProduct,
} from "@sciencediscovery/memory";
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
  /** When set, this search ran inside a subagent: products hang off the
   * subagent's child SubTask instead of a per-search SubTask. Absent in
   * main-agent context — behavior unchanged. */
  parentSubagentId?: string;
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

/** Pull a tool's page body out of the raw MCP response.
 *
 *  llm-wiki get_page returns a single-page payload ``{ content: "..." }``;
 *  get_pages returns a multi-page payload ``{ pages: [{content: "..."}, ...] }``.
 *  The body never enters ``normalizeResult``'s ``McpRecord`` shape, so the
 *  mirror re-reads it here — one extraction shared by the cached and live
 *  paths. Returns one text per record so multi-page calls don't smear the
 *  first page's body across every record (a per-record array is the only
 *  shape that keeps the page-to-CAS mapping correct).
 *  Search tools have no body → ``undefined`` (their WebPage products stay
 *  snippet-only). ``JSON.parse`` failures / non-string content also yield
 *  ``undefined``: a malformed body must degrade to a hash-less page, never
 *  break the call. ``recordsCount`` lets the test (and future callers)
 *  pin the alignment contract: when the upstream wiki drops empty pages
 *  between extract and normalize, records[] can outnumber pages[] — the
 *  returned array pads with "" past its end so the per-record text is
 *  always index-aligned, never smeared from an earlier slot.
 *  Known limit: this assumes prefix-alignment (the wiki may only drop
 *  pages from the tail, not the middle). If a future upstream drops a
 *  page from the middle of pages[], record indices would shift and
 *  page-(i+1)'s body would still land on record-i+1; a stable identifier
 *  join would be the next move if that case is observed. */
export function extractRawTexts(
  raw: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown },
  toolId: string,
  recordsCount: number = 0,
): string[] | undefined {
  if (toolId !== "get_page" && toolId !== "get_pages") return undefined;
  let payload: unknown = raw.structuredContent;
  if (payload === undefined) {
    const text = raw.content?.find((block) => block.type === "text");
    if (text?.text === undefined) return undefined;
    try {
      payload = JSON.parse(text.text);
    } catch {
      return undefined;
    }
  }
  if (payload === null || typeof payload !== "object") return undefined;
  const obj = payload as Record<string, unknown>;
  // get_pages: { pages: [{content: "..."}, ...] } — one text per record, in
  // order. Pages without a string content contribute an empty slot, not a
  // skipped entry, so the indices still line up with records. If records
  // outnumber pages (the upstream wiki dropped empty pages), pad with ""
  // so the tail records land hash-less instead of smearing an earlier slot.
  if (Array.isArray(obj.pages)) {
    const slots = obj.pages.map((p) => {
      const c = p !== null && typeof p === "object" ? (p as Record<string, unknown>).content : undefined;
      return typeof c === "string" && c.length > 0 ? c : "";
    });
    while (slots.length < recordsCount) slots.push("");
    return slots;
  }
  // get_page (single page): { content: "..." } — share that one text across
  // every record. Multi-record responses on this shape are uncommon (each
  // tool call usually has one page), but the mirror must not drop pages.
  if (typeof obj.content === "string" && obj.content.length > 0) {
    return [obj.content];
  }
  return undefined;
}

/** Map one normalized ``McpRecord`` onto the memory-graph product shape that
 *  the sidecar's ``/observe/tool-call`` expects, driven by the registry's
 *  ``product`` for the tool (paper / web_page / db_record; ``code`` never
 *  reaches the MCP mirror path).
 *
 *  The dispatch is exhaustive on purpose. It used to branch on the graph
 *  *type* with a bare fallthrough to db_record, so any newly registered tool
 *  whose type was not spelled out above silently landed as a DbRecord. The
 *  shapes below are the only ones this path can build, so anything else
 *  throws and the caller's catch drops the mirror (a wrong-typed node is
 *  worse than a missing one: it surfaces later as a 422 from declare_evidence
 *  against a product that does not exist).
 *
 *  Notes:
 *  - ``paper`` carries ``link`` (not ``url``) — the Paper label dedups on
 *    normalized ``link``, and ``upsert_tool_call``'s paper branch reads
 *    ``rec.get("url") or rec.get("link")`` for back-compat, but the TS payload
 *    contract puts the canonical name on ``link``.
 *  - ``web_page`` projects ``record.crossReferences[*].identifier`` into
 *    ``sourceRefs`` so a wiki page's references land on the WebPage node
 *    (the detail card renders them). ``crossReferences`` may be undefined on
 *    non-wiki sources; ``?.map`` keeps the field absent then.
 *  - ``web_page`` + a non-empty ``rawText`` first lands the body in the CAS
 *    data pool (same pool as recorder ``dataCas`` — the node stores only the
 *    hash, mirroring SourceFile.content_hash) and carries ``contentHash``.
 *    A CAS write failure leaves ``contentHash`` unset: the page degrades to
 *    its snippet-only state (searchable but not usable as a declare_evidence
 *    source) instead of failing the whole mirror.
 *  - ``code`` never reaches here (the MCP broker only mirrors registered
 *    search/fetch tools; recorder-mirror is its own path).
 *
 *  Exported for tests (same reason as ``extractRawTexts``): the dispatch is
 *  the part worth pinning down, and building a whole broker to reach it would
 *  test less for more.
 */
export async function mcpRecordToProduct(
  record: McpRecord,
  product: ToolGraphProduct,
  rawText: string | undefined,
  dataCas: CasStore,
): Promise<MemoryGraphToolCallProduct> {
  switch (product) {
    case "paper":
      return {
        productType: "paper",
        link: record.url,
        title: record.title,
        identifier: record.identifier,
        identifierType: record.identifierType,
        year: record.year,
        authors: record.authors,
        abstract: record.abstract,
        source: record.source,
      };
    case "web_page": {
      let contentHash: string | undefined;
      if (rawText && rawText.length > 0) {
        try {
          contentHash = (await dataCas.put(rawText)).hash;
        } catch (error) {
          // Never fail the mirror over a CAS write: the page lands hash-less
          // (search-snippet-only state) and the tool call itself is unaffected.
          console.warn("mcpRecordToProduct: dataCas.put failed: %s",
            error instanceof Error ? error.message : String(error));
        }
      }
      return {
        productType: "web_page",
        url: record.url,
        identifier: record.identifier,
        identifierType: record.identifierType,
        title: record.title,
        snippet: record.abstract,
        sourceRefs: record.crossReferences?.map((ref) => ref.identifier),
        ...(contentHash ? { contentHash } : {}),
      };
    }
    case "db_record":
      return {
        productType: "db_record",
        source: record.source,
        identifier: record.identifier,
        identifierType: record.identifierType,
        url: record.url,
        title: record.title,
        snippet: record.abstract,
      };
    case "code":
      throw new Error(
        "mcpRecordToProduct: a code-producing tool is registered on the MCP mirror path "
        + `(tool emitted product "code" for record ${record.identifier ?? "<no identifier>"}); `
        + "executions reach the graph through the provenance recorder, not here.",
      );
    default:
      return assertNeverProduct(product);
  }
}

/** Exhaustiveness guard: a new ``ToolGraphProduct`` must be routed above, or
 *  TypeScript rejects this call and the build stops here rather than at
 *  runtime. */
function assertNeverProduct(product: never): never {
  throw new Error(`mcpRecordToProduct: unhandled product ${String(product)}`);
}

export class McpGovernanceBroker {
  readonly cas: CasStore;
  /** CAS data pool for page bodies — same pool as the provenance recorder's
   *  ``dataCas``; the graph node stores only the hash. */
  private readonly dataCas: CasStore;
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
    this.dataCas = new CasStore(dataDir, "data");
    this.cache = options.cache ?? new McpResultCache(dataDir);
    this.limiter = options.limiter ?? new ResourceRateLimiter();
    this.memoryGraphSink = options.memoryGraphSink ?? null;
  }

  close(): void {
    this.cache.close();
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
    // Explicit IDs belong to a frozen Run. Direct requests resolve the current composition.
    const enabledSourceIds = request.allowedSourceIds ?? filterEnabledMcpSources(settings.enabledConnectorIds, settings.plugins);
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
        // A cache hit still returns records the LLM will cite, so mirror it
        // to the memory graph exactly like the uncached path below — otherwise
        // a re-run of the same search produces no Paper/WebPage/DbRecord nodes
        // and downstream declare_* calls 422 on missing nodes. Gating is
        // driven by the registry (``toolGraphSpec(fullName)``), not by
        // ``tool.kind === "search"`` — the registry is the single source of
        // truth for which MCP tools enter the graph. A cached get_page /
        // get_pages also re-lands its page body (the raw response JSON comes
        // back from CAS; content addressing makes the re-put a no-op).
        const fullName = `mcp__${request.sourceId.replace(/[^A-Za-z0-9_-]/g, "_")}__${request.toolId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        const spec = toolGraphSpec(fullName);
        if (spec !== undefined && !request.suppressMemoryGraphMirror) {
          try {
            let raw: Parameters<typeof extractRawTexts>[0] | undefined;
            if (request.toolId === "get_page" || request.toolId === "get_pages") {
              try {
                raw = JSON.parse((await this.cas.read(cached.rawResponse.hash)).toString("utf8"));
              } catch {
                // Raw response unreadable → mirror without a page body.
              }
            }
            const products = await this.buildMirrorProducts(
              cached.result.records, spec.product, raw, request.toolId,
            );
            this.memoryGraphSink?.observeToolCall({
              taskId: `subtask:mcp:${invocation.id}`,
              sessionId: request.sessionId,
              turnId: request.turnId,
              toolName: fullName,
              toolType: spec.type,
              source: request.sourceId,
              resultCount: cached.result.records.length,
              products,
              parentSubagentId: request.parentSubagentId,
            });
          } catch (error) {
            console.warn("memory-graph mirror (cached) failed: %s",
              error instanceof Error ? error.message : String(error));
          }
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
    let rawResult: McpRawResult | undefined;
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
      // Kept for the graph mirror below: a get_page/get_pages body lives only
      // in this raw response (normalizeResult's McpRecord drops it), so the
      // mirror re-reads it to land the text in the CAS data pool.
      rawResult = raw;
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
    // ToolCall per search + product nodes deduped + produces edges. Gating
    // is driven by the registry (``toolGraphSpec(fullName)``), not by
    // ``tool.kind === "search"`` — the registry is the single source of truth
    // for which MCP tools enter the graph. get_page / get_pages products
    // additionally carry content_hash (body → CAS data pool). Disabled/
    // unreachable memory-graph never breaks the search (the sink no-ops); the
    // try/catch keeps a mirror failure off the tool call too.
    const fullName = `mcp__${request.sourceId.replace(/[^A-Za-z0-9_-]/g, "_")}__${request.toolId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const spec = toolGraphSpec(fullName);
    if (spec !== undefined && !request.suppressMemoryGraphMirror) {
      try {
        const products = await this.buildMirrorProducts(
          result.records, spec.product, rawResult, request.toolId,
        );
        this.memoryGraphSink?.observeToolCall({
          taskId: `subtask:mcp:${invocation.id}`,
          sessionId: request.sessionId,
          turnId: request.turnId,
          toolName: fullName,
          toolType: spec.type,
          source: request.sourceId,
          resultCount: result.records.length,
          products,
          parentSubagentId: request.parentSubagentId,
        });
      } catch (error) {
        console.warn("memory-graph mirror failed: %s",
          error instanceof Error ? error.message : String(error));
      }
    }
    return {
      invocation,
      result: structuredClone(result),
    };
  }

  /** Build the mirrored products for one tool call. Shared by the cached
   *  and live paths so both land a get_page/get_pages body in the CAS
   *  data pool identically; never re-reads CAS for tools without a body.
   *  Each record's text is taken by its index in the per-record array
   *  extractRawTexts returns — get_pages emits one slot per page so the
   *  page-i body lands on record-i, not the page-0 body on every record.
   * When records.length > rawTexts.length (the upstream wiki sometimes
   * dedups or drops empty pages between extract and normalize) the tail
   * records land hash-less instead of smearing an earlier body. */
  async buildMirrorProducts(
    records: McpRecord[],
    product: ToolGraphProduct,
    raw: Parameters<typeof extractRawTexts>[0] | undefined,
    toolId: string,
  ): Promise<MemoryGraphToolCallProduct[]> {
    const rawTexts = raw === undefined
      ? undefined
      : extractRawTexts(raw, toolId, records.length);
    // get_page (single text) shares its one body across every record; other
    // tools (search / db-record sources) leave rawTexts undefined and every
    // record gets an empty slot, so the per-record text is "" — never carry a
    // stale body across record boundaries. With recordsCount padded, per-index
    // access here is always safe for the records the call actually has.
    const sharedText = rawTexts && rawTexts.length === 1 ? rawTexts[0] : undefined;
    return Promise.all(records.map((record, index) => {
      const text = sharedText !== undefined
        ? sharedText
        : (rawTexts?.[index] ?? "");
      return mcpRecordToProduct(record, product, text, this.dataCas);
    }));
  }
}
