// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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
 * Three-level document pipeline (W7) — deterministic, LLM-free.
 *
 * L0 abstract / L1 anchored blocks / L2 fulltext mirror the DeepAnalyze
 * wiki pyramid, but compiled on demand from the stored fulltext markdown
 * (jats.ts or pdfplumber output) instead of persisted pages: SD keeps one
 * canonical markdown per document and re-derives the pyramid per request.
 * Determinism is the contract — same input, same blocks, same anchor ids —
 * because anchors are the join key between chat evidence and the reading
 * view ({docId}:{elementType}:{index}, the DA anchor convention).
 */

export type DocumentBlockType =
  | "heading"
  | "paragraph"
  | "formula"
  | "table"
  | "list"
  | "figure"
  | "reference"
  | "code";

export interface DocumentBlock {
  readonly type: DocumentBlockType;
  /** Index within the block's own type — stable while other blocks change. */
  readonly index: number;
  readonly text: string;
  /** Nearest preceding heading title ("Abstract", "References", …). */
  readonly section: string | null;
  /** 1-based line number of the block start in the source markdown. */
  readonly lineStart: number;
  /** Whitespace-normalized leading characters, capped for list surfaces. */
  readonly preview: string;
}

const PREVIEW_CHARS = 160;

/** DA-convention anchor id: `{docId}:{elementType}:{index}`. */
export function documentAnchor(docId: string, block: Pick<DocumentBlock, "type" | "index">): string {
  return `${docId}:${block.type}:${block.index}`;
}

function previewOf(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= PREVIEW_CHARS ? normalized : `${normalized.slice(0, PREVIEW_CHARS - 1)}…`;
}

function headingTitle(line: string): string {
  return line.replace(/^#{1,6}\s*/, "").trim();
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line);
}

function isFormulaFence(line: string): boolean {
  return line.trim() === "$$";
}

function isTableLine(line: string): boolean {
  return line.trim().startsWith("|");
}

function isListLine(line: string): boolean {
  return /^[-*]\s+\S/.test(line.trim());
}

function isReferenceLine(line: string): boolean {
  return /^-\s+\[[^\]]+\]\s/.test(line.trim());
}

/** `[Table 1] Some caption` — the jats.ts table-wrap caption shape. */
function isLabelCaption(line: string): boolean {
  return /^\[[^\]]+\]\s+\S/.test(line.trim());
}

function isSpecialLine(line: string, inReferences: boolean): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length === 0 ||
    isHeading(line) ||
    isFormulaFence(line) ||
    trimmed.startsWith("```") ||
    trimmed.startsWith("[Figure]") ||
    trimmed.startsWith("$$") ||
    isTableLine(line) ||
    isListLine(line) ||
    (inReferences && isReferenceLine(line))
  );
}

/**
 * Parse stored fulltext markdown into anchored blocks. Line-based and
 * tolerant: JATS-shaped markdown yields fully typed blocks; pdfplumber
 * text (often heading-less) degrades to paragraphs without failing.
 */
export function parseDocumentBlocks(markdown: string): DocumentBlock[] {
  const lines = markdown.split("\n");
  const blocks: DocumentBlock[] = [];
  const counters = new Map<DocumentBlockType, number>();
  let section: string | null = null;
  let inReferences = false;

  function push(type: DocumentBlockType, text: string, lineStart: number, currentSection: string | null): void {
    const index = counters.get(type) ?? 0;
    counters.set(type, index + 1);
    blocks.push({ type, index, text: text.trim(), section: currentSection, lineStart, preview: previewOf(text) });
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      i += 1;
      continue;
    }

    // Fenced code block: consume until the closing fence (or EOF — robust).
    if (trimmed.startsWith("```")) {
      const start = i + 1;
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) i += 1;
      const text = lines.slice(start, i).join("\n");
      if (i < lines.length) i += 1;
      if (text.trim().length > 0) push("code", text, start, section);
      continue;
    }

    // Display formula fence: `$$` … `$$` (the jats.ts disp-formula shape).
    if (isFormulaFence(line)) {
      const start = i + 1;
      i += 1;
      while (i < lines.length && !isFormulaFence(lines[i]!)) i += 1;
      const text = lines.slice(start, i).join("\n");
      if (i < lines.length) i += 1;
      if (text.trim().length > 0) push("formula", text, start, section);
      continue;
    }

    if (isHeading(line)) {
      const title = headingTitle(trimmed);
      inReferences = /^references$/i.test(title);
      section = title.length > 0 ? title : section;
      const start = i + 1;
      if (title.length > 0) push("heading", title, start, section);
      i += 1;
      continue;
    }

    if (trimmed.startsWith("[Figure]")) {
      push("figure", trimmed, i + 1, section);
      i += 1;
      continue;
    }

    // Table with its caption: the jats.ts table-wrap emits `[Label] caption`
    // on the line before the pipe rows — one anchorable unit, not a stray
    // paragraph plus a bare grid.
    if (isTableLine(line) || (isLabelCaption(line) && isTableLine(lines[i + 1] ?? ""))) {
      const start = i + 1;
      if (!isTableLine(line)) i += 1;
      while (i < lines.length && isTableLine(lines[i]!)) i += 1;
      push("table", lines.slice(start - 1, i).join("\n"), start, section);
      continue;
    }

    if (inReferences && isReferenceLine(line)) {
      push("reference", trimmed, i + 1, section);
      i += 1;
      continue;
    }

    if (isListLine(line)) {
      const start = i + 1;
      while (i < lines.length && isListLine(lines[i]!)) i += 1;
      push("list", lines.slice(start - 1, i).join("\n"), start, section);
      continue;
    }

    // Paragraph: consecutive plain lines joined (pdfplumber wraps lines).
    const start = i + 1;
    const collected: string[] = [];
    while (i < lines.length && !isSpecialLine(lines[i]!, inReferences)) {
      collected.push(lines[i]!.trim());
      i += 1;
    }
    if (collected.length > 0) push("paragraph", collected.join(" "), start, section);
  }

  return blocks;
}

