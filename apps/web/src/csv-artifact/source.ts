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

import type { CsvViewerSource, DataSourceRecord } from "./types.js";

/**
 * Builds the source record the viewer profiles a table against.
 *
 * An Artifact version is immutable, so its id, hash and size identify the data.
 * A Workspace file has no version or recorded hash. Its chart layouts are keyed
 * by the Workspace revision the file list observed for the path, so an edited
 * file opens on fresh default charts, as a new Artifact version does. Without a
 * revision the modification time stands in for it.
 */
export function csvSourceRecord(source: CsvViewerSource, fileName: string): DataSourceRecord {
  if (source.kind === "artifact") {
    const { version } = source;
    return {
      fileHash: version.content.hash,
      fileName,
      fileSize: version.content.size,
      importedAt: version.createdAt,
      sourceArtifactVersionId: version.id,
    };
  }
  const revision = source.revisionId
    ?? (source.modifiedAt ? `${source.path}@${source.modifiedAt}` : source.path);
  return {
    fileHash: "",
    fileName,
    fileSize: source.size,
    importedAt: source.openedAt,
    sourceArtifactVersionId: `workspace:${source.sessionId}:${revision}`,
  };
}
