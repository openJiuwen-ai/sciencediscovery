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

import type { Project } from "../api/types.js";

/**
 * How two Project names are compared.
 *
 * The sidebar shows one line per Project and nothing else distinguishes them,
 * so "Notes" and "notes " would be two rows the user cannot tell apart. The
 * service collapses whitespace with `cleanLabel` before storing a name; this
 * collapses the same way and then ignores case.
 */
export function projectNameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** The Project that already answers to `name`, if there is one. */
export function projectWithName(
  projects: Project[],
  name: string,
  exceptId?: string,
): Project | undefined {
  const wanted = projectNameKey(name);
  if (wanted === "") return undefined;
  return projects.find(
    (project) => project.id !== exceptId && projectNameKey(project.name) === wanted,
  );
}
