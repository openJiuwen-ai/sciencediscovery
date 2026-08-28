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
  /** Retained bytes; smaller than the original when the retention cap applied. */
  bytes: number;
  droppedBytes: number;
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
  const characters = [...text];
  if (keep === "tail") characters.reverse();
  const picked: string[] = [];
  let bytes = 0;
  for (const character of characters) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    picked.push(character);
    bytes += size;
  }
  if (keep === "tail") picked.reverse();
  return picked.join("");
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
  sink: ToolOutputSink;
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

  constructor(private readonly options: ToolOutputGuardOptions) {
    this.keepTailTools = new Set(options.keepTailTools ?? DEFAULT_TAIL_PREVIEW_TOOLS);
    this.maxBytes = options.maxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES;
    this.maxLines = options.maxLines ?? DEFAULT_TOOL_OUTPUT_MAX_LINES;
  }

  async apply(toolName: string, content: string, selfBounded = false): Promise<string> {
    const tolerance = selfBounded ? SELF_BOUNDED_TOLERANCE : 1;
    const keep = this.keepTailTools.has(toolName) ? "tail" : "head";
    const bounded = boundText(content, {
      keep,
      maxBytes: this.maxBytes * tolerance,
      maxLines: this.maxLines * tolerance,
    });
    if (!bounded.truncated) return content;

    let record: ToolOutputRecord | undefined;
    try {
      record = await this.options.sink.save(toolName, content);
    } catch {
      // Storage is best effort: a bounded result without a reference is still
      // far better than an oversized one that fails the whole request.
      record = undefined;
    }
    return [describeBound(toolName, bounded, record), bounded.text].join("\n");
  }
}

function describeBound(toolName: string, bounded: BoundedText, record: ToolOutputRecord | undefined): string {
  const shown = Buffer.byteLength(bounded.text, "utf8");
  const position = bounded.keep === "head" ? "first" : "last";
  const lines = [
    `[bounded tool output] ${toolName} produced ${bounded.totalLines} lines (${formatByteSize(bounded.totalBytes)}).`
    + ` This result shows the ${position} ${bounded.totalLines - bounded.omittedLines} lines (${formatByteSize(shown)});`
    + ` ${bounded.omittedLines} lines (${formatByteSize(bounded.omittedBytes)}) are omitted here.`,
  ];
  if (record) {
    lines.push(
      `The full output is stored as ref "${record.ref}" (${record.lines} lines, ${formatByteSize(record.bytes)}).`
      + ` Read any part of it with read_tool_output(ref="${record.ref}", offset=<1-based line>, limit=<lines>).`,
    );
    if (record.droppedBytes > 0) {
      lines.push(`The last ${formatByteSize(record.droppedBytes)} exceeded the retained-output cap and were not stored.`);
    }
  } else {
    lines.push("The full output could not be stored for re-reading. Re-run the tool with a narrower request or explicit pagination.");
  }
  return lines.join("\n");
}
