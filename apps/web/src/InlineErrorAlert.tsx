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

import { AlertCircleIcon, CloseIcon } from "./icons.js";
import { useLocale } from "./i18n/index.js";

export function updateInlineErrors(current: string[], message?: string): string[] {
  if (!message) return [];
  return current.includes(message) ? current : [...current, message];
}

/** @param title overrides the default "Settings error" heading for alerts that
 *  are not a failed save (a rejected access token, for example).
 *  @param onDismiss omitted for alerts the user clears by fixing the condition
 *  rather than by closing the notice. */
export function InlineErrorAlert({
  detail,
  onDismiss,
  title,
}: {
  detail: string;
  onDismiss?: () => void;
  title?: string;
}) {
  const { t } = useLocale();

  return <div className="inline-error-alert" role="alert">
    <span className="inline-error-icon"><AlertCircleIcon size={16} /></span>
    <div>
      <strong>{title ?? t("error.settingsTitle")}</strong>
      <small>{detail}</small>
    </div>
    {onDismiss ? <button
      aria-label={t("error.dismiss")}
      className="icon-button"
      onClick={onDismiss}
      title={t("error.dismiss")}
      type="button"
    >
      <CloseIcon size={14} />
    </button> : null}
  </div>;
}
