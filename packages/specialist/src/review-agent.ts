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

import {
  type RuntimeSkill,
  type WorkspaceAgentOptions,
} from "@sciencediscovery/context";
import { createSubagentProfile, type AgentEvent } from "@sciencediscovery/orchestration";
import type { AgentHistoryMessage, SubagentProfile } from "@sciencediscovery/orchestration";
import {
  reviewerLog,
  type LiteratureCitationCandidate,
  type ReviewerLogContext,
  type SemanticReviewOptions,
} from "@sciencediscovery/provenance";

// Deep review receives preselected evidence. One model response is enough and
// prevents a Reviewer from spending the whole gateway budget planning tool calls.
const REVIEW_AGENT_MAX_MODEL_TURNS = 1;
// Each Deep task is isolated per citation/claim, so it can be given enough
// time to reason without stalling the rest of the Artifact review queue.
// Keep both semantic stages aligned: a provider may take longer to produce a
// structured verdict for a supplied source or Evidence bundle.
const DEEP_REVIEW_TIMEOUT_MS = 120_000;
const COMPUTATION_REVIEW_MAX_MODEL_TURNS = 1;
const CITATION_MCP_SEARCH_TIMEOUT_MS = 12_000;
const CITATION_WEB_SEARCH_TIMEOUT_MS = 12_000;
const MAX_CITATION_SOURCE_CHARACTERS = 12_000;

export interface CreateReviewAgentOptionsInput {
  executeSubagent(request: {
    abortSignal?: AbortSignal;
    observer(event: AgentEvent): void;
    profile: SubagentProfile;
    prompt: string;
    requestExecutionId: string;
    runContract: string;
    runIdleTimeoutMs: number;
    workspace: WorkspaceAgentOptions;
  }): Promise<{ finalMessages: AgentHistoryMessage[] }>;
  modelIdentity: string;
  runIdleTimeoutMs: number;
  skills: RuntimeSkill[];
  workspace: WorkspaceAgentOptions;
}

function assistantText(messages: Array<Record<string, unknown>>): string {
  const message = messages.findLast((item) => item.role === "assistant");
  if (!message) return "";
  if (typeof message.content === "string") return message.content.trim();
  if (Array.isArray(message.content)) {
    return message.content.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" ? [text] : [];
    }).join("\n").trim();
  }
  return "";
}

function deniedExecution(): Promise<never> {
  return Promise.reject(new Error("Reviewer Specialist cannot execute code"));
}

function stableCitationQuery(candidate: LiteratureCitationCandidate, sourceId?: string): string {
  const [, identifier] = candidate.key.split(/:(.+)/u);
  const value = identifier?.trim();
  if (value && candidate.key.startsWith("pmid:")) {
    // E-utilities treats a bare number as a broad text query. Use its UID
    // field and Europe PMC's external-id field so an unrelated ranked record
    // can never masquerade as the target PMID.
    if (sourceId === "pubmed") return `${value}[uid]`;
    if (sourceId === "europe-pmc") return `EXT_ID:${value}`;
  }
  if (value && candidate.key.startsWith("pmcid:") && sourceId === "europe-pmc") return `PMCID:${value.toUpperCase()}`;
  if (value && candidate.key.startsWith("doi:")) return `DOI:${value}`;
  // Never turn a rich bibliography entry into the unusable "surname:year"
  // key. The full entry gives the provider enough title/venue context for a
  // conservative secondary identity check.
  return candidate.reference.slice(0, 800);
}

function citationSearchSources(candidate: LiteratureCitationCandidate): string[] {
  if (candidate.key.startsWith("pmid:")) return ["pubmed", "europe-pmc"];
  if (candidate.key.startsWith("pmcid:") || candidate.key.startsWith("ppr:")) return ["europe-pmc", "pubmed"];
  if (candidate.key.startsWith("arxiv:")) return ["arxiv"];
  // DOI and ordinary bibliography references can be resolved by either
  // literature index. Europe PMC first also covers PMCID/PPR cross-links.
  return ["europe-pmc", "pubmed", "arxiv"];
}

function boundedJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, MAX_CITATION_SOURCE_CHARACTERS);
  } catch {
    return String(value).slice(0, MAX_CITATION_SOURCE_CHARACTERS);
  }
}

