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
  const [rows, setRows] = useState<Array<{ field: string; value: string }>>([]);

  useEffect(() => {
    if (!codeHash) return undefined;
    let cancelled = false;
    void client.getEvolveCandidate(runId, codeHash).then((loaded) => {
      if (!cancelled) setRows(fieldRows(loaded.source));
    }).catch(() => {
      if (!cancelled) setRows([]);
    });
    return () => { cancelled = true; };
  }, [client, codeHash, runId]);

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
