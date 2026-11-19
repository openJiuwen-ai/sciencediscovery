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

import type { Catalog } from "./types.js";

/**
 * Absolute URL for a site-relative path such as `packages/x.zip`.
 *
 * Session packages live under a sibling prefix (`/sessions/`), not under the
 * site base, so a URL that is already absolute or root-relative passes through.
 */
export function assetUrl(basePath: string, relative: string): string {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(relative)) return relative;
  if (relative.startsWith("/")) return relative;
  return `${basePath.replace(/\/+$/u, "")}/${relative}`;
}

/**
 * Fetch a text asset the exporter published (a README, a file preview).
 *
 * A static site answers an unknown path with its own index.html — OBS static
 * hosting's default page and nginx's `try_files` fallback both do. Without
 * this check a missing README renders the hub's HTML into the reader, which
 * looks like corruption rather than a missing file, so an HTML answer is
 * treated as "not published".
 */
export async function fetchTextAsset(basePath: string, relative: string): Promise<string> {
  const response = await fetch(assetUrl(basePath, relative));
  if (!response.ok) throw new Error(String(response.status));
  const text = await response.text();
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const head = text.trimStart().slice(0, 64).toLowerCase();
  if (type.includes("text/html") || head.startsWith("<!doctype html") || head.startsWith("<html")) {
    throw new Error("not a published file");
  }
  return text;
}

export async function loadCatalog(basePath: string): Promise<Catalog> {
  const response = await fetch(assetUrl(basePath, "catalog.json"));
  if (!response.ok) throw new Error(`Failed to load catalog.json: ${response.status}`);
  return await response.json() as Catalog;
}
