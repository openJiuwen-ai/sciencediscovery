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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { automaticReviewComposerState } from "../src/automatic-review-composer.js";

test("composer Automatic review does not claim unavailable while Reviewer settings are loading", () => {
  const state = automaticReviewComposerState({
    reviewerSettings: undefined,
    sessionAutomaticReviewEnabled: true,
  });
  assert.equal(state.capabilityKnown, false);
  assert.equal(state.capabilityEnabled, false);
  assert.equal(state.switchChecked, true);
  assert.equal(state.labelOn, true);
  assert.equal(state.showUnavailableNotice, false);
  assert.equal(state.titleKey, "reviewer.automaticReview");
});

test("composer Automatic review is available when Reviewer is on and the Session defaults on", () => {
  const state = automaticReviewComposerState({
    reviewerSettings: { enabled: true, feedbackPolicy: "record" },
    sessionAutomaticReviewEnabled: true,
  });
  assert.equal(state.capabilityKnown, true);
  assert.equal(state.capabilityEnabled, true);
  assert.equal(state.switchChecked, true);
  assert.equal(state.labelOn, true);
  assert.equal(state.showUnavailableNotice, false);
  assert.equal(state.titleKey, "reviewer.automaticReview");
});

test("composer shows unavailable only after Reviewer settings load as off", () => {
  const state = automaticReviewComposerState({
    reviewerSettings: { enabled: false, feedbackPolicy: "record" },
    sessionAutomaticReviewEnabled: true,
  });
  assert.equal(state.showUnavailableNotice, true);
  assert.equal(state.switchChecked, false);
  assert.equal(state.labelOn, false);
  assert.equal(state.titleKey, "reviewer.automaticUnavailable");
});

test("composer keeps Session Automatic review off without an unavailable notice", () => {
  const state = automaticReviewComposerState({
    reviewerSettings: { enabled: true, feedbackPolicy: "record" },
    sessionAutomaticReviewEnabled: false,
  });
  assert.equal(state.switchChecked, false);
  assert.equal(state.labelOn, false);
  assert.equal(state.showUnavailableNotice, false);
  assert.equal(state.titleKey, "reviewer.automaticReview");
});
