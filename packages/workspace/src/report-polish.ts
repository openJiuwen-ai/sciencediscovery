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
 * Report polish (phase V, V2-C4 — SA report/cleaner.ts adapted): a
 * deterministic post-generation pass over markdown reports. Three stages:
 * boilerplate strip, citation marking (verbatim fragments matched against
 * the knowledge base become [n] markers with an index — the backstop for
 * quotes the model forgot to attribute), and heading normalization.
 *
 * Deliberate divergences from SA: entity linking is dropped (the KE graph
 * has real entities — regex-extracting names is strictly worse), and
 * citation marking VERIFIES each fragment against the corpus via a caller
 * probe instead of fuzzy-matching locally — an unverifiable fragment is
 * left untouched, never re-attributed by similarity guessing.
 */

export interface PolishCitation {
  docId: string;
  docTitle?: string;
  marker: number;
}

export interface PolishStats {
  boilerplateBlocksRemoved: number;
  citationsMarked: number;
  fragmentsChecked: number;
  headingsNormalized: number;
}

export interface PolishResult {
  citations: PolishCitation[];
  cleaned: string;
  stats: PolishStats;
}

/** Probe: does this exact fragment appear in the corpus? Returns the source. */
export type CitationProbe = (fragment: string) => Promise<{ docId: string; docTitle?: string } | undefined>;

// ---------------------------------------------------------------------------
// Stage 1: boilerplate strip
// ---------------------------------------------------------------------------

const BOILERPLATE_PATTERNS: readonly RegExp[] = [
  /^From:\s*(?:Overview|Summary):\s*.*?(?:\n\n|\n(?=\S)|$)/gms,
  /^Based on the (?:provided )?(?:documents?|information|text|context|papers?|knowledge base)[^.]*\.\s*/gim,
  /^According to the (?:documents?|text|provided information|papers?|knowledge base)[^.]*\.\s*/gim,
  /^(?:基于|根据)(?:所提供的?)?(?:文档|论文|材料|上下文|知识库)[^。\n]*[。:：]\s*/gm,
];

/** Boilerplate stripping only inspects the report's opening — mid-report
 *  sentences that happen to start with these phrases are real content. */
const BOILERPLATE_SCAN_LINES = 20;

export function stripBoilerplate(raw: string): { blocksRemoved: number; content: string } {
  const lines = raw.split("\n");
  let head = lines.slice(0, BOILERPLATE_SCAN_LINES).join("\n");
  let blocksRemoved = 0;
  for (const pattern of BOILERPLATE_PATTERNS) {
    const before = head;
    head = head.replace(pattern, "");
    if (head !== before) blocksRemoved += 1;
  }
  const content = `${head}\n${lines.slice(BOILERPLATE_SCAN_LINES).join("\n")}`
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { blocksRemoved, content };
}

// ---------------------------------------------------------------------------
// Stage 2: citation marking
// ---------------------------------------------------------------------------

const MIN_FRAGMENT_CHARS = 30;
const MAX_FRAGMENT_CHARS = 500;
const MAX_FRAGMENTS = 25;

