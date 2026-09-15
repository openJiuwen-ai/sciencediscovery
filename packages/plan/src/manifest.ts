// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { PluginManifest } from "@sciencediscovery/plugin-sdk";
export const manifest: PluginManifest = {
  id: "plan", version: "0.1.0", apiVersion: 1,
  entries: { runtime: "./plugin", web: "./web" },
  capabilities: ["tools","context","state","project.panel"], contributes: ["tools","context","state","project.panel"],
  services: { requires: [{ id: "plan.store", version: 1 }] },
  permissions: ["runtime.contribute"],
  configuration: { schemaVersion: 1, scopes: ["global", "project", "session"], applies: "nextRun",
    fields: {},
    defaults: {} },
};
