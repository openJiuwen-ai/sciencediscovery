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
 * A popover that appears above the composer when the user types
 * ``/evolve-design``, letting them pick the search algorithm before the
 * message is sent.
 *
 * Each algorithm card shows a name, a one-line tagline, and a bullet list of
 * what makes it different — so the user can choose based on what the algorithm
 * *does*, not just what it is called. A "recommended for" line at the bottom
 * says which tasks each is better suited for.
 */

import type { EvolveAlgorithm } from "@sciencediscovery/schema";

import { useLocale } from "../i18n/LocaleProvider.js";
import type { MessageKey } from "../i18n/messages.js";

export interface EvolveAlgorithmPickerProps {
  onSelect: (algorithm: EvolveAlgorithm) => void;
  onDismiss: () => void;
}

interface AlgorithmOption {
  id: EvolveAlgorithm;
  label: string;
  taglineKey: MessageKey;
  featuresKey: MessageKey;
  suitedForKey: MessageKey;
}

const ALGORITHMS: readonly AlgorithmOption[] = [
  {
    id: "puct",
    label: "PUCT",
    taglineKey: "evolve.picker.puct.tagline",
    featuresKey: "evolve.picker.puct.features",
    suitedForKey: "evolve.picker.puct.suitedfor",
  },
  {
    id: "openevolve",
    label: "OpenEvolve",
    taglineKey: "evolve.picker.openevolve.tagline",
    featuresKey: "evolve.picker.openevolve.features",
    suitedForKey: "evolve.picker.openevolve.suitedfor",
  },
];

export function EvolveAlgorithmPicker({ onSelect, onDismiss }: EvolveAlgorithmPickerProps) {
  const { t } = useLocale();
  return (
    <div className="evolve-algorithm-picker" role="listbox" aria-label={t("evolve.picker.title")}>
      <div className="evolve-algorithm-picker-header">
        <span className="evolve-algorithm-picker-title">{t("evolve.picker.title")}</span>
        <button type="button" className="icon-button" onClick={onDismiss} aria-label={t("evolve.picker.dismiss")}>
          {"\u00d7"}
        </button>
      </div>
      <div className="evolve-algorithm-picker-options">
        {ALGORITHMS.map((algorithm) => (
          <button
            key={algorithm.id}
            type="button"
            role="option"
            aria-selected={false}
            className="evolve-algorithm-option"
            onClick={() => onSelect(algorithm.id)}
          >
            <div className="evolve-algorithm-option-header">
              <span className="evolve-algorithm-option-name">{algorithm.label}</span>
              <span className="evolve-algorithm-option-tagline">{t(algorithm.taglineKey)}</span>
            </div>
            <ul className="evolve-algorithm-option-features">
              {t(algorithm.featuresKey).split("\n").map((feature, i) => (
                <li key={i}>{feature}</li>
              ))}
            </ul>
            <div className="evolve-algorithm-option-suitedfor">
              <span className="evolve-algorithm-option-suitedfor-label">{t("evolve.picker.suitedfor")}</span>
              {t(algorithm.suitedForKey)}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
