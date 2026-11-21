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

/**
 * Optional bridge to the hub API.
 *
 * The site stays a static catalogue by default. When `VITE_HUB_API_BASE` is
 * set at build time (the API prefix, e.g. `/api/v1` or
 * `https://hub.example.org/api/v1`), a download resolves through the backend
 * instead of using the permanent link in `catalog.json`: that deployment keeps
 * the bucket private, so the only way to get the bytes is to ask the API for a
 * short-lived URL.
 *
 * Nothing else in the UI changes: the catalogue still supplies the listing,
 * the README and the file inventory.
 */
const rawBase = (import.meta.env.VITE_HUB_API_BASE ?? "").trim().replace(/\/+$/u, "");

export const hubApiBase = rawBase;

export const hubApiConfigured = hubApiBase.length > 0;

interface ArtifactResponse {
  code: number;
  data: { filename?: string; url: string };
}

export interface ResolvedDownload {
  filename?: string;
  url: string;
}

/** A same-origin URL that streams the artifact; used by the save dialog. */
export function downloadContentPath(assetId: string, version: string | null): string {
  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  return `${hubApiBase}/artifacts/${encodeURIComponent(assetId)}/content${query}`;
}

export async function resolveDownload(
  assetId: string,
  version: string | null,
): Promise<ResolvedDownload> {
  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  const path = `${hubApiBase}/artifacts/${encodeURIComponent(assetId)}${query}`;
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to resolve a download URL: ${response.status}`);
  }
  const body = await response.json() as ArtifactResponse;
  return { url: body.data.url, filename: body.data.filename };
}
