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

// The packaging snapshot, exercised offline: the writer runs from a local
// document, and both packaging paths are checked to still request one. A
// release that quietly stopped carrying the catalog would leave a first,
// network-less start with no model metadata at all.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { assertCatalogPayload, catalogUrl, fetchModelCatalogSnapshot } from "../fetch-model-catalog.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const testRoot = join(repositoryRoot, ".tmp", "model-catalog-snapshot-tests");

const DOCUMENT = {
  openai: {
    doc: "https://developers.openai.com/api/docs/api-reference/introduction",
    id: "openai",
    models: {
      "gpt-5.5": {
        cost: { input: 1.25, output: 10 },
        id: "gpt-5.5",
        limit: { context: 1_050_000, output: 128_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        name: "GPT-5.5",
        reasoning: true,
      },
    },
  },
};

async function workspace(name) {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, `${name}-`));
  const source = join(directory, "api.json");
  await writeFile(source, JSON.stringify(DOCUMENT), "utf8");
  return { directory, source };
}

test("the catalog endpoint comes from the shared external URL registry", async () => {
  const url = await catalogUrl();
  assert.equal(url, "https://models.dev/api.json");
});

test("packaging writes the envelope the control API loads", async () => {
  const { directory, source } = await workspace("writes-envelope");
  try {
    const output = join(directory, "resources", "model-catalog", "models-dev.json");
    const result = await fetchModelCatalogSnapshot({
      fetchedAt: "2026-08-26T09:00:00.000Z",
      output,
      source,
    });
    assert.equal(result.models, 1);
    assert.equal(result.providers, 1);

    const envelope = JSON.parse(await readFile(output, "utf8"));
    assert.equal(envelope.fetchedAt, "2026-08-26T09:00:00.000Z");
    assert.equal(envelope.sourceUrl, "https://models.dev/api.json");
    // Stored verbatim, so changing how the product maps the document does not
    // require another download.
    assert.deepEqual(envelope.payload, DOCUMENT);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("a document that is not the catalog is rejected before it can ship", () => {
  assert.throws(() => assertCatalogPayload([]), /not a provider map/);
  assert.throws(() => assertCatalogPayload("<html>error</html>"), /not a provider map/);
  assert.throws(() => assertCatalogPayload({ openai: { id: "openai" } }), /contains no models/);
});

test("both packaging paths still download the snapshot and assert it is present", async () => {
  const payloadScript = await readFile(join(repositoryRoot, "scripts/binary-release/build-payload.sh"), "utf8");
  assert.match(payloadScript, /scripts\/fetch-model-catalog\.mjs/);
  assert.match(payloadScript, /app\/resources\/model-catalog\/models-dev\.json/);
  // The release fails rather than shipping a payload without a catalog.
  assert.match(payloadScript, /The model catalog snapshot is missing from the payload/);

  const dockerfile = await readFile(join(repositoryRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /scripts\/fetch-model-catalog\.mjs/);
  assert.match(dockerfile, /test -s \/opt\/sciencediscovery\/resources\/model-catalog\/models-dev\.json/);
  // The baked copy is only reachable if the runtime stage both copies it and
  // points the API at it.
  assert.match(dockerfile, /COPY --from=model-catalog \/opt\/sciencediscovery\/resources \/opt\/sciencediscovery\/resources/);
  assert.match(dockerfile, /SCIENCE_AGENT_MODEL_CATALOG_PATH=\/opt\/sciencediscovery\/resources\/model-catalog\/models-dev\.json/);
});

test("the downloaded document is never committed", async () => {
  const ignored = await readFile(join(repositoryRoot, ".gitignore"), "utf8");
  assert.match(ignored, /^\/resources\/$/mu);
});
