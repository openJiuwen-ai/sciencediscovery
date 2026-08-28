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
  DEFAULT_TOOL_OUTPUT_MAX_LINES,
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
