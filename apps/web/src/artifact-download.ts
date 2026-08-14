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

import { zip } from "fflate";

export const MAX_ARTIFACT_ARCHIVE_FILES = 100;
export const MAX_ARTIFACT_ARCHIVE_BYTES = 100 * 1024 * 1024;

export interface ArtifactArchiveEntry {
  content: Uint8Array;
  name: string;
}

export function normalizeArtifactArchivePath(name: string): string {
  const posix = name.replaceAll("\\", "/");
  if (posix.startsWith("/") || /^[a-zA-Z]:\//.test(posix)) {
    throw new Error("Artifact path must be relative");
  }
  const segments = posix.split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length || segments.some((segment) => segment === "..")) {
    throw new Error("Artifact path is unsafe");
  }
  return segments.join("/");
}

export function artifactDownloadFileName(name: string): string {
  return normalizeArtifactArchivePath(name).split("/").at(-1) ?? "artifact";
}

export function artifactArchiveLimitError(fileCount: number, totalBytes: number): string | undefined {
  if (fileCount > MAX_ARTIFACT_ARCHIVE_FILES) {
    return `Select at most ${MAX_ARTIFACT_ARCHIVE_FILES} artifacts per download.`;
  }
  if (totalBytes > MAX_ARTIFACT_ARCHIVE_BYTES) {
    return "Selected artifacts exceed the 100 MiB download limit.";
  }
  return undefined;
}

export async function createArtifactArchive(entries: readonly ArtifactArchiveEntry[]): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    const path = normalizeArtifactArchivePath(entry.name);
    if (files[path]) throw new Error(`Duplicate artifact path: ${path}`);
    files[path] = entry.content;
  }
  return new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function artifactArchiveBlob(bytes: Uint8Array): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: "application/zip" });
}
