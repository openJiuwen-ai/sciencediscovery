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

import type { ReviewerSpecialistLevel, ReviewerSpecialistSettings } from "@sciencediscovery/schema";
import React from "react";

import { useLocale } from "./i18n/index.js";
import { ReviewerSpecialistAvatar } from "./ReviewerPanel.js";

export function ReviewerControlCard({
  busy,
  configBusy = false,
  disabled = false,
  automaticReviewEnabled,
  level,
  onAutomaticReviewChange,
  onLevelChange,
  onRun,
  onStop,
  settings,
  stopping = false,
}: {
  busy: boolean;
  configBusy?: boolean;
  disabled?: boolean;
  automaticReviewEnabled: boolean;
  level: ReviewerSpecialistLevel;
  onAutomaticReviewChange: (enabled: boolean) => void;
  onLevelChange: (level: ReviewerSpecialistLevel) => void;
  onRun: () => void;
  onStop: () => void;
  settings?: ReviewerSpecialistSettings;
  stopping?: boolean;
}) {
  const { t } = useLocale();
  const enabled = settings?.enabled ?? false;

  // The System configuration page remains the single place to turn this
  // built-in Specialist back on. Do not leave a disabled, non-actionable
  // session-workspace entry behind.
  if (!enabled) return null;

  return (
    <section aria-label={t("reviewer.controlsAria")} className="reviewer-control-card">
      <header>
        <ReviewerSpecialistAvatar />
        <span>
          <strong>{t("specialist.reviewerName")}</strong>
          <small>{t("reviewer.builtInSpecialist")}</small>
        </span>
        <i className="on">{t("common.on")}</i>
      </header>
      <div className="reviewer-control-setting">
        <span><strong>{t("reviewer.automaticReview")}</strong></span>
        <button
          aria-checked={automaticReviewEnabled}
          aria-label={t(automaticReviewEnabled ? "reviewer.automaticOff" : "reviewer.automaticOn")}
          className={automaticReviewEnabled ? "specialist-switch on" : "specialist-switch"}
          disabled={disabled || configBusy}
          onClick={() => onAutomaticReviewChange(!automaticReviewEnabled)}
          role="switch"
          type="button"
        ><i aria-hidden="true" /></button>
      </div>
      <label className="reviewer-control-level">
        <span>{t("reviewer.level")}</span>
        <select
          aria-label={t("reviewer.levelAria")}
          disabled={disabled || configBusy}
          onChange={(event) => onLevelChange(event.target.value as ReviewerSpecialistLevel)}
          value={level}
        >
          <option value="quick">{t("reviewer.levelQuick")}</option>
          <option value="deep">{t("reviewer.levelDeep")}</option>
        </select>
      </label>
      <button
        className={busy ? "danger-button" : "primary-button"}
        disabled={busy ? stopping : disabled || !settings}
        onClick={busy ? onStop : onRun}
        type="button"
      >{busy ? (stopping ? t("reviewer.stopping") : t("reviewer.stop")) : t("reviewer.run")}</button>
    </section>
  );
}
