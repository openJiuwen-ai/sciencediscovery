// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ConnectorConfigurationRequest } from "@sciencediscovery/schema";
import { ProcessRecord } from "../ProcessRecord.js";
import { useLocale } from "../i18n/index.js";

/** Read-only history for a resolved configuration request. */
export function ConversationalConnectorReceipt({ request, connectorName }: {
  request?: ConnectorConfigurationRequest;
  connectorName?: string;
}) {
  const { t } = useLocale();
  const name = request?.connectorName ?? connectorName;
  const stale = request?.state === "stale" || request?.state === "dismissed";
  const summaryKey = request?.state === "dismissed" ? "configuration.connector.dismissedSummary"
    : stale ? "configuration.connector.staleSummary" : "configuration.connector.appliedSummary";
  const label = name
    ? t(summaryKey, { name })
    : t("configuration.connector.resuming");
  return <ProcessRecord className="conversation-configuration-record" label={label}>
    <section aria-label={t("configuration.connector.title")} className="conversation-configuration-record-details">
      {stale ? <p>{t(request?.state === "dismissed" ? "configuration.connector.dismissedDetail" : "configuration.connector.staleDetail")}</p> : <>
        <div className="conversation-configuration-impact">
          <span>{t("configuration.connector.change")}</span>
          <strong>{name ? t("configuration.connector.enable", { name }) : t("configuration.connector.resuming")}</strong>
          <span>{t("configuration.connector.scope")}</span>
          <strong>{t("configuration.card.sessionScope")}</strong>
          {request ? <>
            <span>{t("configuration.card.continuation")}</span>
            <strong>{t(request.continuationRunId
              ? "configuration.connector.continuationRecorded" : "configuration.connector.nextRun")}</strong>
          </> : null}
        </div>
      </>}
    </section>
  </ProcessRecord>;
}
