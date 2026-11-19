// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { manifest } from "./manifest.js";
import { normalizeSkillLibraryMounts } from "./web.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

test("skill manifest exposes runtime, web and scoped settings capabilities", () => {
  assert.equal(manifest.id, "skill");
  assert.equal(manifest.entries!.runtime, "./plugin");
  assert.equal(manifest.entries!.web, "./web");
  assert.deepEqual(manifest.configuration?.scopes, ["global", "project", "session"]);
  assert.ok(manifest.settingsFields!.includes("enabledSkillLibraries"));
});

test("skill library mounts are clamped and ordered by the catalog", () => {
  const mounts = normalizeSkillLibraryMounts([
    { libraryId: "unknown", limit: 1000, priority: -2_000_000, versionId: " " },
    { libraryId: "known", limit: 0, priority: 2_000_000, versionId: " v1 " },
  ] as never, [{ id: "known" }] as never);
  assert.deepEqual(mounts, [
    { libraryId: "known", limit: 1, priority: 1_000_000, versionId: "v1" },
    { libraryId: "unknown", limit: 100, priority: -1_000_000, versionId: "head" },
  ]);
});
