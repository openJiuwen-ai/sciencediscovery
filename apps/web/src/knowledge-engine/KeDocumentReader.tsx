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

import katex from "katex";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { KeDocumentBlock, KeDocumentLevel, KeDocumentRead } from "../api/knowledge-engine.js";
import { KnowledgeEngineApiClient } from "../api/knowledge-engine.js";
import { useLocale, type MessageKey } from "../i18n/index.js";
import { MarkdownRenderer } from "../Markdown.js";

export interface KeDocumentReaderProps {
  client: KnowledgeEngineApiClient;
  kbId: string;
  docId: string;
  /** Verbatim evidence quote — when provided, the reader jumps to L1 and
   *  highlights the block containing it (NotebookLM-style click-through). */
  highlightQuote?: string | null;
  onClose: () => void;
}

const LEVEL_STORAGE_KEY = "keDocDefaultLevel";

function readDefaultLevel(): KeDocumentLevel {
  try {
    const raw = window.localStorage.getItem(LEVEL_STORAGE_KEY);
    return raw === "L1" || raw === "L2" ? raw : "L0";
  } catch {
    return "L0";
  }
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function wordSet(text: string): Set<string> {
  return new Set(normalize(text).toLowerCase().split(" ").filter((word) => word.length > 1));
}

/** Gate-parity quote location — the SAME verification standard as the
 *  extraction provenance gate, so a quote the gate admitted always locates:
 *  verbatim substring first, then the best ≥85% word-overlap block (the
 *  quote may have been gate-passed through the overlap arm, e.g. a PDF whose
 *  parsed text differs in punctuation/one word). */
function blockForQuote(blocks: KeDocumentBlock[], quote: string): { block: KeDocumentBlock; exact: boolean } | null {
  const needle = normalize(quote);
  if (!needle) return null;
  const verbatim = blocks.find((block) => normalize(block.text).includes(needle));
  if (verbatim) return { block: verbatim, exact: true };
  const quoteWords = wordSet(needle);
  if (quoteWords.size === 0) return null;
  let best: KeDocumentBlock | null = null;
  let bestRatio = 0.85;
  for (const block of blocks) {
    if (block.type === "reference") continue;
    const blockWords = wordSet(block.text);
    if (blockWords.size === 0) continue;
    let hit = 0;
    for (const word of quoteWords) {
      if (blockWords.has(word)) hit += 1;
    }
    const ratio = hit / quoteWords.size;
    if (ratio > bestRatio) {
      best = block;
      bestRatio = ratio;
    }
  }
  return best ? { block: best, exact: false } : null;
}

/** Inline `$..$` math segments rendered via KaTeX. Conservative: an inner
 *  segment that starts or ends with whitespace, or contains no letter and no
 *  backslash ("$5-$10" is money talk, never a formula), stays literal. */
const INLINE_MATH = /\$([^$\n]{1,200})\$/g;

function renderTex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false });
  } catch {
    // Unreachable with throwOnError:false in practice; keep the source visible.
    return "";
  }
}

