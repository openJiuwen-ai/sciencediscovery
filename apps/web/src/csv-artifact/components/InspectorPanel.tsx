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

import {
  Activity,
  FileCheck2,
  Fingerprint,
  MousePointer2,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";

import type { ArtifactVersionProvenance } from "@science-agent/schema";

import { formatBytes } from "../csv/inferCsv.js";
import type {
  ChartSpec,
  DataRow,
  DataTable,
} from "../types.js";

interface InspectorPanelProps {
  hoveredRowId?: string;
  provenance?: ArtifactVersionProvenance;
  selectedRowIds: string[];
  spec: ChartSpec;
  table: DataTable;
}

function rowFields(row: DataRow, table: DataTable): Array<[string, string]> {
  return table.columns.slice(0, 12).map((column) => [
    column.id,
    row[column.id] === null || row[column.id] === undefined ? "-" : String(row[column.id]),
  ]);
}

export function InspectorPanel({
  hoveredRowId,
  provenance,
  selectedRowIds,
  spec,
  table,
}: InspectorPanelProps) {
  const [tab, setTab] = useState<"lineage" | "selection">("selection");
  const focusedId = hoveredRowId ?? selectedRowIds[0];
  const focused = table.rows.find((row) => row.__rowId === focusedId);
  return <aside className="csva-inspector-panel" aria-label="Selection and provenance">
    <nav>
      <button className={tab === "selection" ? "active" : ""} onClick={() => setTab("selection")} type="button"><MousePointer2 size={14} /> Selection</button>
      <button className={tab === "lineage" ? "active" : ""} onClick={() => setTab("lineage")} type="button"><Fingerprint size={14} /> Provenance</button>
    </nav>
    {tab === "selection" ? <div className="csva-inspector-content">
      <div className="csva-selection-count"><strong>{selectedRowIds.length.toLocaleString()}</strong><span>selected records</span></div>
      {focused ? <>
        <div className="csva-focus-heading"><span>Current record</span><strong>{focused.__rowId}</strong>{hoveredRowId ? <i>Hovered</i> : null}</div>
        <dl className="csva-record-fields">
          {rowFields(focused, table).map(([field, value]) => <div key={field}><dt>{field}</dt><dd title={value}>{value}</dd></div>)}
        </dl>
      </> : <div className="csva-inspector-empty"><MousePointer2 size={22} /><strong>Select a record</strong><p>Click or lasso-select chart points, or select a row in the data table.</p></div>}
      {selectedRowIds.length > 1 ? <details className="csva-selected-id-list"><summary>Selected IDs</summary><ol>{selectedRowIds.slice(0, 50).map((id) => <li key={id}>{id}</li>)}</ol></details> : null}
    </div> : <div className="csva-inspector-content csva-lineage">
      <section>
        <h3><FileCheck2 size={15} /> Source Artifact</h3>
        <dl>
          <div><dt>File</dt><dd>{table.source.fileName}</dd></div>
          <div><dt>Size</dt><dd>{formatBytes(table.source.fileSize)}</dd></div>
          <div><dt>Version</dt><dd title={table.source.sourceArtifactVersionId}>{table.source.sourceArtifactVersionId}</dd></div>
          <div><dt>SHA-256</dt><dd title={table.source.fileHash}>{table.source.fileHash.slice(0, 16)}...</dd></div>
          <div><dt>Imported</dt><dd>{new Date(table.source.importedAt).toLocaleString("en-US")}</dd></div>
        </dl>
      </section>
      <section>
        <h3><Activity size={15} /> Current view</h3>
        <dl>
          <div><dt>ChartSpec</dt><dd>schema v{spec.schemaVersion}</dd></div>
          <div><dt>Preset</dt><dd>{spec.preset}</dd></div>
          <div><dt>Display filters</dt><dd>{spec.displayFilters.length}</dd></div>
          <div><dt>Visualization</dt><dd>Browser-derived view</dd></div>
        </dl>
      </section>
      <section className="csva-provenance-record">
        <h3><Activity size={15} /> Recorded provenance</h3>
        {provenance ? <dl>
          <div><dt>Input dependencies</dt><dd>{provenance.dependencies.length}</dd></div>
          <div><dt>Execution records</dt><dd>{provenance.executionLog.length}</dd></div>
          <div><dt>Environment revisions</dt><dd>{provenance.environments.length}</dd></div>
          <div><dt>Review records</dt><dd>{provenance.review.length}</dd></div>
        </dl> : <small>Loading provenance for this Artifact version.</small>}
      </section>
      {table.warnings.length ? <section className="csva-warning-list"><h3><TriangleAlert size={15} /> Import warnings</h3>{table.warnings.map((warning) => <p key={warning}>{warning}</p>)}</section> : null}
    </div>}
  </aside>;
}
