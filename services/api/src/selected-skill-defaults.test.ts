// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_SKILL_SELECTION_MODE } from "@sciencediscovery/schema";
import { SessionStore } from "./store.js";

test("explicit selected choices stay narrow across catalog growth and reload", async (context) => {
  const parent = resolve(process.cwd(), ".tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "selected-skills-"));
  const store = new SessionStore(root);
  let reloaded: SessionStore | undefined;
  context.after(async () => {
    reloaded?.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.load();
  store.setAvailableSkillIds(["code-engineer", "evolve-design"]);
  assert.equal(DEFAULT_SKILL_SELECTION_MODE, "all");
  const project = await store.createProject("Selected defaults");
  assert.equal(project.settingsOverrides.skillSelectionMode, "all");
  await store.replaceProjectSettings(project.id, { enabledSkillIds: [], skillSelectionMode: "selected" });
  const session = await store.createSession(project.id, "Selected", {}, {}, { allowUnconfiguredModel: true });
  assert.deepEqual(store.getSessionSettings(session.id).effective.enabledSkillIds, []);
  await store.replaceSessionSettings(session.id, { enabledSkillIds: ["code-engineer"], skillSelectionMode: "selected" });
  store.setAvailableSkillIds(["code-engineer", "evolve-design", "new-skill"]);
  assert.deepEqual(store.getSessionSettings(session.id).effective.enabledSkillIds, ["code-engineer"]);
  reloaded = new SessionStore(root);
  await reloaded.load();
  reloaded.setAvailableSkillIds(["code-engineer", "evolve-design", "new-skill"]);
  assert.deepEqual(reloaded.getSessionSettings(session.id).effective.enabledSkillIds, ["code-engineer"]);
  await reloaded.replaceSessionSettings(session.id, { skillSelectionMode: "all" });
  assert.deepEqual(reloaded.getSessionSettings(session.id).effective.enabledSkillIds, ["code-engineer", "evolve-design", "new-skill"]);
});
