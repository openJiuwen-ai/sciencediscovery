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

/**
 * Retention and re-reading for tool results that were too large for one model
 * input. `ToolOutputGuard` writes the full text here and puts only a reference
 * into canonical history; `read_tool_output` pages it back on demand.
 *
 * Records are written under a session-scoped root so a reference survives the
 * run that produced it — later runs replay the same history, and the notice
 * that carries the reference stays in that history for as long as the Session
 * does. Retention therefore follows the Session: records live until the
 * Session (or its Project) is deleted, alongside messages, execution runs, and
 * the other provenance data. There is no separate expiry, because a reference
 * that outlives its store would hand the model a dead pointer.
 *
 * The record is the tool's output verbatim: there is no size cap, because a
 * cap would silently make part of the result unreachable through the very
 * reference that promises to reach it. The text is written as its own file
 * rather than embedded in JSON, so storing it costs one copy instead of an
 * escaped second one.
 *
 * Without a root the store is process-local, which is enough for tests and for
 * a run that only pages back within itself.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Type } from "typebox";

import {
  boundText,
  DEFAULT_READ_PAGE_MAX_BYTES,
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  DEFAULT_TOOL_OUTPUT_MAX_LINES,
  DEFAULT_TOOL_OUTPUT_RETENTION_BYTES,
  formatByteSize,
  splitKeepingLineEndings,
  type ToolOutputRecord,
  type ToolOutputSink,
} from "./bounded-output.js";
import type { AgentTool } from "./types.js";

const REF_PATTERN = /^tool-output-[0-9a-f]{16}$/;

/**
 * Where one Session's stored tool output lives. Both the writer and the
 * Session deletion path resolve it here, so a Session cannot be deleted while
 * leaving its stored output behind under a differently derived name.
 */
export function toolOutputStoreRoot(dataDir: string, sessionId: string): string {
  const segment = sessionId.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "session";
  return resolve(dataDir, "tool-outputs", segment);
}

/** Sidecar metadata; the output itself lives beside it in `<ref>.txt`. */
interface StoredMeta {
  createdAt: string;
  toolName: string;
}

interface StoredOutput extends StoredMeta {
  text: string;
}

export interface ToolOutputPage {
  bytes: number;
  /** Last 1-based line included in this page; `startLine - 1` for an empty page. */
  endLine: number;
  /**
   * True only when line paging can still advance. It does not cover the
   * cut-off remainder of an over-wide line — no offset can address that, so it
   * is reported by `partialLine` instead.
   */
  hasMore: boolean;
  /** Always greater than the offset just used; absent when `hasMore` is false. */
  nextOffset?: number;
  /**
   * True when one line was wider than the page budget and had to be cut. The
   * page is not the end of that line, even when `hasMore` is false.
   */
  partialLine: boolean;
  ref: string;
  startLine: number;
  text: string;
  toolName: string;
  totalBytes: number;
  totalLines: number;
}

export interface ToolOutputCharacterPage {
  bytes: number;
  endChar: number;
  hasMore: boolean;
  nextCharOffset?: number;
  ref: string;
  startChar: number;
  text: string;
  toolName: string;
  totalBytes: number;
  totalChars: number;
}

export interface ToolOutputSearchMatch {
  endChar: number;
  startChar: number;
  text: string;
}

export interface ToolOutputSearchResult {
  bytes: number;
  caseSensitive: boolean;
  matches: ToolOutputSearchMatch[];
  query: string;
  ref: string;
  toolName: string;
  totalBytes: number;
  totalMatches: number;
  truncated: boolean;
}

export interface ToolOutputReadPolicy {
  advisoryBytes: number;
  strongAdvisoryBytes: number;
}

export const DEFAULT_TOOL_OUTPUT_READ_POLICY: ToolOutputReadPolicy = Object.freeze({
  advisoryBytes: 64 * 1_024,
  strongAdvisoryBytes: 96 * 1_024,
});

