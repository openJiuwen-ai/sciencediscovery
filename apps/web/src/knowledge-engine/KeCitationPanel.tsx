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

import { useEffect, useState } from "react";

import type { KeCitation } from "../api/knowledge-engine.js";
import { KnowledgeEngineApiClient } from "../api/knowledge-engine.js";
import { useLocale } from "../i18n/index.js";

export interface KeCitationPanelProps {
  client: KnowledgeEngineApiClient;
  kbId: string;
  docId: string;
  /** Open another document in the reader; absent → rows render inert. */
  onOpenDocument?: (docId: string) => void;
}

type CiteTab = "references" | "cited-by" | "similar";

interface CiteData {
  outgoing: KeCitation[];
  incoming: KeCitation[];
  similar: Array<{ docId: string; title: string; sharedEntities: number }>;
}

/** Intent aggregation → the three badge colors (industry pattern: supporting /
 *  contrasting / mentioning). Unknown/null intents are counted nowhere. */
const SUPPORTING_INTENTS = new Set(["uses", "extends", "baseline_for", "motivated_by"]);

const INTENT_BADGE_STYLE = {
  supporting: { background: "var(--success-soft, #ecfdf5)", color: "var(--success, #059669)" },
  contrasting: { background: "var(--danger-soft, #fef2f2)", color: "var(--danger, #dc2626)" },
  mentioning: { background: "var(--surface-subtle, #f1f5f9)", color: "var(--text-secondary, #64748b)" },
} as const;

