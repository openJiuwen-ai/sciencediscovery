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

/** Absolute URL for a site-relative path such as `packages/x.zip`. */
export function assetUrl(basePath: string, relative: string): string {
  return `${basePath.replace(/\/+$/u, "")}/${relative.replace(/^\/+/u, "")}`;
}

export async function loadCatalog(basePath: string): Promise<Catalog> {
  const response = await fetch(assetUrl(basePath, "catalog.json"));
  if (!response.ok) throw new Error(`Failed to load catalog.json: ${response.status}`);
  return await response.json() as Catalog;
}
