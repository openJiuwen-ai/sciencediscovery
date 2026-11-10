// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { ConfigurationRequestCard as SharedConfigurationRequestCard,
  type ConfigurationRequestCardProps as SharedConfigurationRequestCardProps } from "@sciencediscovery/configuration-ui";
import { ApiRequestError } from "../api/auth.js";
import { useLocale } from "../i18n/index.js";
import { providerCardPresentation } from "./provider-card-presentation.js";
import { configurationMessages } from "./messages.js";
import { ProcessRecord } from "../ProcessRecord.js";

export { isConfigurationRequestView } from "@sciencediscovery/configuration-ui";
export type { ConfigurationRequestActions } from "@sciencediscovery/configuration-ui";
export type ConfigurationRequestCardProps = Omit<SharedConfigurationRequestCardProps, "locale" | "ProcessRecord" | "ApiRequestError"> & { onOpenModelSettings?: () => void };

export function ConfigurationRequestCard(props: ConfigurationRequestCardProps) {
  const { locale } = useLocale();
  const presentation = providerCardPresentation(props.request);
  const settingsHandoff = presentation ? { kind: presentation.kind, onOpenSettings: props.onOpenModelSettings, copy: configurationMessages(locale).providerCompact } : undefined;
  return <SharedConfigurationRequestCard {...props} settingsHandoff={settingsHandoff} locale={locale} ProcessRecord={ProcessRecord} ApiRequestError={ApiRequestError} />;
}