export function KeCitationPanel({ client, kbId, docId, onOpenDocument }: KeCitationPanelProps) {
  const { t } = useLocale();
  const [data, setData] = useState<CiteData | null>(null);
  const [tab, setTab] = useState<CiteTab>("references");

  useEffect(() => {
    let cancelled = false;
    setData(null);
    void Promise.all([
      client.listKeCitations(kbId, { srcDocId: docId, limit: 50 }),
      client.listKeCitations(kbId, { dstDocId: docId, limit: 50 }),
      client.getKeSimilarDocuments(kbId, docId),
    ])
      .then(([outgoing, incoming, similar]) => {
        if (cancelled) return;
        setData({
          outgoing: outgoing.citations,
          incoming: incoming.citations,
          similar: similar.similar.filter((entry) => entry.docId !== docId),
        });
      })
      .catch(() => {
        if (!cancelled) setData({ outgoing: [], incoming: [], similar: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [client, kbId, docId]);

  if (data === null) return null;

  const all = [...data.outgoing, ...data.incoming];
  const counts = { supporting: 0, contrasting: 0, mentioning: 0 };
  const sections = new Set<string>();
  for (const citation of all) {
    if (!citation.intent) continue;
    if (SUPPORTING_INTENTS.has(citation.intent)) counts.supporting += 1;
    else if (citation.intent === "contrasts_with") counts.contrasting += 1;
    else if (citation.intent === "mentions") counts.mentioning += 1;
  }
  for (const citation of all) {
    if (citation.section) sections.add(citation.section);
  }
  const total = data.outgoing.length + data.incoming.length + data.similar.length;
  if (total === 0) {
    return (
      <div data-testid="ke-cite-panel" style={{ borderTop: "1px solid var(--border, #e2e8f0)", padding: "8px 16px", fontSize: 11, color: "var(--text-faint, #94a3b8)" }}>
        {t("ke.cite.title")} · {t("ke.cite.empty")}
      </div>
    );
  }

  const tabButton = (id: CiteTab, count: number) => (
    <button
      key={id}
      type="button"
      data-testid={`ke-cite-tab-${id}`}
      aria-selected={tab === id}
      role="tab"
      onClick={() => setTab(id)}
      style={{
        fontSize: 11,
        padding: "2px 10px",
        borderRadius: "var(--radius-m, 6px)",
        border: "1px solid var(--border, #e2e8f0)",
        background: tab === id ? "var(--accent, #2563eb)" : "transparent",
        color: tab === id ? "#fff" : "var(--text-secondary, #64748b)",
        cursor: "pointer",
      }}
    >
      {t(`ke.cite.${id === "cited-by" ? "citedBy" : id}`)} {count}
    </button>
  );

  const citationRow = (citation: KeCitation, direction: "outgoing" | "incoming") => {
    const label = direction === "outgoing"
      ? citation.dstTitle ?? t("ke.cite.unresolved")
      : citation.srcTitle ?? "";
    const targetDocId = direction === "outgoing" ? citation.dstDocId : citation.srcDocId;
    const clickable = Boolean(targetDocId && onOpenDocument);
    return (
      <button
        key={`${direction}-${citation.id}`}
        type="button"
        data-testid="ke-cite-row"
        disabled={!clickable}
        onClick={() => {
          if (targetDocId && onOpenDocument) onOpenDocument(targetDocId);
        }}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          padding: "4px 8px",
          marginBottom: 4,
          border: "1px solid var(--border, #e2e8f0)",
          borderRadius: "var(--radius-m, 6px)",
          background: "var(--surface, #fff)",
          color: "inherit",
          cursor: clickable ? "pointer" : "default",
          fontSize: 11,
        }}
      >
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320, fontWeight: 500, color: clickable ? "var(--accent, #2563eb)" : "inherit" }}>
            {label}
          </span>
          {citation.intent ? (
            <span
              data-testid="ke-cite-intent"
              style={{
                padding: "0 6px",
                borderRadius: 4,
                fontSize: 10,
                ...INTENT_BADGE_STYLE[
                  citation.intent === "contrasts_with"
                    ? "contrasting"
                    : citation.intent === "mentions"
                      ? "mentioning"
                      : "supporting"
                ],
              }}
            >
              {citation.intent}
            </span>
          ) : null}
          {citation.section ? (
            <span data-testid="ke-cite-section" style={{ fontSize: 10, color: "var(--text-faint, #94a3b8)" }}>
              § {citation.section}
            </span>
          ) : null}
        </div>
        <div style={{ color: "var(--text-secondary, #64748b)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>
          {citation.sentence}
        </div>
      </button>
    );
  };

  return (
    <div data-testid="ke-cite-panel" style={{ borderTop: "1px solid var(--border, #e2e8f0)", padding: "8px 16px", flexShrink: 0 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
        <strong style={{ fontSize: 11 }}>{t("ke.cite.title")}</strong>
        {(Object.keys(counts) as Array<keyof typeof counts>)
          .filter((kind) => counts[kind] > 0)
          .map((kind) => (
            <span
              key={kind}
              data-testid={`ke-cite-badge-${kind}`}
              style={{ fontSize: 10, padding: "1px 8px", borderRadius: 999, ...INTENT_BADGE_STYLE[kind] }}
            >
              {t(`ke.cite.${kind}`, { count: counts[kind] })}
            </span>
          ))}
        {[...sections].slice(0, 3).map((section) => (
          <span key={section} data-testid="ke-cite-section-badge" style={{ fontSize: 10, padding: "1px 8px", borderRadius: 999, background: "var(--surface-subtle, #f1f5f9)", color: "var(--text-secondary, #64748b)" }}>
            § {section}
          </span>
        ))}
      </div>
      <div role="tablist" aria-label="citation views" style={{ display: "flex", gap: 4, marginBottom: 6 }}>
        {tabButton("references", data.outgoing.length)}
        {tabButton("cited-by", data.incoming.length)}
        {tabButton("similar", data.similar.length)}
      </div>
      <div style={{ maxHeight: 150, overflowY: "auto" }}>
        {tab === "references" ? (
          data.outgoing.length === 0
            ? <span style={{ fontSize: 11, color: "var(--text-faint, #94a3b8)" }}>{t("ke.cite.empty")}</span>
            : data.outgoing.map((citation) => citationRow(citation, "outgoing"))
        ) : tab === "cited-by" ? (
          data.incoming.length === 0
            ? <span style={{ fontSize: 11, color: "var(--text-faint, #94a3b8)" }}>{t("ke.cite.empty")}</span>
            : data.incoming.map((citation) => citationRow(citation, "incoming"))
        ) : (
          data.similar.length === 0
            ? <span style={{ fontSize: 11, color: "var(--text-faint, #94a3b8)" }}>{t("ke.cite.empty")}</span>
            : data.similar.map((entry) => (
              <button
                key={entry.docId}
                type="button"
                data-testid="ke-cite-similar-row"
                disabled={!onOpenDocument}
                onClick={() => {
                  if (onOpenDocument) onOpenDocument(entry.docId);
                }}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  padding: "4px 8px",
                  marginBottom: 4,
                  border: "1px solid var(--border, #e2e8f0)",
                  borderRadius: "var(--radius-m, 6px)",
                  background: "var(--surface, #fff)",
                  color: "inherit",
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--accent, #2563eb)", fontWeight: 500 }}>
                  {entry.title || entry.docId.slice(0, 8)}
                </span>
                <span style={{ color: "var(--text-secondary, #64748b)", flexShrink: 0 }}>
                  {t("ke.cite.sharedEntities", { count: entry.sharedEntities })}
                </span>
              </button>
            ))
        )}
      </div>
    </div>
  );
}
