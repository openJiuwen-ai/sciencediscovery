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

import { createFeedbackOpenHook } from "@sciencediscovery/operational-logging/feedback-client";

const hook = createFeedbackOpenHook();

/** Imperative open hook used by entry points that are not the dialog itself. */
export const openFeedback = hook.openFeedback;

/** The single mounted dialog subscribes here; returns an unsubscribe function. */
export const subscribeFeedbackOpen = hook.subscribeFeedbackOpen;

export type { FeedbackSeed } from "@sciencediscovery/operational-logging/feedback-client";
