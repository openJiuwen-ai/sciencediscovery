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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { RuntimeSettingsDetails, RuntimeSettingsOverrides } from "@sciencediscovery/schema";

import { replaceDefaultModelOverride } from "../src/default-model-override.js";

const stored: RuntimeSettingsOverrides = {
  enabledConnectorIds: [],
  semanticReviewEnabled: true,
  thinkingEffort: "high",
};

function details(overrides: RuntimeSettingsOverrides): RuntimeSettingsDetails {
  return { effective: { modelId: overrides.modelId }, overrides } as RuntimeSettingsDetails;
}

test("setting the default model keeps the overrides returned by the settings read", async () => {
  const writes: RuntimeSettingsOverrides[] = [];
  const updated = await replaceDefaultModelOverride({
    getGlobalSettings: async () => details(stored),
    replaceGlobalSettings: async (body) => {
      writes.push(body);
      return details(body);
    },
  }, "model-1");

  assert.deepEqual(writes, [{ ...stored, modelId: "model-1" }]);
  assert.equal(updated.overrides.modelId, "model-1");
  assert.equal(updated.overrides.semanticReviewEnabled, true);
});

test("clearing the default model removes only modelId", async () => {
  const writes: RuntimeSettingsOverrides[] = [];
  await replaceDefaultModelOverride({
    getGlobalSettings: async () => details({ ...stored, modelId: "model-1" }),
    replaceGlobalSettings: async (body) => {
      writes.push(body);
      return details(body);
    },
  }, undefined);

  assert.deepEqual(writes, [stored]);
  assert.equal("modelId" in writes[0]!, false);
});

test("a failed settings read does not replace the stored overrides", async () => {
  let written = false;
  await assert.rejects(
    replaceDefaultModelOverride({
      getGlobalSettings: async () => { throw new Error("settings 500"); },
      replaceGlobalSettings: async () => {
        written = true;
        return details({});
      },
    }, "model-1"),
    /settings 500/,
  );
  assert.equal(written, false);
});