export interface ToolOutputSettings {
  maxBytes: number;
  maxLines: number;
  readPolicy: ToolOutputReadPolicy;
  retentionBytes: number;
}

function positiveSetting(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function resolveToolOutputSettings(env: NodeJS.ProcessEnv = process.env): ToolOutputSettings {
  const advisoryBytes = positiveSetting(
    env,
    "SCIENCE_AGENT_TOOL_OUTPUT_READ_ADVISORY_BYTES",
    DEFAULT_TOOL_OUTPUT_READ_POLICY.advisoryBytes,
  );
  const strongAdvisoryBytes = positiveSetting(
    env,
    "SCIENCE_AGENT_TOOL_OUTPUT_READ_STRONG_ADVISORY_BYTES",
    DEFAULT_TOOL_OUTPUT_READ_POLICY.strongAdvisoryBytes,
  );
  if (strongAdvisoryBytes < advisoryBytes) {
    throw new Error("SCIENCE_AGENT_TOOL_OUTPUT_READ_STRONG_ADVISORY_BYTES must be at least SCIENCE_AGENT_TOOL_OUTPUT_READ_ADVISORY_BYTES");
  }
  return {
    maxBytes: positiveSetting(env, "SCIENCE_AGENT_TOOL_OUTPUT_MAX_BYTES", DEFAULT_TOOL_OUTPUT_MAX_BYTES),
    maxLines: positiveSetting(env, "SCIENCE_AGENT_TOOL_OUTPUT_MAX_LINES", DEFAULT_TOOL_OUTPUT_MAX_LINES),
    readPolicy: { advisoryBytes, strongAdvisoryBytes },
    retentionBytes: positiveSetting(
      env,
      "SCIENCE_AGENT_TOOL_OUTPUT_RETENTION_BYTES",
      DEFAULT_TOOL_OUTPUT_RETENTION_BYTES,
    ),
  };
}

export interface ToolOutputReadObservation {
  advisory?: string;
  cumulativeBytes: number;
  duplicatePage: boolean;
  pagesRead: number;
}

/** Run-scoped guardrail; advisory only, never blocks access to stored output. */
export class ToolOutputReadTracker {
  private readonly reads = new Map<string, { bytes: number; pages: number; ranges: Set<string> }>();

  constructor(private readonly policy: ToolOutputReadPolicy = DEFAULT_TOOL_OUTPUT_READ_POLICY) {
    if (policy.advisoryBytes <= 0 || policy.strongAdvisoryBytes < policy.advisoryBytes) {
      throw new Error("Tool output read thresholds must be positive and ordered");
    }
  }

  observe(read: { bytes: number; key: string; ref: string }): ToolOutputReadObservation {
    const state = this.reads.get(read.ref) ?? { bytes: 0, pages: 0, ranges: new Set<string>() };
    const range = read.key;
    const duplicatePage = state.ranges.has(range);
    state.ranges.add(range);
    state.bytes += read.bytes;
    state.pages += 1;
    this.reads.set(read.ref, state);
    const level = duplicatePage ? "duplicate"
      : state.bytes >= this.policy.strongAdvisoryBytes ? "strong"
        : state.bytes >= this.policy.advisoryBytes ? "ordinary" : undefined;
    const advisory = level ? [
      "[tool output read advisory]",
      `ref=${read.ref}; reads=${state.pages}; cumulative_bytes=${state.bytes}; duplicate_read=${duplicatePage}.`,
      level === "duplicate"
        ? "This exact range or query was already read. Use the existing observation instead of reading it again."
        : "Continue only for a specific missing fact. Prefer query search, then the smallest useful range, instead of sequentially reading the whole result.",
    ].join("\n") : undefined;
    return {
      ...(advisory ? { advisory } : {}),
      cumulativeBytes: state.bytes,
      duplicatePage,
      pagesRead: state.pages,
    };
  }
}

export class ToolOutputStore implements ToolOutputSink {
  private readonly memory = new Map<string, StoredOutput>();
  private readonly root: string | undefined;

  constructor(options: { root?: string } = {}) {
    this.root = options.root;
  }

  async save(toolName: string, text: string): Promise<ToolOutputRecord> {
    const stored: StoredOutput = { createdAt: new Date().toISOString(), text, toolName };
    const ref = `tool-output-${randomBytes(8).toString("hex")}`;
    this.memory.set(ref, stored);
    await this.persist(ref, stored);
    return {
      bytes: Buffer.byteLength(text, "utf8"),
      lines: splitKeepingLineEndings(text).length,
      ref,
      toolName,
    };
  }

  async read(ref: string, options: { limit?: number; offset?: number } = {}): Promise<ToolOutputPage> {
    const stored = await this.resolveStored(ref);

    const lines = splitKeepingLineEndings(stored.text);
    const startLine = Math.max(1, Math.trunc(options.offset ?? 1));
    const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_TOOL_OUTPUT_MAX_LINES));
    const requested = lines.slice(startLine - 1, startLine - 1 + limit);
    // Re-bound the requested slice: a caller-chosen limit still may not exceed
    // the model-facing page budget.
    const page = boundText(requested.join(""), { keep: "head", maxBytes: DEFAULT_READ_PAGE_MAX_BYTES, maxLines: limit });
    const pageLines = page.totalLines - page.omittedLines;
    const endLine = startLine + pageLines - 1;
    const hasMore = endLine < lines.length;
    return {
      bytes: Buffer.byteLength(page.text, "utf8"),
      endLine,
      hasMore,
      ...(hasMore ? { nextOffset: endLine + 1 } : {}),
      partialLine: page.partialLine,
      ref,
      startLine,
      text: page.text,
      toolName: stored.toolName,
      totalBytes: Buffer.byteLength(stored.text, "utf8"),
      totalLines: lines.length,
    };
  }

  /** Read by Unicode code-point offset, including the remainder of an over-wide single line. */
  async readCharacters(
    ref: string,
    options: { charLimit?: number; charOffset?: number } = {},
  ): Promise<ToolOutputCharacterPage> {
    const stored = await this.resolveStored(ref);
    let totalChars = 0;
    for (const _character of stored.text) totalChars += 1;
    const startChar = Math.min(totalChars, Math.max(0, Math.trunc(options.charOffset ?? 0)));
    const requestedLimit = Math.max(1, Math.trunc(options.charLimit ?? DEFAULT_READ_PAGE_MAX_BYTES));
    const pageCharacters: string[] = [];
    let characterIndex = 0;
    let pageBytes = 0;
    for (const character of stored.text) {
      if (characterIndex >= startChar && pageCharacters.length < requestedLimit) {
        const characterBytes = Buffer.byteLength(character, "utf8");
        if (pageBytes + characterBytes > DEFAULT_READ_PAGE_MAX_BYTES) {
          characterIndex += 1;
          break;
        }
        pageCharacters.push(character);
        pageBytes += characterBytes;
      }
      characterIndex += 1;
    }
    const endChar = startChar + pageCharacters.length;
    const hasMore = endChar < totalChars;
    return {
      bytes: pageBytes,
      endChar,
      hasMore,
      ...(hasMore ? { nextCharOffset: endChar } : {}),
      ref,
      startChar,
      text: pageCharacters.join(""),
      toolName: stored.toolName,
      totalBytes: Buffer.byteLength(stored.text, "utf8"),
      totalChars,
    };
  }

  /** Search the retained original without exposing its physical storage path. */
  async search(
    ref: string,
    query: string,
    options: { caseSensitive?: boolean; contextChars?: number; maxMatches?: number } = {},
  ): Promise<ToolOutputSearchResult> {
    const stored = await this.resolveStored(ref);
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new Error("read_tool_output query must not be empty");
    if ([...normalizedQuery].length > 4_096) throw new Error("read_tool_output query must not exceed 4096 characters");
    const caseSensitive = options.caseSensitive === true;
    const contextChars = Math.max(0, Math.trunc(options.contextChars ?? 500));
    const maxMatches = Math.max(1, Math.trunc(options.maxMatches ?? 5));
    const searchable = caseSensitive ? stored.text : stored.text.toLocaleLowerCase();
    const needle = caseSensitive ? normalizedQuery : normalizedQuery.toLocaleLowerCase();
    const candidates: Array<{ end: number; start: number }> = [];
    let totalMatches = 0;
    let from = 0;
    while (from <= searchable.length - needle.length) {
      const start = searchable.indexOf(needle, from);
      if (start < 0) break;
      totalMatches += 1;
      if (candidates.length < maxMatches) candidates.push({ start, end: start + needle.length });
      from = Math.max(start + needle.length, start + 1);
    }
    const matches: ToolOutputSearchMatch[] = [];
    let resultBytes = 0;
    for (const candidate of candidates) {
      const startUnit = safeCodeUnitBoundary(stored.text, Math.max(0, candidate.start - contextChars), "forward");
      const endUnit = safeCodeUnitBoundary(
        stored.text,
        Math.min(stored.text.length, candidate.end + contextChars),
        "backward",
      );
      const rawText = stored.text.slice(startUnit, endUnit);
      const text = boundText(rawText, {
        keep: "head",
        maxBytes: DEFAULT_READ_PAGE_MAX_BYTES,
        maxLines: DEFAULT_TOOL_OUTPUT_MAX_LINES,
      }).text;
      const bytes = Buffer.byteLength(text, "utf8");
      if (matches.length > 0 && resultBytes + bytes > DEFAULT_READ_PAGE_MAX_BYTES) break;
      const startChar = countCodePoints(stored.text, startUnit);
      matches.push({ startChar, endChar: startChar + countCodePoints(text), text });
      resultBytes += bytes;
      if (resultBytes >= DEFAULT_READ_PAGE_MAX_BYTES) break;
    }
    return {
      bytes: resultBytes,
      caseSensitive,
      matches,
      query: normalizedQuery,
      ref,
      toolName: stored.toolName,
      totalBytes: Buffer.byteLength(stored.text, "utf8"),
      totalMatches,
      truncated: matches.length < totalMatches,
    };
  }

  private async resolveStored(ref: string): Promise<StoredOutput> {
    if (!REF_PATTERN.test(ref)) throw new Error(`Unknown tool output ref: ${ref}`);
    const stored = this.memory.get(ref) ?? await this.load(ref);
    if (!stored) throw new Error(`Tool output ref is no longer available: ${ref}`);
    return stored;
  }

  /**
   * Text and metadata are separate files. Embedding a multi-hundred-megabyte
   * result in JSON would need an escaped second copy of it in memory, and past
   * roughly half of `MAX_STRING_LENGTH` that copy cannot be built at all — the
   * store would start failing on exactly the outputs it exists to keep.
   *
   * The metadata is renamed last, so a record is only discoverable once its
   * text is fully in place.
   */
  private async persist(ref: string, stored: StoredOutput): Promise<void> {
    if (!this.root) return;
    await mkdir(this.root, { recursive: true });
    const textPath = resolve(this.root, `${ref}.txt`);
    const metaPath = resolve(this.root, `${ref}.json`);
    const meta: StoredMeta = { createdAt: stored.createdAt, toolName: stored.toolName };
    await writeFile(`${textPath}.${process.pid}.tmp`, stored.text, { encoding: "utf8", mode: 0o600 });
    await writeFile(`${metaPath}.${process.pid}.tmp`, JSON.stringify(meta), { encoding: "utf8", mode: 0o600 });
    await rename(`${textPath}.${process.pid}.tmp`, textPath);
    await rename(`${metaPath}.${process.pid}.tmp`, metaPath);
  }

  private async load(ref: string): Promise<StoredOutput | undefined> {
    if (!this.root) return undefined;
    try {
      const meta = JSON.parse(await readFile(resolve(this.root, `${ref}.json`), "utf8")) as StoredMeta;
      const text = await readFile(resolve(this.root, `${ref}.txt`), "utf8");
      if (typeof meta?.toolName !== "string") return undefined;
      const stored: StoredOutput = { createdAt: meta.createdAt, text, toolName: meta.toolName };
      this.memory.set(ref, stored);
      return stored;
    } catch {
      return undefined;
    }
  }
}