/** Verbatim-intended fragments: paired quotes and blockquote lines. */
export function extractFragments(text: string): string[] {
  const fragments: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const fragment = raw.trim().replaceAll(/\s+/g, " ");
    if (fragment.length < MIN_FRAGMENT_CHARS || fragment.length > MAX_FRAGMENT_CHARS) return;
    const key = fragment.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    fragments.push(fragment);
  };
  for (const match of text.matchAll(/[“"「]([^”"「“」]{30,500})[”"」]/gu)) push(match[1]!);
  for (const match of text.matchAll(/^[ \t]*>[ \t]*(["“][^"”]{30,500}["”]|[^"”\n]{30,500})[ \t]*$/gmu)) {
    push(match[1]!.replace(/^["“]|["”]$/g, ""));
  }
  return fragments.slice(0, MAX_FRAGMENTS);
}

/** Whitespace-tolerant location of a (folded) fragment in the raw text. */
function locate(content: string, fragment: string): { end: number; start: number } | undefined {
  const tokens = fragment.split(" ").filter(Boolean)
    .map((token) => token.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!tokens.length) return undefined;
  const match = new RegExp(tokens.join("\\s+")).exec(content);
  return match ? { end: match.index + match[0].length, start: match.index } : undefined;
}

/**
 * Mark verified fragments as [n] citations. The probe decides each
 * fragment's source; fragments the probe cannot place are left EXACTLY as
 * written (the grounding gate handles them separately — this pass never
 * strips or rewrites unattributed text). A citation is recorded ONLY when
 * its marker was actually inserted (no dangling index entries), fragments
 * nested inside an already-marked span are skipped, and the marker lands
 * after the closing quote mark, not inside the quotation.
 */
export async function markCitations(
  content: string,
  probe: CitationProbe,
  startMarker = 1,
): Promise<{ citations: PolishCitation[]; content: string; fragmentsChecked: number }> {
  const fragments = extractFragments(content);
  if (!fragments.length) return { citations: [], content, fragmentsChecked: 0 };
  const citations: PolishCitation[] = [];
  const byDoc = new Map<string, number>();
  const markedIntervals: Array<{ end: number; start: number }> = [];
  let marked = content;
  let nextMarker = startMarker;
  for (const fragment of fragments) {
    const source = await probe(fragment);
    if (!source) continue;
    const location = locate(marked, fragment);
    // Never record what was not inserted (review P2: folded fragments that
    // cannot be located produce no dangling index entries).
    if (!location) continue;
    // Skip fragments nested in (or overlapping) an already-marked span.
    if (markedIntervals.some((interval) => location.start < interval.end && interval.start < location.end)) continue;
    let marker = byDoc.get(source.docId);
    if (marker === undefined) {
      marker = nextMarker;
      nextMarker += 1;
      byDoc.set(source.docId, marker);
      citations.push({ docId: source.docId, marker, ...(source.docTitle ? { docTitle: source.docTitle } : {}) });
    }
    // The marker goes after the closing quote mark when one follows (P3).
    let insertAt = location.end;
    const nextChar = marked[insertAt];
    if (nextChar === "”" || nextChar === '"' || nextChar === "」") insertAt += 1;
    marked = `${marked.slice(0, insertAt)} [${marker}]${marked.slice(insertAt)}`;
    markedIntervals.push({ end: insertAt + ` [${marker}]`.length, start: location.start });
  }
  return { citations, content: marked, fragmentsChecked: fragments.length };
}

// ---------------------------------------------------------------------------
// Stage 3: heading normalization (top-level headings start at ##; the title
// itself, if any, stays at #)
// ---------------------------------------------------------------------------

export function normalizeHeadings(content: string): { content: string; normalized: number } {
  let normalized = 0;
  const lines = content.split("\n");
  let firstHeadingSeen = false;
  let inCodeFence = false;
  const out = lines.map((line) => {
    // Fenced code blocks are opaque — a "# comment" inside is not a heading,
    // and it must not steal the first-heading slot either (review P2).
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      return line;
    }
    if (inCodeFence) return line;
    const match = /^(#{1,6})\s/.exec(line);
    if (!match) return line;
    if (!firstHeadingSeen) {
      firstHeadingSeen = true;
      return line; // the document title keeps its level
    }
    const level = match[1]!.length;
    if (level === 2) return line;
    if (level === 1) {
      normalized += 1;
      return `##${line.slice(1)}`;
    }
    if (level > 4) {
      normalized += 1;
      return `####${line.slice(level)}`;
    }
    return line;
  });
  return { content: out.join("\n"), normalized };
}

/** The full pipeline (stages 1 → 2 → 3). */
export async function polishReport(raw: string, probe?: CitationProbe): Promise<PolishResult> {
  const stage1 = stripBoilerplate(raw);
  const stage2 = probe
    ? await markCitations(stage1.content, probe)
    : { citations: [], content: stage1.content, fragmentsChecked: 0 };
  const stage3 = normalizeHeadings(stage2.content);
  return {
    citations: stage2.citations,
    cleaned: stage3.content,
    stats: {
      boilerplateBlocksRemoved: stage1.blocksRemoved,
      citationsMarked: stage2.citations.length,
      fragmentsChecked: stage2.fragmentsChecked,
      headingsNormalized: stage3.normalized,
    },
  };
}
