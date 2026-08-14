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

// Shared building blocks for memory-graph node detail panels. Each node label
// (Paper / Evidence / Claim / Code / SubTask / ResearchGoal) composes these
// instead of dumping `node.extra` as a flat key/value list — so hashes decode
// to content, long text truncates, times format, and links are clickable.

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useLocale } from "./i18n/LocaleProvider.js";

// --- Evidence field classification (shared with EvidenceModal) -------------
// Known structured fields on an Evidence node's `extra`. Everything else falls
// through to a collapsible "raw attributes" block so no data is hidden, but the
// human-readable content/metadata get the primary surface.
export const EVIDENCE_CONTENT_KEYS = ["content", "source_excerpt"] as const;
export const EVIDENCE_META_KEYS = ["confidence", "locator"] as const;

/** snake_case → Title Case (e.g. evidence_type → Evidence Type). */
export function humanizeKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export type EvidenceExtraPartition = {
  contentNodes: { key: string; value: unknown }[];
  metaPairs: { key: string; value: unknown }[];
  rawPairs: { key: string; value: unknown }[];
};

/**
 * Split an Evidence node's `extra` into content / meta / raw buckets. Content
 * fields render as prominent paragraphs, meta fields as a compact key/value
 * strip, and everything else collapses under "raw attributes". Nullish and
 * empty values are dropped.
 */
export function partitionEvidenceExtra(extra: Record<string, unknown> | undefined): EvidenceExtraPartition {
  const entries = Object.entries(extra ?? {});
  const contentKeys = new Set<string>(EVIDENCE_CONTENT_KEYS);
  const metaKeys = new Set<string>(EVIDENCE_META_KEYS);
  const contentNodes: { key: string; value: unknown }[] = [];
  const metaPairs: { key: string; value: unknown }[] = [];
  const rawPairs: { key: string; value: unknown }[] = [];
  for (const [key, value] of entries) {
    if (value === null || value === undefined || value === "") continue;
    if (contentKeys.has(key)) contentNodes.push({ key, value });
    else if (metaKeys.has(key)) metaPairs.push({ key, value });
    else rawPairs.push({ key, value });
  }
  return { contentNodes, metaPairs, rawPairs };
}

/** The first known content field's string value (content / source_excerpt).
 *  Used as a header title so the full evidence text is one hover away even when
 *  CSS truncates it to one line. Returns undefined for non-string values — the
 *  title is text-only. */
export function firstContentValue(extra: Record<string, unknown> | undefined): string | undefined {
  if (!extra) return undefined;
  for (const key of EVIDENCE_CONTENT_KEYS) {
    const value = extra[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

// --- Primitive field components ---------------------------------------------

/** A single labeled field: dt humanized + dd with typed rendering. */
export function Field({ label, value, children }: { label: string; value?: unknown; children?: ReactNode }) {
  return <div className="node-field">
    <dt className="node-field-label">{humanizeKey(label)}</dt>
    <dd className="node-field-value">{children ?? renderValue(value)}</dd>
  </div>;
}

/** Long text: clamps to `maxLines` then expands on click; full text on hover.
 *  The expand/collapse toggle appears only when the CSS `-webkit-line-clamp`
 *  actually truncates the rendered text (measured via scrollHeight), so a
 *  short value that fits within `maxLines` shows no misleading toggle even if
 *  its raw length exceeds the old 80-char heuristic.
 *
 *  `overflow` is measured only in the *collapsed* state and is sticky: once a
 *  value is known to overflow, expanding it must not re-measure (an expanded
 *  paragraph has scrollHeight === clientHeight, which would clear the flag and
 *  make the collapse button vanish — the user could never fold it back). The
 *  button text and clamp toggle on `expanded`; visibility stays on `overflow`. */
export function LongText({ value, maxLines = 6 }: { value: unknown; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const { t } = useLocale();
  const ref = useRef<HTMLParagraphElement>(null);
  const text = renderValue(value);
  if (!text) return null;
  // Measure overflow only while collapsed. `expanded` is intentionally absent
  // from the deps so the effect does not re-run when the user expands — that
  // re-measure would read the unclamped height and drop the button.
  useLayoutEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (!el) return;
    // +1 px guards against sub-pixel rounding reporting a phantom overflow.
    setOverflow(el.scrollHeight - el.clientHeight > 1);
  }, [text, maxLines, expanded]);
  return <div className="node-longtext-wrap">
    <p ref={ref} className={expanded ? "node-longtext node-longtext-expanded" : "node-longtext"}
      style={{ WebkitLineClamp: expanded ? "none" : String(maxLines) }}
      title={overflow && !expanded ? text : undefined}>
      {text}
    </p>
    {overflow ? <button className="node-longtext-toggle" onClick={() => setExpanded((e) => !e)} type="button">
      {expanded ? t("node.longtext.collapse") : t("node.longtext.expand")}
    </button> : null}
  </div>;
}

/** ISO timestamp → localized string; non-ISO values pass through untouched. */
export function TimeField({ value }: { value: unknown }) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  // ISO 8601 detection: "YYYY-MM-DDTHH:..." or trailing Z/offset.
  const iso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw);
  if (!iso) return <time className="node-time">{raw}</time>;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return <time className="node-time">{raw}</time>;
  return <time className="node-time" dateTime={raw}>{d.toLocaleString()}</time>;
}

