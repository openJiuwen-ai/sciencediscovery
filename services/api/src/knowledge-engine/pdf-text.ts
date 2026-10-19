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
 * PDF → markdown via the paper worker (services/paper/paper_worker.py),
 * the same one-shot process contract the control plane's PaperService uses:
 * argv = [python, worker, input.pdf, outputDir], stdout = manifest JSON,
 * body text in <outputDir>/fulltext.md. The worker times out at 120s like
 * the artifact path; JATS remains the preferred text source and this is the
 * fallback for papers EuropePMC does not cover.
 *
 * Optional vision pass (image-heavy papers): when the `describeImage` hook is
 * provided, pages the worker flagged as needsVision (little embedded text) or
 * figure-dense (imageAreaRatio > 0.25) are described from their rendered page
 * previews and the descriptions are merged into the markdown as clearly-
 * labelled annotation blocks. Without the hook the behavior is byte-identical
 * to before (opt-in).
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { classifyPdfDocument, type PdfClassification } from "./pdf-classify.js";
import { selectVisionCandidatePages, VISION_CONCURRENCY, type WorkerPageEntry } from "./pdf-vision.js";

const execFileAsync = promisify(execFile);
const WORKER_TIMEOUT_MS = 120_000;

/**
 * Marker heading every vision annotation block. The honesty contract: this
 * text is VLM-GENERATED, not verbatim source — extraction must treat it as
 * secondary evidence (and the marker makes that visible to the LLM reading
 * the fulltext).
 */
export const VISION_ANNOTATION_MARKER = "vision-model annotation (generated, secondary evidence — not verbatim source text)";

/** Describer seam: page PNG bytes → description, or null to skip the page. */
export type VisionDescriber = (pngBytes: Uint8Array, page: number) => Promise<string | null>;

export interface PdfTextOptions {
  readonly pythonPath: string;
  readonly workerPath: string;
  /** Scratch root; a per-document subdirectory is created and removed. */
  readonly workDirRoot: string;
  readonly pdfBytes: Uint8Array;
  readonly docId: string;
  readonly signal?: AbortSignal;
  /** Opt-in vision pass (absent → pure text extraction, as before). */
  readonly describeImage?: VisionDescriber;
  /** Observability hook for per-page vision failures (never throws). */
  readonly onWarn?: (message: string, detail?: unknown) => void;
  /** V1-Z3: receives the document classification (scanned/table-heavy/…) —
   *  callers may persist it into the document's source metadata. */
  readonly onClassification?: (classification: PdfClassification) => void;
}

interface WorkerManifest {
  readonly textPath?: string;
  readonly pages?: readonly WorkerPageEntry[];
}

/**
 * Insert each annotation right after its page section (the worker emits
 * `## Page N` headings). Unknown pages are appended under a trailing section
 * so the text is never silently dropped.
 */
export function mergeVisionAnnotations(fulltext: string, annotations: ReadonlyMap<number, string>): string {
  if (annotations.size === 0) return fulltext;
  const lines = fulltext.split("\n");
  const out: string[] = [];
  const injected = new Set<number>();
  // A page's annotation lands at the END of its section: the page's own
  // heading defers the block into `pending`, and the next `## Page` heading
  // flushes it (so it sits just before that heading). End-of-input flushes
  // the last page's block. Worker pages are strictly increasing — a body
  // line that happens to match the heading shape with a non-increasing
  // number is text, not a boundary.
  const pending: string[] = [];
  let lastHeadingPage = 0;
  for (const line of lines) {
    const heading = /^## Page (\d+)\s*$/.exec(line.trim());
    if (heading && Number(heading[1]) > lastHeadingPage) {
      lastHeadingPage = Number(heading[1]);
      if (pending.length > 0) {
        out.push(...pending.splice(0));
      }
      const page = Number(heading[1]);
      const annotation = annotations.get(page);
      if (annotation !== undefined && !injected.has(page)) {
        pending.push("", `### Page ${page} ${VISION_ANNOTATION_MARKER}`, "", annotation, "");
        injected.add(page);
      }
    }
    out.push(line);
  }
  if (pending.length > 0) out.push(...pending.splice(0));
  const leftovers = [...annotations.keys()].filter((page) => !injected.has(page));
  if (leftovers.length > 0) {
    out.push("", "## Vision annotations (pages without matching text sections)", "");
    for (const page of leftovers) {
      out.push(`### Page ${page} ${VISION_ANNOTATION_MARKER}`, "", annotations.get(page)!, "");
    }
  }
  return out.join("\n");
}

