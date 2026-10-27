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

import type { Subagent } from "@sciencediscovery/schema";

import type { SessionStore } from "../store.js";

/**
 * A deliverable declaration is only trusted when it is an explicit relative
 * file path. Free-text requirements ("a short summary", "JSON with fields …"),
 * absolute host paths and URLs are not deliverable identities and are ignored:
 * the Reviewer then reports completeness as unconfirmed instead of guessing.
 */
const DELIVERABLE_EXTENSIONS = new Set([
  "cif", "csv", "docx", "h5", "hdf5", "html", "json", "jsonl", "md", "npy", "npz",
  "parquet", "pdf", "png", "pdb", "qmd", "svg", "tex", "tsv", "txt", "xlsx", "zip",
]);
const WINDOWS_SEPARATOR = /\\/gu;
const MAX_DECLARED_PATH_LENGTH = 200;

export function declaredDeliverablePath(requirement: string): string | undefined {
  const trimmed = requirement.trim();
  if (!trimmed || trimmed.length > MAX_DECLARED_PATH_LENGTH) return undefined;
  // Free-text requirements contain spaces or prose punctuation; a deliverable is one token.
  if (/[\s,;:()[\]{}*?<>|"'`]/u.test(trimmed)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return undefined;
  // An absolute host path identifies a machine location, not a task deliverable.
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(trimmed)) return undefined;
  const path = trimmed.replace(WINDOWS_SEPARATOR, "/").replace(/^\.\//u, "").replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (!path || path.startsWith("../")) return undefined;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (!name.includes(".") || !DELIVERABLE_EXTENSIONS.has(extension)) return undefined;
  return path;
}

/** Structured delivery declarations a task made through its subagent Briefs. */
export function declaredDeliverablePaths(subagents: readonly Subagent[]): string[] {
  const paths = new Set<string>();
  for (const subagent of subagents) {
    for (const requirement of subagent.input?.brief?.outputRequirements ?? []) {
      const path = declaredDeliverablePath(requirement);
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

/**
 * Reviewer input for delivery completeness. `undefined` means the Session
 * declared no structured deliverable, and the review must say the scope was
 * limited rather than present the citation check as an overall pass.
 */
export function sessionRequiredDeliverables(
  store: SessionStore,
  sessionId: string,
): { paths: string[]; source: "brief" } | undefined {
  const paths = declaredDeliverablePaths(store.listSubagents(sessionId));
  return paths.length ? { paths, source: "brief" } : undefined;
}
