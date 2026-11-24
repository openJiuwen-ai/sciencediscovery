// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { getModelUsage } from "../../api/usage.js";
import { useLoaded } from "../../app/use-loaded.js";
import { knownTokenValue, modelUsageRows, usageFilters, usageIncomplete, type TokenField, type UsageRange } from "../../app/usage-format.js";
import { getLanguage, TEXT } from "../../text.js";
import { Group, LoadGate, Pills, SkeletonBlock, SkeletonRegion } from "./rows.js";

export function ModelUsageSettings({ client }: { client: ApiClient }) {
  const [range, setRange] = useState<UsageRange>("week");
  // Unmount the old range so a late response cannot replace a newer selection.
  return <UsagePeriod key={range} client={client} range={range} onRangeChange={setRange} />;
}

function UsagePeriod({ client, range, onRangeChange }: {
  client: ApiClient; range: UsageRange; onRangeChange: (range: UsageRange) => void;
}) {
  const loaded = useLoaded(async () => ({ client, summary: await getModelUsage(client, usageFilters(range)) }),
    { client, key: `model-usage:${range}` });
  const text = TEXT.settings.system.usage;
  const ranges: { value: UsageRange; label: string }[] = [
    { value: "today", label: text.today }, { value: "week", label: text.week },
    { value: "month", label: text.month }, { value: "all", label: text.all },
  ];
  return <div className="model-usage-settings">
    <Group><div className="usage-settings-toolbar">
      <Pills label={text.range} value={range} options={ranges} onChange={value => {
        const next = ranges.find(item => item.value === value);
        if (next) onRangeChange(next.value);
      }} />
      <button className="secondary-button" type="button" disabled={loaded.loading} onClick={loaded.reload}>
        {loaded.loading ? text.refreshing : text.refresh}
      </button>
    </div></Group>
    <LoadGate loaded={loaded} skeleton={<SkeletonRegion label={text.skeleton}>
      <Group>
        <div className="usage-settings-metrics">
          {[0, 1, 2].map(index => <div className="usage-settings-metric" key={index}>
            <SkeletonBlock className="is-usage-metric-label" />
            <SkeletonBlock className="is-usage-metric-value" />
          </div>)}
        </div>
      </Group>
      <Group heading={text.byModel}>
        <div className="usage-settings-table-scroll">
          <div className="settings-skeleton-table">
            {[0, 1, 2, 3].map(index => <div className="settings-skeleton-row" key={index}>
              <SkeletonBlock className="is-name" />
              <SkeletonBlock />
              <SkeletonBlock />
              <SkeletonBlock />
            </div>)}
          </div>
        </div>
      </Group>
    </SkeletonRegion>}>{result => {
      if (result.client !== client) return <Group><p className="settings-empty">{TEXT.settings.loading}</p></Group>;
      const summary = result.summary;
      const rows = modelUsageRows(summary.dailyByModel);
      const format = new Intl.NumberFormat(getLanguage());
      const compact = new Intl.NumberFormat(getLanguage(), { notation: "compact", maximumFractionDigits: 1 });
      const fields: { field: TokenField; title: string; column: string }[] = [
        { field: "totalTokens", title: text.total, column: text.totalColumn },
        { field: "inputTokens", title: text.input, column: text.inputColumn },
        { field: "outputTokens", title: text.output, column: text.outputColumn },
      ];
      const columns = [fields[1], fields[2], fields[0]].filter(field => field !== undefined);
      const updated = new Date(summary.generatedAt);
      return <>
        <Group>
          <dl className="usage-settings-metrics">
            {fields.map(({ field, title }) => {
              const value = knownTokenValue(summary.overview[field], field, summary.overview.reporting, rows.length > 0);
              return <div className="usage-settings-metric" key={field}>
                <dt>{title}</dt><dd title={value === null ? text.unreported : format.format(value)}>{value === null ? "—" : compact.format(value)}</dd>
              </div>;
            })}
          </dl>
          {usageIncomplete(summary.overview.reporting, rows.length > 0) ? <p className="settings-note" role="status">{text.incomplete}</p> : null}
        </Group>
        <Group heading={text.byModel}>
          {!rows.length ? <p className="settings-empty">{text.empty}</p> : <div className="usage-settings-table-scroll">
            <table className="usage-settings-table" aria-label={text.byModel}>
              <thead><tr><th scope="col">{text.model}</th>{columns.map(({ field, column }) => <th scope="col" key={field}>{column}</th>)}</tr></thead>
              <tbody>{rows.map(row => <tr key={row.id}>
                <th scope="row"><strong>{row.name}</strong><small>{row.model}</small></th>
                {columns.map(({ field }) => {
                  const value = knownTokenValue(row[field], field, row.reporting, true);
                  return <td key={field} title={value === null ? text.unreported : undefined}>{value === null ? "—" : format.format(value)}</td>;
                })}
              </tr>)}</tbody>
            </table>
          </div>}
        </Group>
        {Number.isFinite(updated.getTime()) ? <p className="settings-detail-meta">{text.updated} · {new Intl.DateTimeFormat(getLanguage(), {
          dateStyle: "short", timeStyle: "short", timeZone: summary.filters.timeZone,
        }).format(updated)}</p> : null}
      </>;
    }}</LoadGate>
  </div>;
}