export async function extractPdfText(options: PdfTextOptions): Promise<{ fulltext: string; classification: PdfClassification }> {
  // Defense in depth: docId is always a store UUID, but this function is
  // exported — never let it become a path-escape vector.
  if (!/^[\w-]+$/.test(options.docId)) {
    throw new Error(`invalid docId for staging path: ${options.docId.slice(0, 40)}`);
  }
  const workDir = resolve(options.workDirRoot, options.docId);
  // The worker REQUIRES an empty output directory, so the input PDF lives
  // next to (not inside) it.
  const outputDir = resolve(workDir, "out");
  await mkdir(outputDir, { recursive: true });
  const pdfPath = resolve(workDir, "source.pdf");
  try {
    await writeFile(pdfPath, options.pdfBytes);
    const { stdout } = await execFileAsync(
      options.pythonPath,
      [options.workerPath, pdfPath, outputDir],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, signal: options.signal, timeout: WORKER_TIMEOUT_MS },
    );
    const manifest = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as WorkerManifest;
    if (!manifest.textPath) {
      throw new Error("paper worker manifest has no textPath");
    }
    const fulltext = await readFile(resolve(outputDir, manifest.textPath), "utf8");

    // V1-Z3: classify from the manifest (no second parse) and surface the
    // routing-relevant outcomes. A scanned PDF without the vision pass used
    // to ingest as a silently hollow document — that is now a loud warning.
    const classification = classifyPdfDocument(fulltext, manifest.pages ?? []);
    options.onClassification?.(classification);
    if (classification.type === "scanned") {
      if (!options.describeImage) {
        options.onWarn?.("ke_pdf_scanned_no_vision", {
          type: classification.type,
          reasons: classification.reasons,
          signals: classification.signals,
        });
      } else {
        const visionCovered = selectVisionCandidatePages(manifest.pages ?? []).length;
        if (visionCovered === 0) {
          options.onWarn?.("ke_pdf_scanned_vision_uncovered", {
            type: classification.type,
            reasons: classification.reasons,
            signals: classification.signals,
          });
        }
      }
    } else if (classification.reasons.length > 0 && classification.type !== "text-only") {
      options.onWarn?.("ke_pdf_enhancement_hint", {
        type: classification.type,
        reasons: classification.reasons,
        signals: classification.signals,
      });
    }

    if (!options.describeImage) {
      return { fulltext, classification };
    }
    return {
      fulltext: await applyVisionPass(fulltext, manifest, outputDir, options.describeImage, options.onWarn),
      classification,
    };
  } finally {
    await rm(workDir, { force: true, recursive: true }).catch(() => {});
  }
}

/**
 * Describe candidate pages from their rendered previews and merge the
 * annotations. Per-page failures degrade to a warning — a vision outage
 * must never fail ingestion (the page's text, if any, still flows through).
 */
async function applyVisionPass(
  fulltext: string,
  manifest: WorkerManifest,
  outputDir: string,
  describeImage: VisionDescriber,
  onWarn?: (message: string, detail?: unknown) => void,
): Promise<string> {
  const pages = manifest.pages ?? [];
  const candidates = selectVisionCandidatePages(pages);
  if (candidates.length === 0) return fulltext;
  const previewByPage = new Map(pages.filter((p) => p.previewPath).map((p) => [p.page, p.previewPath!]));
  const annotations = new Map<number, string>();
  const describePage = async (page: number): Promise<void> => {
    const previewPath = previewByPage.get(page);
    if (!previewPath) return;
    try {
      const png = await readFile(resolve(outputDir, previewPath));
      const description = await describeImage(new Uint8Array(png), page);
      if (description && description.trim().length > 20) {
        annotations.set(page, description.trim());
      } else {
        onWarn?.("ke_pdf_vision_page_stub", { page, chars: description?.trim().length ?? 0 });
      }
    } catch (error) {
      onWarn?.("ke_pdf_vision_page_failed", {
        page,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  // Bounded concurrency: a slow vision endpoint must not serialize six
  // sequential timeouts into the ingest path.
  for (let index = 0; index < candidates.length; index += VISION_CONCURRENCY) {
    await Promise.all(candidates.slice(index, index + VISION_CONCURRENCY).map(describePage));
  }
  return mergeVisionAnnotations(fulltext, annotations);
}
