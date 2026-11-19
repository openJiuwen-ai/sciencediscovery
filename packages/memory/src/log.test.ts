// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { mgLog } from "./log.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

test("memory graph logger respects the live toggle and formats structured arguments", async (context) => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "sciencediscovery-memory-log-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let enabled = false;
  mgLog.setDataDir(dataDir);
  mgLog.setToggle(() => enabled);
  mgLog.info("hidden %s", "value");
  const path = resolve(dataDir, "logs", "memory-graph.log");
  assert.equal((await readFile(path, "utf8")).length, 0);
  enabled = true;
  mgLog.info("visible %s %d %j", "value", "2", { ok: true });
  const line = await readFile(path, "utf8");
  assert.match(line, /event=memory_graph/);
  assert.match(line, /message=/);
  assert.match(line, /message="\[OMITTED\]"/);
  assert.doesNotMatch(line, /value|visible/);
});
