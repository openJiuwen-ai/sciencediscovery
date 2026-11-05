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

import type { FeedbackKind } from "@sciencediscovery/operational-logging/feedback";

const FEEDBACK_INSTALL_KEY = "sciencediscovery-feedback-install";
const FEEDBACK_DRAFT_KEY = "sciencediscovery-feedback-draft";
const FEEDBACK_HISTORY_KEY = "sciencediscovery-feedback-history";

export interface FeedbackDraft {
  kind: FeedbackKind;
  body: string;
  contact: string;
  reproducibility: string;
  impact: string;
  includeDiagnostics: boolean;
}

export interface FeedbackRecord {
  receipt: string;
  kind: FeedbackKind;
  title: string;
  submittedAt: string;
  status: "submitted";
}

/** Narrower-than-`Storage` surface, matching the browser-storage conventions. */
export interface FeedbackStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/** A stable per-install id, generated once and reused for rate limiting identity. */
export function readFeedbackInstallId(storage: FeedbackStorage): string {
  const existing = storage.getItem(FEEDBACK_INSTALL_KEY);
  if (existing) return existing;
  const id = uuid();
  try { storage.setItem(FEEDBACK_INSTALL_KEY, id); } catch { /* keep serving the id */ }
  return id;
}

const EMPTY_DRAFT: FeedbackDraft = {
  kind: "bug",
  body: "",
  contact: "",
  reproducibility: "",
  impact: "",
  includeDiagnostics: true,
};

export function emptyFeedbackDraft(): FeedbackDraft {
  return { ...EMPTY_DRAFT };
}

function isFeedbackKind(value: unknown): value is FeedbackKind {
  return value === "bug" || value === "idea" || value === "other";
}

export function loadFeedbackDraft(storage: FeedbackStorage): FeedbackDraft {
  try {
    const raw = storage.getItem(FEEDBACK_DRAFT_KEY);
    if (!raw) return emptyFeedbackDraft();
    const parsed = JSON.parse(raw) as Partial<FeedbackDraft>;
    return {
      kind: isFeedbackKind(parsed.kind) ? parsed.kind : "bug",
      body: typeof parsed.body === "string" ? parsed.body : "",
      contact: typeof parsed.contact === "string" ? parsed.contact : "",
      reproducibility: typeof parsed.reproducibility === "string" ? parsed.reproducibility : "",
      impact: typeof parsed.impact === "string" ? parsed.impact : "",
      includeDiagnostics: parsed.includeDiagnostics !== false,
    };
  } catch {
    return emptyFeedbackDraft();
  }
}

export function saveFeedbackDraft(storage: FeedbackStorage, draft: FeedbackDraft): void {
  try { storage.setItem(FEEDBACK_DRAFT_KEY, JSON.stringify(draft)); } catch { /* quota or private mode */ }
}

export function clearFeedbackDraft(storage: FeedbackStorage): void {
  try { storage.removeItem?.(FEEDBACK_DRAFT_KEY); } catch { /* ignore */ }
}

function isFeedbackRecord(value: unknown): value is FeedbackRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<FeedbackRecord>;
  return typeof record.receipt === "string" && typeof record.submittedAt === "string";
}

export function loadFeedbackHistory(storage: FeedbackStorage): FeedbackRecord[] {
  try {
    const raw = storage.getItem(FEEDBACK_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isFeedbackRecord);
  } catch {
    return [];
  }
}

export function saveFeedbackRecord(storage: FeedbackStorage, record: FeedbackRecord): FeedbackRecord[] {
  const history = [record, ...loadFeedbackHistory(storage)].slice(0, 50);
  try { storage.setItem(FEEDBACK_HISTORY_KEY, JSON.stringify(history)); } catch { /* ignore */ }
  return history;
}

export function removeFeedbackRecord(storage: FeedbackStorage, receipt: string): FeedbackRecord[] {
  const history = loadFeedbackHistory(storage).filter((item) => item.receipt !== receipt);
  try { storage.setItem(FEEDBACK_HISTORY_KEY, JSON.stringify(history)); } catch { /* ignore */ }
  return history;
}