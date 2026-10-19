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
 * V1-Z3 PDF document classification — port of SA's pdf-classifier heuristics,
 * adapted to SD's paper-worker manifest (per-page textCharacters +
 * imageAreaRatio already exist, so no second pdf-parse pass is needed).
 *
 * Routing outcomes in SD:
 *  - scanned     → the vision pass is the OCR stand-in; without it the text
 *                  layer is nearly empty and ingestion must WARN LOUDLY
 *                  instead of silently storing a hollow document.
 *  - formula_heavy → prefer the arXiv LaTeX source (the ingest order already
 *                  tries JATS → LaTeX → PDF); vision annotations stay
 *                  secondary evidence.
 *  - table_heavy → verify table numbers against rendered pages before
 *                  quoting them.
 *
 * The classifier is intentionally conservative: "scanned" requires the text
 * layer to be clearly absent (SA's <100 chars/page bar) so digital-born PDFs
 * never get misrouted.
 */

import { IMAGE_AREA_RATIO_THRESHOLD, type WorkerPageEntry } from "./pdf-vision.js";

export type PdfDocumentClass =
  | "scanned"
  | "image-heavy"
  | "table-heavy"
  | "formula-heavy"
  | "mixed"
  | "text-only";

export interface PdfClassification {
  readonly type: PdfDocumentClass;
  /** 0-1 (1 = very confident). */
  readonly confidence: number;
  readonly signals: {
    readonly pageCount: number;
    readonly textCharsPerPage: number;
    readonly imageDensePages: number;
    readonly imageDensePageRatio: number;
    readonly hasTableMarkers: boolean;
    readonly hasFormulaMarkers: boolean;
  };
  /** Human-readable reasons the classification suggests an enhancement. */
  readonly reasons: readonly string[];
}

/** SA's markers, verbatim in spirit: markdown/tabular tables and "Table N". */
const TABLE_MARKER_RE = /(\n\s*\|.*\|.*\n)|((?:Table|表格|表)\s*\d+\s*[:：])|(\n[^\n]+\t[^\n]+\t[^\n]+\n)/i;

/** SA's formula markers: LaTeX commands, equation labels, math symbols. */
const FORMULA_MARKER_RE =
  /(\\frac|\\sum|\\int|\\sqrt|\\alpha|\\beta|\\gamma|\\delta|\\theta|\\lambda|\\mu|\\sigma|\\pi|\\infty)|(Equation\s*\d+)|(公式\s*\d+)|([∑∫√∂∇∝≈≠≤≥±×÷∞])/;

/** SA's bar: below this the text layer counts as clearly absent. */
const SCANNED_TEXT_CHARS_PER_PAGE = 100;
/** SA's bar: enough text that image density alone does not dominate. */
const IMAGE_HEAVY_TEXT_CHARS_PER_PAGE = 500;

/**
 * Classify one extracted document. `pages` is the worker manifest's page
 * table; when absent (older manifests), per-page signals degrade to the
 * fulltext alone — classification stays conservative, never throws.
 */
export function classifyPdfDocument(fulltext: string, pages: readonly WorkerPageEntry[]): PdfClassification {
  const pageCount = pages.length > 0
    ? pages.length
    // Worker markdown emits `## Page N` sections; fall back to counting those.
    : (fulltext.match(/^## Page \d+\s*$/gm) ?? []).length;
  const manifestTextChars = pages.reduce((sum, page) => sum + (page.textCharacters ?? 0), 0);
  // Manifest per-page counts win; a manifest without them degrades to the
  // extracted text's own length.
  const textChars = manifestTextChars > 0 ? manifestTextChars : fulltext.length;
  const textCharsPerPage = pageCount > 0 ? textChars / pageCount : 0;
  const imageDensePages = pages.filter((page) => (page.imageAreaRatio ?? 0) > IMAGE_AREA_RATIO_THRESHOLD).length;
  const imageDensePageRatio = pageCount > 0 ? imageDensePages / pageCount : 0;
  const hasTableMarkers = TABLE_MARKER_RE.test(fulltext);
  const hasFormulaMarkers = FORMULA_MARKER_RE.test(fulltext);

  const signals = {
    pageCount,
    textCharsPerPage,
    imageDensePages,
    imageDensePageRatio,
    hasTableMarkers,
    hasFormulaMarkers,
  };

  let type: PdfDocumentClass;
  let confidence: number;
  if (pageCount > 0 && textCharsPerPage < SCANNED_TEXT_CHARS_PER_PAGE) {
    type = "scanned";
    confidence = 0.85;
  } else if (imageDensePageRatio >= 0.3 && textCharsPerPage < IMAGE_HEAVY_TEXT_CHARS_PER_PAGE) {
    type = "image-heavy";
    confidence = 0.7;
  } else if (hasTableMarkers && hasFormulaMarkers) {
    type = "mixed";
    confidence = 0.7;
  } else if (hasTableMarkers) {
    type = "table-heavy";
    confidence = 0.7;
  } else if (hasFormulaMarkers) {
    type = "formula-heavy";
    confidence = 0.7;
  } else {
    type = "text-only";
    confidence = textCharsPerPage > 1_500 ? 0.8 : 0.5;
  }

  return { type, confidence, signals, reasons: enhancementReasons(type, signals) };
}

function enhancementReasons(type: PdfDocumentClass, signals: PdfClassification["signals"]): string[] {
  const reasons: string[] = [];
  if (type === "scanned") {
    reasons.push(
      `text layer is nearly absent (${Math.round(signals.textCharsPerPage)} chars/page across ${signals.pageCount} pages) — ` +
      "without the vision pass this document ingests as a hollow shell; enable the vision endpoint or supply an OCR'd variant",
    );
  }
  if (type === "image-heavy" || type === "scanned") {
    reasons.push(
      `${signals.imageDensePages}/${signals.pageCount} pages are figure-dense — vision annotations recover figure-plate content the text layer cannot see`,
    );
  }
  if (type === "table-heavy" || type === "mixed") {
    reasons.push("table-like column structures detected — verify quoted table numbers against the rendered pages");
  }
  if (type === "formula-heavy" || type === "mixed") {
    reasons.push("math/LaTeX markers present — prefer the arXiv LaTeX source for exact formulas (the ingest order already tries JATS → LaTeX → PDF)");
  }
  return reasons;
}
