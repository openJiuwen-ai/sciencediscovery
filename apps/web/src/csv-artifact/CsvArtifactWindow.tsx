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

import type {
  ArtifactVersionProvenance,
  ScientificArtifactVersion,
} from "@sciencediscovery/schema";
import {
  Braces,
  Check,
  Download,
  FileImage,
  FlaskConical,
  Image,
  LassoSelect,
  Move,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  RotateCcw,
  Table2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { downloadText, filterRows, rowsToCsv } from "./chart-spec/filters.js";
import { createCustomSpec, createDefaultSpecs, requiredMappings } from "./chart-spec/presets.js";
import { PlotlyChart, type PlotlyChartHandle } from "./charts/PlotlyChart.js";
import { ChartConfigPanel } from "./components/ChartConfigPanel.js";
import { InspectorPanel } from "./components/InspectorPanel.js";
import { VirtualDataTable } from "./components/VirtualDataTable.js";
import { formatBytes, parseCsvText } from "./csv/inferCsv.js";
import { translateActive, useLocale } from "../i18n/index.js";
import {
  DEFAULT_CHART_DRAG_MODE,
  type ChartDragMode,
  type ChartSpec,
  type DataRow,
} from "./types.js";
import {
  loadWorkspaceState,
  removeChartFromWorkspace,
  saveWorkspaceState,
} from "./workspaceCache.js";
import "./styles.css";

interface CsvArtifactWindowProps {
  content: string;
  fileName: string;
  onClose: () => void;
  provenance?: ArtifactVersionProvenance;
  version: ScientificArtifactVersion;
}

function cloneSpec(spec: ChartSpec): ChartSpec {
  return structuredClone(spec);
}

function compactVersion(version: string): string {
  return version.length > 30 ? `${version.slice(0, 18)}...${version.slice(-7)}` : version;
}

function nextCustomSequence(specs: ChartSpec[]): number {
  return specs.reduce((highest, item) => {
    const match = /^custom-chart-(\d+)$/.exec(item.id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0) + 1;
}

function parsedArtifact(
  content: string,
  fileName: string,
  version: ScientificArtifactVersion,
) {
  try {
    const table = parseCsvText(content, {
      fileHash: version.content.hash,
      fileName,
      fileSize: version.content.size,
      importedAt: version.createdAt,
      sourceArtifactVersionId: version.id,
    });
    const specs = createDefaultSpecs(table);
    return { specs, table };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : translateActive("csv.parseArtifactFailed"),
      specs: [],
      table: undefined,
    };
  }
}

export default function CsvArtifactWindow({
  content,
  fileName,
  onClose,
  provenance,
  version,
}: CsvArtifactWindowProps) {
  const { t } = useLocale();
  const parsed = useMemo(
    () => parsedArtifact(content, fileName, version),
    [content, fileName, version],
  );
  const initialWorkspace = useMemo(() => {
    if (!parsed.table || typeof window === "undefined") {
      return { activeSpecId: parsed.specs[0]?.id ?? "", specs: parsed.specs };
    }
    return loadWorkspaceState(window.localStorage, parsed.table, parsed.specs);
  }, [parsed]);
  const [specs, setSpecs] = useState<ChartSpec[]>(() => initialWorkspace.specs);
  const [activeSpecId, setActiveSpecId] = useState(() => initialWorkspace.activeSpecId);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [hoveredRowId, setHoveredRowId] = useState<string>();
  const [error, setError] = useState<string>();
  const [leftOpen, setLeftOpen] = useState(() =>
    typeof window === "undefined" || !window.matchMedia("(max-width: 820px)").matches);
  const [rightOpen, setRightOpen] = useState(() =>
    typeof window === "undefined" || !window.matchMedia("(max-width: 1120px)").matches);
  const [dragMode, setDragMode] = useState<ChartDragMode>(DEFAULT_CHART_DRAG_MODE);
  const baselineSpecs = useRef(new Map([
    ...parsed.specs.map((item) => [item.id, cloneSpec(item)] as const),
    ...initialWorkspace.specs
      .filter((item) => item.id.startsWith("custom-chart-"))
      .map((item) => [item.id, cloneSpec(item)] as const),
  ]));
  const nextCustomChartSequence = useRef(nextCustomSequence(initialWorkspace.specs));
  const chart = useRef<PlotlyChartHandle>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  const spec = specs.find((item) => item.id === activeSpecId) ?? specs[0];
  const table = parsed.table;
  const visibleRows = useMemo(
    () => spec && table ? filterRows(table.rows, spec.displayFilters) : [],
    [spec, table],
  );
  const tableFields = new Set(table?.columns.map((column) => column.id) ?? []);
  const missingMappings = spec
    ? requiredMappings(spec.type).filter((mapping) => {
        const field = spec.mappings[mapping];
        return typeof field !== "string" || !tableFields.has(field);
      })
    : [];
  const heatmapActive = spec?.type === "heatmap";

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    setHoveredRowId(undefined);
  }, [activeSpecId]);

  useEffect(() => {
    if (!table || typeof window === "undefined" || !specs.length) return;
    saveWorkspaceState(window.localStorage, table.source.sourceArtifactVersionId, {
      activeSpecId,
      specs,
    });
  }, [activeSpecId, specs, table]);

  function updateSpec(next: ChartSpec): void {
    setSpecs((current) => current.map((item) => item.id === next.id ? next : item));
  }

  function resetSpec(): void {
    if (!spec) return;
    const baseline = baselineSpecs.current.get(spec.id);
    if (baseline) updateSpec(cloneSpec(baseline));
  }

  function addChart(): void {
    if (!table) return;
    const next = createCustomSpec(table, nextCustomChartSequence.current);
    nextCustomChartSequence.current += 1;
    baselineSpecs.current.set(next.id, cloneSpec(next));
    setSpecs((current) => [...current, next]);
    setActiveSpecId(next.id);
  }

  function deleteChart(): void {
    if (!spec || specs.length <= 1) return;
    const displayName = spec.displayName.trim() || t("csv.untitledChart");
    if (!window.confirm(t("csv.confirmDeleteChart", { name: displayName }))) return;
    const next = removeChartFromWorkspace({ activeSpecId, specs }, spec.id);
    baselineSpecs.current.delete(spec.id);
    setSpecs(next.specs);
    setActiveSpecId(next.activeSpecId);
  }

  function exportRows(rows: DataRow[]): void {
    if (!table) return;
    downloadText(
      rowsToCsv(rows, table.columns.map((column) => column.id)),
      `${fileName.replace(/\.csv$/i, "")}-visible.csv`,
      "text/csv;charset=utf-8",
    );
  }

  function exportSpec(): void {
    if (!spec) return;
    downloadText(`${JSON.stringify(spec, null, 2)}\n`, `${spec.id}.chart-spec.json`, "application/json");
  }

  async function exportImage(format: "png" | "svg"): Promise<void> {
    try {
      await chart.current?.exportImage(format, format === "png" ? 2 : 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("csv.exportFailed", { format: format.toUpperCase() }));
    }
  }

  return <div className="csva-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }} role="presentation">
    <section
      aria-label={t("csv.dialogLabel", { fileName })}
      aria-modal="true"
      className="csva-window"
      role="dialog"
    >
      <div className={`csva-shell ${leftOpen ? "" : "csva-left-closed"} ${rightOpen ? "" : "csva-right-closed"}`}>
        <header className="csva-header">
          <div className="csva-identity">
            <span>CSV</span>
            <div><strong>{t("csv.workspaceTitle")}</strong><small>{t("csv.workspaceSubtitle")}</small></div>
          </div>
          <div className="csva-file-heading" title={fileName}>
            <strong>{fileName}</strong>
            <span>v{version.version}</span>
          </div>
          <button aria-label={t("csv.closeWorkspace")} onClick={onClose} ref={closeButton} title={t("csv.close")} type="button"><X size={18} /></button>
        </header>

        {table && spec ? <>
          <div className="csva-source-strip">
            <span className="csva-source-kind">CSV</span>
            <strong>{table.source.fileName}</strong>
            <span>{formatBytes(table.source.fileSize)}</span>
            <span>{t("csv.rowsCount", { count: table.rows.length.toLocaleString() })}</span>
            <span>{t("csv.fieldsCount", { count: table.columns.length })}</span>
            <code title={table.source.sourceArtifactVersionId}>{compactVersion(table.source.sourceArtifactVersionId)}</code>
            <i><Check size={13} /> {t("csv.inputVersionPinned")}</i>
            <button aria-label={t(leftOpen ? "csv.hideChartSettings" : "csv.showChartSettings")} onClick={() => setLeftOpen((current) => !current)} title={t(leftOpen ? "csv.hideChartSettings" : "csv.showChartSettings")} type="button"><PanelLeftClose size={16} /></button>
            <button aria-label={t(rightOpen ? "csv.hideInspector" : "csv.showInspector")} onClick={() => setRightOpen((current) => !current)} title={t(rightOpen ? "csv.hideInspector" : "csv.showInspector")} type="button"><PanelRightClose size={16} /></button>
          </div>

          {error ? <div className="csva-message" role="alert"><span>{error}</span><button aria-label={t("error.dismiss")} onClick={() => setError(undefined)} title={t("error.dismiss")} type="button"><X size={15} /></button></div> : null}

          <div className="csva-workspace-grid">
            <ChartConfigPanel
              activeTable={table}
              canDelete={specs.length > 1}
              onChange={updateSpec}
              onDeleteSpec={deleteChart}
              onResetSpec={resetSpec}
              spec={spec}
            />

            <main className="csva-visual-workspace">
              <nav aria-label={t("csv.chartViews")} className="csva-view-tabs">
                {specs.map((item) => <button
                  className={item.id === spec.id ? "active" : ""}
                  key={item.id}
                  onClick={() => setActiveSpecId(item.id)}
                  title={item.displayName.trim() || t("csv.untitledChart")}
                  type="button"
                >
                  {item.type === "table" ? <Table2 size={14} /> : item.type === "volcano" ? <FlaskConical size={14} /> : <Image size={14} />}
                  <span>{item.displayName.trim() || t("csv.untitledChart")}</span>
                </button>)}
                <button
                  aria-label={t("csv.createChart")}
                  className="csva-add-view"
                  onClick={addChart}
                  title={t("csv.createChart")}
                  type="button"
                >
                  <Plus size={16} />
                </button>
              </nav>

              <div className="csva-chart-toolbar">
                <div className="csva-chart-meta">
                  <span>{spec.type}</span>
                  <strong>{t("csv.visibleRecords", { count: visibleRows.length.toLocaleString() })}</strong>
                  {spec.mappings.facetBy ? <i>{t("csv.facetField", { field: spec.mappings.facetBy })}</i> : null}
                </div>
                <div className="csva-chart-tools">
                  {spec.type !== "table" ? <>
                    <span aria-label={t("csv.chartDragMode")} className="csva-mode-switch">
                      <button aria-pressed={dragMode === "pan" || heatmapActive} className={dragMode === "pan" || heatmapActive ? "active" : ""} onClick={() => setDragMode("pan")} title={t("csv.dragToPan")} type="button"><Move size={15} /></button>
                      <button aria-pressed={dragMode === "lasso" && !heatmapActive} className={dragMode === "lasso" && !heatmapActive ? "active" : ""} disabled={heatmapActive} onClick={() => setDragMode("lasso")} title={t(heatmapActive ? "csv.heatmapSelectHint" : "csv.lassoSelectHint")} type="button"><LassoSelect size={15} /></button>
                    </span>
                    <span className="csva-toolbar-divider" />
                    <button aria-label={t("csv.zoomIn")} onClick={() => void chart.current?.zoom(.78)} title={t("csv.zoomIn")} type="button"><ZoomIn size={16} /></button>
                    <button aria-label={t("csv.zoomOut")} onClick={() => void chart.current?.zoom(1.28)} title={t("csv.zoomOut")} type="button"><ZoomOut size={16} /></button>
                    <button aria-label={t("csv.resetView")} onClick={() => void chart.current?.reset()} title={t("csv.resetView")} type="button"><RotateCcw size={16} /></button>
                    <span className="csva-toolbar-divider" />
                    <button onClick={() => void exportImage("png")} title={t("csv.exportPng")} type="button"><FileImage size={15} /> PNG</button>
                    <button onClick={() => void exportImage("svg")} title={t("csv.exportSvg")} type="button"><Image size={15} /> SVG</button>
                  </> : null}
                  <button onClick={() => exportRows(visibleRows)} title={t("csv.exportVisibleRows")} type="button"><Download size={15} /> CSV</button>
                  <button onClick={exportSpec} title={t("csv.exportSpec")} type="button"><Braces size={15} /> Spec</button>
                </div>
              </div>

              {missingMappings.length ? <div className="csva-mapping-error">
                <strong>{t("csv.incompleteMappings")}</strong>
                <span>{t("csv.selectMappings", { mappings: missingMappings.join(", ") })}</span>
              </div> : spec.type === "table"
                ? <VirtualDataTable
                    onExport={exportRows}
                    onSelectRows={setSelectedRowIds}
                    rows={visibleRows}
                    selectedRowIds={selectedRowIds}
                    table={table}
                  />
                : <div className="csva-chart-stage">
                    <PlotlyChart
                      dragMode={heatmapActive ? "pan" : dragMode}
                      onHoverRow={setHoveredRowId}
                      onSelectRows={setSelectedRowIds}
                      ref={chart}
                      selectedRowIds={selectedRowIds}
                      spec={spec}
                      table={table}
                    />
                    <div className="csva-interaction-hint">{t(heatmapActive ? "csv.hintHeatmap" : dragMode === "pan" ? "csv.hintPan" : "csv.hintLasso")}</div>
                  </div>}
            </main>

            <InspectorPanel
              hoveredRowId={hoveredRowId}
              provenance={provenance}
              selectedRowIds={selectedRowIds}
              spec={spec}
              table={table}
            />
          </div>

          <footer className="csva-status-bar">
            <span>{t("app.selectedArtifacts", { count: selectedRowIds.length.toLocaleString() })}</span>
            <span>{t("csv.displayFiltersCount", { count: spec.displayFilters.length })}</span>
            <span>ChartSpec v{spec.schemaVersion}</span>
            <strong>{t("csv.browserOnlyNote")}</strong>
          </footer>
        </> : <div className="csva-parse-error">
          <strong>{t("csv.openFailed")}</strong>
          <p>{parsed.error ?? t("csv.noTabularRecords")}</p>
        </div>}
      </div>
    </section>
  </div>;
}
