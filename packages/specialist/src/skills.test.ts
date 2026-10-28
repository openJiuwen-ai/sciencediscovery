// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { SkillCatalogError, validateSkillPackage } from "./skills.js";

function packageWithDescription(frontmatter: string): Map<string, Buffer> {
  return new Map([["SKILL.md", Buffer.from(`---\nname: description-check\n${frontmatter}\n---\n\nFollow the instructions.\n`)]]);
}

test("skill packages reject missing, blank and non-string descriptions", () => {
  for (const frontmatter of ["", 'description: ""', 'description: "   "', 'description: "\\t\\n"', "description: null", "description: 123", "description: false", "description: []", "description: {}"]) {
    assert.throws(() => validateSkillPackage(packageWithDescription(frontmatter)), (error: unknown) => {
      assert.ok(error instanceof SkillCatalogError);
      assert.match(error.message, /description/);
      return true;
    }, frontmatter);
  }
});

test("skill packages preserve a nonblank description and the original package bytes", () => {
  const files = packageWithDescription('description: "  A useful description.  "');
  const loaded = validateSkillPackage(files);
  assert.equal(loaded.detail.description, "  A useful description.  ");
  assert.deepEqual(loaded.files.get("SKILL.md"), files.get("SKILL.md"));
});
