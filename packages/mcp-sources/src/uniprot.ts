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

import {
  DEFAULT_MCP_RATE_LIMIT_QUEUE,
  externalUrl,
  externalUrlList,
  type McpRawResult,
  type McpSourceAdapter,
  type McpSourceManifest,
  type McpToolResult,
  type ValidationResult,
} from "@science-agent/schema";

import { assertMcpProviderResult } from "./public-biomed.js";

const retryPolicy = {
  initialDelayMs: 500,
  jitterRatio: 0.2,
  maxAttempts: 3,
  maxDelayMs: 10_000,
  multiplier: 2,
  respectRetryAfter: true,
  retryOn: ["transport-error", "rate-limited", "server-error"] as const,
};

export const UNIPROT_MCP_MANIFEST: McpSourceManifest = {
  cache: { enabled: true, scope: "global-public", ttlSeconds: 3_600 },
  description: "Curated protein records and sequence exports from UniProtKB through a native MCP server.",
  displayName: "UniProt",
  enabledByDefault: false,
  governance: {
    attribution: "Protein annotations provided by the UniProt Consortium.",
    commercialUseConstraints: "Observe UniProt terms and attribution requirements for redistributed data.",
    dataClassification: "public",
    license: "UniProt terms of use",
    maxConcurrentRequests: 2,
    maxQueueDepth: DEFAULT_MCP_RATE_LIMIT_QUEUE.maxQueueDepth,
    maxResponseBytes: 2_000_000,
    networkHosts: [...externalUrlList("connector_hosts.uniprot")],
    queueTimeoutMs: DEFAULT_MCP_RATE_LIMIT_QUEUE.queueTimeoutMs,
    rateLimitGroup: "rest.uniprot.org",
    rateLimitPerSecond: 5,
    termsUrl: externalUrl("terms.uniprot"),
  },
  id: "uniprot",
  kinds: ["protein"],
  prompt: {
    caveats: [
      "Preserve the canonical accession and reviewed status.",
      "A prepared sequence artifact has not been downloaded or inspected until its ArtifactJob completes.",
    ],
    citationPolicy: "Cite protein claims with the primaryCitation markdown returned by the tool.",
    summary: "Use UniProtKB for protein identity, function, disease annotation, organism, and canonical sequence.",
  },
  publisher: "UniProt Consortium",
  schemaVersion: "1",
  tools: {
    search: {
      description: "Search UniProtKB by protein, gene, organism, function, disease, or query syntax.",
      displayName: "Search UniProtKB",
      id: "search",
      idempotent: true,
      inputSchema: {
        additionalProperties: false,
        properties: {
          limit: { default: 5, maximum: 25, minimum: 1, type: "integer" },
          query: { maxLength: 500, minLength: 1, type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      kind: "search",
      mcpToolName: "search",
      permission: { action: "connector", resourceTemplate: "uniprot:search", summaryTemplate: "Search UniProtKB" },
      resultType: "evidence-records",
      retryPolicy: { ...retryPolicy, retryOn: [...retryPolicy.retryOn] },
      routing: { keywords: ["UniProt", "protein", "gene product", "organism", "protein function"], mode: "prefer", priority: 90 },
      timeoutMs: 30_000,
    },
    lookup: {
      description: "Look up one canonical UniProtKB accession.",
      displayName: "Look up UniProt accession",
      id: "lookup",
      idempotent: true,
      inputSchema: {
        additionalProperties: false,
        properties: {
          accession: { maxLength: 20, minLength: 5, pattern: "^[A-Za-z0-9][A-Za-z0-9-]+$", type: "string" },
        },
        required: ["accession"],
        type: "object",
      },
      kind: "lookup",
      mcpToolName: "lookup",
      permission: {
        action: "connector",
        resourceTemplate: "uniprot:lookup:{accession}",
        summaryTemplate: "Look up UniProtKB accession {accession}",
      },
      resultType: "evidence-records",
      retryPolicy: { ...retryPolicy, retryOn: [...retryPolicy.retryOn] },
      routing: { keywords: ["UniProt accession", "protein accession", "UniProtKB"], mode: "prefer", priority: 95 },
      timeoutMs: 30_000,
    },
    prepare_sequence: {
      cachePolicy: { ttlSeconds: 900 },
      description: "Prepare a FASTA or UniProt text sequence download candidate without transferring file bytes.",
      displayName: "Prepare protein sequence",
      id: "prepare_sequence",
      idempotent: true,
      inputSchema: {
        additionalProperties: false,
        properties: {
          accession: { maxLength: 20, minLength: 5, pattern: "^[A-Za-z0-9][A-Za-z0-9-]+$", type: "string" },
          format: { default: "fasta", enum: ["fasta", "txt"], type: "string" },
        },
        required: ["accession"],
        type: "object",
      },
      kind: "artifact-plan",
      mcpToolName: "prepare_sequence",
      permission: {
        action: "connector",
        resourceTemplate: "uniprot:prepare-sequence:{accession}",
        summaryTemplate: "Prepare a UniProt sequence download for {accession}",
      },
      resultType: "artifact-plan",
      retryPolicy: { ...retryPolicy, retryOn: [...retryPolicy.retryOn] },
      routing: { keywords: ["FASTA", "protein sequence", "amino acid sequence", "download sequence"], mode: "prefer", priority: 92 },
      timeoutMs: 15_000,
    },
  },
  transport: { mcpServerId: "uniprot", type: "mcp" },
  version: "2.0.0",
};

function isObject(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function validateInput(toolId: string, input: unknown): ValidationResult {
  if (!isObject(input)) return { issues: [{ message: "input must be an object", path: "" }], valid: false };
  if (toolId === "search") {
    const query = input.query;
    const limit = input.limit ?? 5;
    if (typeof query !== "string" || !query.trim() || query.length > 500) {
      return { issues: [{ message: "query must contain 1 to 500 characters", path: "query" }], valid: false };
    }
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 25) {
      return { issues: [{ message: "limit must be an integer from 1 to 25", path: "limit" }], valid: false };
    }
    return { input: { limit: Number(limit), query: query.trim() }, valid: true };
  }
  if (toolId === "lookup" || toolId === "prepare_sequence") {
    const accession = input.accession;
    if (typeof accession !== "string" || !/^[A-Z0-9][A-Z0-9-]{4,19}$/i.test(accession.trim())) {
      return { issues: [{ message: "accession has an invalid UniProtKB format", path: "accession" }], valid: false };
    }
    if (toolId === "prepare_sequence" && input.format !== undefined && !["fasta", "txt"].includes(String(input.format))) {
      return { issues: [{ message: "format must be fasta or txt", path: "format" }], valid: false };
    }
    return {
      input: {
        accession: accession.trim().toUpperCase(),
        ...(toolId === "prepare_sequence" ? { format: input.format === "txt" ? "txt" : "fasta" } : {}),
      },
      valid: true,
    };
  }
  return { issues: [{ message: `Unknown UniProt tool: ${toolId}`, path: "toolId" }], valid: false };
}

function payloadFromRaw(raw: McpRawResult): unknown {
  const candidates: unknown[] = [
    raw.structuredContent,
    ...raw.content.filter((item) => item.type === "json").map((item) => item.type === "json" ? item.value : undefined),
  ];
  for (const candidate of candidates) {
    if (isObject(candidate) && "sourceId" in candidate) return candidate;
    if (isObject(candidate) && isObject(candidate.result) && "sourceId" in candidate.result) return candidate.result;
  }
  for (const block of raw.content) {
    if (block.type !== "text") continue;
    try {
      const parsed = JSON.parse(block.text) as unknown;
      if (isObject(parsed) && "sourceId" in parsed) return parsed;
    } catch {
      // Non-JSON text stays in the raw audit object but cannot be normalized.
    }
  }
  throw new Error("UniProt MCP response did not contain a structured result");
}

export const uniprotMcpSource: McpSourceAdapter = {
  manifest: UNIPROT_MCP_MANIFEST,
  async normalizeResult(context, raw) {
    const payload = payloadFromRaw(raw);
    if (!isObject(payload)) {
      throw new Error("UniProt MCP response has an invalid result envelope");
    }
    const result = structuredClone(payload) as unknown as McpToolResult;
    assertMcpProviderResult(result, UNIPROT_MCP_MANIFEST, context.tool.id);
    return {
      ...result,
      attribution: UNIPROT_MCP_MANIFEST.governance.attribution,
      license: UNIPROT_MCP_MANIFEST.governance.license,
      retrievedAt: typeof result.retrievedAt === "string" ? result.retrievedAt : context.retrievedAt,
      sourceId: "uniprot",
      toolId: context.tool.id,
      untrusted: true,
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
    };
  },
  validateInput,
};
