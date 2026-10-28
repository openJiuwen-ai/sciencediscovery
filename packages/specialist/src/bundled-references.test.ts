// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

async function findSkillRoots(root: URL): Promise<URL[]> {
  const roots: URL[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if ([".git", ".sciencediscovery-data", ".tmp", "node_modules"].includes(entry.name)) continue;
    if (entry.isDirectory()) {
      roots.push(...await findSkillRoots(new URL(`${entry.name}/`, root)));
    } else if (entry.name === "SKILL.md") {
      roots.push(root);
    }
  }
  return roots;
}

test("repository Skills ship every linked reference as a readable nonempty file", async () => {
  for (const root of await findSkillRoots(new URL("../../../", import.meta.url))) {
    const markdown = await readFile(new URL("SKILL.md", root), "utf8");
    for (const [, path] of markdown.matchAll(/\[[^\]]*\]\((references\/[^)#]+)(?:#[^)]*)?\)/gu)) {
      const reference = await readFile(new URL(path!, root), "utf8");
      assert.ok(reference.trim(), `${root.pathname}${path} must not be empty`);
    }
  }
});
