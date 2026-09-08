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

import { useState } from "react";

import type { ApiClient } from "../api/client.js";
import type { KeEngineState, KeGrowStatus } from "../api/knowledge-engine.js";

export interface KeGrowPanelProps {
  client: ApiClient;
  kbId: string;
  status: KeGrowStatus | undefined;
  /** Re-fetch after a local action (grow started). */
  onChanged: () => void;
  onError: (error: unknown) => void;
}

const BADGE_BASE = {
  display: "inline-block",
  padding: "1px 6px",
  borderRadius: 4,
  fontSize: 11,
  marginRight: 6,
} as const;

function badgeStyle(met: boolean, na: boolean): Record<string, unknown> {
  return {
    ...BADGE_BASE,
    background: na ? "#f1f5f9" : met ? "#dcfce7" : "#fee2e2",
    color: na ? "#64748b" : met ? "#166534" : "#b91c1c",
  };
}

/** One convergence-signal badge row. */
function SignalBadges({ engineState }: { engineState: KeEngineState }) {
  const signals = engineState.signals;
  if (!signals) return null;
  const saturation = signals.conceptSaturation;
  const coverage = signals.citationCoverage;
  const exhaustion = signals.frontierExhaustion;
  const boundary = signals.boundaryCoverage;
  // Boundary label: Chao1 coverage when available, else the L-P recall
  // fallback estimate, else n/a.
  let boundaryLabel = "Boundary n/a";
  if (!boundary.insufficientData && boundary.coverage !== null) {
    boundaryLabel = `Boundary ${(boundary.coverage * 100).toFixed(0)}%`;
  } else if (boundary.recallEstimate && !boundary.recallEstimate.insufficientData && boundary.recallEstimate.recall !== null) {
    boundaryLabel = `L-P ${(boundary.recallEstimate.recall * 100).toFixed(0)}%`;
  }
  return (
    <div data-testid="ke-grow-signals" style={{ margin: "6px 0" }}>
      <span style={badgeStyle(saturation.met, saturation.insufficientData)}>
        Saturation {saturation.insufficientData ? "n/a" : saturation.met ? "✓" : "✗"}
      </span>
      <span style={badgeStyle(coverage.met, false)}>
        Coverage {(coverage.ratio * 100).toFixed(0)}%
      </span>
      <span style={badgeStyle(exhaustion.met, false)}>
        Exhaustion {exhaustion.met ? "✓" : "✗"}
      </span>
      <span style={badgeStyle(boundary.met, boundary.insufficientData)}>{boundaryLabel}</span>
    </div>
  );
}

/**
 * Grow control panel: start a crawl cycle, watch the active cycle's frontier
 * counts, and read the persisted convergence assessment (four-signal badges,
 * Chao1 boundary or the Lincoln–Petersen recall fallback).
 */
export function KeGrowPanel({ client, kbId, status, onChanged, onError }: KeGrowPanelProps) {
  const [starting, setStarting] = useState(false);
  const active = status?.activeCycle ?? null;
  const frontier = status?.frontier ?? null;
  const engineState = status?.engineState ?? {};
  const hasEngineState = Boolean(engineState.updatedAt);

  return (
    <section style={{ marginTop: 20 }} data-testid="ke-grow-panel">
      <h4 style={{ margin: "4px 0" }}>Growth</h4>
      <button
        type="button"
        data-testid="ke-grow-start"
        disabled={starting || active !== null}
        onClick={() => {
          setStarting(true);
          void client.startKeGrow(kbId).then(() => {
            setStarting(false);
            onChanged();
          }).catch((error: unknown) => {
            setStarting(false);
            onError(error);
          });
        }}
      >
        {active ? "Cycle running…" : "Start grow cycle"}
      </button>
      {active && frontier ? (
        <div data-testid="ke-grow-progress" style={{ fontSize: 12, color: "#475569", marginTop: 6 }}>
          frontier: {frontier.done} done · {frontier.pending} pending · {frontier.failed} failed · {frontier.skipped} skipped
          {frontier.total > 0 ? ` (${Math.round((frontier.done / Math.max(1, frontier.total)) * 100)}%)` : ""}
        </div>
      ) : null}
      {hasEngineState ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12 }}>
            <span style={badgeStyle(Boolean(engineState.converged), false)}>
              {engineState.converged ? "converged" : "not converged"}
            </span>
            <span style={{ fontSize: 11, color: "#94a3b8" }}>
              {engineState.updatedAt ? new Date(engineState.updatedAt).toLocaleString() : ""}
            </span>
          </div>
          <SignalBadges engineState={engineState} />
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 6 }}>no cycle completed yet</div>
      )}
    </section>
  );
}