function recordMatchesCitation(record: Record<string, unknown>, candidate: LiteratureCitationCandidate): boolean {
  const [kind, rawIdentifier] = candidate.key.split(/:(.+)/u);
  const identifier = rawIdentifier?.trim().toLowerCase();
  if (!identifier) return false;
  const recordIdentifier = typeof record.identifier === "string" ? record.identifier.trim().toLowerCase() : "";
  const recordUrl = typeof record.url === "string" ? record.url.trim().toLowerCase() : "";
  if (kind === "pmid" || kind === "pmcid" || kind === "ppr") {
    return recordIdentifier === identifier || recordUrl.includes(`/${identifier}/`);
  }
  if (kind === "doi") {
    const structured = JSON.stringify(record.structuredData ?? "").toLowerCase();
    return recordIdentifier === identifier || recordUrl.includes(identifier) || structured.includes(identifier);
  }
  if (kind === "url") return recordUrl === identifier;
  if (kind !== "reference") return false;
  const year = candidate.reference.match(/\b((?:19|20)\d{2})\b/u)?.[1];
  const firstAuthor = candidate.authorYearKey?.split(":", 1)[0];
  const recordYear = typeof record.year === "string" ? record.year : "";
  const recordAuthors = Array.isArray(record.authors) ? record.authors.filter((author): author is string => typeof author === "string") : [];
  const normalized = (value: string): string => value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const authorMatches = Boolean(firstAuthor && recordAuthors.some((author) => normalized(author).includes(firstAuthor)));
  const title = typeof record.title === "string" ? record.title : "";
  const titleTerms = normalized(title).match(/[a-z]{4,}/gu) ?? [];
  const candidateText = normalized(candidate.reference);
  // A non-identifier match is allowed only when all three bibliographic
  // fields agree. This is intentionally stricter than a broad author search.
  const titleMatches = titleTerms.length >= 3
    && titleTerms.filter((term) => candidateText.includes(term)).length >= Math.min(5, Math.ceil(titleTerms.length * 0.6));
  return Boolean(year && recordYear === year && authorMatches && titleMatches);
}

function mcpSearchSnapshot(
  result: unknown,
  candidate: LiteratureCitationCandidate,
): { content: string; url?: string } | undefined {
  if (!result || typeof result !== "object") return undefined;
  const records = (result as { records?: unknown }).records;
  if (!Array.isArray(records) || !records.length) return undefined;
  const exactRecord = records.find((record) => record && typeof record === "object"
    && recordMatchesCitation(record as Record<string, unknown>, candidate));
  if (!exactRecord || typeof exactRecord !== "object") return undefined;
  const concise = [exactRecord].map((record) => {
    if (!record || typeof record !== "object") return record;
    const value = record as Record<string, unknown>;
    return {
      abstract: value.abstract,
      authors: value.authors,
      identifier: value.identifier,
      identifierType: value.identifierType,
      peerReviewStatus: value.peerReviewStatus,
      source: value.source,
      title: value.title,
      url: value.url,
      year: value.year,
    };
  });
  const first = concise[0] as Record<string, unknown> | undefined;
  return {
    content: boundedJson({ records: concise }),
    ...(typeof first?.url === "string" ? { url: first.url } : {}),
  };
}

function webSearchContainsExactCitation(content: string, candidate: LiteratureCitationCandidate): boolean {
  const [, rawIdentifier] = candidate.key.split(/:(.+)/u);
  const identifier = rawIdentifier?.trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!identifier) return false;
  if (candidate.key.startsWith("pmid:")) {
    return new RegExp(`(?:pubmed\\.ncbi\\.nlm\\.nih\\.gov|europepmc\\.org/article/MED)/${identifier}(?:[/?#]|$)`, "iu").test(content);
  }
  if (candidate.key.startsWith("pmcid:")) {
    return new RegExp(`europepmc\\.org/article/PMC/${identifier}(?:[/?#]|$)`, "iu").test(content);
  }
  if (candidate.key.startsWith("doi:")) return new RegExp(`doi\\.org/${identifier}(?:[/?#]|$)|\\b${identifier}\\b`, "iu").test(content);
  if (candidate.key.startsWith("reference:")) {
    const [firstAuthor, year] = candidate.authorYearKey?.split(":") ?? [];
    if (!firstAuthor || !year) return false;
    const normalized = (value: string): string => value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase();
    const candidateText = normalized(candidate.reference);
    const sourceText = normalized(content);
    const terms = candidateText.match(/[a-z]{5,}/gu) ?? [];
    const titleMatches = terms.filter((term) => sourceText.includes(term)).length >= 5;
    return sourceText.includes(firstAuthor) && sourceText.includes(year) && titleMatches;
  }
  return false;
}

