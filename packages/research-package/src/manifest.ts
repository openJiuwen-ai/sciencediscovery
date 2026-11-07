// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { PluginManifest } from "@sciencediscovery/plugin-sdk";

export const manifest: PluginManifest = {
  id: "research-package",
  version: "0.1.0",
  apiVersion: 1,
  capabilities: ["research-package.export", "research-package.import", "research-package.inspect"],
  contributes: ["research-package.provider"],
  permissions: ["artifact.read"],
  configuration: {
    schemaVersion: 1,
    scopes: ["global", "project", "session"],
    applies: "nextRun",
    fields: {},
    defaults: {},
  },
};
