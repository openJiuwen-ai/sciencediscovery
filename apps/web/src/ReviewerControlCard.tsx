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
  const enabled = settings?.enabled ?? false;

  // The System configuration page remains the single place to turn this
  // built-in Specialist back on. Do not leave a disabled, non-actionable
  // session-workspace entry behind.
  if (!enabled) return null;

  return (
    <section aria-label="Reviewer Specialist controls" className="reviewer-control-card">
      <header>
        <ReviewerSpecialistAvatar />
        <span>
          <strong>Reviewer Specialist</strong>
          <small>Built-in Specialist</small>
        </span>
        <i className="on">On</i>
      </header>
      <div className="reviewer-control-setting">
        <span><strong>Automatic review</strong></span>
        <button
          aria-checked={automaticReviewEnabled}
          aria-label={automaticReviewEnabled ? "Turn automatic review off" : "Turn automatic review on"}
          className={automaticReviewEnabled ? "specialist-switch on" : "specialist-switch"}
          disabled={disabled || configBusy}
          onClick={() => onAutomaticReviewChange(!automaticReviewEnabled)}
          role="switch"
          type="button"
        ><i aria-hidden="true" /></button>
      </div>
      <label className="reviewer-control-level">
        <span>Level</span>
        <select
          aria-label="Reviewer Specialist level for this Session"
          disabled={disabled || configBusy}
          onChange={(event) => onLevelChange(event.target.value as ReviewerSpecialistLevel)}
          value={level}
        >
          <option value="quick">Quick</option>
          <option value="deep">Deep</option>
        </select>
      </label>
      <button
        className={busy ? "danger-button" : "primary-button"}
        disabled={busy ? stopping : disabled || !settings}
        onClick={busy ? onStop : onRun}
        type="button"
      >{busy ? (stopping ? "Stopping review…" : "Stop review") : "Run review"}</button>
    </section>
  );
}
