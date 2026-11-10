// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

export { ConfigurationRequestCard, isConfigurationRequestView } from "./ConfigurationRequestCard.js";
export type { ConfigurationRequestActions, ConfigurationRequestCardProps, ConfigurationProcessRecordProps,
  ConfigurationApiRequestError, ConfigurationApiRequestErrorConstructor } from "./ConfigurationRequestCard.js";
export { configurationMessages } from "./messages.js";
export { genericConfigurationPresentation, mergeConfigurationRequests, shouldPollConfigurationRequest } from "./presentation.js";
export { configurationSecurityConsent, configurationNeedsSecurityConsent } from "./compatibility.js";
export type { ConfigurationSecurityConsent, SecurityConsentCapability } from "./compatibility.js";
export { configurationCompactToggleCopy } from "./compact-toggle-copy.js";
export { configurationImpactText } from "./impact-messages.js";
