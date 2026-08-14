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

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  WebAttemptStatus,
  WebError,
  WebFetchProvider,
  WebInvocation,
  WebInvocationAttempt,
  WebProxyMode,
  WebSearchProvider,
  WebSettingsDetails,
  WebUsageSummary,
} from "@science-agent/schema";
import { CasStore } from "@science-agent/cas";

import type { AgentPermissionRuntime } from "../agent-run/permission-runtime.js";
import { proxyEnvOverlay, type ProxyEnvironment } from "../proxy/index.js";
import { SessionStore } from "../store.js";
import { WebCache, webCacheKey } from "./cache.js";
import { WebGatewayClient, WebGatewayError } from "./gateway-client.js";

export interface WebCallContext {
  forceRefresh: boolean;
  projectId: string;
  sessionId: string;
  toolCallId: string;
  turnId: string;
}

const TRANSIENT = new Set(["rate-limited", "timeout", "server-error", "transport-error"]);
const ERROR_CODES: Partial<Record<WebAttemptStatus, WebError["code"]>> = {
  "rate-limited": "RATE_LIMITED",
  timeout: "TIMEOUT",
  unauthorized: "UNAUTHORIZED",
  "server-error": "UPSTREAM_UNAVAILABLE",
  "transport-error": "UPSTREAM_UNAVAILABLE",
};

export class WebInvocationError extends Error {
  constructor(
    message: string,
    readonly invocation: WebInvocation,
  ) {
    super(message);
    this.name = "WebInvocationError";
  }
}

function status(value: string | undefined): WebAttemptStatus {
  const allowed = new Set<WebAttemptStatus>([
    "unauthorized", "rate-limited", "timeout", "server-error", "transport-error", "semantic-error",
  ]);
  return allowed.has(value as WebAttemptStatus) ? value as WebAttemptStatus : "semantic-error";
}

function invocationError(attempt: WebInvocationAttempt): WebError {
  const message = attempt.errorMessage || `Web provider failed: ${attempt.status}`;
  const noResults = attempt.status === "semantic-error" && /no (?:search )?results? found/i.test(message);
  const code: WebError["code"] = attempt.errorCode === "gateway-contract-error"
    ? "GATEWAY_CONTRACT_ERROR"
    : attempt.errorCode === "invalid-input"
      ? "INVALID_INPUT"
      : attempt.errorCode === "cancelled"
        ? "CANCELLED"
        : noResults
          ? "NO_RESULTS"
          : ERROR_CODES[attempt.status] ?? "PROVIDER_ERROR";
  const hint = code === "NO_RESULTS"
    ? " Try a more specific query or different search terms."
    : code === "RATE_LIMITED"
      ? " Retry after the provider cooldown."
      : code === "UNAUTHORIZED"
        ? " Ask the user to configure a valid API key in global Web settings."
        : code === "INVALID_INPUT"
          ? " Correct the tool arguments and retry."
          : "";
  return {
    code,
    message: `${message}${hint}`.slice(0, 1_000),
    retryable: TRANSIENT.has(attempt.status),
    ...(attempt.errorCode ? { upstreamCode: attempt.errorCode } : {}),
  };
}

export class WebBroker {
  private readonly cache: WebCache;
  private readonly cas: CasStore;
  private readonly database: DatabaseSync;

