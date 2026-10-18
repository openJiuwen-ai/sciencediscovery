// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { SettingsApiClient } from "../src/api/settings.js";
test('shipped Settings client sends consent and explicit compatibility mode with normal authentication', async () => {
  const previous = globalThis.fetch, seen: any[] = [];
  globalThis.fetch = async (path, options) => { seen.push([path, options]); return Response.json({ ok: true }); };
  try {
    const client = new SettingsApiClient('synthetic-key'); await client.testModel('a/b'); await client.testModel('a/b', true);
    assert.deepEqual(seen.map(([path, options]) => [path, JSON.parse(options.body), options.headers.authorization]), [['/api/models/a%2Fb/test', { consent: true, compatibility: false }, 'Bearer synthetic-key'], ['/api/models/a%2Fb/test', { consent: true, compatibility: true }, 'Bearer synthetic-key']]);
  } finally { globalThis.fetch = previous; }
});
