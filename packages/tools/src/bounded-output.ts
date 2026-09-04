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
 * Deterministic model-facing bounds for tool results.
 *
 * A tool result becomes an atomic message in canonical history: the window
 * policy may not drop it while it belongs to the newest user turn, so an
 * unbounded result can push the assembled input past the model-aware budget
 * before the provider is ever called. Everything here is deterministic — no
 * extra model call — so the bound holds for the result that already exists.
 *
 * The strategy is preview + reference: keep a fixed-size page (head for reads,
 * tail for execution output where the exit status and stack trace live), store
 * the full text behind a reference, and tell the model how to page back in.
 */

export const DEFAULT_TOOL_OUTPUT_MAX_LINES = 2_000;
export const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 50 * 1_024;
/** Store moderately large results before compaction needs to replace them. */
export const DEFAULT_TOOL_OUTPUT_RETENTION_BYTES = 8 * 1_024;

/**
 * Page bound for tools that paginate themselves. It stays below
 * `DEFAULT_TOOL_OUTPUT_MAX_BYTES` so the page plus its envelope (JSON wrapper,
 * range header) still fits inside the registry bound.
 */
export const DEFAULT_READ_PAGE_MAX_BYTES = 40 * 1_024;

/**
 * A self-bounded result is trusted, but not unconditionally: a tool that
 * mis-reports its own bound must still not reach canonical history unbounded.
 */
const SELF_BOUNDED_TOLERANCE = 4;

export type BoundedKeep = "head" | "tail";

export interface BoundTextOptions {
  /** Which end of the text survives. Defaults to `head`. */
  keep?: BoundedKeep;
  maxBytes?: number;
  maxLines?: number;
}

export interface BoundedText {
  keep: BoundedKeep;
  omittedBytes: number;
  omittedLines: number;
  /**
   * True when the cut fell inside a line because one line was wider than the
   * whole budget. Line offsets cannot address the remainder of that line.
   */
  partialLine: boolean;
  text: string;
  totalBytes: number;
  totalLines: number;
  truncated: boolean;
}

/** Reference to a stored full tool result the model can page back through. */
export interface ToolOutputRecord {
  /** Byte size of the stored output; the tool's result verbatim. */
  bytes: number;
  lines: number;
  ref: string;
  toolName: string;
}

export interface ToolOutputSink {
  save(toolName: string, text: string): Promise<ToolOutputRecord>;
}

/** Split into lines that keep their own terminator, so joining is lossless. */
export function splitKeepingLineEndings(text: string): string[] {
  if (!text) return [];
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    lines.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** Cut on a character boundary so a byte cap never emits a broken code point. */
function sliceToBytes(text: string, maxBytes: number, keep: BoundedKeep): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  if (keep === "head") {
    let end = maxBytes;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    return bytes.subarray(0, end).toString("utf8");
  }
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

/** Keep at most `maxLines` lines and `maxBytes` bytes from one end of `text`. */
export function boundText(text: string, options: BoundTextOptions = {}): BoundedText {
  const keep = options.keep ?? "head";
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_TOOL_OUTPUT_MAX_LINES);
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES);
  const totalBytes = Buffer.byteLength(text, "utf8");
  const lines = splitKeepingLineEndings(text);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { keep, omittedBytes: 0, omittedLines: 0, partialLine: false, text, totalBytes, totalLines, truncated: false };
  }

  const ordered = keep === "head" ? lines : [...lines].reverse();
  const kept: string[] = [];
  let bytes = 0;
  let partialLine = false;
  for (const line of ordered) {
    if (kept.length >= maxLines) break;
    const size = Buffer.byteLength(line, "utf8");
    if (bytes + size > maxBytes) {
      // One line longer than the whole budget still has to yield a usable
      // preview, so cut inside it rather than returning an empty page.
      if (kept.length === 0) {
        kept.push(sliceToBytes(line, maxBytes, keep));
        partialLine = true;
      }
      break;
    }
    kept.push(line);
    bytes += size;
  }
  if (keep === "tail") kept.reverse();
  const preview = kept.join("");
  return {
    keep,
    omittedBytes: totalBytes - Buffer.byteLength(preview, "utf8"),
    omittedLines: Math.max(0, totalLines - kept.length),
    partialLine,
    text: preview,
    totalBytes,
    totalLines,
    truncated: true,
  };
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

