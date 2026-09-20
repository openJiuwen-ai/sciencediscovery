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

import { translateActive } from "./i18n/index.js";

export const MAX_SKILL_FOLDER_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const MAX_SKILL_FOLDER_EXTRACTED_BYTES = 50 * 1024 * 1024;
export const MAX_SKILL_FOLDER_FILES = 500;

/** The limits read as MiB in every message, so they are derived from one place. */
function mebibytes(bytes: number): number {
  return bytes / (1024 * 1024);
}

function normalizeFolderPath(path: string): string {
  const posix = path.replaceAll("\\", "/");
  if (!posix || posix.startsWith("/") || /^[A-Za-z]:\//.test(posix) || posix.includes("\0")) {
    throw new Error(translateActive("skillFolder.unsafePath"));
  }
  const segments = posix.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(translateActive("skillFolder.unsafePath"));
  }
  return segments.join("/");
}

function createZip(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (error, archive) => {
      if (error) reject(error);
      else resolve(archive);
    });
  });
}

export async function createSkillFolderArchive(selectedFiles: readonly File[]): Promise<File> {
  if (!selectedFiles.length) throw new Error(translateActive("skillFolder.selectFolder"));
  if (selectedFiles.length > MAX_SKILL_FOLDER_FILES) {
    throw new Error(translateActive("skillFolder.tooManyFiles", { count: MAX_SKILL_FOLDER_FILES }));
  }

  const files = Object.create(null) as Record<string, Uint8Array>;
  const roots = new Set<string>();
  let extractedBytes = 0;
  for (const file of selectedFiles) {
    if (!file.webkitRelativePath) {
      throw new Error(translateActive("skillFolder.pathsNotPreserved"));
    }
    const path = normalizeFolderPath(file.webkitRelativePath);
    if (Object.hasOwn(files, path)) throw new Error(translateActive("skillFolder.duplicatePath", { path }));
    roots.add(path.split("/", 1)[0]!);
    extractedBytes += file.size;
    if (extractedBytes > MAX_SKILL_FOLDER_EXTRACTED_BYTES) {
      throw new Error(translateActive("skillFolder.extractedTooLarge", { size: mebibytes(MAX_SKILL_FOLDER_EXTRACTED_BYTES) }));
    }
    files[path] = new Uint8Array(await file.arrayBuffer());
  }

  if (roots.size !== 1) throw new Error(translateActive("skillFolder.singleFolder"));
  const root = [...roots][0]!;
  if (!Object.hasOwn(files, `${root}/SKILL.md`)) {
    throw new Error(translateActive("skillFolder.missingSkillMd"));
  }

  const archive = await createZip(files);
  if (archive.byteLength > MAX_SKILL_FOLDER_ARCHIVE_BYTES) {
    throw new Error(translateActive("skillFolder.archiveTooLarge", { size: mebibytes(MAX_SKILL_FOLDER_ARCHIVE_BYTES) }));
  }
  const bytes = new Uint8Array(archive.byteLength);
  bytes.set(archive);
  return new File([bytes.buffer], `${root}.zip`, { type: "application/zip" });
}
