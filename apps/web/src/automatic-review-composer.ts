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

export type AutomaticReviewComposerTitleKey =
  | "reviewer.automaticReview"
  | "reviewer.automaticUnavailable";

/**
 * Composer Automatic review presentation for #588 / #413.
 * While system Reviewer settings are still loading (`undefined`), do not claim
 * the capability is off — that flash was a leftover after #466 mirrored the
 * Specialists loading fix in Orchestration.
 */
export function automaticReviewComposerState(input: {
  reviewerSettings: ReviewerSpecialistSettings | undefined;
  sessionAutomaticReviewEnabled: boolean;
}): {
  capabilityKnown: boolean;
  capabilityEnabled: boolean;
  switchChecked: boolean;
  showUnavailableNotice: boolean;
  titleKey: AutomaticReviewComposerTitleKey;
  labelOn: boolean;
} {
  const capabilityKnown = input.reviewerSettings !== undefined;
  const capabilityEnabled = input.reviewerSettings?.enabled === true;
  // Until settings arrive, mirror the Session preference so a new Session that
  // already defaults Automatic review on does not flash "Off / unavailable".
  const effectiveOn = capabilityKnown
    ? capabilityEnabled && input.sessionAutomaticReviewEnabled
    : input.sessionAutomaticReviewEnabled;
  return {
    capabilityKnown,
    capabilityEnabled,
    switchChecked: effectiveOn,
    showUnavailableNotice: capabilityKnown && !capabilityEnabled && input.sessionAutomaticReviewEnabled,
    titleKey: !capabilityKnown || capabilityEnabled
      ? "reviewer.automaticReview"
      : "reviewer.automaticUnavailable",
    labelOn: effectiveOn,
  };
}
