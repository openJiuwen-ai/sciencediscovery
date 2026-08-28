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
 * Records are written under a caller-supplied session-scoped root so a
 * reference survives the run that produced it (later runs replay the same
 * history) while staying inside that session's data directory. Without a root
 * the store is process-local, which is enough for tests and for a run that
 * only pages back within itself.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Type } from "typebox";

import {
  boundText,
  DEFAULT_READ_PAGE_MAX_BYTES,
  DEFAULT_TOOL_OUTPUT_MAX_LINES,
  formatByteSize,
  splitKeepingLineEndings,
  type ToolOutputRecord,
  type ToolOutputSink,
} from "./bounded-output.js";
import type { AgentTool } from "./types.js";

/** Retention cap for one stored result; the reference stays useful, the disk does not fill. */
export const DEFAULT_RETAINED_OUTPUT_BYTES = 8 * 1_024 * 1_024;

/** How long a reference keeps resolving. Long enough to outlive a Session's active life. */
export const DEFAULT_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const REF_PATTERN = /^tool-output-[0-9a-f]{16}$/;

interface StoredOutput {
  createdAt: string;
  droppedBytes: number;
  text: string;
  toolName: string;
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

export class ToolOutputStore implements ToolOutputSink {
  private readonly memory = new Map<string, StoredOutput>();
  private readonly root: string | undefined;
  private readonly retainedBytes: number;
  private readonly retentionMs: number;
  private pruned = false;

  constructor(options: { retainedBytes?: number; retentionMs?: number; root?: string } = {}) {
    this.root = options.root;
    this.retainedBytes = options.retainedBytes ?? DEFAULT_RETAINED_OUTPUT_BYTES;
    this.retentionMs = options.retentionMs ?? DEFAULT_OUTPUT_RETENTION_MS;
  }

  async save(toolName: string, text: string): Promise<ToolOutputRecord> {
    const totalBytes = Buffer.byteLength(text, "utf8");
    const retained = totalBytes > this.retainedBytes
      ? boundText(text, { keep: "head", maxBytes: this.retainedBytes, maxLines: Number.MAX_SAFE_INTEGER }).text
      : text;
    const stored: StoredOutput = {
      createdAt: new Date().toISOString(),
      droppedBytes: totalBytes - Buffer.byteLength(retained, "utf8"),
      text: retained,
      toolName,
    };
    const ref = `tool-output-${randomBytes(8).toString("hex")}`;
    this.memory.set(ref, stored);
    await this.persist(ref, stored);
    return {
      bytes: Buffer.byteLength(retained, "utf8"),
      droppedBytes: stored.droppedBytes,
      lines: splitKeepingLineEndings(retained).length,
      ref,
      toolName,
    };
  }

  async read(ref: string, options: { limit?: number; offset?: number } = {}): Promise<ToolOutputPage> {
    if (!REF_PATTERN.test(ref)) throw new Error(`Unknown tool output ref: ${ref}`);
    const stored = this.memory.get(ref) ?? await this.load(ref);
    if (!stored) throw new Error(`Tool output ref is no longer available: ${ref}`);

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

  private async persist(ref: string, stored: StoredOutput): Promise<void> {
    if (!this.root) return;
    await mkdir(this.root, { recursive: true });
    await this.pruneExpired();
    const destination = resolve(this.root, `${ref}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
  }

  /**
   * Drop expired records once per store, so a long-lived Session directory
   * cannot grow without bound. Best effort: a failed prune must never fail the
   * tool call whose output is being stored.
   */
  private async pruneExpired(): Promise<void> {
    if (this.pruned || !this.root) return;
    this.pruned = true;
    const deadline = Date.now() - this.retentionMs;
    try {
      for (const entry of await readdir(this.root)) {
        if (!entry.endsWith(".json")) continue;
        const path = resolve(this.root, entry);
        const metadata = await stat(path).catch(() => undefined);
        if (metadata && metadata.mtimeMs < deadline) await unlink(path).catch(() => undefined);
      }
    } catch {
      // A missing or unreadable directory is not a reason to lose the output.
    }
  }

  private async load(ref: string): Promise<StoredOutput | undefined> {
    if (!this.root) return undefined;
    try {
      const raw = await readFile(resolve(this.root, `${ref}.json`), "utf8");
      const parsed = JSON.parse(raw) as StoredOutput;
      if (typeof parsed?.text !== "string") return undefined;
      this.memory.set(ref, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }
}

const readToolOutputParameters = Type.Object({
  limit: Type.Optional(Type.Integer({
    description: "Maximum number of lines to return. A page is additionally capped at 40 KB.",
    maximum: 10_000,
    minimum: 1,
  })),
  offset: Type.Optional(Type.Integer({
    description: "1-based line to start from. Defaults to 1.",
    minimum: 1,
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
export function createToolOutputTools(store: ToolOutputStore): AgentTool[] {
  const readToolOutput: AgentTool<typeof readToolOutputParameters> = {
    description: "Read a page of a tool result that was too large to be returned in full. Pass the ref printed in a bounded tool result, then page through it with offset and limit. Prefer narrowing the original tool call when you only need a small part.",
    execute: async (_toolCallId, params) => {
      const page = await store.read(params.ref, {
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.offset === undefined ? {} : { offset: params.offset }),
      });
      const header = [
        `[tool output page] ${page.toolName} ref ${page.ref}: lines ${page.startLine}-${page.endLine}`
        + ` of ${page.totalLines} (${formatByteSize(page.totalBytes)} total, ${formatByteSize(page.bytes)} shown).`,
        ...(page.partialLine
          ? [`Line ${page.startLine} is wider than one page and was cut here; line offsets cannot address the rest of it.`
            + " Re-run the original tool with a narrower request, or read the source with run_python or run_shell."]
          : []),
        page.hasMore
          ? `Continue with read_tool_output(ref="${page.ref}", offset=${page.nextOffset}).`
          // Saying "end of the stored output" after cutting inside a line would
          // tell the model it has seen everything, which is exactly what it has
          // not done.
          : page.partialLine ? "" : "This is the end of the stored output.",
      ].filter(Boolean).join("\n");
      return {
        bounded: true,
        content: [{ type: "text", text: `${header}\n${page.text}` }],
        details: page,
      };
    },
    label: "Read stored tool output",
    name: "read_tool_output",
    parameters: readToolOutputParameters,
  };
  return [readToolOutput];
}
