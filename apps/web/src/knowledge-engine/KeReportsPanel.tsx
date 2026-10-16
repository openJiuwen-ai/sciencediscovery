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

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import type { ApiClient } from "../api/client.js";
import type { KeCommunityReport, KeReportsStatus } from "../api/knowledge-engine.js";
import { useLocale } from "../i18n/index.js";

export interface KeReportsPanelProps {
  client: ApiClient;
  kbId: string;
  /** Reports status from the page's central refresh (allSettled pool). The
   *  panel self-fetches ONLY while its own generation poll is running — a
   *  mount-time-only self-fetch would freeze on the empty pre-seed graph and
   *  keep the generate button disabled forever. */
  status: KeReportsStatus | undefined;
  /** Re-fetch after generation completes (jobs panel / roots refresh). */
  onChanged: () => void;
  onError: (error: unknown) => void;
}

const POLL_INTERVAL_MS = 3_000;
const POLL_ROUNDS = 80; // ~4 minutes of generation waiting

const ITEM_STYLE: CSSProperties = {
  border: "1px solid var(--border, #e2e8f0)",
  borderRadius: "var(--radius-m, 6px)",
  padding: "6px 8px",
  marginBottom: 6,
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1.6,
};

/** Community reports sidebar panel: coverage, per-community report cards
 *  (expandable to summary + findings with verbatim evidence). */
export function KeReportsPanel({ client, kbId, status: pageStatus, onChanged, onError }: KeReportsPanelProps) {
  const { t } = useLocale();
  // Local override active only while the generation poll runs; otherwise the
  // page's centrally refreshed status is the truth.
  const [pollStatus, setPollStatus] = useState<KeReportsStatus | undefined>(undefined);
  const [generating, setGenerating] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const status = generating && pollStatus ? pollStatus : pageStatus;

  useEffect(() => {
    setExpanded(null);
  }, [kbId]);

  useEffect(() => {
    return () => {
      if (pollTimer.current !== null) clearTimeout(pollTimer.current);
    };
  }, []);

  const waitForCompletion = useCallback(() => {
    let round = 0;
    const tick = () => {
      round += 1;
      client.getKeReports(kbId).then((next) => {
        setPollStatus(next);
        const complete = next.communities.every((community) => community.reportId !== null);
        if (complete || round >= POLL_ROUNDS) {
          setGenerating(false);
          onChanged();
          return;
        }
        pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
      }).catch((error: unknown) => {
        setGenerating(false);
        onError(error);
      });
    };
    pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
  }, [client, kbId, onChanged, onError]);

  const reportByCommunity = new Map<number, KeCommunityReport>(
    (status?.reports ?? []).map((report) => [report.communityId, report]),
  );

  return (
    <section style={{ marginTop: 20 }} data-testid="ke-reports-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 8px" }}>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text-heading, #0f172a)" }}>
          {t("ke.reports.title")}
        </h4>
        {status ? (
          <span
            data-testid="ke-reports-coverage"
            style={{ fontSize: 11, color: "var(--text-secondary, #475569)" }}
          >
            {t("ke.reports.coverage", { ready: String(status.readyReports), total: String(status.totalCommunities) })}
          </span>
        ) : null}
      </div>
      <p style={{ fontSize: 12, color: "var(--text-secondary, #475569)", lineHeight: 1.6, margin: "0 0 8px" }}>
        {t("ke.reports.explainer")}
      </p>
      <button
        type="button"
        data-testid="ke-report-generate"
        disabled={generating || (status?.totalCommunities ?? 0) === 0}
        onClick={() => {
          setGenerating(true);
          void client.startKeReports(kbId).then(() => {
            waitForCompletion();
          }).catch((error: unknown) => {
            setGenerating(false);
            onError(error);
          });
        }}
        style={{
          width: "100%",
          fontSize: 13,
          padding: "6px 14px",
          borderRadius: "var(--radius-m, 6px)",
          border: "1px solid var(--accent, #2563eb)",
          background: generating ? "var(--surface-hover, #f1f5f9)" : "var(--accent, #2563eb)",
          color: generating ? "var(--text-secondary, #475569)" : "var(--accent-ink, #ffffff)",
          cursor: generating ? "default" : "pointer",
        }}
      >
        {generating ? t("ke.reports.generating") : t("ke.reports.generate")}
      </button>
      <div style={{ marginTop: 8 }}>
        {(status?.communities ?? []).map((community) => {
          const report = reportByCommunity.get(community.id) ?? null;
          const open = expanded === community.id;
          return (
            <div
              key={community.id}
              data-testid={`ke-report-item-${community.id}`}
              style={{ ...ITEM_STYLE, background: open ? "var(--surface-hover, #f1f5f9)" : "var(--surface, #ffffff)" }}
              onClick={() => setExpanded(open ? null : community.id)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                <span style={{ fontWeight: 600 }}>
                  #{community.id} {community.name}
                </span>
                <span style={{ color: "var(--text-faint, #94a3b8)", flexShrink: 0 }}>
                  {community.size}
                </span>
              </div>
              {report && report.status === "ready" ? (
                <div data-testid={`ke-report-title-${community.id}`} style={{ color: "var(--text-secondary, #475569)" }}>
                  {report.rating !== null ? t("ke.reports.rating", { rating: String(report.rating) }) : t("ke.reports.noRating")}
                  {" · "}
                  {report.title}
                </div>
              ) : report && report.status === "error" ? (
                <div style={{ color: "var(--danger, #b91c1c)" }}>{report.error ?? "error"}</div>
              ) : (
                <div style={{ color: "var(--text-faint, #94a3b8)" }}>{t("ke.reports.notGenerated")}</div>
              )}
              {open && report && report.status === "ready" ? (
                <div data-testid={`ke-report-detail-${community.id}`} style={{ marginTop: 6 }}>
                  <div>{report.summary}</div>
                  {report.findings.length > 0 ? (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ fontWeight: 600 }}>{t("ke.reports.findings")}</div>
                      {report.findings.map((finding, index) => (
                        <div key={index} data-testid={`ke-report-finding-${community.id}`} style={{ marginTop: 4 }}>
                          <div>• {finding.summary}</div>
                          {finding.evidence ? (
                            <div style={{ color: "var(--text-secondary, #475569)", fontStyle: "italic" }}>
                              {t("ke.reports.evidence")}: “{finding.evidence}”
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
