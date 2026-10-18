// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import type { EvolveApiClient, EvolveStatus } from "../api/evolve.js";
import { useLocale } from "../i18n/LocaleProvider.js";

export function useEvolveStatus(client: EvolveApiClient) {
  const [status, setStatus] = useState<EvolveStatus>({ state: "not_initialized", canInitialize: false });
  useEffect(() => {
    let live = true;
    const refresh = () => { void client.getEvolveStatus().then((next) => { if (live) setStatus(next); })
      .catch(() => { if (live) setStatus({ state: "error", canInitialize: false }); }); };
    refresh();
    const timer = setInterval(refresh, 5_000);
    return () => { live = false; clearInterval(timer); };
  }, [client]);
  return { status, setStatus };
}

export function EvolveSetup({ client, status, onStatus }: {
  client: EvolveApiClient; status: EvolveStatus; onStatus: (value: EvolveStatus) => void;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const installing = busy || status.state === "installing";
  const key = installing ? "evolve.setup.installing" : status.state === "ready" ? "evolve.setup.ready"
    : status.state === "error" ? "evolve.setup.error" : "evolve.setup.missing";
  return <section aria-label={t("evolve.setup.title")} className="workspace-fold-body evolve-setup">
    <strong>{t("evolve.setup.title")}</strong>
    <p role="status" aria-live="polite">{t(key)}</p>
    {status.state !== "ready" ? <>
      <p className="muted">{t(status.canInitialize ? "evolve.setup.download" : "evolve.setup.operator")}</p>
      <button className="secondary-button compact-button" type="button" disabled={installing || !status.canInitialize} onClick={() => {
        setBusy(true);
        void client.initEvolve().then(onStatus).catch(() => onStatus({ state: "error", canInitialize: true }))
          .finally(() => setBusy(false));
      }}>{t(installing ? "evolve.setup.installing" : "evolve.setup.init")}</button>
    </> : null}
  </section>;
}
