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

import type { ToolTrace } from "@sciencediscovery/schema";

/** Only promote deliberately short task fields, never raw prompts or workspace paths. */
export function researchLabel(trace: Pick<ToolTrace, "args" | "input" | "name">): string {
  let args = trace.args;
  if (!args && trace.input) {
    try { args = JSON.parse(trace.input) as Record<string, unknown>; } catch { /* Legacy prose stays in details. */ }
  }
  for (const key of ["description", "query"]) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return compactStatus(value);
  }
  return trace.name;
}

export function compactStatus(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 160 ? text.slice(0, 157) + "…" : text;
}
