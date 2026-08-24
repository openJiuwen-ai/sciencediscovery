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

import type { ReviewerSpecialistSettings } from "@sciencediscovery/schema";
import React from "react";

import { ReviewerSpecialistAvatar } from "./ReviewerPanel.js";

export function ReviewerControlCard({
  busy,
  disabled = false,
  onRun,
  settings,
}: {
  busy: boolean;
  disabled?: boolean;
  onRun: () => void;
  settings?: ReviewerSpecialistSettings;
}) {
  const enabled = settings?.enabled ?? false;
  const level = settings?.level ?? "quick";
  const levelLabel = level[0]!.toUpperCase() + level.slice(1);

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
      <div className="reviewer-control-level">
        <span>Level</span>
        <strong>{levelLabel}</strong>
      </div>
      <button
        className="primary-button"
        disabled={busy || disabled || !settings}
        onClick={onRun}
        type="button"
      >{busy ? "Reviewing…" : "Run review"}</button>
    </section>
  );
}
