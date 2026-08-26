#!/usr/bin/env node
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

// Download the model catalog snapshot that ships inside a release.
//
// The catalog itself is never committed: it moves too fast, and the product
// refreshes it at runtime. Packaging downloads one copy so a Docker image or
// release binary has a usable catalog on a first start with no network. The
// envelope written here is exactly the one the control API reads, so the
// packaged copy and a runtime refresh parse through the same code path.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CATALOG_BYTES = 64 * 1024 * 1024;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = resolve(scriptDirectory, "../config/external-urls.json");

function usage() {
  return `Usage:
  node scripts/fetch-model-catalog.mjs --output <path> [--source <path>] [--url <url>] [--config <path>]

Downloads the models.dev catalog document and writes the snapshot envelope the
control API loads. --source reads an already downloaded document from disk
instead, for an offline or reproducible build.`;
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (["--config", "--output", "--source", "--url"].includes(argument)) {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

/** The catalog endpoint stays in the shared external-URL registry so releases
 *  and the running product cannot drift onto different sources. */
export async function catalogUrl(configPath = defaultConfigPath) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const url = config?.model_catalog?.api_json;
  if (typeof url !== "string" || !url) {
    throw new Error("External URL configuration is missing model_catalog.api_json");
  }
  return url;
}

/** Accept only a document shaped like the catalog, so a captive portal or an
 *  error page cannot become the snapshot every user starts with. */
export function assertCatalogPayload(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("The model catalog document is not a provider map");
  }
  const models = Object.values(payload).reduce((total, provider) => {
    const entries = provider && typeof provider === "object" ? provider.models : undefined;
    return total + (entries && typeof entries === "object" ? Object.keys(entries).length : 0);
  }, 0);
  if (!models) throw new Error("The model catalog document contains no models");
  return models;
}

async function acquireText({ source, url }) {
  if (source) return await readFile(source, "utf8");
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`The model catalog download failed (${response.status})`);
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_CATALOG_BYTES) throw new Error("The model catalog download exceeds the size limit");
  const text = await response.text();
  if (text.length > MAX_CATALOG_BYTES) throw new Error("The model catalog download exceeds the size limit");
  return text;
}

export async function fetchModelCatalogSnapshot({ configPath, fetchedAt, output, source, url }) {
  const sourceUrl = url ?? await catalogUrl(configPath);
  const text = await acquireText({ source, url: sourceUrl });
  const payload = JSON.parse(text);
  const models = assertCatalogPayload(payload);
  const envelope = { fetchedAt: fetchedAt ?? new Date().toISOString(), payload, sourceUrl };

  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(envelope));
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return { fetchedAt: envelope.fetchedAt, models, providers: Object.keys(payload).length, sourceUrl };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.output) throw new Error("--output is required");
  const result = await fetchModelCatalogSnapshot({
    configPath: options.config,
    output: options.output,
    source: options.source,
    url: options.url,
  });
  console.log(
    `Model catalog snapshot written: ${result.providers} providers, ${result.models} models,`
    + ` retrieved ${result.fetchedAt} from ${result.sourceUrl}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
