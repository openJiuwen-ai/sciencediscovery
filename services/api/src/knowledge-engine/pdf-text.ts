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
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WORKER_TIMEOUT_MS = 120_000;

export interface PdfTextOptions {
  readonly pythonPath: string;
  readonly workerPath: string;
  /** Scratch root; a per-document subdirectory is created and removed. */
  readonly workDirRoot: string;
  readonly pdfBytes: Uint8Array;
  readonly docId: string;
  readonly signal?: AbortSignal;
}

export async function extractPdfText(options: PdfTextOptions): Promise<string> {
  // Defense in depth: docId is always a store UUID, but this function is
  // exported — never let it become a path-escape vector.
  if (!/^[\w-]+$/.test(options.docId)) {
    throw new Error(`invalid docId for staging path: ${options.docId.slice(0, 40)}`);
  }
  const workDir = resolve(options.workDirRoot, options.docId);
  await mkdir(workDir, { recursive: true });
  const pdfPath = resolve(workDir, "source.pdf");
  try {
    await writeFile(pdfPath, options.pdfBytes);
    const { stdout } = await execFileAsync(
      options.pythonPath,
      [options.workerPath, pdfPath, workDir],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, signal: options.signal, timeout: WORKER_TIMEOUT_MS },
    );
    const manifest = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { textPath?: string };
    if (!manifest.textPath) {
      throw new Error("paper worker manifest has no textPath");
    }
    return await readFile(resolve(workDir, manifest.textPath), "utf8");
  } finally {
    await rm(workDir, { force: true, recursive: true }).catch(() => {});
  }
}
