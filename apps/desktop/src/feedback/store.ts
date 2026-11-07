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

// Shared with apps/web; only the storage namespace differs. The prefix is part
// of the on-disk format: `sciencediscovery-desktop:feedback-install` etc.

import { createFeedbackStore } from "@sciencediscovery/operational-logging/feedback-client";

const store = createFeedbackStore("sciencediscovery-desktop:feedback");

export const {
  clearFeedbackDraft,
  emptyFeedbackDraft,
  loadFeedbackDraft,
  loadFeedbackHistory,
  readFeedbackInstallId,
  removeFeedbackRecord,
  saveFeedbackDraft,
  saveFeedbackRecord,
} = store;

export type {
  FeedbackDraft,
  FeedbackRecord,
  FeedbackStorage,
} from "@sciencediscovery/operational-logging/feedback-client";
