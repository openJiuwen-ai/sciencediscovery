// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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
 * Vision pass for image-heavy PDF pages (ported from the DeepAnalyze
 * page-visual-enhancer idea, adapted to the KE paper-worker contract).
 *
 * Candidate rule (SA's two conditions): a page with little embedded text
 * (worker-flagged needsVision) OR an image-dense page (imageAreaRatio above
 * threshold) is described by a vision model; the description is merged into
 * the extracted markdown as a clearly-labelled annotation block so the
 * extraction LLM sees figure-plate content instead of a blank page.
 *
 * Anti-hallucination honesty: annotation text is VLM-GENERATED, not source
 * text — blocks carry an explicit marker telling downstream consumers to
 * treat them as secondary evidence. This is the same trade-off DA made; the
 * marker keeps it visible instead of silent.
 */

/** Image-area share above which a page counts as figure-dense (SA: 0.25). */
export const IMAGE_AREA_RATIO_THRESHOLD = 0.25;
/** Hard cap on vision calls per document — batch ingestion must stay bounded. */
export const MAX_VISION_PAGES_PER_DOC = 6;
/** Vision calls run with bounded concurrency so a slow endpoint can't serialize into a stall. */
export const VISION_CONCURRENCY = 3;

export const PAGE_VISUAL_PROMPT =
  "This is a page from a scientific paper, rendered as an image. Describe its complete visible content " +
  "objectively and in detail. If the page contains figure panels, describe each panel (what kind of plot or " +
  "image, axis labels, key visible findings). If a figure caption is visible, transcribe it VERBATIM — captions " +
  "usually begin with 'Figure' or 'Fig.'. Do not speculate beyond what is visible. Answer in English.";

export interface VisionEndpoint {
  readonly baseUrl: string;
  readonly apiToken: string;
  /** minimax: POST {baseUrl}/coding_plan/vlm {prompt, image_url}. */
  readonly protocol?: "openai" | "minimax";
  /** openai protocol only: chat-completions model id. */
  readonly model?: string;
  readonly timeoutMs?: number;
}

export interface WorkerPageEntry {
  readonly page: number;
  readonly textCharacters?: number;
  readonly needsVision?: boolean;
  readonly imageAreaRatio?: number;
  readonly previewPath?: string;
}

/**
 * Pages worth a vision call: needsVision (little embedded text) or
 * figure-dense, ordered by page, capped. Pages without a rendered preview
 * (the worker only renders the first MAX_PAGE_PREVIEWS) cannot be described
 * and are excluded — presence of previewPath is the source of truth, so this
 * never drifts from the worker's preview window.
 */
export function selectVisionCandidatePages(pages: readonly WorkerPageEntry[]): number[] {
  const candidates: number[] = [];
  for (const entry of pages) {
    if (candidates.length >= MAX_VISION_PAGES_PER_DOC) break;
    if (!entry.previewPath) continue;
    const dense = (entry.imageAreaRatio ?? 0) > IMAGE_AREA_RATIO_THRESHOLD;
    if (entry.needsVision || dense) candidates.push(entry.page);
  }
  return candidates;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * One vision call. Returns the description text, or throws on transport /
 * API errors — the caller (pdf-text) degrades per-page to a warning.
 */
export async function describeImageWithVision(
  endpoint: VisionEndpoint,
  pngBytes: Uint8Array,
): Promise<string> {
  const dataUrl = `data:image/png;base64,${Buffer.from(pngBytes).toString("base64")}`;
  const timeout = endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (endpoint.protocol === "minimax") {
    const base = endpoint.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}/coding_plan/vlm`, {
      body: JSON.stringify({ image_url: dataUrl, prompt: PAGE_VISUAL_PROMPT }),
      headers: { authorization: `Bearer ${endpoint.apiToken}`, "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      throw new Error(`minimax VLM HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const data = (await response.json()) as { content?: string; base_resp?: { status_code?: number; status_msg?: string } };
    if (data.base_resp?.status_code !== undefined && data.base_resp.status_code !== 0) {
      throw new Error(`minimax VLM error ${data.base_resp.status_code}: ${data.base_resp.status_msg ?? ""}`);
    }
    const content = data.content?.trim() ?? "";
    if (!content) throw new Error("minimax VLM returned empty content");
    return content;
  }
  if (!endpoint.model) throw new Error("openai vision protocol requires a model id");
  const base = endpoint.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    body: JSON.stringify({
      max_tokens: 2048,
      messages: [{
        content: [
          { text: PAGE_VISUAL_PROMPT, type: "text" },
          { image_url: { url: dataUrl }, type: "image_url" },
        ],
        role: "user",
      }],
      model: endpoint.model,
    }),
    headers: { authorization: `Bearer ${endpoint.apiToken}`, "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    throw new Error(`vision chat HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const raw = data.choices?.[0]?.message?.content;
  const content = (typeof raw === "string" ? raw : "").trim();
  if (!content) throw new Error("vision chat returned empty content");
  return content;
}