function safeCodeUnitBoundary(text: string, index: number, direction: "backward" | "forward"): number {
  let resolved = Math.max(0, Math.min(text.length, index));
  if (resolved === 0 || resolved === text.length) return resolved;
  const code = text.charCodeAt(resolved);
  if (code < 0xdc00 || code > 0xdfff) return resolved;
  resolved += direction === "forward" ? 1 : -1;
  return Math.max(0, Math.min(text.length, resolved));
}

function countCodePoints(text: string, endUnit: number = text.length): number {
  let count = 0;
  for (const _character of text.slice(0, endUnit)) count += 1;
  return count;
}

const readToolOutputParameters = Type.Object({
  caseSensitive: Type.Optional(Type.Boolean({
    description: "Whether query matching is case-sensitive. Defaults to false.",
  })),
  charLimit: Type.Optional(Type.Integer({
    description: "Maximum Unicode characters to return in character-range mode. The response is also capped at 40 KB.",
    maximum: 100_000,
    minimum: 1,
  })),
  charOffset: Type.Optional(Type.Integer({
    description: "Zero-based Unicode character offset. Use with charLimit when line paging cannot address a long line.",
    minimum: 0,
  })),
  contextChars: Type.Optional(Type.Integer({
    description: "Characters of context to include on each side of a query match. Defaults to 500.",
    maximum: 4_000,
    minimum: 0,
  })),
  limit: Type.Optional(Type.Integer({
    description: "Maximum number of lines to return. A page is additionally capped at 40 KB.",
    maximum: 10_000,
    minimum: 1,
  })),
  offset: Type.Optional(Type.Integer({
    description: "1-based line to start from. Defaults to 1.",
    minimum: 1,
  })),
  maxMatches: Type.Optional(Type.Integer({
    description: "Maximum query matches to return. Defaults to 5.",
    maximum: 20,
    minimum: 1,
  })),
  query: Type.Optional(Type.String({
    description: "Literal text to find in the complete stored result. Prefer this over sequential paging for a specific fact.",
    maxLength: 4_096,
    minLength: 1,
  })),
  ref: Type.String({
    description: "The ref printed in a bounded tool result, for example tool-output-0a1b2c3d4e5f6071.",
    minLength: 1,
  }),
});

