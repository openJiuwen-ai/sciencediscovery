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

import { hubApiBase, hubApiConfigured } from "./api.js";
import { DOMAIN_LABELS, SESSION_TASK_LABELS, SUBDOMAIN_LABELS } from "../labels.js";

import type { Catalog, CategoryNode, Label } from "./types.js";

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

function pretty(id: string): string {
  const last = id.split("/").pop() ?? id;
  return last.replace(/[_-]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function labelFor(id: string): Label {
  const key = id.split("/").pop() ?? id;
  return DOMAIN_LABELS[key] ?? SUBDOMAIN_LABELS[key] ?? SESSION_TASK_LABELS[key] ?? { en: pretty(key), zh: pretty(key) };
}

function hydrate(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.map((node) => ({
    ...node,
    children: node.children ? hydrate(node.children) : undefined,
    label: node.label ?? labelFor(node.id),
  }));
}

/** The catalogue from the API, for a deployment whose database is the source. */
async function loadCatalogFromApi(): Promise<Catalog> {
  const response = await fetch(`${hubApiBase}/catalog`);
  if (!response.ok) throw new Error(`Failed to load the catalogue: ${response.status}`);
  const body = await response.json() as { data: Catalog };
  const catalog = body.data;
  return {
    ...catalog,
    categories: {
      skill: hydrate(catalog.categories.skill ?? []),
      connector: hydrate(catalog.categories.connector ?? []),
      sessionPackage: hydrate(catalog.categories.sessionPackage ?? []),
    },
  };
}

export async function loadCatalog(basePath: string): Promise<Catalog> {
  if (hubApiConfigured) return loadCatalogFromApi();
  const response = await fetch(assetUrl(basePath, "catalog.json"));
  if (!response.ok) throw new Error(`Failed to load catalog.json: ${response.status}`);
  return await response.json() as Catalog;
}
