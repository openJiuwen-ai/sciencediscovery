// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { PluginManifest } from "@sciencediscovery/plugin-sdk";
export const manifest: PluginManifest = {
  id: "skill", version: "0.1.0", apiVersion: 1,
  settingsFields: ["enabledSkillIds", "enabledSkillLibraries", "skillSelectionMode"],
  entries: { runtime: "./plugin", web: "./web" },
  capabilities: ["tools","context","settings"], contributes: ["tools","context","settings"],
  services: { requires: [{ id: "skill.catalog", version: 1 }] },
  permissions: ["runtime.contribute"],
  configuration: { schemaVersion: 1, scopes: ["global", "project", "session"], applies: "nextRun",
    fields: {},
    defaults: {} },
};
