// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { createReviewAgentOptions } from "./review-agent.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

const base = {
  executeSubagent: async () => ({ finalMessages: [] }),
  modelIdentity: "model-1",
  runIdleTimeoutMs: 1000,
  workspace: {},
};

test("review agent fails closed when semantic review skills are missing", () => {
  assert.throws(() => createReviewAgentOptions({ ...base, skills: [] } as never), /semantic skills are unavailable/);
});

test("review agent publishes the selected skill hashes in its semantic options", () => {
  const options = createReviewAgentOptions({
    ...base,
    skills: [{ id: "citation-reviewer", hash: "citation-v1" }, { id: "computation-reviewer", hash: "computation-v1" }],
  } as never);
  assert.equal(options.citationSkillHash, "citation-v1");
  assert.equal(options.computationSkillHash, "computation-v1");
  assert.equal(options.modelIdentity, "model-1");
});
