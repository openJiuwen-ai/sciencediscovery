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

import type { CasObjectRef } from "./provenance.js";

export type PaperSourceId = string;

export interface PaperPageExtraction {
  needsVision: boolean;
  page: number;
  previewPath?: string;
  textCharacters: number;
}

export interface PaperTableExtraction {
  bbox: number[];
  columns: number;
  csvPath: string;
  page: number;
  previewPath?: string | null;
  rows: number;
}

export interface PaperImageExtraction {
  bbox: number[];
  height: number;
  page: number;
  path: string;
  width: number;
}

export interface PaperExtractionManifest {
  generatedAt: string;
  images: PaperImageExtraction[];
  inputSha256: string;
  limits: Record<string, number>;
  pageCount: number;
  pages: PaperPageExtraction[];
  parser: string;
  pdfBytes: number;
  schemaVersion: 1;
  tables: PaperTableExtraction[];
  textCharacters: number;
  textPath: string;
  warnings: string[];
}

export interface PaperAcquisition {
  connectorId: PaperSourceId | "upload";
  createdAt: string;
  id: string;
  identifier: string;
  license: string;
  manifest: CasObjectRef;
  manifestPath: string;
  pdf: CasObjectRef;
  pdfPath: string;
  sessionId: string;
  sourceUrl?: string;
  status: "succeeded";
  title: string;
  extraction: PaperExtractionManifest;
}

export interface ImportPaperRequest {
  connectorId: PaperSourceId;
  identifier: string;
  title?: string;
}

export interface AnalyzePaperVisionRequest {
  modelId: string;
  prompt?: string;
}

export interface PaperVisionRun {
  completedAt: string;
  id: string;
  inputPaths: string[];
  modelId: string;
  modelUsage?: {
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  modelName: string;
  paperId: string;
  prompt: string;
  request: CasObjectRef;
  response: CasObjectRef;
  resultPath: string;
  sessionId: string;
  status: "succeeded";
}
