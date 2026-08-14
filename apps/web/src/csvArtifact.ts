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

export type CsvDetectionMethod = "content" | "extension" | "media-type";

export interface CsvDetection {
  delimiter: ",";
  method: CsvDetectionMethod;
}

interface CsvCandidate {
  content?: string;
  mediaType?: string;
  name?: string;
}

const CSV_MEDIA_TYPES = new Set([
  "application/csv",
  "text/comma-separated-values",
  "text/csv",
  "text/x-csv",
]);

function normalizedMediaType(mediaType?: string): string {
  return mediaType?.split(";", 1)[0]?.trim().toLocaleLowerCase() ?? "";
}

function commaCount(line: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\"") {
      if (quoted && line[index + 1] === "\"") {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      count += 1;
    }
  }
  return quoted ? -1 : count;
}

function looksLikeCsv(content: string): boolean {
  const sample = content.replace(/^\uFEFF/, "").slice(0, 64 * 1024);
  if (!sample || sample.includes("\0")) return false;
  const lines = sample.split(/\r?\n/).filter((line) => line.trim()).slice(0, 8);
  if (lines.length < 2) return false;
  const counts = lines.map(commaCount);
  const width = counts[0];
  return width !== undefined
    && width > 0
    && counts.every((count) => count === width);
}

/**
 * Detects a CSV artifact without parsing the full data set. Name and media type
 * are authoritative; content sniffing is a fallback for extensionless outputs.
 */
export function detectCsvArtifact(candidate: CsvCandidate): CsvDetection | undefined {
  const name = candidate.name?.split(/[?#]/, 1)[0]?.trim().toLocaleLowerCase();
  if (name?.endsWith(".csv")) return { delimiter: ",", method: "extension" };
  if (CSV_MEDIA_TYPES.has(normalizedMediaType(candidate.mediaType))) {
    return { delimiter: ",", method: "media-type" };
  }
  return candidate.content && looksLikeCsv(candidate.content)
    ? { delimiter: ",", method: "content" }
    : undefined;
}
