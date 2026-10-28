// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import type { ApiClient } from "./api.js";
import { isAuthFailure } from "./api/auth.js";
import { useLocale } from "./i18n/index.js";

type Client = Pick<ApiClient, "getRunnerExecutionCapability">;
type Probe = Awaited<ReturnType<Client["getRunnerExecutionCapability"]>>;
type Snapshot = { client: Client; value?: Probe; error?: string; unauthorized?: boolean };

/** API reachability and the local Runner's sandbox are independent signals. */
export function useComputeReadiness(client: Client) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [revision, setRevision] = useState(0);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setSnapshot(previous => previous?.client === client ? previous : undefined);
    setChecking(true);
    const read = async (refresh: boolean) => {
      try {
        const value = await client.getRunnerExecutionCapability("local", refresh);
        if (active) setSnapshot({ client, value });
      } catch (reason) {
        // A failed read invalidates a previous ready result, including after
        // credentials change. Unrelated application errors never drive this.
        if (active) setSnapshot({ client, error: reason instanceof Error ? reason.message : String(reason), unauthorized: isAuthFailure(reason) });
      } finally {
        if (active) {
          setChecking(false);
          timer = setTimeout(() => void read(false), 15_000);
        }
      }
    };
    void read(revision > 0);
    return () => { active = false; clearTimeout(timer); };
  }, [client, revision]);

  const current = snapshot?.client === client ? snapshot : undefined;
  const value = current?.value;
  const connection = !current ? "checking" : current.unauthorized ? "unauthorized" : current.error !== undefined ? "unavailable" : "connected";
  // Older Runners may omit the capability: absence is unknown, never ready.
  const compute = !value ? "unknown" : !value.connected ? "unavailable" : value.capability?.ready === true ? "ready" : value.capability?.ready === false ? "unavailable" : "unknown";
  return { connection, compute, value, error: current?.error, checking: checking || !current, recheck: () => setRevision(value => value + 1) } as const;
}

type Readiness = ReturnType<typeof useComputeReadiness>;

export function ComputeStatus({ readiness, error }: { readiness: Readiness; error?: string }) {
  const { t } = useLocale();
  return <div className="compute-status" role="status" aria-label={t("compute.statusLabel")}>
    <span className={`api-connection ${readiness.connection === "connected" ? "" : readiness.connection === "checking" ? "pending" : "bad"}`}>
      <i aria-hidden="true" />{t(`compute.api.${readiness.connection}`)}
    </span>
    <span className={`compute ${readiness.compute === "ready" ? "" : readiness.compute === "unknown" ? "pending" : "bad"}`} title={t("compute.scope")}>
      <i aria-hidden="true" />{t(`compute.local.${readiness.compute}`)}
    </span>
    {error ? <span className="connection bad" title={t("app.connectionErrorTooltip", { error })}>
      <i aria-hidden="true" />{t("app.connectionErrorChip")}
    </span> : null}
  </div>;
}

// Direct host execution needs a reachable Runner, so only the notice for a
// reachable Runner with an unusable sandbox mentions that approval path.
const NOTICE_COPY = {
  unknown: { title: "compute.unknownTitle", hint: "compute.unknownHint" },
  runner: { title: "compute.runnerUnavailableTitle", hint: "compute.runnerRepairHint" },
  sandbox: { title: "compute.unavailableTitle", hint: "compute.repairHint" },
} as const;

export function ComputeNotice({ readiness }: { readiness: Readiness }) {
  const { t } = useLocale();
  // Connection settings own token recovery. A rejected credential cannot
  // confirm sandbox readiness and must not add a second authentication notice.
  if (readiness.compute === "ready" || readiness.connection === "checking" || readiness.connection === "unauthorized") return null;
  const capability = readiness.value?.capability;
  const reason = readiness.error || readiness.value?.reason || capability?.detail || (capability ? t(`compute.reason.${capability.reason}`) : t("compute.reason.unknown"));
  const copy = NOTICE_COPY[readiness.compute === "unknown" ? "unknown" : readiness.value?.connected === false ? "runner" : "sandbox"];
  return <section className="compute-notice" role="status" aria-label={t("compute.noticeLabel")}>
    <div>
      <strong>{t(copy.title)}</strong>
      <p className="compute-notice-reason">{reason}</p>
      <p>{t(copy.hint)}</p>
      <small>{t("compute.scope")}</small>
    </div>
    <button className="secondary-button" type="button" disabled={readiness.checking} onClick={readiness.recheck}>
      {t(readiness.checking ? "compute.checking" : "compute.recheck")}
    </button>
  </section>;
}
