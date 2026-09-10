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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { KeDocumentBlock, KeDocumentLevel, KeDocumentRead } from "../api/knowledge-engine.js";
import { KnowledgeEngineApiClient } from "../api/knowledge-engine.js";
import { useLocale } from "../i18n/index.js";

export interface KeDocumentReaderProps {
  client: KnowledgeEngineApiClient;
  kbId: string;
  docId: string;
  /** Verbatim evidence quote — when provided, the reader jumps to L1 and
   *  highlights the block containing it (NotebookLM-style click-through). */
  highlightQuote?: string | null;
  onClose: () => void;
}

/**
 * W7 three-level document reader: L0 deterministic abstract → L1 anchored
 * blocks → L2 fulltext (the DA wiki pyramid, compiled on demand). Level
 * preference persists across opens. Anchors (`{docId}:{type}:{index}`) are
 * the address space shared with chat evidence links (W8).
 *
 * Standalone by design during the W6/W7 transition: copy lives in a local
 * bilingual map pending migration to `ke.doc.*` i18n keys once the W6
 * messages.ts changes land; the component is wired into KnowledgeEnginePage
 * in the same step.
 */
const STRINGS = {
  levelL0: { en: "L0 · Abstract", "zh-CN": "L0 · 摘要" },
  levelL1: { en: "L1 · Structure", "zh-CN": "L1 · 结构" },
  levelL2: { en: "L2 · Full text", "zh-CN": "L2 · 原文" },
  close: { en: "Close", "zh-CN": "关闭" },
  loading: { en: "Loading…", "zh-CN": "加载中…" },
  loadFailed: { en: "Failed to load document", "zh-CN": "文档加载失败" },
  retry: { en: "Retry", "zh-CN": "重试" },
  pendingDoc: { en: "This document has not been parsed yet — no fulltext levels available.", "zh-CN": "该文档尚未解析完成——暂无正文层级。" },
  outline: { en: "Outline", "zh-CN": "目录" },
  blocksCount: { en: "{count} blocks", "zh-CN": "{count} 个块" },
  sourceAbstract: { en: "summary from abstract", "zh-CN": "摘要来自摘要段" },
  sourceBody: { en: "summary from first paragraph", "zh-CN": "摘要来自正文首段" },
  sourceTitle: { en: "summary from title", "zh-CN": "摘要来自标题" },
  tagsLabel: { en: "Tags", "zh-CN": "标签" },
  noTags: { en: "no section tags", "zh-CN": "暂无章节标签" },
  highlightMiss: { en: "evidence passage not found verbatim in this version", "zh-CN": "证据原文在此版本中未逐字命中" },
  lineRef: { en: "line {line}", "zh-CN": "第 {line} 行" },
} as const;

type LocaleKey = "en" | "zh-CN";

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

/** Locate the L1 block whose text contains the verbatim quote (whitespace-
 *  normalized, same leniency as the provenance gate's substring arm). */
function blockForQuote(blocks: KeDocumentBlock[], quote: string): KeDocumentBlock | null {
  const needle = normalize(quote);
  if (!needle) return null;
  return blocks.find((block) => normalize(block.text).includes(needle)) ?? null;
}

