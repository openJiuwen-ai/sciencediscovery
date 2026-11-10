/**
 * The fields this directed run may change, read from the seed.
 *
 * The ticks were chosen before the run started. They stay visible so a long
 * value can be opened, and so a fixed field is not mistaken for one the search
 * is allowed to edit.
 */

import { useEffect, useState } from "react";

import type { ApiClient } from "../api.js";
import { useLocale } from "../i18n/LocaleProvider.js";

import { fieldRows, previewValue } from "./field-rows.js";

export function FieldDirection({
  client,
  codeHash,
  editable,
  runId,
}: {
  client: ApiClient;
  codeHash?: string;
  editable: readonly string[];
  runId: string;
}) {
  const { t } = useLocale();
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    client: ApiClient; runId: string; codeHash: string; retry: number;
    status: "ready" | "error";
    rows: Array<{ field: string; value: string }>;
  }>();

  useEffect(() => {
    setResult(undefined);
    if (!codeHash) return undefined;
    let cancelled = false;
    const scope = { client, runId, codeHash, retry };
    void client.getEvolveCandidate(runId, codeHash).then((loaded) => {
      if (!cancelled) setResult({ ...scope, status: "ready", rows: fieldRows(loaded.source) });
    }).catch(() => {
      if (!cancelled) setResult({ ...scope, status: "error", rows: [] });
    });
    return () => { cancelled = true; };
  }, [client, codeHash, runId, retry]);

  // Do not show the previous source even during the render before effect cleanup.
  const current = result?.client === client && result.runId === runId
    && result.codeHash === codeHash && result.retry === retry ? result : undefined;
  if (!codeHash) return null;
  if (!current || current.status === "error") return <section className="evolve-fields">
    <h3 className="evolve-block-title">{t("evolve.fields.title")}</h3>
    {current?.status === "error"
      ? <>
        <p role="alert">{t("evolve.fields.loadError")}</p>
        <button type="button" onClick={() => setRetry((value) => value + 1)}>{t("evolve.fields.retry")}</button>
      </>
      : <p role="status">{t("evolve.fields.loading")}</p>}
  </section>;
  const rows = current.rows;
  if (!rows.length) return null;
  const allowed = new Set(editable);

  return <section className="evolve-fields">
    <h3 className="evolve-block-title">{t("evolve.fields.title")}</h3>
    <div className="evolve-fields-scroll">
      <table>
        <thead>
          <tr>
            <th>{t("evolve.fields.field")}</th>
            <th>{t("evolve.fields.value")}</th>
            <th>{t("evolve.fields.editable")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const shown = previewValue(row.value);
            return <tr key={row.field}>
              <td><code>{row.field}</code></td>
              <td>
                {shown.short === shown.full
                  ? shown.full
                  : <details>
                    <summary>{shown.short}</summary>
                    <code>{shown.full}</code>
                  </details>}
              </td>
              <td>
                <label className="evolve-fields-tick">
                  <input checked={allowed.has(row.field)} disabled readOnly type="checkbox" />
                  <span>{allowed.has(row.field) ? t("evolve.fields.yes") : t("evolve.fields.no")}</span>
                </label>
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  </section>;
}
