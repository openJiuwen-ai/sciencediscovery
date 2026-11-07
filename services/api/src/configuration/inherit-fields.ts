// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { RuntimeSettingsOverrides } from "@sciencediscovery/schema";
/** Security, plugin JSON, credentials and execution resources have separate controls. */
export const INHERITABLE_CONFIGURATION_FIELDS = ["modelId", "reviewModelId", "semanticReviewEnabled", "thinkingMode", "thinkingEffort", "enabledConnectorIds", "skillSelectionMode", "enabledSkillIds", "enabledSkillLibraries"] as const satisfies readonly (keyof RuntimeSettingsOverrides)[];