/**
 * The re-read half of preview + reference. Registered alongside the workspace
 * tools so any bounded result — MCP, execution output, a large file read — has
 * one documented way back to the omitted text.
 */
export function createToolOutputTools(
  store: ToolOutputStore,
  options: { tracker?: ToolOutputReadTracker } = {},
): AgentTool[] {
  const tracker = options.tracker ?? new ToolOutputReadTracker();
  const readToolOutput: AgentTool<typeof readToolOutputParameters> = {
    description: "Recover a specific missing fact from a stored tool result. Prefer query for bounded literal search. Use offset/limit for line ranges, or charOffset/charLimit when one line is too wide. These modes are mutually exclusive. Do not sequentially read the whole result; extract the needed conclusion and continue the task.",
    execute: async (_toolCallId, params) => {
      const lineMode = params.offset !== undefined || params.limit !== undefined;
      const characterMode = params.charOffset !== undefined || params.charLimit !== undefined;
      const queryMode = params.query !== undefined;
      const hasQueryOptions = params.caseSensitive !== undefined
        || params.contextChars !== undefined
        || params.maxMatches !== undefined;
      if (hasQueryOptions && !queryMode) {
        throw new Error("read_tool_output search options require query");
      }
      if ([lineMode, characterMode, queryMode].filter(Boolean).length > 1) {
        throw new Error("read_tool_output accepts exactly one mode: query, line range, or character range");
      }
      if (queryMode) {
        const result = await store.search(params.ref, params.query!, {
          ...(params.caseSensitive === undefined ? {} : { caseSensitive: params.caseSensitive }),
          ...(params.contextChars === undefined ? {} : { contextChars: params.contextChars }),
          ...(params.maxMatches === undefined ? {} : { maxMatches: params.maxMatches }),
        });
        const observation = tracker.observe({
          bytes: result.bytes,
          key: `query:${result.caseSensitive}:${result.query}`,
          ref: result.ref,
        });
        const header = [
          `[tool output search] ${result.toolName} ref ${result.ref}: ${result.totalMatches} literal match(es)`
          + ` for ${JSON.stringify(result.query)} (${formatByteSize(result.totalBytes)} total).`,
          result.truncated ? `Showing ${result.matches.length} bounded match(es); narrow the query if the needed fact is absent.` : "",
          observation.advisory ?? "",
        ].filter(Boolean).join("\n");
        const body = result.matches.length
          ? result.matches.map((match, index) => [
            `[match ${index + 1}: chars ${match.startChar}-${match.endChar}]`,
            match.text,
          ].join("\n")).join("\n\n")
          : "No matches found. Change the query meaningfully or use the smallest relevant character range.";
        return {
          bounded: true,
          content: [{ type: "text", text: `${header}\n${body}` }],
          details: { ...result, readObservation: observation },
        };
      }
      if (characterMode) {
        const page = await store.readCharacters(params.ref, {
          ...(params.charLimit === undefined ? {} : { charLimit: params.charLimit }),
          ...(params.charOffset === undefined ? {} : { charOffset: params.charOffset }),
        });
        const observation = tracker.observe({
          bytes: page.bytes,
          key: `chars:${page.startChar}:${page.endChar}`,
          ref: page.ref,
        });
        const header = [
          `[tool output character page] ${page.toolName} ref ${page.ref}: chars ${page.startChar}-${page.endChar}`
          + ` of ${page.totalChars} (${formatByteSize(page.totalBytes)} total, ${formatByteSize(page.bytes)} shown).`,
          page.hasMore
            ? `More content is available at charOffset=${page.nextCharOffset}. Read it only when a specific missing fact requires that range.`
            : "This is the end of the stored output.",
          observation.advisory ?? "",
        ].filter(Boolean).join("\n");
        return {
          bounded: true,
          content: [{ type: "text", text: `${header}\n${page.text}` }],
          details: { ...page, readObservation: observation },
        };
      }
      const page = await store.read(params.ref, {
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.offset === undefined ? {} : { offset: params.offset }),
      });
      const observation = tracker.observe({
        bytes: page.bytes,
        key: `lines:${page.startLine}:${page.endLine}`,
        ref: page.ref,
      });
      const header = [
        `[tool output page] ${page.toolName} ref ${page.ref}: lines ${page.startLine}-${page.endLine}`
        + ` of ${page.totalLines} (${formatByteSize(page.totalBytes)} total, ${formatByteSize(page.bytes)} shown).`,
        ...(page.partialLine
          ? [`Line ${page.startLine} is wider than one page and was cut here; line offsets cannot address the rest of it.`
            + " Use query for a specific fact, or charOffset/charLimit to continue inside this line."]
          : []),
        page.hasMore
          ? `More content is available at offset=${page.nextOffset}. Read it only when a specific missing fact requires that range.`
          // Saying "end of the stored output" after cutting inside a line would
          // tell the model it has seen everything, which is exactly what it has
          // not done.
          : page.partialLine ? "" : "This is the end of the stored output.",
        observation.advisory ?? "",
      ].filter(Boolean).join("\n");
      return {
        bounded: true,
        content: [{ type: "text", text: `${header}\n${page.text}` }],
        details: { ...page, readObservation: observation },
      };
    },
    label: "Read stored tool output",
    name: "read_tool_output",
    parameters: readToolOutputParameters,
  };
  return [readToolOutput];
}
