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

export const ENVIRONMENT_TOOL_NAMES = {
  create: "environment_create",
  delete: "environment_delete",
  install: "environment_install",
  list: "environment_list",
  uninstall: "environment_uninstall",
} as const;

const LEGACY_ENVIRONMENT_TOOL_NAMES: Readonly<Record<string, string>> = {
  "environment.create": ENVIRONMENT_TOOL_NAMES.create,
  "environment.delete": ENVIRONMENT_TOOL_NAMES.delete,
  "environment.install": ENVIRONMENT_TOOL_NAMES.install,
  "environment.list": ENVIRONMENT_TOOL_NAMES.list,
  "environment.uninstall": ENVIRONMENT_TOOL_NAMES.uninstall,
};

/** Normalize only the five historical environment tool names. */
export function normalizeLegacyEnvironmentToolName(name: string): string {
  return LEGACY_ENVIRONMENT_TOOL_NAMES[name] ?? name;
}