/** Build a two-sided preview so both the result header and final status survive. */
function headTailPreview(text: string, maxBytes: number, maxLines: number, preferred: BoundedKeep): string {
  const primaryShare = Math.max(1, Math.floor(maxBytes * 0.65));
  const secondaryShare = Math.max(1, maxBytes - primaryShare);
  const primaryLines = Math.max(1, Math.floor(maxLines * 0.65));
  const secondaryLines = Math.max(1, maxLines - primaryLines);
  const lines = splitKeepingLineEndings(text);
  const head = sliceToBytes(lines.slice(0, preferred === "head" ? primaryLines : secondaryLines).join(""),
    preferred === "head" ? primaryShare : secondaryShare, "head");
  const tail = sliceToBytes(lines.slice(-(preferred === "tail" ? primaryLines : secondaryLines)).join(""),
    preferred === "tail" ? primaryShare : secondaryShare, "tail");
  return `${head}\n[... middle omitted; full result available by ref ...]\n${tail}`;
}

/**
 * Tools whose answer lives at the end of the stream: exit status, final
 * metrics, and the traceback of a failed experiment.
 */
export const DEFAULT_TAIL_PREVIEW_TOOLS: readonly string[] = [
  "run_npu_job",
  "run_python",
  "run_r",
  "run_shell",
];

export interface ToolOutputGuardOptions {
  keepTailTools?: Iterable<string>;
  maxBytes?: number;
  maxLines?: number;
  /** Results above this size receive a durable ref even when shown in full. */
  retentionBytes?: number;
  sink: ToolOutputSink;
}

export interface ToolOutputGuardResult {
  content: string;
  record?: ToolOutputRecord;
  truncated: boolean;
}

/**
 * The single bound every tool result crosses on its way into canonical
 * history. Tools that paginate themselves keep their own formatting; the
 * guard only re-truncates them if they blow past the bound anyway, so a new
 * tool cannot silently opt out of the limit.
 */
export class ToolOutputGuard {
  private readonly keepTailTools: ReadonlySet<string>;
  private readonly maxBytes: number;
  private readonly maxLines: number;
  private readonly retentionBytes: number;

  constructor(private readonly options: ToolOutputGuardOptions) {
    this.keepTailTools = new Set(options.keepTailTools ?? DEFAULT_TAIL_PREVIEW_TOOLS);
    this.maxBytes = options.maxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES;
    this.maxLines = options.maxLines ?? DEFAULT_TOOL_OUTPUT_MAX_LINES;
    this.retentionBytes = options.retentionBytes ?? DEFAULT_TOOL_OUTPUT_RETENTION_BYTES;
  }

  async apply(toolName: string, content: string, selfBounded = false): Promise<string> {
    return (await this.applyDetailed(toolName, content, selfBounded)).content;
  }

  async applyDetailed(toolName: string, content: string, selfBounded = false): Promise<ToolOutputGuardResult> {
    const tolerance = selfBounded ? SELF_BOUNDED_TOLERANCE : 1;
    const keep = this.keepTailTools.has(toolName) ? "tail" : "head";
    const bounded = boundText(content, {
      keep,
      maxBytes: this.maxBytes * tolerance,
      maxLines: this.maxLines * tolerance,
    });
    let record: ToolOutputRecord | undefined;
    if (bounded.truncated || (!selfBounded && Buffer.byteLength(content, "utf8") > this.retentionBytes)) {
      try {
        record = await this.options.sink.save(toolName, content);
      } catch {
        // Storage is best effort: a bounded result without a reference is still
        // far better than an oversized one that fails the whole request.
        record = undefined;
      }
    }
    if (!bounded.truncated) return { content, ...(record ? { record } : {}), truncated: false };
    const preview = headTailPreview(content, this.maxBytes * tolerance, this.maxLines * tolerance, keep);
    return {
      content: [describeBound(toolName, bounded, preview, record), preview].join("\n"),
      ...(record ? { record } : {}),
      truncated: true,
    };
  }
}

function describeBound(toolName: string, bounded: BoundedText, preview: string, record: ToolOutputRecord | undefined): string {
  const shown = Buffer.byteLength(preview, "utf8");
  const lines = [
    `[bounded tool output] ${toolName} produced ${bounded.totalLines} lines (${formatByteSize(bounded.totalBytes)}).`
    + ` This result shows a bounded head/tail preview (${formatByteSize(shown)}); the middle is omitted here.`,
  ];
  if (record) {
    lines.push(
      `The full output is stored as ref "${record.ref}" (${record.lines} lines, ${formatByteSize(record.bytes)}).`
      + ` Read any part of it with read_tool_output(ref="${record.ref}", offset=<1-based line>, limit=<lines>).`,
    );
  } else {
    lines.push("The full output could not be stored for re-reading. Re-run the tool with a narrower request or explicit pagination.");
  }
  return lines.join("\n");
}
