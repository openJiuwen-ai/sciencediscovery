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

import { ArrowDownAZ, ArrowUpAZ, Download, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { resolveSelectedRowIds } from "../charts/selection.js";
import type { DataRow, DataTable, DataValue } from "../types.js";

const ROW_HEIGHT = 36;
const MAX_RENDERED_VIEWPORT_HEIGHT = 900;
const OVERSCAN = 8;

function display(value: DataValue): string {
  if (value === null) return "-";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : value.toPrecision(5);
  return String(value);
}

interface VirtualDataTableProps {
  onExport: (rows: DataRow[]) => void;
  onSelectRows: (ids: string[]) => void;
  rows: DataRow[];
  selectedRowIds: string[];
  table: DataTable;
}

export function VirtualDataTable({
  onExport,
  onSelectRows,
  rows,
  selectedRowIds,
  table,
}: VirtualDataTableProps) {
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [sort, setSort] = useState<{ direction: "asc" | "desc"; field: string }>({
    direction: "asc",
    field: table.columns[0]?.id ?? "__rowId",
  });
  const columns = table.columns;
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = needle
      ? rows.filter((row) => columns.some((column) =>
          String(row[column.id] ?? "").toLocaleLowerCase().includes(needle)))
      : rows;
    return [...filtered].sort((left, right) => {
      const a = left[sort.field] ?? "";
      const b = right[sort.field] ?? "";
      const compared = typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a).localeCompare(String(b), undefined, { numeric: true });
      return sort.direction === "asc" ? compared : -compared;
    });
  }, [columns, query, rows, sort]);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const count = Math.ceil(MAX_RENDERED_VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
  const rendered = visible.slice(start, start + count);
  const gridTemplateColumns = `52px repeat(${columns.length}, minmax(116px, 1fr))`;
  const minWidth = 52 + columns.length * 126;

  function changeSort(field: string): void {
    setSort((current) => current.field === field
      ? { direction: current.direction === "asc" ? "desc" : "asc", field }
      : { direction: "asc", field });
  }

  return <section className="csva-table-view" aria-label={`${table.label} data table`}>
    <div className="csva-table-toolbar">
      <label><Search size={15} /><input aria-label="Search data table" onChange={(event) => setQuery(event.target.value)} placeholder="Search this data table" value={query} /></label>
      <span>{visible.length.toLocaleString()} / {rows.length.toLocaleString()} rows</span>
      <button onClick={() => onExport(visible)} type="button"><Download size={14} /> Export visible rows</button>
    </div>
    <div
      className="csva-virtual-grid"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="csva-virtual-grid-inner" style={{ minWidth }}>
        <div className="csva-virtual-grid-header" role="row" style={{ gridTemplateColumns }}>
          <span>#</span>
          {columns.map((column) => <button key={column.id} onClick={() => changeSort(column.id)} title={`Sort by ${column.id}`} type="button">
            <span>{column.id}</span>
            {sort.field === column.id ? sort.direction === "asc" ? <ArrowDownAZ size={13} /> : <ArrowUpAZ size={13} /> : null}
          </button>)}
        </div>
        <div className="csva-virtual-grid-body" style={{ height: visible.length * ROW_HEIGHT }}>
          {rendered.map((row, localIndex) => {
            const index = start + localIndex;
            const selected = selectedRowIds.includes(row.__rowId);
            return <button
              aria-selected={selected}
              className={selected ? "csva-virtual-grid-row selected" : "csva-virtual-grid-row"}
              key={row.__rowId}
              onClick={(event) => onSelectRows(resolveSelectedRowIds(
                selectedRowIds,
                [row.__rowId],
                event.ctrlKey,
              ))}
              role="row"
              style={{ gridTemplateColumns, height: ROW_HEIGHT, top: index * ROW_HEIGHT }}
              type="button"
            >
              <span>{index + 1}</span>
              {columns.map((column) => <span key={column.id} title={display(row[column.id] ?? null)}>{display(row[column.id] ?? null)}</span>)}
            </button>;
          })}
        </div>
      </div>
    </div>
  </section>;
}
