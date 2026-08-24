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
 * What the search has spent, against what it was allowed.
 *
 * Three bars because there are three gates and any of them can end the run: a
 * user who sees "budget_exhausted" and cannot tell which one ran out has to go
 * read a log to find out.
 *
 * The cost bar says **no price table configured** rather than drawing 0%. There
 * is no pricing anywhere in this system, so the sidecar reports tokens and
 * leaves cents at zero; a bar sitting at empty would read as "this run is free",
 * which is a claim nobody made.
 */

import { useLocale } from "../i18n/LocaleProvider.js";

export interface BudgetBarProps {
  /** `null` while the run has not started; the bar shows no elapsed time
   *  rather than counting from the epoch. */
  elapsedSeconds: number | null;
  limits: { maxCostCents: number; maxSeconds: number; maxTokens: number };
  spentCents: number;
  tokens: number;
}

export function BudgetBar({ elapsedSeconds, limits, spentCents, tokens }: BudgetBarProps) {
  const { t } = useLocale();
  const priced = limits.maxCostCents > 0 && spentCents > 0;

  return <div className="evolve-budget">
    <h3 className="evolve-block-title">{t("evolve.budget.title")}</h3>
    <Bar
      label={t("evolve.budget.tokens")}
      limit={limits.maxTokens}
      text={`${tokens.toLocaleString()} / ${limits.maxTokens.toLocaleString()}`}
      value={tokens}
    />
    <Bar
      label={t("evolve.budget.elapsed")}
      limit={limits.maxSeconds}
      text={elapsedSeconds === null
        ? "—"
        : `${formatDuration(elapsedSeconds)} / ${formatDuration(limits.maxSeconds)}`}
      value={elapsedSeconds ?? 0}
    />
    <Bar
      label={t("evolve.budget.cost")}
      limit={limits.maxCostCents}
      text={priced
        ? `${(spentCents / 100).toFixed(2)} / ${(limits.maxCostCents / 100).toFixed(2)}`
        : t("evolve.budget.unpriced")}
      value={priced ? spentCents : 0}
    />
  </div>;
}

function Bar({ label, limit, text, value }: {
  label: string;
  limit: number;
  text: string;
  value: number;
}) {
  const ratio = limit > 0 ? Math.min(1, value / limit) : 0;
  return <div className="evolve-budget-row">
    <span className="evolve-budget-label">{label}</span>
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuetext={text}
      className="evolve-budget-track"
      role="progressbar"
    >
      <div
        className={`evolve-budget-fill${ratio >= 0.9 ? " evolve-budget-fill-hot" : ""}`}
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </div>
    <span className="evolve-budget-value">{text}</span>
  </div>;
}

/** Exported for the test: the boundary cases are 0 and "over an hour", and both
 *  read badly as a bare second count. */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
