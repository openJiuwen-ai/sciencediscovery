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

import { useState, type CSSProperties } from "react";

import type { ApiClient } from "../api/client.js";
import type { KeEngineState, KeGrowStatus } from "../api/knowledge-engine.js";
import { useLocale } from "../i18n/index.js";

export interface KeGrowPanelProps {
  client: ApiClient;
  kbId: string;
  status: KeGrowStatus | undefined;
  /** Re-fetch after a local action (grow started). */
  onChanged: () => void;
  onError: (error: unknown) => void;
}

const BUDGET_OPTIONS = [10, 30, 50, 100];

const BADGE_BASE: CSSProperties = {
  display: "inline-block",
  padding: "1px 6px",
  borderRadius: 4,
  fontSize: 11,
  marginRight: 6,
};

function badgeStyle(met: boolean, na: boolean): CSSProperties {
  return {
    ...BADGE_BASE,
    background: na
      ? "var(--surface-track, #f1f5f9)"
      : met
        ? "var(--success-soft, #dcfce7)"
        : "var(--danger-soft, #fee2e2)",
    color: na
      ? "var(--text-secondary, #64748b)"
      : met
        ? "var(--success, #166534)"
        : "var(--danger, #b91c1c)",
  };
}

const INPUT_STYLE: CSSProperties = {
  fontSize: 13,
  padding: "6px 8px",
  borderRadius: "var(--radius-m, 6px)",
  border: "1px solid var(--border, #e2e8f0)",
  background: "var(--surface, #ffffff)",
  color: "var(--text, #0f172a)",
  boxSizing: "border-box",
};

/** One convergence-signal badge row (four signals, Chao1 boundary or the
 *  Lincoln–Petersen recall fallback). */
function SignalBadges({ engineState }: { engineState: KeEngineState }) {
  const { t } = useLocale();
  const signals = engineState.signals;
  if (!signals) return null;
  const saturation = signals.conceptSaturation;
  const coverage = signals.citationCoverage;
  const exhaustion = signals.frontierExhaustion;
  const boundary = signals.boundaryCoverage;
  // Boundary label: Chao1 coverage when available, else the L-P recall
  // fallback estimate, else n/a.
  let boundaryLabel = `${t("ke.grow.signal.boundaryCoverage")} ${t("ke.grow.signal.insufficientData")}`;
  if (!boundary.insufficientData && boundary.coverage !== null) {
    boundaryLabel = `${t("ke.grow.signal.boundaryCoverage")} ${(boundary.coverage * 100).toFixed(0)}%`;
  } else if (boundary.recallEstimate && !boundary.recallEstimate.insufficientData && boundary.recallEstimate.recall !== null) {
    boundaryLabel = t("ke.grow.signal.lp", { pct: (boundary.recallEstimate.recall * 100).toFixed(0) });
  }
  return (
    <div data-testid="ke-grow-signals" style={{ margin: "6px 0", fontSize: 12 }}>
      <span style={{ color: "var(--text-secondary, #475569)", marginRight: 4 }}>{t("ke.grow.signals")}:</span>
      <span style={badgeStyle(saturation.met, saturation.insufficientData)}>
        {t("ke.grow.signal.saturation")} {saturation.insufficientData ? t("ke.grow.signal.insufficientData") : saturation.met ? "✓" : "✗"}
      </span>
      <span style={badgeStyle(coverage.met, false)}>
        {t("ke.grow.signal.citationCoverage", { pct: (coverage.ratio * 100).toFixed(0) })}
      </span>
      <span style={badgeStyle(exhaustion.met, false)}>
        {t("ke.grow.signal.frontierExhaustion")} {exhaustion.met ? "✓" : "✗"}
      </span>
      <span style={badgeStyle(boundary.met, boundary.insufficientData)}>{boundaryLabel}</span>
    </div>
  );
}

/**
 * Grow control panel: start a citation-snowball crawl cycle with a direction
 * and paper budget, watch the active cycle's progress bar and frontier
 * counts, and read the persisted convergence assessment.
 */
