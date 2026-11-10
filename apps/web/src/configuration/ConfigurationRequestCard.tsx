// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { ConfigurationRequestCard as SharedConfigurationRequestCard,
  type ConfigurationRequestCardProps as SharedConfigurationRequestCardProps } from "@sciencediscovery/configuration-ui";
import { ApiRequestError } from "../api/auth.js";
import { useLocale } from "../i18n/index.js";
import { ProcessRecord } from "../ProcessRecord.js";

export { isConfigurationRequestView } from "@sciencediscovery/configuration-ui";
export type { ConfigurationRequestActions } from "@sciencediscovery/configuration-ui";
export type ConfigurationRequestCardProps = Omit<SharedConfigurationRequestCardProps, "locale" | "ProcessRecord" | "ApiRequestError">;

export function ConfigurationRequestCard(props: ConfigurationRequestCardProps) {
  const { locale } = useLocale();
  return <SharedConfigurationRequestCard {...props} locale={locale} ProcessRecord={ProcessRecord} ApiRequestError={ApiRequestError} />;
}
