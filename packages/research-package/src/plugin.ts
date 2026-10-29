// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { PluginDefinition } from "@sciencediscovery/plugin-sdk";
import { manifest } from "./manifest.js";
import { createResearchPackageProvider, type ResearchPackageProvider } from "./index.js";

export { manifest } from "./manifest.js";

export interface ResearchPackageContribution {
  readonly provider: ResearchPackageProvider;
}

/** Trusted build-time plugin. Package bytes remain data and are never executed. */
export const researchPackagePlugin: PluginDefinition<ResearchPackageContribution> = {
  manifest,
  create: () => ({ contribution: { provider: createResearchPackageProvider() } }),
};