function inlineMathNodes(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE_MATH)) {
    const tex = match[1]!;
    if (tex !== tex.trim() || !/[\p{L}\\]/u.test(tex)) continue;
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const html = renderTex(tex, false);
    if (html) {
      nodes.push(<span key={key++} dangerouslySetInnerHTML={{ __html: html }} />);
    } else {
      nodes.push(match[0]);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor === 0) return [text];
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/** Block body: formula blocks are pure LaTeX (the `$$`-fenced jats.ts shape)
 *  and render in display mode; prose-like blocks get inline `$..$` math;
 *  table/reference/code stay literal for source fidelity. */
function blockBody(block: KeDocumentBlock): ReactNode {
  if (block.type === "formula") {
    const html = renderTex(block.text, true);
    if (html) return <span data-testid="ke-doc-formula" dangerouslySetInnerHTML={{ __html: html }} />;
    return block.text;
  }
  if (block.type === "paragraph" || block.type === "heading" || block.type === "list" || block.type === "figure") {
    return <>{inlineMathNodes(block.text)}</>;
  }
  return block.text;
}

/**
 * W7 three-level document reader: L0 deterministic abstract → L1 anchored
 * blocks → L2 fulltext (the DA wiki pyramid, compiled on demand). Level
 * preference persists across opens. Anchors (`{docId}:{type}:{index}`) are
 * the address space shared with chat evidence links (W8). KaTeX renders the
 * `$..$` formulas the JATS pipeline emits (CSS is loaded once in main.tsx).
 */
export function KeDocumentReader({ client, kbId, docId, highlightQuote, onClose }: KeDocumentReaderProps) {
  const { t } = useLocale();

  const [level, setLevel] = useState<KeDocumentLevel>(readDefaultLevel);
  const [doc, setDoc] = useState<KeDocumentRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [highlightAnchorId, setHighlightAnchorId] = useState<string | null>(null);
  const [highlightFuzzy, setHighlightFuzzy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const cache = useRef(new Map<KeDocumentLevel, KeDocumentRead>());
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Armed by the reset effect (new doc / new quote); consumed once by the
  // resolver below — a manual level switch afterwards never bounces back.
  const pendingHighlight = useRef<string | null>(null);

  useEffect(() => {
    cache.current.clear();
    setDoc(null);
    setError(null);
    setLoading(true);
    setHighlightAnchorId(null);
    setHighlightFuzzy(false);
    pendingHighlight.current = highlightQuote ?? null;
  }, [docId, kbId, highlightQuote]);

  useEffect(() => {
    const cached = cache.current.get(level);
    if (cached) {
      setDoc(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .getKeDocument(kbId, docId, level)
      .then((payload) => {
        if (cancelled) return;
        cache.current.set(level, payload);
        setDoc(payload);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t("ke.doc.loadFailed"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, kbId, docId, level, t, reloadToken]);

  const selectLevel = useCallback((next: KeDocumentLevel) => {
    setLevel(next);
    try {
      window.localStorage.setItem(LEVEL_STORAGE_KEY, next);
    } catch {
      // Storage may be unavailable (private mode) — level choice stays per-open.
    }
  }, []);

  const blocks = doc?.blocks ?? null;

  // Evidence click-through resolver: the pending quote drives ONE automatic
  // switch to L1 (whichever level the reader opened at), then locates the
  // block. Order matters — the level switch must be decided BEFORE checking
  // blocks (blocks only exist in the L1 payload, so gating on them first
  // would make the switch unreachable from L0/L2).
  useEffect(() => {
    if (pendingHighlight.current === null) return;
    if (level !== "L1") {
      selectLevel("L1");
      return;
    }
    if (!blocks || blocks.length === 0) {
      // L1 loaded but unparsed — resolve honestly instead of waiting forever.
      if (!loading && doc) {
        pendingHighlight.current = null;
        setHighlightAnchorId("__miss__");
      }
      return;
    }
    const quote = pendingHighlight.current;
    pendingHighlight.current = null;
    const located = blockForQuote(blocks, quote);
    setHighlightAnchorId(located ? located.block.anchorId : "__miss__");
    setHighlightFuzzy(located ? !located.exact : false);
    if (located && containerRef.current) {
      const element = containerRef.current.querySelector<HTMLElement>(`[data-anchor="${located.block.anchorId}"]`);
      element?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [blocks, level, loading, doc, selectLevel]);

  const outline = useMemo(
    () => (blocks ?? []).filter((block) => block.type === "heading"),
    [blocks],
  );

  const jumpToAnchor = useCallback((anchorId: string) => {
    setHighlightAnchorId(anchorId);
    const element = containerRef.current?.querySelector<HTMLElement>(`[data-anchor="${anchorId}"]`);
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  return (
    <div
      data-testid="ke-doc-reader"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 30,
        display: "flex",
        flexDirection: "column",
        background: "var(--surface, #fff)",
        borderTop: "1px solid var(--border, #e2e8f0)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          borderBottom: "1px solid var(--border, #e2e8f0)",
          flexWrap: "wrap",
        }}
      >
        <strong data-testid="ke-doc-title" style={{ fontSize: 14, flex: "1 1 240px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {doc?.title ?? docId}
        </strong>
        <div role="tablist" aria-label="document levels" style={{ display: "flex", gap: 4 }}>
          {(["L0", "L1", "L2"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={level === option}
              data-testid={`ke-doc-level-${option}`}
              onClick={() => selectLevel(option)}
              style={{
                fontSize: 12,
                padding: "4px 10px",
                borderRadius: "var(--radius-m, 6px)",
                border: "1px solid var(--border, #e2e8f0)",
                background: level === option ? "var(--accent, #2563eb)" : "transparent",
                color: level === option ? "#fff" : "var(--text-secondary, #64748b)",
                cursor: "pointer",
              }}
            >
              {t(`ke.doc.level.${option}` as MessageKey)}
            </button>
          ))}
        </div>
        <button
          type="button"
          data-testid="ke-doc-close"
          onClick={onClose}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            borderRadius: "var(--radius-m, 6px)",
            border: "1px solid var(--border, #e2e8f0)",
            background: "transparent",
            color: "var(--text-secondary, #64748b)",
            cursor: "pointer",
          }}
        >
          {t("ke.doc.close")}
        </button>
      </div>

      <div ref={containerRef} style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {loading && <div style={{ color: "var(--text-secondary, #64748b)", fontSize: 13 }}>{t("ke.doc.loading")}</div>}
        {!loading && error && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--danger, #dc2626)", fontSize: 13 }}>
            <span>{error}</span>
            <button type="button" onClick={() => {
              cache.current.delete(level);
              setError(null);
              setReloadToken((token) => token + 1);
            }} style={{ fontSize: 12, cursor: "pointer" }}>
              {t("ke.doc.retry")}
            </button>
          </div>
        )}
        {!loading && !error && doc && level === "L0" && (
          <div>
            <p data-testid="ke-doc-summary" style={{ fontSize: 14, lineHeight: 1.7, margin: "0 0 8px" }}>
              {doc.l0?.summary ?? doc.abstract ?? ""}
            </p>
            <div style={{ fontSize: 11, color: "var(--text-faint, #94a3b8)", marginBottom: 12 }}>
              {doc.l0 ? t(`ke.doc.source.${doc.l0.source}` as MessageKey) : ""}
              {doc.year ? ` · ${doc.year}` : ""}
              {doc.venue ? ` · ${doc.venue}` : ""}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--text-faint, #94a3b8)" }}>{t("ke.doc.tagsLabel")}:</span>
              {(doc.l0?.tags ?? []).map((tag) => (
                <span
                  key={tag}
                  data-testid="ke-doc-tag"
                  style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "var(--surface-subtle, #f1f5f9)", color: "var(--text-secondary, #64748b)" }}
                >
                  {tag}
                </span>
              ))}
              {(doc.l0?.tags ?? []).length === 0 && <span style={{ fontSize: 11, color: "var(--text-faint, #94a3b8)" }}>{t("ke.doc.noTags")}</span>}
            </div>
          </div>
        )}
        {!loading && !error && doc && level === "L1" && (
          <div>
            {(blocks ?? []).length === 0 && <div style={{ color: "var(--text-secondary, #64748b)", fontSize: 13 }}>{t("ke.doc.pending")}</div>}
            {(blocks ?? []).length > 0 && (
              <>
                {outline.length > 0 && (
                  <div data-testid="ke-doc-outline" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                    {outline.map((heading) => (
                      <button
                        key={heading.anchorId}
                        type="button"
                        onClick={() => jumpToAnchor(heading.anchorId)}
                        style={{
                          fontSize: 11,
                          padding: "2px 8px",
                          borderRadius: "var(--radius-m, 6px)",
                          border: "1px solid var(--border, #e2e8f0)",
                          background: "transparent",
                          color: "var(--text-secondary, #64748b)",
                          cursor: "pointer",
                        }}
                      >
                        {heading.text}
                      </button>
                    ))}
                  </div>
                )}
                <div data-testid="ke-doc-blocks" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {t("ke.doc.blocksCount", { count: doc.blockCount ?? (blocks ?? []).length })}
                  {(blocks ?? []).map((block) => {
                    const highlighted = block.anchorId === highlightAnchorId;
                    return (
                      <div
                        key={block.anchorId}
                        data-testid={highlighted ? "ke-doc-highlight" : "ke-doc-block"}
                        data-anchor={block.anchorId}
                        data-type={block.type}
                        onClick={() => setHighlightAnchorId(block.anchorId)}
                        style={{
                          padding: "6px 10px",
                          borderRadius: "var(--radius-m, 6px)",
                          border: highlighted ? "1px solid var(--accent, #2563eb)" : "1px solid transparent",
                          background: highlighted ? "var(--surface-subtle, #eff6ff)" : "transparent",
                          cursor: "pointer",
                          fontSize: block.type === "heading" ? 14 : 13,
                          fontWeight: block.type === "heading" ? 600 : 400,
                          fontFamily: block.type === "code" || block.type === "table" ? "ui-monospace, monospace" : "inherit",
                          whiteSpace: block.type === "code" || block.type === "table" ? "pre" : "normal",
                          color: block.type === "figure" || block.type === "reference" ? "var(--text-secondary, #64748b)" : "inherit",
                          lineHeight: 1.6,
                          overflowX: block.type === "code" || block.type === "table" ? "auto" : "visible",
                        }}
                      >
                        {blockBody(block)}
                      </div>
                    );
                  })}
                </div>
                {highlightAnchorId === "__miss__" && (
                  <div data-testid="ke-doc-highlight-miss" style={{ marginTop: 8, fontSize: 11, color: "var(--warning, #d97706)" }}>
                    {t("ke.doc.highlightMiss")}
                  </div>
                )}
                {highlightAnchorId !== "__miss__" && highlightFuzzy && (
                  <div data-testid="ke-doc-highlight-fuzzy" style={{ marginTop: 8, fontSize: 11, color: "var(--warning, #d97706)" }}>
                    {t("ke.doc.highlightFuzzy")}
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {!loading && !error && doc && level === "L2" && (
          <div>
            {(doc.fulltext ?? "").length === 0 && <div style={{ color: "var(--text-secondary, #64748b)", fontSize: 13 }}>{t("ke.doc.pending")}</div>}
            <div data-testid="ke-doc-fulltext">
              <MarkdownRenderer content={doc.fulltext ?? ""} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
