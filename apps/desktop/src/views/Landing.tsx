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

import { useState, type ComponentProps } from "react";

import { LANDING_CATEGORIES, type LandingCategory, type LandingSeed } from "../app/landing.js";
import { TEXT } from "../text.js";
import { Composer } from "./Composer.js";

/** Everything the composer needs except the three things the welcome page
 *  decides for it: its layout, the category chip, and the prompt a topic
 *  drops in. */
type ComposerProps = Omit<ComponentProps<typeof Composer>, "landing" | "seed" | "tag">;

/**
 * The welcome page: the wordmark over the three ways into a new session, and
 * the composer floating under them rather than pinned to the bottom of the
 * window.
 *
 * A category is two states, not one. Choosing it puts its name in the composer
 * as a chip and opens its row of starter topics; choosing a topic drops that
 * prompt into the composer and folds the row back to the three categories, so
 * the next topic is one click away without losing the chip. The chip keeps the
 * turn's subject attached until the ✕ clears it.
 */
export function Landing({ composer }: { composer: ComposerProps }) {
  const [category, setCategory] = useState<LandingCategory>();
  const [browsing, setBrowsing] = useState(false);
  const [seed, setSeed] = useState<LandingSeed>();

  const topics = category === undefined ? [] : TEXT.landing.topics[category];
  const tag = category === undefined
    ? undefined
    : {
        kind: category,
        label: TEXT.landing.categories[category],
        onClear: () => {
          setCategory(undefined);
          setBrowsing(false);
        },
      };

  const choose = (next: LandingCategory) => {
    setCategory(next);
    setBrowsing(true);
  };

  return (
    <div className="landing">
      <div className="landing-inner">
        <div className="landing-brand">
          {/* Decorative: the wordmark beside it already names the product. */}
          <span aria-hidden="true" className="landing-mascot" />
          <div className="landing-brand-text">
            <h1 className="landing-wordmark">{TEXT.appName}</h1>
            <p className="landing-tagline">{TEXT.landing.tagline}</p>
          </div>
        </div>

        <div className="landing-pills">
          {browsing && category !== undefined
            ? topics.map((topic) => (
                <button
                  className="landing-pill is-topic"
                  key={topic.label}
                  onClick={() => {
                    setBrowsing(false);
                    setSeed((current) => ({ nonce: (current?.nonce ?? 0) + 1, text: topic.prompt }));
                  }}
                  type="button"
                >
                  <span>{topic.label}</span>
                  <span aria-hidden="true" className="landing-topic-arrow" />
                </button>
              ))
            : LANDING_CATEGORIES.map((key) => (
                <button className="landing-pill" key={key} onClick={() => choose(key)} type="button">
                  <span aria-hidden="true" className="landing-icon" data-kind={key} />
                  <span>{TEXT.landing.categories[key]}</span>
                </button>
              ))}
        </div>

        <Composer {...composer} landing seed={seed} tag={tag} />
      </div>
    </div>
  );
}
