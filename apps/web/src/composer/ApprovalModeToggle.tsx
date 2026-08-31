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

import { ShieldCheckIcon, ShieldOffIcon } from "../icons.js";
import { useLocale } from "../i18n/index.js";

export type ApprovalMode = "always_allow" | "ask_for_dangerous";

export function nextApprovalMode(mode: ApprovalMode): ApprovalMode {
  return mode === "ask_for_dangerous" ? "always_allow" : "ask_for_dangerous";
}

export function ApprovalModeToggle({
  disabled = false,
  mode,
  onChange,
}: {
  disabled?: boolean;
  mode: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
}) {
  const { t } = useLocale();
  const asking = mode === "ask_for_dangerous";
  const tooltip = asking ? t("composer.approvalAskTooltip") : t("composer.approvalAlwaysTooltip");
  const modeLabel = asking ? t("composer.askDangerous") : t("composer.alwaysAllow");
  return (
    <button
      aria-label={`${t("composer.approvals")}: ${modeLabel}`}
      aria-pressed={!asking}
      className={asking ? "approval-mode-toggle" : "approval-mode-toggle always-allow"}
      disabled={disabled}
      onClick={() => onChange(nextApprovalMode(mode))}
      title={tooltip}
      type="button"
    >
      {asking ? <ShieldCheckIcon size={15} /> : <ShieldOffIcon size={15} />}
      <span className="approval-mode-toggle-state">{modeLabel}</span>
    </button>
  );
}
