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

import type { FeedbackKind, FeedbackMeta } from "@sciencediscovery/operational-logging/feedback";

/**
 * Pre-fill for a feedback dialog opened from a specific context. The sidebar
 * entry opens without a seed; the error diagnostics "anonymous submit" button
 * opens with the error title/diagnostic and correlation ids.
 */
export interface FeedbackSeed {
  kind?: FeedbackKind;
  title?: string;
  body?: string;
  diagnostics?: string;
  meta?: FeedbackMeta;
}

type OpenFeedbackListener = (seed?: FeedbackSeed) => void;

let openListener: OpenFeedbackListener | undefined;

/** Imperative open hook used by entry points that are not the dialog itself. */
export function openFeedback(seed?: FeedbackSeed): void {
  openListener?.(seed);
}

/** The single mounted dialog subscribes here; returns an unsubscribe function. */
export function subscribeFeedbackOpen(listener: OpenFeedbackListener): () => void {
  openListener = listener;
  return () => { if (openListener === listener) openListener = undefined; };
}