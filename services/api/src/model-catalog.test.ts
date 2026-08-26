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

// Offline coverage for the runtime catalog: which snapshot wins, what a manual
// refresh persists, and what survives a failed refresh. No test here reaches
// the network — the download is injected.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { ModelCatalogFetchError } from "@sciencediscovery/model";
import {
  getModelCatalogSnapshot,
  lookupModelCatalog,
  setModelCatalogSnapshot,
  type ModelsDevPayload,
} from "@sciencediscovery/schema";

import { ModelCatalogStore } from "./model-catalog.js";

const SOURCE_URL = "https://models.dev/api.json";

function payload(contextWindow: number): ModelsDevPayload {
  return {
    openai: {
      doc: "https://developers.openai.com/api/docs/api-reference/introduction",
      id: "openai",
      models: {
        "gpt-5.5": {
          cost: { input: 1.25, output: 10 },
          id: "gpt-5.5",
          limit: { context: contextWindow, output: 128_000 },
          modalities: { input: ["text", "image"], output: ["text"] },
          name: "GPT-5.5",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh"] }],
        },
      },
    },
  };
}

async function temporaryDataDir(): Promise<string> {
  const root = resolve(process.cwd(), ".tmp");
  await mkdir(root, { recursive: true });
  return await mkdtemp(resolve(root, "model-catalog-test-"));
}

async function writeSnapshot(path: string, fetchedAt: string, contextWindow: number): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ fetchedAt, payload: payload(contextWindow), sourceUrl: SOURCE_URL }), "utf8");
}

function store(dataDir: string, bundledPath: string, fetchCatalog?: () => Promise<ModelsDevPayload>): ModelCatalogStore {
  return new ModelCatalogStore({
    bundledPath,
    dataDir,
    ...(fetchCatalog ? { fetchCatalog } : {}),
    sourceUrl: SOURCE_URL,
  });
}

test("a first start with no network loads the snapshot packaging left behind", async () => {
  setModelCatalogSnapshot(undefined);
  const dataDir = await temporaryDataDir();
  const bundledPath = join(dataDir, "packaged", "models-dev.json");
  await writeSnapshot(bundledPath, "2026-08-20T00:00:00.000Z", 400_000);

  const details = await store(dataDir, bundledPath).load();
  assert.equal(details.snapshot?.origin, "bundled");
  assert.equal(details.snapshot?.fetchedAt, "2026-08-20T00:00:00.000Z");
  assert.equal(details.sourceUrl, SOURCE_URL);
  // Installed process-wide, so the synchronous lookups see it.
  assert.equal(lookupModelCatalog("gpt-5.5", "openai")?.contextWindow, 400_000);
});

test("this installation's own snapshot outranks the packaged one", async () => {
  setModelCatalogSnapshot(undefined);
  const dataDir = await temporaryDataDir();
  const bundledPath = join(dataDir, "packaged", "models-dev.json");
  await writeSnapshot(bundledPath, "2026-08-20T00:00:00.000Z", 400_000);
  await writeSnapshot(join(dataDir, "model-catalog", "models-dev.json"), "2026-08-25T00:00:00.000Z", 900_000);

  const details = await store(dataDir, bundledPath).load();
  assert.equal(details.snapshot?.origin, "downloaded");
  assert.equal(details.snapshot?.fetchedAt, "2026-08-25T00:00:00.000Z");
  assert.equal(lookupModelCatalog("gpt-5.5", "openai")?.contextWindow, 900_000);
});

test("a corrupt snapshot falls back to the packaged copy instead of failing the start", async () => {
  setModelCatalogSnapshot(undefined);
  const dataDir = await temporaryDataDir();
  const bundledPath = join(dataDir, "packaged", "models-dev.json");
  await writeSnapshot(bundledPath, "2026-08-20T00:00:00.000Z", 400_000);
  await mkdir(join(dataDir, "model-catalog"), { recursive: true });
  await writeFile(join(dataDir, "model-catalog", "models-dev.json"), "{ not json", "utf8");

  const details = await store(dataDir, bundledPath).load();
  assert.equal(details.snapshot?.origin, "bundled");
  assert.equal(lookupModelCatalog("gpt-5.5", "openai")?.contextWindow, 400_000);
});

