// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { manifest as skill } from "@sciencediscovery/skill/manifest";
import { manifest as mcp } from "@sciencediscovery/mcp/manifest";
import { manifest as scheduler } from "@sciencediscovery/scheduler/manifest";
import { manifest as plan } from "@sciencediscovery/plan/manifest";
import { builtinMcpSourceManifests } from "@sciencediscovery/mcp-sources/plugin";
import { manifest as json } from "@sciencediscovery/artifact-json/manifest";
import type { PluginManifest } from "@sciencediscovery/plugin-sdk";

/** Only installed trusted packages are advertised. No user-supplied entry imports. */
export const installedPlugins: readonly PluginManifest[] = [skill, mcp, scheduler, plan, ...builtinMcpSourceManifests, json];
// API installation capabilities, not evidence that a particular Run has activated them.
export const hostServices = ["skill.catalog", "mcp.tools", "subagent.dispatch", "plan.store", "mcp.sources", "artifact.read"]
  .map((id) => ({ id, version: 1 }));
export const hostPermissions = ["runtime.contribute", "connector.register", "artifact.read"];
