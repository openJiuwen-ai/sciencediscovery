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

import externalUrlsConfig from "../external-urls.json" with { type: "json" };

type JsonObject = { [key: string]: JsonObject | string | string[] };

function configValue(key: string): JsonObject | string | string[] {
  let value = externalUrlsConfig as unknown as JsonObject | string | string[];
  for (const segment of key.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !(segment in value)) {
      throw new Error(`External URL configuration is missing required key: ${key}`);
    }
    value = value[segment]!;
  }
  return value;
}

export function externalUrl(key: string): string {
  const value = configValue(key);
  if (typeof value !== "string" || !value) {
    throw new Error(`External URL configuration key ${key} must be a non-empty string`);
  }
  return value;
}

export function externalUrlList(key: string): readonly string[] {
  const value = configValue(key);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`External URL configuration key ${key} must be an array of non-empty strings`);
  }
  return Object.freeze([...value]);
}

export function formatExternalUrl(key: string, parameters: Record<string, string | number>): string {
  const template = externalUrl(key);
  const rendered = template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_match, name: string) => {
    const value = parameters[name];
    if (value === undefined) throw new Error(`External URL template ${key} requires parameter: ${name}`);
    return String(value);
  });
  if (/\{[a-zA-Z][a-zA-Z0-9_]*\}/.test(rendered)) {
    throw new Error(`External URL template ${key} contains an unresolved parameter`);
  }
  return rendered;
}
