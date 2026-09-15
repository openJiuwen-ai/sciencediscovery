// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";
import { createPluginScope } from "@sciencediscovery/plugin-sdk";
import { uniprotPlugin } from "./uniprot-plugin.js";
test("UniProt contributes the governed source and can be independently disabled", async () => {
  const scope = await createPluginScope([uniprotPlugin]);
  const source = scope.contributions[0]!.sources[0]!;
  assert.equal(source.manifest.id, "uniprot");
  assert.ok(source.manifest.tools.lookup!.permission);
  assert.equal(source.validateInput("lookup", { accession: "../bad" }).valid, false);
  await scope.dispose();
  assert.deepEqual((await createPluginScope([uniprotPlugin], ["connector.uniprot"])).contributions, []);
});
