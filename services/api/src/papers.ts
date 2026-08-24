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

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { promisify } from "node:util";

import type {
  ArtifactCandidate,
  ArtifactExtractionJob,
  PaperAcquisition,
  PaperExtractionManifest,
  PaperSourceId,
  PaperVisionRun,
} from "@sciencediscovery/schema";
import { resolveWorkspaceFile } from "@sciencediscovery/workspace";
import { CasStore } from "@sciencediscovery/cas";

import { SessionStore } from "./store.js";

const execFileAsync = promisify(execFile);
export const MAX_PAPER_PDF_BYTES = 50 * 1024 * 1024;
const MAX_VISION_IMAGES = 4;
const MAX_VISION_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VISION_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_VISION_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_VISION_PROMPT = "Describe the scientific content of these extracted paper pages and figures. Transcribe only labels and values needed to explain plots, diagrams, or tables; do not invent unreadable details. Distinguish direct observations from interpretation.";

function numberFromUsage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

function extractOpenAiUsage(value: unknown): PaperVisionRun["modelUsage"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = numberFromUsage(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = numberFromUsage(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = numberFromUsage(usage.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    inputTokens: inputTokens ?? Math.max(0, (totalTokens ?? 0) - (outputTokens ?? 0)),
    outputTokens: outputTokens ?? Math.max(0, (totalTokens ?? 0) - (inputTokens ?? 0)),
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

interface StorePaperOptions {
  bytes: Buffer;
  connectorId: PaperSourceId | "upload";
  identifier: string;
  license: string;
  outputPathPrefix?: string;
  sessionId: string;
  signal?: AbortSignal;
  sourceUrl: string;
  title?: string;
}

function cleanTitle(value: string | undefined, fallback: string): string {
  const cleaned = value?.trim().replace(/\s+/g, " ").slice(0, 500);
  return cleaned || fallback;
}

function validatePdf(bytes: Buffer): void {
  if (bytes.length > MAX_PAPER_PDF_BYTES) {
    throw new Error(`PDF exceeds the ${MAX_PAPER_PDF_BYTES} byte limit`);
  }
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("Paper upload does not have a PDF signature");
  }
}

export class PaperService {
  private readonly cas: CasStore;

  constructor(
    private readonly store: SessionStore,
    private readonly pythonPath: string,
    private readonly workerPath: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.cas = new CasStore(store.dataDir);
  }

  async upload(input: {
    bytes: Buffer;
    sessionId: string;
    title?: string;
  }): Promise<PaperAcquisition> {
    this.store.assertSessionWritable(input.sessionId);
    return await this.storePaper({
      bytes: input.bytes,
      connectorId: "upload",
      identifier: `upload:${randomUUID()}`,
      license: "User supplied; verify reuse rights before redistribution",
      sessionId: input.sessionId,
      sourceUrl: "",
      title: input.title,
    });
  }

  async importArtifact(input: {
    candidate: ArtifactCandidate;
    outputPathPrefix?: string;
    path: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<PaperAcquisition> {
    if (input.candidate.kind !== "paper" || input.candidate.format !== "pdf") {
      throw new Error("Only PDF paper artifacts can be imported into the Paper reader");
    }
    this.store.assertSessionWritable(input.sessionId);
    const target = resolveWorkspaceFile(this.store.workspacePath(input.sessionId), input.path);
    const bytes = await readFile(target);
    return await this.storePaper({
      bytes,
      connectorId: input.candidate.sourceId,
      identifier: input.candidate.sourceRecordId,
      license: input.candidate.license,
      outputPathPrefix: input.outputPathPrefix,
      sessionId: input.sessionId,
      signal: input.signal,
      sourceUrl: input.candidate.sourceUrl,
      title: input.candidate.logicalName.replace(/\.pdf$/i, ""),
    });
  }

  async extractArtifact(input: {
    artifactJobId: string;
    candidate: ArtifactCandidate;
    outputPathPrefix?: string;
    path: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<{ acquisition: PaperAcquisition; job: ArtifactExtractionJob }> {
    const existing = (await this.store.listArtifactExtractionJobs(input.sessionId))
      .find((job) => job.artifactJobId === input.artifactJobId && job.state === "completed");
    if (existing?.paperAcquisitionId) {
      const acquisition = (await this.store.listPaperAcquisitions(input.sessionId))
        .find((paper) => paper.id === existing.paperAcquisitionId);
      if (acquisition) return { acquisition, job: existing };
    }
    const createdAt = new Date().toISOString();
    let job: ArtifactExtractionJob = {
      artifactJobId: input.artifactJobId,
      createdAt,
      id: randomUUID(),
      sessionId: input.sessionId,
      state: "queued",
      updatedAt: createdAt,
    };
    await this.store.appendArtifactExtractionJob(job);
    job = {
      ...job,
      startedAt: new Date().toISOString(),
      state: "running",
      updatedAt: new Date().toISOString(),
    };
    await this.store.replaceArtifactExtractionJob(job);
    try {
      const acquisition = await this.importArtifact(input);
      const analysisRoot = acquisition.manifestPath.slice(0, acquisition.manifestPath.lastIndexOf("/"));
      job = {
        ...job,
        finishedAt: new Date().toISOString(),
        manifestPath: acquisition.manifestPath,
        paperAcquisitionId: acquisition.id,
        state: "completed",
        textPath: `${analysisRoot}/${acquisition.extraction.textPath}`,
        updatedAt: new Date().toISOString(),
      };
      await this.store.replaceArtifactExtractionJob(job);
      return { acquisition, job };
    } catch (error) {
      const cancelled = input.signal?.aborted === true
        || (error instanceof Error && error.name === "AbortError");
      job = {
        ...job,
        error: {
          code: cancelled ? "CANCELLED" : "NORMALIZATION_FAILED",
          message: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
          retryable: false,
        },
        finishedAt: new Date().toISOString(),
        state: cancelled ? "cancelled" : "failed",
        updatedAt: new Date().toISOString(),
      };
      await this.store.replaceArtifactExtractionJob(job);
      throw error;
    }
  }

  async analyzeVision(input: {
    modelId: string;
    paperId: string;
    prompt?: string;
    sessionId: string;
  }): Promise<PaperVisionRun> {
    this.store.assertSessionWritable(input.sessionId);
    const acquisition = (await this.store.listPaperAcquisitions(input.sessionId))
      .find((paper) => paper.id === input.paperId);
    if (!acquisition) throw new Error("Paper not found");
    const model = this.store.getModel(input.modelId);
    if (!model) throw new Error("Vision model not found");
    if (!model.vision) throw new Error("The selected model is not marked as vision capable");
    const apiToken = this.store.getModelApiToken(model.id);
    if (!apiToken) throw new Error("The selected vision model does not have a saved API token");

    const analysisRoot = dirname(acquisition.manifestPath);
    const candidatePaths = [
      ...acquisition.extraction.pages.filter((page) => page.needsVision).map((page) => page.previewPath),
      ...acquisition.extraction.images.map((image) => image.path),
      ...acquisition.extraction.pages.map((page) => page.previewPath),
    ].filter((path): path is string => Boolean(path));
    const inputPaths = [...new Set(candidatePaths)].slice(0, MAX_VISION_IMAGES)
      .map((path) => `${analysisRoot}/${path}`);
    if (!inputPaths.length) throw new Error("The paper parser produced no images for vision analysis");

    const workspace = this.store.workspacePath(input.sessionId);
    const inputs: Array<{ bytes: Buffer; mime: string; path: string }> = [];
    let totalBytes = 0;
    for (const path of inputPaths) {
      const target = resolve(workspace, path);
      if (target !== workspace && !target.startsWith(`${workspace}/`)) throw new Error("Vision input escaped the session workspace");
      const extension = extname(target).toLowerCase();
      const mime = extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : undefined;
      if (!mime) throw new Error("Vision inputs must be PNG or JPEG images");
      const bytes = await readFile(target);
      if (bytes.length > MAX_VISION_IMAGE_BYTES) throw new Error(`Vision image ${path} exceeds the per-image limit`);
      totalBytes += bytes.length;
      if (totalBytes > MAX_VISION_TOTAL_BYTES) throw new Error("Vision images exceed the combined byte limit");
      inputs.push({ bytes, mime, path });
    }

    const prompt = input.prompt?.trim().replace(/\s+/g, " ").slice(0, 4_000) || DEFAULT_VISION_PROMPT;
    const inputRefs = await Promise.all(inputs.map(async ({ bytes, path }) => ({
      content: await this.cas.put(bytes),
      path,
    })));
    const requestRecord = await this.cas.put(JSON.stringify({
      inputs: inputRefs,
      model: { id: model.id, model: model.model, name: model.name },
      paperId: acquisition.id,
      prompt,
    }));
    const response = await this.fetchImpl(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      body: JSON.stringify({
        messages: [{
          content: [
            { text: prompt, type: "text" },
            ...inputs.map(({ bytes, mime }) => ({
              image_url: { detail: "high", url: `data:${mime};base64,${bytes.toString("base64")}` },
              type: "image_url",
            })),
          ],
          role: "user",
        }],
        model: model.model,
        temperature: 0,
      }),
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`Vision model failed with HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") || "0");
    if (declaredLength > MAX_VISION_RESPONSE_BYTES) throw new Error("Vision model response exceeds the byte limit");
    const responseBytes = Buffer.from(await response.arrayBuffer());
    if (responseBytes.length > MAX_VISION_RESPONSE_BYTES) throw new Error("Vision model response exceeds the byte limit");
    const responseBody = JSON.parse(responseBytes.toString("utf8")) as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
    const content = responseBody.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("Vision model returned no content");
    const modelUsage = extractOpenAiUsage(responseBody.usage);

    const id = randomUUID();
    const resultPath = `papers/${acquisition.id}/vision/${id}.md`;
    await mkdir(resolve(workspace, dirname(resultPath)), { recursive: true });
    await writeFile(resolve(workspace, resultPath), `# Vision analysis\n\n${content}\n`, "utf8");
    const run: PaperVisionRun = {
      completedAt: new Date().toISOString(),
      id,
      inputPaths,
      modelId: model.id,
      ...(modelUsage ? { modelUsage } : {}),
      modelName: model.name,
      paperId: acquisition.id,
      prompt,
      request: requestRecord,
      response: await this.cas.put(responseBytes),
      resultPath,
      sessionId: input.sessionId,
      status: "succeeded",
    };
    await this.store.appendPaperVisionRun(run);
    return run;
  }

  private async storePaper(options: StorePaperOptions): Promise<PaperAcquisition> {
    validatePdf(options.bytes);
    const workspace = this.store.workspacePath(options.sessionId);
    const id = randomUUID();
    const cleanedPrefix = options.outputPathPrefix?.replace(/^\/+|\/+$/g, "");
    const relativeRoot = cleanedPrefix ? `${cleanedPrefix}/papers/${id}` : `papers/${id}`;
    const targetRoot = resolve(workspace, relativeRoot);
    const stagingRoot = resolve(workspace, `.paper-${id}.tmp`);
    const pdfPath = resolve(stagingRoot, "source.pdf");
    const analysisPath = resolve(stagingRoot, "analysis");
    try {
      await mkdir(stagingRoot, { recursive: false });
      await writeFile(pdfPath, options.bytes);
      const { stdout } = await execFileAsync(this.pythonPath, [this.workerPath, pdfPath, analysisPath], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        signal: options.signal,
        timeout: 120_000,
      });
      const manifest = JSON.parse(stdout.trim()) as PaperExtractionManifest;
      if (manifest.inputSha256 !== this.cas.hash(options.bytes)) {
        throw new Error("PDF parser manifest hash does not match the downloaded PDF");
      }
      const manifestBytes = await readFile(resolve(analysisPath, "manifest.json"));
      const [pdf, manifestRef] = await Promise.all([
        this.cas.put(options.bytes),
        this.cas.put(manifestBytes),
      ]);
      await mkdir(resolve(targetRoot, ".."), { recursive: true });
      await rename(stagingRoot, targetRoot);
      const acquisition: PaperAcquisition = {
        connectorId: options.connectorId,
        createdAt: new Date().toISOString(),
        extraction: manifest,
        id,
        identifier: options.identifier,
        license: options.license,
        manifest: manifestRef,
        manifestPath: `${relativeRoot}/analysis/manifest.json`,
        pdf,
        pdfPath: `${relativeRoot}/source.pdf`,
        sessionId: options.sessionId,
        ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
        status: "succeeded",
        title: cleanTitle(options.title, options.identifier),
      };
      await this.store.appendPaperAcquisition(acquisition);
      return acquisition;
    } catch (error) {
      await rm(stagingRoot, { force: true, recursive: true });
      await rm(targetRoot, { force: true, recursive: true });
      throw error;
    }
  }
}