  constructor(
    dataDir: string,
    private readonly store: SessionStore,
    private readonly gateway: WebGatewayClient,
    private readonly proxyEnvironment: ProxyEnvironment = process.env,
  ) {
    this.cache = new WebCache(dataDir);
    this.cas = new CasStore(dataDir);
    const path = resolve(dataDir, "web-audit.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS web_invocations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS web_invocations_session_created
        ON web_invocations(session_id, created_at DESC)
    `);
  }

  private save(invocation: WebInvocation): void {
    this.database.prepare(
      "INSERT INTO web_invocations (id, session_id, created_at, record_json) VALUES (?, ?, ?, ?)",
    ).run(invocation.id, invocation.sessionId, invocation.createdAt, JSON.stringify(invocation));
  }

  usage(): WebUsageSummary {
    const rows = this.database.prepare("SELECT record_json FROM web_invocations").all() as Array<{ record_json: string }>;
    const invocations = rows.flatMap((row) => {
      try {
        return [JSON.parse(row.record_json) as WebInvocation];
      } catch {
        return [];
      }
    });
    return {
      cacheHits: invocations.filter((item) => item.cacheHit).length,
      failures: invocations.filter((item) => item.status === "failed").length,
      fallbacks: invocations.filter((item) => item.attempts.length > 1).length,
      fetches: invocations.filter((item) => item.operation === "fetch").length,
      searches: invocations.filter((item) => item.operation === "search").length,
    };
  }

  listInvocations(sessionId: string, turnId?: string): WebInvocation[] {
    const rows = this.database.prepare(
      "SELECT record_json FROM web_invocations WHERE session_id = ? ORDER BY created_at",
    ).all(sessionId) as Array<{ record_json: string }>;
    return rows.flatMap((row) => {
      try {
        const invocation = JSON.parse(row.record_json) as WebInvocation;
        return !turnId || invocation.turnId === turnId ? [invocation] : [];
      } catch {
        return [];
      }
    });
  }

  private async invokeProvider(
    operation: "search" | "fetch",
    provider: WebSearchProvider | WebFetchProvider,
    request: string,
    settings: WebSettingsDetails,
    signal?: AbortSignal,
  ) {
    const started = Date.now();
    let proxyUsed = false;
    // Resolved lazily below; failures surface as a diagnosable failed attempt.
    let proxyMode: WebProxyMode = "direct";
    try {
      // Resolve the stored policy through the global registry, then send only
      // the transport-neutral result to the Gateway.
      const resolved = this.store.resolveProxy(settings.proxyPolicy);
      proxyMode = resolved.mode === "url" ? "custom" : resolved.mode === "environment" ? "environment" : "direct";
      const proxyUrl = resolved.mode === "url" ? resolved.url : undefined;
      const proxyEnvironment = resolved.mode === "environment"
        ? proxyEnvOverlay(resolved, this.proxyEnvironment)
        : undefined;
      const apiKey = provider === "brave" || provider === "exa" || provider === "jina" || provider === "tavily"
        ? this.store.getWebProviderApiKey(provider)
        : undefined;
      if ((provider === "brave" || provider === "exa" || provider === "tavily") && !apiKey) {
        return {
          attempts: [{
            durationMs: Date.now() - started,
            errorCode: "unauthorized",
            errorMessage: `${provider} does not have a configured API key`,
            provider,
            proxyMode,
            proxyUsed: false,
            status: "unauthorized" as const,
          }],
          content: "",
        };
      }
      proxyUsed = resolved.mode === "url"
        ? true
        : resolved.mode === "environment" && ["HTTPS_PROXY", "ALL_PROXY"]
          .some((name) => Boolean(proxyEnvironment?.[name]));
      const response = await this.gateway.invoke({
        arguments: operation === "search" ? { query: request } : { url: request },
        operation,
        options: {
          ...(apiKey ? { apiKey } : {}),
          ...(operation === "search" && provider === "ddgs" ? { backend: settings.ddgsBackend } : {}),
          ...(proxyUrl ? { proxy: proxyUrl } : {}),
          ...(proxyEnvironment ? { proxyEnvironment } : {}),
          proxyMode,
        },
        provider,
        signal,
      });
      const common = {
        ...(provider === "ddgs" ? { backend: settings.ddgsBackend } : {}),
        provider,
        proxyMode,
        proxyUsed,
      } as const;
      return {
        attempts: response.attempts?.map((attempt) => ({
          ...common,
          durationMs: attempt.durationMs,
          ...(attempt.endpoint ? { endpoint: attempt.endpoint } : {}),
          ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
          ...(attempt.errorMessage ? { errorMessage: attempt.errorMessage } : {}),
          status: attempt.isError ? status(attempt.errorCode) : "succeeded",
        } satisfies WebInvocationAttempt)) ?? [{
          ...common,
          durationMs: response.durationMs,
          ...(response.errorCode ? { errorCode: response.errorCode } : {}),
          ...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
          status: response.isError ? status(response.errorCode) : "succeeded",
        } satisfies WebInvocationAttempt],
        content: response.content,
      };
    } catch (error) {
      const gatewayError = error instanceof WebGatewayError ? error : undefined;
      return {
        attempts: [{
          ...(provider === "ddgs" ? { backend: settings.ddgsBackend } : {}),
          durationMs: Date.now() - started,
          ...(signal?.aborted
            ? { errorCode: "cancelled" }
            : gatewayError
              ? { errorCode: gatewayError.code }
              : {}),
          errorMessage: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
          provider,
          proxyMode,
          proxyUsed,
          status: signal?.aborted
            ? "semantic-error"
            : gatewayError
              ? status(gatewayError.code)
              : "transport-error",
        } satisfies WebInvocationAttempt],
        content: "",
      };
    }
  }

  async search(
    query: string,
    context: WebCallContext,
    permission: AgentPermissionRuntime,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await permission.requirePrivilege({
      action: "connector",
      executionId: context.turnId,
      resource: "web:search",
      signal,
      summary: `Search the public web for “${query.slice(0, 120)}”`,
      toolCallId: context.toolCallId,
    });
    const settings = this.store.getWebSettings();
    const invocation: WebInvocation = {
      attempts: [],
      cacheHit: false,
      createdAt: new Date().toISOString(),
      forceRefresh: context.forceRefresh,
      id: randomUUID(),
      operation: "search",
      projectId: context.projectId,
      request: { query },
      sessionId: context.sessionId,
      status: "failed",
      toolCallId: context.toolCallId,
      turnId: context.turnId,
    };
    const searchRoute = settings.searchProvider === "ddgs"
      ? `${settings.searchProvider}:${settings.ddgsBackend}`
      : settings.searchProvider;
    const key = webCacheKey("search", searchRoute, query);
    if (!context.forceRefresh) {
      const cached = this.cache.get(key);
      if (cached) {
        invocation.cacheHit = true;
        invocation.casObjectId = cached.snapshot.hash;
        invocation.status = "succeeded";
        invocation.attempts.push({
          ...(settings.searchProvider === "ddgs" ? { backend: settings.ddgsBackend } : {}),
          durationMs: 0,
          provider: settings.searchProvider,
          proxyUsed: false,
          status: "cache-hit",
        });
        this.save(invocation);
        return { content: cached.content, invocation };
      }
    }

    let result = await this.invokeProvider("search", settings.searchProvider, query, settings, signal);
    invocation.attempts.push(...result.attempts);
    let terminalAttempt = result.attempts.at(-1)!;
    if (terminalAttempt.status !== "succeeded"
      && TRANSIENT.has(terminalAttempt.status)
      && settings.searchFallbackProvider
      && settings.searchFallbackProvider !== settings.searchProvider) {
      result = await this.invokeProvider("search", settings.searchFallbackProvider, query, settings, signal);
      invocation.attempts.push(...result.attempts);
      terminalAttempt = result.attempts.at(-1)!;
    }
    if (terminalAttempt.status !== "succeeded") {
      invocation.error = invocationError(terminalAttempt);
      this.save(invocation);
      throw new WebInvocationError(invocation.error.message, invocation);
    }
    const snapshot = await this.cas.put(result.content);
    invocation.casObjectId = snapshot.hash;
    invocation.status = "succeeded";
    const successfulRoute = terminalAttempt.provider === "ddgs"
      ? `ddgs:${settings.ddgsBackend}`
      : terminalAttempt.provider;
    this.cache.put(
      webCacheKey("search", successfulRoute, query),
      result.content,
      snapshot,
      settings.searchCacheTtlSeconds,
    );
    this.save(invocation);
    return { content: result.content, invocation };
  }

  async fetch(
    url: string,
    context: WebCallContext,
    permission: AgentPermissionRuntime,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("web_fetch requires a valid URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("web_fetch requires a public http(s) URL without embedded credentials");
    }
    const hostname = parsed.hostname;
    await permission.requirePrivilege({
      action: "host",
      executionId: context.turnId,
      resource: hostname,
      signal,
      summary: `Fetch public web content from ${hostname}`,
      toolCallId: context.toolCallId,
    });
    const settings = this.store.getWebSettings();
    const invocation: WebInvocation = {
      attempts: [],
      cacheHit: false,
      createdAt: new Date().toISOString(),
      forceRefresh: context.forceRefresh,
      id: randomUUID(),
      operation: "fetch",
      projectId: context.projectId,
      request: { url },
      sessionId: context.sessionId,
      status: "failed",
      toolCallId: context.toolCallId,
      turnId: context.turnId,
    };
    const key = webCacheKey("fetch", settings.fetchProvider, url);
    if (!context.forceRefresh) {
      const cached = this.cache.get(key);
      if (cached) {
        invocation.cacheHit = true;
        invocation.casObjectId = cached.snapshot.hash;
        invocation.status = "succeeded";
        invocation.attempts.push({
          durationMs: 0,
          provider: settings.fetchProvider,
          proxyUsed: false,
          status: "cache-hit",
        });
        this.save(invocation);
        return { content: cached.content, invocation };
      }
    }
    const result = await this.invokeProvider("fetch", settings.fetchProvider, url, settings, signal);
    invocation.attempts.push(...result.attempts);
    const terminalAttempt = result.attempts.at(-1)!;
    if (terminalAttempt.status !== "succeeded") {
      invocation.error = invocationError(terminalAttempt);
      this.save(invocation);
      throw new WebInvocationError(invocation.error.message, invocation);
    }
    const snapshot = await this.cas.put(result.content);
    invocation.casObjectId = snapshot.hash;
    invocation.status = "succeeded";
    this.cache.put(key, result.content, snapshot, settings.fetchCacheTtlSeconds);
    this.save(invocation);
    return { content: result.content, invocation };
  }
}
