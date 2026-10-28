// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BUNDLED_SKILL_IDS } from "./skills.js";

test("bundled Skills ship every linked reference as a readable nonempty file", async () => {
  for (const id of BUNDLED_SKILL_IDS) {
    const root = new URL(`../../../skills/${id}/`, import.meta.url);
    const markdown = await readFile(new URL("SKILL.md", root), "utf8");
    for (const [, path] of markdown.matchAll(/\[[^\]]*\]\((references\/[^)#]+)(?:#[^)]*)?\)/gu)) {
      const reference = await readFile(new URL(path!, root), "utf8");
      assert.ok(reference.trim(), `${id}/${path} must not be empty`);
    }
  }
});