/** A clickable URL: shows domain + truncated path; falls back to raw text. */
export function LinkField({ href, children }: { href: unknown; children?: ReactNode }) {
  const url = typeof href === "string" ? href : "";
  if (!url) return null;
  let display: string;
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    display = u.host + (path && path !== "/" ? path : "");
    if (display.length > 50) display = display.slice(0, 49) + "…";
  } catch {
    display = url.length > 50 ? url.slice(0, 49) + "…" : url;
  }
  return <a className="node-link" href={url} rel="noreferrer" target="_blank" title={url}>{children ?? display}</a>;
}

/** A CAS hash field: shows decoded content when given, else collapses the raw
 *  hex under a <details> so it doesn't dominate the panel. */
export function HashField({ hash, children }: { hash: unknown; children?: ReactNode }) {
  const raw = typeof hash === "string" ? hash : "";
  const id = useId();
  if (children) {
    // Decoded content path: render the content, with the raw hash folded away.
    return <div className="node-hash">
      {children}
      {raw ? <details className="node-hash-raw"><summary id={id}>原始 hash</summary><code className="node-hash-code">{raw}</code></details> : null}
    </div>;
  }
  if (!raw) return null;
  return <details className="node-hash-raw">
    <summary>原始 hash</summary>
    <code className="node-hash-code">{raw}</code>
  </details>;
}

/** Collapsible "raw attributes" block for fields that don't warrant a primary
 *  surface (internal keys, routing ids). */
export function RawAttributes({ pairs }: { pairs: { key: string; value: unknown }[] }) {
  if (!pairs.length) return null;
  return <details className="node-raw-attrs">
    <summary>原始属性（{pairs.length}）</summary>
    <dl className="node-raw-attrs-list">
      {pairs.map(({ key, value }) => <div className="node-field node-raw-field" key={key}>
        <dt className="node-field-label">{humanizeKey(key)}</dt>
        <dd className="node-field-value">{renderValue(value)}</dd>
      </div>)}
    </dl>
  </details>;
}

// --- Value rendering --------------------------------------------------------

/** Strip HTML tags from a string and collapse the whitespace they leave
 *  behind. Upstream records (e.g. MCP search `abstract`) sometimes carry
 *  stray HTML fragments like `<h4>`/`</i>`; LongText/Field render text into
 *  a `<p>`, so without stripping those tags surface as literal visible text
 *  (React escapes them). No-op for tag-free strings. */
function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/\s{2,}/g, " ").trim();
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return stripHtml(String(value));
}
