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

import { createHash } from "node:crypto";
import {
  DEFAULT_MCP_READ_RETRY_POLICY,
  type JsonValue,
  type McpRecord,
  type McpSourceAdapter,
  type McpSourceManifest,
  type McpToolManifest,
  type ValidationResult,
} from "@sciencediscovery/schema";

const pathSchema = { type: "string", minLength: 1, maxLength: 500 };
const definitions = {
  search: {
    description: "Search the local LLM Wiki for relevant pages and source references without generating an answer.",
    kind: "search",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 500 },
      limit: { type: "integer", minimum: 1, maximum: 25, default: 5 },
    },
    required: ["query"],
  },
  get_page: {
    description: "Read one LLM Wiki page by the path returned by search, including its source references.",
    kind: "lookup",
    properties: { path: pathSchema },
    required: ["path"],
  },
  get_pages: {
    description: "Read up to 20 LLM Wiki pages within a token budget. Inspect missing and omitted paths before drawing conclusions.",
    kind: "lookup",
    properties: {
      paths: { type: "array", items: pathSchema, minItems: 1, maxItems: 20 },
      max_tokens: { type: "integer", minimum: 100, maximum: 16000, default: 8000 },
    },
    required: ["paths"],
  },
} satisfies Record<string, {
  description: string; kind: "search" | "lookup";
  properties: Record<string, unknown>; required: string[];
}>;

function isPagePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500
    && !/[\\%?#\x00-\x1f:]/.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createLlmWikiSource(
  baseUrl = process.env.SCIENCE_AGENT_LLM_WIKI_URL || "http://127.0.0.1:8100",
): McpSourceAdapter {
  const origin = new URL(baseUrl);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("LLM Wiki URL must be an HTTP(S) origin without credentials or a path");
  }
  const manifest: McpSourceManifest = {
    id: "llm-wiki", displayName: "LLM Wiki",
    description: "Search and read an LLM Wiki knowledge base in any domain through its HTTP API.",
    enabledByDefault: false,
    cache: { enabled: false, scope: "session", ttlSeconds: 60 },
    governance: {
      attribution: "Local LLM Wiki; preserve each page's original source references.",
      dataClassification: "private", license: "Owner-managed; underlying sources retain their terms",
      networkHosts: [origin.hostname], termsUrl: origin.origin,
      maxConcurrentRequests: 2, maxQueueDepth: 8, queueTimeoutMs: 20000,
      maxResponseBytes: 2_000_000, minIntervalMs: 0, rateLimitGroup: "llm-wiki",
    },
    kinds: ["knowledge-base"], publisher: "Local knowledge base owner", schemaVersion: "1", version: "1.0.0",
    transport: { type: "mcp", mcpServerId: "llm-wiki" },
    prompt: {
      summary: "Use the configured LLM Wiki for topics covered by its knowledge base, then read relevant pages as needed.",
      citationPolicy: "Cite the returned Wiki primaryCitation and preserve original source references separately.",
      caveats: ["Wiki pages may summarize other documents. Reading a Wiki page does not retrieve the full text of its cited sources."],
    },
    tools: Object.fromEntries(Object.entries(definitions).map(([id, definition]) => [id, {
      id, mcpToolName: id, displayName: `LLM Wiki ${id}`, description: definition.description,
      kind: definition.kind, idempotent: true, resultType: "evidence-records",
      inputSchema: { type: "object", additionalProperties: false, properties: definition.properties, required: definition.required },
      permission: { action: "connector", resourceTemplate: `llm-wiki:${id}`, summaryTemplate: definition.description },
      retryPolicy: { ...DEFAULT_MCP_READ_RETRY_POLICY, retryOn: [...DEFAULT_MCP_READ_RETRY_POLICY.retryOn] },
      routing: { keywords: ["llm-wiki", "wiki", "knowledge base", "知识库"], mode: "prefer", priority: 80 },
      timeoutMs: 60000,
    } satisfies McpToolManifest])),
  };

  return {
    manifest,
    validateInput(toolId, input): ValidationResult {
      const tool = manifest.tools[toolId];
      const invalid = { valid: false as const, issues: [{ path: "input", message: `Invalid LLM Wiki ${toolId} arguments` }] };
      if (!tool || !isObject(input)
        || Object.keys(input).some((key) => !Object.hasOwn(tool.inputSchema.properties as object, key))) return invalid;
      if (toolId === "search") {
        const limit = input.limit ?? 5;
        return typeof input.query === "string" && input.query.trim().length > 0 && input.query.length <= 500
          && Number.isInteger(limit) && Number(limit) >= 1 && Number(limit) <= 25
          ? { valid: true, input: { query: input.query.trim(), limit } } : invalid;
      }
      if (toolId === "get_page") return isPagePath(input.path) ? { valid: true, input: { path: input.path } } : invalid;
      const maxTokens = input.max_tokens ?? 8000;
      return Array.isArray(input.paths) && input.paths.length > 0 && input.paths.length <= 20 && input.paths.every(isPagePath)
        && Number.isInteger(maxTokens) && Number(maxTokens) >= 100 && Number(maxTokens) <= 16000
        ? { valid: true, input: { paths: input.paths, max_tokens: maxTokens } } : invalid;
    },
    async normalizeResult(context, raw) {
      const text = raw.content.find((block) => block.type === "text");
      const payload: unknown = raw.structuredContent ?? (text?.type === "text" ? JSON.parse(text.text) : undefined);
      if (raw.isError || !isObject(payload)) throw new Error("Invalid LLM Wiki response");
      const pages = context.tool.id === "search" ? payload.sources : context.tool.id === "get_page" ? [payload] : payload.pages;
      if (!Array.isArray(pages)) throw new Error("LLM Wiki response must contain pages");
      const records: McpRecord[] = pages.map((page) => {
        if (!isObject(page)) throw new Error("Invalid LLM Wiki page");
        // Search results carry the provider's index paths, which may use Windows
        // separators; normalize them so page lookups round-trip cleanly.
        const rawPath = page.page_id ?? page.path;
        const path = typeof rawPath === "string" ? rawPath.replaceAll("\\", "/") : rawPath;
        if (!isPagePath(path)) throw new Error("Invalid LLM Wiki page path");
        const title = typeof page.title === "string" && page.title ? page.title : path;
        const encodedPath = path.split("/").map(encodeURIComponent).join("/").replaceAll("(", "%28").replaceAll(")", "%29");
        const url = `${origin.origin}/api/v1/wiki/${encodedPath}`;
        const citation = {
          identifier: path, identifierType: "wiki-path", label: title,
          markdown: `[LLM Wiki:${path.replace(/[\[\]]/g, "\\$&")}](${url})`,
          role: "database-record" as const, source: manifest.id, url,
          sourceVersion: createHash("sha256").update(JSON.stringify(page)).digest("hex"),
        };
        const refs = page.source_refs ?? page.sources ?? [];
        if (!Array.isArray(refs) || !refs.every((ref) => typeof ref === "string")) throw new Error("Invalid Wiki source references");
        return {
          identifier: path, identifierType: "wiki-path", title, source: manifest.id, url,
          citations: [citation], primaryCitation: citation,
          contentScope: "curated-record", fullTextRetrieved: false, peerReviewStatus: "not-applicable",
          ...(typeof page.summary === "string" ? { abstract: page.summary } : {}),
          structuredData: page,
          crossReferences: refs.map((ref) => ({ identifier: ref as string, source: "wiki-source-reference" })),
          warnings: [],
        };
      });
      const { pages: _pages, sources: _sources, ...details } = payload;
      return {
        records, ...(context.tool.id === "get_pages" ? { data: details } : {}),
        attribution: manifest.governance.attribution, license: manifest.governance.license,
        retrievedAt: context.retrievedAt, sourceId: manifest.id, toolId: context.tool.id,
        untrusted: true, warnings: [],
      };
    },
  };
}
