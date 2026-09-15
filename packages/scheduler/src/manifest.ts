// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { PluginManifest } from "@sciencediscovery/plugin-sdk";
export const manifest: PluginManifest = {
  id: "scheduler", version: "0.1.0", apiVersion: 1,
  entries: {"runtime":"./plugin","web":"./manifest"},
  capabilities: ["tools","settings"], contributes: ["tools","settings"],
  services: { requires: [{ id: "subagent.dispatch", version: 1 }] },
  permissions: ["runtime.contribute"],
  configuration: { schemaVersion: 1, scopes: ["global", "project", "session"], applies: "nextRun",
    fields: { policy: { type: "string", enum: ["default"] } },
    defaults: { policy: "default" } },
};