test("with no snapshot at all the catalog stays empty rather than guessing", async () => {
  setModelCatalogSnapshot(undefined);
  const dataDir = await temporaryDataDir();
  const details = await store(dataDir, join(dataDir, "packaged", "absent.json")).load();
  assert.equal(details.snapshot, undefined);
  assert.equal(details.sourceUrl, SOURCE_URL);
  assert.equal(lookupModelCatalog("gpt-5.5", "openai"), undefined);
});

test("a manual refresh persists the download and stamps it with the retrieval time", async () => {
  setModelCatalogSnapshot(undefined);
  const dataDir = await temporaryDataDir();
  const bundledPath = join(dataDir, "packaged", "models-dev.json");
  await writeSnapshot(bundledPath, "2026-08-20T00:00:00.000Z", 400_000);

  const catalog = store(dataDir, bundledPath, async () => payload(1_050_000));
  await catalog.load();
  const before = catalog.details.snapshot!.fetchedAt;

  const refreshed = await catalog.refresh();
  assert.equal(refreshed.snapshot?.origin, "downloaded");
  assert.notEqual(refreshed.snapshot?.fetchedAt, before);
  assert.equal(lookupModelCatalog("gpt-5.5", "openai")?.contextWindow, 1_050_000);

  // The next start reads the refreshed snapshot from the data directory.
  const written = JSON.parse(await readFile(join(dataDir, "model-catalog", "models-dev.json"), "utf8")) as {
    fetchedAt: string;
    payload: ModelsDevPayload;
    sourceUrl: string;
  };
  assert.equal(written.fetchedAt, refreshed.snapshot?.fetchedAt);
  assert.equal(written.sourceUrl, SOURCE_URL);
  setModelCatalogSnapshot(undefined);
  const reloaded = await store(dataDir, bundledPath).load();
  assert.equal(reloaded.snapshot?.fetchedAt, refreshed.snapshot?.fetchedAt);
  assert.equal(lookupModelCatalog("gpt-5.5", "openai")?.contextWindow, 1_050_000);
});

test("a failed refresh keeps the loaded catalog and says what went wrong", async () => {
  setModelCatalogSnapshot(undefined);
  const dataDir = await temporaryDataDir();
  const bundledPath = join(dataDir, "packaged", "models-dev.json");
  await writeSnapshot(bundledPath, "2026-08-20T00:00:00.000Z", 400_000);

  const catalog = store(dataDir, bundledPath, async () => {
    throw new ModelCatalogFetchError("The model catalog is unreachable: getaddrinfo ENOTFOUND models.dev");
  });
  await catalog.load();

  await assert.rejects(() => catalog.refresh(), (error: unknown) => {
    assert.ok(error instanceof ModelCatalogFetchError);
    assert.match(error.message, /unreachable/);
    return true;
  });
  // Nothing was replaced and nothing was written.
  assert.equal(catalog.details.snapshot?.fetchedAt, "2026-08-20T00:00:00.000Z");
  assert.equal(getModelCatalogSnapshot()?.origin, "bundled");
  assert.equal(lookupModelCatalog("gpt-5.5", "openai")?.contextWindow, 400_000);
  await assert.rejects(() => readFile(join(dataDir, "model-catalog", "models-dev.json"), "utf8"));
});

test("a download this product cannot use is rejected instead of emptying the catalog", async () => {
  setModelCatalogSnapshot(undefined);
  const dataDir = await temporaryDataDir();
  const bundledPath = join(dataDir, "packaged", "models-dev.json");
  await writeSnapshot(bundledPath, "2026-08-20T00:00:00.000Z", 400_000);

  // A document whose only provider is one we deliberately do not map.
  const catalog = store(dataDir, bundledPath, async () => ({
    "ollama-cloud": { id: "ollama-cloud", models: { "some-model": { id: "some-model", name: "Some Model" } } },
  }));
  await catalog.load();

  await assert.rejects(() => catalog.refresh(), ModelCatalogFetchError);
  assert.equal(catalog.details.snapshot?.fetchedAt, "2026-08-20T00:00:00.000Z");
  assert.equal(lookupModelCatalog("gpt-5.5", "openai")?.contextWindow, 400_000);
});
