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

import { useLocale } from "../i18n/LocaleProvider.js";
import { SparkleIcon } from "../icons.js";

/**
 * A low-intrusion confirmation seam between "the user typed an improvement
 * sentence" and "an evolution search starts". Detection is a guess; starting a
 * search spends real budget (mutations + sandboxed evaluations), so the bar
 * offers instead of fires. Accepting opens the algorithm picker; dismissing
 * never re-offers until the message leaves evolve intent.
 */
export function EvolveSuggestionBar({
  onAccept,
  onDismiss,
}: {
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="evolve-suggestion-bar" role="status">
      <span className="evolve-suggestion-icon"><SparkleIcon size={14} /></span>
      <span className="evolve-suggestion-text">{t("evolve.suggestion.text")}</span>
      <button type="button" className="evolve-suggestion-accept" onClick={onAccept}>
        {t("evolve.suggestion.accept")}
      </button>
      <button type="button" className="icon-button" aria-label={t("evolve.suggestion.dismiss")} onClick={onDismiss}>
        {"\u00d7"}
      </button>
    </div>
  );
}