export function KeGrowPanel({ client, kbId, status, onChanged, onError }: KeGrowPanelProps) {
  const { t, locale } = useLocale();
  const [starting, setStarting] = useState(false);
  const [direction, setDirection] = useState("");
  const [budget, setBudget] = useState(10);
  const active = status?.activeCycle ?? null;
  const frontier = status?.frontier ?? null;
  const engineState = status?.engineState ?? {};
  const hasEngineState = Boolean(engineState.updatedAt);
  const progress = frontier && frontier.total > 0 ? frontier.done / Math.max(1, frontier.total) : 0;

  return (
    <section style={{ marginTop: 20 }} data-testid="ke-grow-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 8px" }}>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text-heading, #0f172a)" }}>{t("ke.grow.title")}</h4>
        {hasEngineState && engineState.converged ? (
          <span
            data-testid="ke-converged-badge"
            title={engineState.updatedAt ? new Date(engineState.updatedAt).toLocaleString(locale) : undefined}
            style={{
              fontSize: 11,
              padding: "1px 8px",
              borderRadius: 10,
              color: "var(--success, #16a34a)",
              background: "var(--success-soft, rgba(82,196,26,0.12))",
              border: "1px solid var(--success, rgba(82,196,26,0.4))",
            }}
          >
            {t("ke.grow.converged")}
          </span>
        ) : null}
        {active ? (
          <span style={{ fontSize: 11, color: "var(--accent, #2563eb)" }}>{t("ke.grow.running")}</span>
        ) : null}
      </div>
      <p style={{ fontSize: 12, color: "var(--text-secondary, #475569)", lineHeight: 1.6, margin: "0 0 8px" }}>
        {t("ke.grow.explainer")}
      </p>
      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
        <input
          aria-label={t("ke.grow.directionPlaceholder")}
          placeholder={t("ke.grow.directionPlaceholder")}
          value={direction}
          onChange={(event) => setDirection(event.target.value)}
          style={{ ...INPUT_STYLE, flex: 1 }}
        />
        <select
          aria-label={t("ke.grow.budgetUnit")}
          value={budget}
          onChange={(event) => setBudget(Number(event.target.value))}
          style={{ ...INPUT_STYLE, width: "auto" }}
        >
          {BUDGET_OPTIONS.map((option) => (
            <option key={option} value={option}>{option} {t("ke.grow.budgetUnit")}</option>
          ))}
        </select>
      </div>
      <button
        type="button"
        data-testid="ke-grow-start"
        disabled={starting || active !== null}
        onClick={() => {
          setStarting(true);
          void client.startKeGrow(kbId, direction.trim(), { maxPapers: budget }).then(() => {
            setStarting(false);
            onChanged();
          }).catch((error: unknown) => {
            setStarting(false);
            onError(error);
          });
        }}
        style={{
          width: "100%",
          fontSize: 13,
          padding: "6px 14px",
          borderRadius: "var(--radius-m, 6px)",
          border: "1px solid var(--accent, #2563eb)",
          background: starting || active !== null ? "var(--surface-hover, #f1f5f9)" : "var(--accent, #2563eb)",
          color: starting || active !== null ? "var(--text-secondary, #475569)" : "var(--accent-ink, #ffffff)",
          cursor: starting || active !== null ? "default" : "pointer",
        }}
      >
        {starting ? t("ke.grow.starting") : active ? t("ke.grow.running") : t("ke.grow.start")}
      </button>
      {active && frontier ? (
        <div style={{ marginTop: 8 }}>
          <div
            data-testid="ke-grow-progress-bar"
            style={{
              height: 6,
              borderRadius: 3,
              background: "var(--surface-track, #f1f5f9)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.round(progress * 100)}%`,
                background: "var(--accent, #2563eb)",
                transition: "width 0.5s",
              }}
            />
          </div>
          <div data-testid="ke-grow-progress" style={{ fontSize: 12, color: "var(--text-secondary, #475569)", marginTop: 4 }}>
            {t("ke.grow.frontier", {
              done: frontier.done,
              pending: frontier.pending,
              failed: frontier.failed,
              skipped: frontier.skipped,
            })}
            {frontier.total > 0 ? ` (${Math.round(progress * 100)}%)` : ""}
          </div>
        </div>
      ) : null}
      {hasEngineState ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12 }}>
            <span style={badgeStyle(Boolean(engineState.converged), false)}>
              {engineState.converged ? t("ke.grow.converged") : t("ke.grow.notConverged")}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-faint, #94a3b8)" }}>
              {engineState.updatedAt ? new Date(engineState.updatedAt).toLocaleString(locale) : ""}
            </span>
          </div>
          <SignalBadges engineState={engineState} />
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "var(--text-faint, #94a3b8)", marginTop: 6 }}>{t("ke.grow.noCycle")}</div>
      )}
    </section>
  );
}