export function KeDocumentReader({ client, kbId, docId, highlightQuote, onClose }: KeDocumentReaderProps) {
  const { locale } = useLocale();
  const lang: LocaleKey = locale === "zh-CN" ? "zh-CN" : "en";
  const say = useCallback((key: keyof typeof STRINGS, vars?: Record<string, string | number>): string => {
    const template: string = STRINGS[key][lang];
    if (!vars) return template;
    return Object.entries(vars).reduce<string>((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template);
  }, [lang]);

  const [level, setLevel] = useState<KeDocumentLevel>(readDefaultLevel);
  const [doc, setDoc] = useState<KeDocumentRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [highlightAnchorId, setHighlightAnchorId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const cache = useRef(new Map<KeDocumentLevel, KeDocumentRead>());
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    cache.current.clear();
    setDoc(null);
    setError(null);
    setLoading(true);
  }, [docId]);

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
        setError(say("loadFailed"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, kbId, docId, level, say, reloadToken]);

  const selectLevel = useCallback((next: KeDocumentLevel) => {
    setLevel(next);
    try {
      window.localStorage.setItem(LEVEL_STORAGE_KEY, next);
    } catch {
      // Storage may be unavailable (private mode) — level choice stays per-open.
    }
  }, []);

  const blocks = doc?.blocks ?? null;
  const pendingHighlight = useRef<string | null>(null);

  // Evidence click-through: once L1 blocks are in hand, find the block whose
  // text contains the quote, reveal it, and scroll it into view.
  useEffect(() => {
    if (!highlightQuote || !blocks || blocks.length === 0) return;
    if (level !== "L1") {
      pendingHighlight.current = highlightQuote;
      selectLevel("L1");
      return;
    }
    const quote = pendingHighlight.current ?? highlightQuote;
    pendingHighlight.current = null;
    const target = blockForQuote(blocks, quote);
    setHighlightAnchorId(target ? target.anchorId : "__miss__");
    if (target && containerRef.current) {
      const element = containerRef.current.querySelector<HTMLElement>(`[data-anchor="${target.anchorId}"]`);
      element?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [highlightQuote, blocks, level, selectLevel]);

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
              {say(`level${option}` as keyof typeof STRINGS)}
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
          {say("close")}
        </button>
      </div>

      <div ref={containerRef} style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {loading && <div style={{ color: "var(--text-secondary, #64748b)", fontSize: 13 }}>{say("loading")}</div>}
        {!loading && error && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--danger, #dc2626)", fontSize: 13 }}>
            <span>{error}</span>
            <button type="button" onClick={() => {
              cache.current.delete(level);
              setError(null);
              setReloadToken((token) => token + 1);
            }} style={{ fontSize: 12, cursor: "pointer" }}>
              {say("retry")}
            </button>
          </div>
        )}
        {!loading && !error && doc && level === "L0" && (
          <div>
            <p data-testid="ke-doc-summary" style={{ fontSize: 14, lineHeight: 1.7, margin: "0 0 8px" }}>
              {doc.l0?.summary ?? doc.abstract ?? ""}
            </p>
            <div style={{ fontSize: 11, color: "var(--text-faint, #94a3b8)", marginBottom: 12 }}>
              {doc.l0 ? say(`source${doc.l0.source[0]!.toUpperCase()}${doc.l0.source.slice(1)}` as keyof typeof STRINGS) : ""}
              {doc.year ? ` · ${doc.year}` : ""}
              {doc.venue ? ` · ${doc.venue}` : ""}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--text-faint, #94a3b8)" }}>{say("tagsLabel")}:</span>
              {(doc.l0?.tags ?? []).map((tag) => (
                <span
                  key={tag}
                  data-testid="ke-doc-tag"
                  style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "var(--surface-subtle, #f1f5f9)", color: "var(--text-secondary, #64748b)" }}
                >
                  {tag}
                </span>
              ))}
              {(doc.l0?.tags ?? []).length === 0 && <span style={{ fontSize: 11, color: "var(--text-faint, #94a3b8)" }}>{say("noTags")}</span>}
            </div>
          </div>
        )}
        {!loading && !error && doc && level === "L1" && (
          <div>
            {(blocks ?? []).length === 0 && <div style={{ color: "var(--text-secondary, #64748b)", fontSize: 13 }}>{say("pendingDoc")}</div>}
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
                  {say("blocksCount", { count: doc.blockCount ?? (blocks ?? []).length })}
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
                          fontFamily: block.type === "formula" || block.type === "code" || block.type === "table" ? "ui-monospace, monospace" : "inherit",
                          whiteSpace: block.type === "formula" || block.type === "code" || block.type === "table" ? "pre" : "normal",
                          color: block.type === "figure" || block.type === "reference" ? "var(--text-secondary, #64748b)" : "inherit",
                          lineHeight: 1.6,
                        }}
                      >
                        {block.text}
                      </div>
                    );
                  })}
                </div>
                {highlightAnchorId === "__miss__" && (
                  <div data-testid="ke-doc-highlight-miss" style={{ marginTop: 8, fontSize: 11, color: "var(--warning, #d97706)" }}>
                    {say("highlightMiss")}
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {!loading && !error && doc && level === "L2" && (
          <div>
            {(doc.fulltext ?? "").length === 0 && <div style={{ color: "var(--text-secondary, #64748b)", fontSize: 13 }}>{say("pendingDoc")}</div>}
            <pre data-testid="ke-doc-fulltext" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, lineHeight: 1.6, fontFamily: "inherit", margin: 0 }}>
              {doc.fulltext ?? ""}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