// --------------------------------------------------------------------- L0

export interface DocumentL0 {
  readonly summary: string;
  readonly tags: readonly string[];
  /** Where the summary came from — the reading view labels it honestly. */
  readonly source: "abstract" | "body" | "title";
}

function clampSummary(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  const head = normalized.slice(0, maxChars);
  const sentenceEnd = Math.max(head.lastIndexOf("。"), head.lastIndexOf(". "), head.lastIndexOf("!"), head.lastIndexOf("?"), head.lastIndexOf("！"), head.lastIndexOf("？"));
  if (sentenceEnd >= Math.floor(maxChars * 0.5)) return head.slice(0, sentenceEnd + 1);
  const wordEnd = head.lastIndexOf(" ");
  return `${(wordEnd >= Math.floor(maxChars * 0.5) ? head.slice(0, wordEnd) : head)}…`;
}

/**
 * Deterministic extractive L0 — no LLM. The DA three-layer contract keeps
 * abstracts "deliberately extractive when the summarizer is unavailable";
 * SD starts there and may layer an LLM abstract behind a grounding gate
 * in a later wave. Preference: stored abstract column → first substantial
 * body paragraph → title. Tags come from section headings.
 */
export function buildDeterministicL0(input: {
  title: string;
  abstract?: string | null;
  blocks: readonly DocumentBlock[];
  maxSummaryChars?: number;
  maxTags?: number;
}): DocumentL0 {
  const maxSummaryChars = input.maxSummaryChars ?? 320;
  const maxTags = input.maxTags ?? 5;

  const abstract = input.abstract?.replace(/\s+/g, " ").trim() ?? "";
  if (abstract.length > 0) {
    return { summary: clampSummary(abstract, maxSummaryChars), tags: headingTags(input.blocks, maxTags), source: "abstract" };
  }
  const bodyParagraph = input.blocks.find((block) => block.type === "paragraph" && block.text.length >= 120);
  if (bodyParagraph) {
    return { summary: clampSummary(bodyParagraph.text, maxSummaryChars), tags: headingTags(input.blocks, maxTags), source: "body" };
  }
  const title = input.title.replace(/\s+/g, " ").trim();
  return { summary: clampSummary(title, maxSummaryChars), tags: headingTags(input.blocks, maxTags), source: "title" };
}

function headingTags(blocks: readonly DocumentBlock[], maxTags: number): string[] {
  const tags: string[] = [];
  for (const block of blocks) {
    if (block.type !== "heading") continue;
    if (/^(abstract|references)$/i.test(block.text)) continue;
    if (!tags.includes(block.text)) tags.push(block.text);
    if (tags.length >= maxTags) break;
  }
  return tags;
}

// ------------------------------------------------------------------ anchors

export interface DocumentAnchorHit {
  readonly block: DocumentBlock;
  readonly before: DocumentBlock | null;
  readonly after: DocumentBlock | null;
}

/**
 * Resolve `{docId}:{elementType}:{index}` against parsed blocks. Unknown
 * ids return null — the caller decides 404. Type and index are taken from
 * the RIGHT of the id so docIds containing colons cannot shift the parse.
 */
export function resolveDocumentAnchor(blocks: readonly DocumentBlock[], anchorId: string): DocumentAnchorHit | null {
  const parts = anchorId.split(":");
  if (parts.length < 3) return null;
  const index = Number(parts.pop());
  const type = parts.pop()!;
  if (!Number.isInteger(index) || index < 0) return null;
  const position = blocks.findIndex((block) => block.type === type && block.index === index);
  if (position === -1) return null;
  return {
    block: blocks[position]!,
    before: position > 0 ? blocks[position - 1]! : null,
    after: position < blocks.length - 1 ? blocks[position + 1]! : null,
  };
}
