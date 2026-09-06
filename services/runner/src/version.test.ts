// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { readRunnerVersion, RUNNER_VERSION } from "./version.js";

test("build identity survives deployment without Git and malformed metadata is unknown", async () => {
  const parent = resolve(".tmp/version-test");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "run-"));
  const file = join(directory, "build-info.json");
  try {
    assert.equal(readRunnerVersion(pathToFileURL(file)), "unknown");
    await writeFile(file, JSON.stringify({ version: "1234abcd" }));
    assert.equal(readRunnerVersion(pathToFileURL(file)), "1234abcd");
    await writeFile(file, JSON.stringify({ version: "1234abcd-dirty" }));
    assert.equal(readRunnerVersion(pathToFileURL(file)), "1234abcd-dirty");
    await writeFile(file, JSON.stringify({ version: "m4-isolation-only-v1" }));
    assert.equal(readRunnerVersion(pathToFileURL(file)), "unknown");
    await writeFile(file, "invalid json");
    assert.equal(readRunnerVersion(pathToFileURL(file)), "unknown");
    assert.equal(RUNNER_VERSION, readRunnerVersion(new URL("./build-info.json", import.meta.url)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