function toolResultText(event: Extract<AgentEvent, { type: "tool_execution_end" }>): string {
  return event.result.content.flatMap((item) => "text" in item ? [item.text] : []).join("\n");
}

function logAgentEvent(context: ReviewerLogContext, event: AgentEvent): void {
  if (event.type === "turn_start") reviewerLog.event(context, "model.turn.started");
  else if (event.type === "model_usage") reviewerLog.event(context, "model.usage", {
    usage: event.usage,
    usageReported: event.usageReported,
  });
  else if (event.type === "tool_execution_start") reviewerLog.event(context, "tool.started", {
    arguments: event.args,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
  });
  else if (event.type === "tool_execution_end") reviewerLog.event(context, "tool.finished", {
    error: event.isError,
    output: toolResultText(event),
    toolCallId: event.toolCallId,
    toolName: event.toolName,
  });
  // Do not persist thinking_delta. It is not an audit artifact and may contain
  // untrusted or sensitive intermediate reasoning.
}

/** Build the shared constrained agent used by semantic review levels. */
export function createReviewAgentOptions(input: CreateReviewAgentOptionsInput): SemanticReviewOptions {
  const citationSkill = input.skills.find((skill) => skill.id === "citation-reviewer");
  const computationSkill = input.skills.find((skill) => skill.id === "computation-reviewer");
  if (!citationSkill || !computationSkill) {
    throw new Error("Reviewer Specialist semantic skills are unavailable");
  }
  return {
    citationSkillHash: citationSkill.hash,
    computationSkillHash: computationSkill.hash,
    modelIdentity: input.modelIdentity,
    async probeCitation(request, signal) {
      const candidate = request.citation;
      if (!candidate) return { status: "unavailable", message: "No citation reference was supplied for source verification." };
      const logContext: ReviewerLogContext = {
        artifactLogicalName: request.artifactLogicalName,
        artifactVersionId: request.artifactVersionId,
        checkpointId: request.checkpointId,
        executionId: randomUUID(),
        sessionId: request.sessionId,
      };
      reviewerLog.event(logContext, "deep.citation.search.started", { citation: candidate.label });

      for (const sourceId of citationSearchSources(candidate)) {
        const tool = input.workspace.mcpTools?.find((item) => item.sourceId === sourceId && item.toolId === "search");
        if (!tool) continue;
        try {
          const query = stableCitationQuery(candidate, sourceId);
          reviewerLog.event(logContext, "deep.citation.search.started", { citation: candidate.label, query, sourceId });
          const timeout = AbortSignal.timeout(CITATION_MCP_SEARCH_TIMEOUT_MS);
          const searchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
          const result = await tool.execute(
            `reviewer-citation-mcp-search:${randomUUID()}`,
            { limit: 3, query },
            searchSignal,
          );
          const snapshot = mcpSearchSnapshot(result, candidate);
          if (!snapshot) {
            reviewerLog.event(logContext, "deep.citation.search.empty", {
              reason: "no_exact_identifier_match",
              sourceId,
            });
            continue;
          }
          reviewerLog.event(logContext, "deep.citation.search.finished", {
            contentLength: snapshot.content.length,
            sourceId,
            sourceType: "mcp",
          });
          return { ...snapshot, status: "available" as const };
        } catch (error) {
          if (signal?.aborted) throw new DOMException("Review cancelled", "AbortError");
          reviewerLog.event(logContext, "deep.citation.search.failed", {
            error: error instanceof Error ? error.message : String(error),
            sourceId,
          });
        }
      }

      if (input.workspace.webSearch) {
        try {
          const webQuery = stableCitationQuery(candidate);
          const timeout = AbortSignal.timeout(CITATION_WEB_SEARCH_TIMEOUT_MS);
          const searchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
          const result = await input.workspace.webSearch(`reviewer-citation-web-search:${randomUUID()}`, webQuery, searchSignal);
          const content = boundedJson(result);
          if (content && content !== "{}" && content !== "[]" && webSearchContainsExactCitation(content, candidate)) {
            reviewerLog.event(logContext, "deep.citation.search.finished", {
              contentLength: content.length,
              sourceType: "web_search",
            });
            return { content, status: "available" as const };
          }
          reviewerLog.event(logContext, "deep.citation.search.empty", {
            reason: "no_exact_identifier_match",
            sourceId: "web_search",
          });
        } catch (error) {
          if (signal?.aborted) throw new DOMException("Review cancelled", "AbortError");
          reviewerLog.event(logContext, "deep.citation.search.failed", {
            error: error instanceof Error ? error.message : String(error),
            sourceId: "web_search",
          });
        }
      }
      return { status: "unavailable", message: "No governed literature search returned a usable source record." };
    },
    async execute(request, signal) {
      if (signal?.aborted) throw new DOMException("Review cancelled", "AbortError");
      const executionId = randomUUID();
      const logContext: ReviewerLogContext = {
        artifactLogicalName: request.artifactLogicalName,
        artifactVersionId: request.artifactVersionId,
        checkpointId: request.checkpointId,
        executionId,
        sessionId: request.sessionId,
      };
      const isComputationStage = request.stage === "computation";
      const activeSkills = isComputationStage ? [computationSkill] : [citationSkill];
      const mandatoryGuide = activeSkills[0]!;
      const guidedPrompt = [
        `The following is the mandatory built-in ${mandatoryGuide.id} guide for this Reviewer Specialist run. Read and follow it before producing your answer.`,
        `<reviewer-skill id="${mandatoryGuide.id}" revision="${mandatoryGuide.revision}">`,
        mandatoryGuide.content,
        "</reviewer-skill>",
        "This is a bounded review: use only the supplied Artifact, Evidence, and governed source snapshot. Do not attempt to load a skill or invoke a tool.",
        "Your entire response must be the requested JSON object only. Do not include analysis, headings, Markdown fences, or a preamble.",
        request.prompt,
      ].join("\n\n");
      // The protocol is injected in the request; Deep review must not enter a
      // tool-selection loop after its source/evidence has already been chosen.
      const stageAllowedToolNames: string[] = [];
      const profile = createSubagentProfile({
        allowedToolNames: stageAllowedToolNames,
        connectorIds: input.workspace.enabledConnectorIds,
        deniedToolNames: [
          "task",
          "run_python",
          "run_r",
          "run_shell",
          "write_file",
          "review_checkpoint",
          "declare_claim",
          "declare_evidence",
        ],
        gatewayThreadId: executionId,
        maxModelTurns: isComputationStage ? COMPUTATION_REVIEW_MAX_MODEL_TURNS : REVIEW_AGENT_MAX_MODEL_TURNS,
        presetId: `reviewer-specialist-${request.stage}`,
        runTimeoutMs: DEEP_REVIEW_TIMEOUT_MS,
        skills: [],
        workspaceRoot: input.workspace.workspaceRoot,
      });
      const workspace: WorkspaceAgentOptions = {
        ...input.workspace,
        declareClaim: undefined,
        declareEvidence: undefined,
        executePython: deniedExecution,
        executeScientific: undefined,
        executeShell: deniedExecution,
        history: [],
        memoryGraphEnabled: false,
        mcpTools: [],
        proposePlan: undefined,
        proposeRemoteJob: undefined,
        queryGraph: undefined,
        remoteHosts: [],
        reviewCheckpoint: undefined,
        runSubagent: undefined,
        skills: [],
        specialist: undefined,
        subagent: {
          instructions: "Review one locked Artifact read-only. Follow the requested capability stages in order. Return only the required JSON object.",
          name: "Reviewer Specialist",
        },
        toolPolicy: { allowed: stageAllowedToolNames, disallowed: profile.toolPolicy.deniedToolNames },
        webFetch: undefined,
        webSearch: undefined,
      };
      reviewerLog.event(logContext, "review.started", {
        allowedToolNames: stageAllowedToolNames,
        modelIdentity: input.modelIdentity,
        prompt: guidedPrompt,
        skillIds: activeSkills.map((skill) => skill.id),
        stage: request.stage,
      });
      const executeRequest = {
        ...(signal ? { abortSignal: signal } : {}),
        observer: (event: AgentEvent) => logAgentEvent(logContext, event),
        profile,
        prompt: guidedPrompt,
        requestExecutionId: executionId,
        runContract: guidedPrompt,
        runIdleTimeoutMs: input.runIdleTimeoutMs,
        workspace,
      };
      try {
        const result = await input.executeSubagent(executeRequest);
        const output = assistantText(result.finalMessages);
        if (!output) throw new Error("Reviewer Specialist returned no assistant result");
        reviewerLog.event(logContext, "review.finished", { modelOutput: output });
        return output;
      } catch (error) {
        reviewerLog.event(logContext, "review.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}
