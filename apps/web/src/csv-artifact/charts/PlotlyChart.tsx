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
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import type {
  PlotlyApi,
  PlotlyEvent,
  PlotlyHTMLElement,
} from "plotly.js-dist-min";

import type { ChartDragMode, ChartSpec, DataTable } from "../types.js";
import { buildFigure } from "./buildFigure.js";
import {
  resolveSelectedRowIds,
  rowIdsFromCustomData,
  selectedPointIndicesByTrace,
} from "./selection.js";

let plotlyPromise: Promise<PlotlyApi> | undefined;

function loadPlotly(): Promise<PlotlyApi> {
  plotlyPromise ??= import("plotly.js-dist-min").then((module) => module.default);
  return plotlyPromise;
}

export interface PlotlyChartHandle {
  exportImage(format: "png" | "svg", scale?: number): Promise<void>;
  reset(): Promise<void>;
  zoom(factor: number): Promise<void>;
}

interface PlotlyChartProps {
  dragMode: ChartDragMode;
  onHoverRow: (rowId?: string) => void;
  onSelectRows: (rowIds: string[]) => void;
  selectedRowIds: string[];
  spec: ChartSpec;
  table: DataTable;
}

function reportPlotlyError(error: unknown): void {
  console.error("CSV chart rendering failed.", error);
}

function removeInteractionListeners(element: PlotlyHTMLElement): void {
  element.removeAllListeners("plotly_selecting");
  element.removeAllListeners("plotly_selected");
  element.removeAllListeners("plotly_deselect");
  element.removeAllListeners("plotly_click");
  element.removeAllListeners("plotly_hover");
  element.removeAllListeners("plotly_unhover");
}

function withSelectionStyles(
  traces: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return traces.map((trace) => {
    if (trace.type === "heatmap" || !Array.isArray(trace.customdata)) return trace;
    const selected = trace.selected as Record<string, unknown> | undefined;
    const selectedMarker = {
      ...((selected?.marker as Record<string, unknown> | undefined) ?? {}),
    };
    delete selectedMarker.size;
    const unselected = trace.unselected as Record<string, unknown> | undefined;
    const unselectedMarker = unselected?.marker as Record<string, unknown> | undefined;
    return {
      ...trace,
      selected: {
        ...selected,
        marker: {
          ...selectedMarker,
          line: { color: "#111827", width: 1.2 },
          opacity: 1,
        },
      },
      unselected: {
        ...unselected,
        marker: {
          ...unselectedMarker,
          opacity: 0.16,
        },
      },
    };
  });
}

async function applySelectedRows(
  Plotly: PlotlyApi,
  element: PlotlyHTMLElement,
  traces: Array<Record<string, unknown>>,
  selectedRowIds: string[],
): Promise<void> {
  if (!traces.length) return;
  await Plotly.restyle(element, {
    selectedpoints: selectedPointIndicesByTrace(traces, selectedRowIds),
  });
}

export const PlotlyChart = forwardRef<PlotlyChartHandle, PlotlyChartProps>(function PlotlyChart({
  dragMode,
  onHoverRow,
  onSelectRows,
  selectedRowIds,
  spec,
  table,
}, forwardedRef) {
  const host = useRef<HTMLDivElement>(null);
  const graph = useRef<PlotlyHTMLElement | undefined>(undefined);
  const lifecycleToken = useRef<object | undefined>(undefined);
  const renderQueue = useRef<Promise<void>>(Promise.resolve());
  const requestResize = useRef<() => void>(() => undefined);
  const activeDragMode = useRef(dragMode);
  const selectedRows = useRef(selectedRowIds);
  const selectionGestureBaseRows = useRef(selectedRowIds);
  const selectionGestureModified = useRef(false);
  const suppressedSelectionEvents = useRef(0);
  const outlineCleanupRevision = useRef(0);
  activeDragMode.current = dragMode;
  selectedRows.current = selectedRowIds;
  const figure = useMemo(() => buildFigure(table, spec), [spec, table]);
  const interactiveData = useMemo(() => withSelectionStyles(figure.data), [figure.data]);
  const handlers = useRef({ onHoverRow, onSelectRows });
  handlers.current = { onHoverRow, onSelectRows };

  useImperativeHandle(forwardedRef, () => ({
    async exportImage(format, scale = 2): Promise<void> {
      if (!graph.current) return;
      const Plotly = await loadPlotly();
      const safeTitle = spec.appearance.title.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "") || spec.type;
      await Plotly.downloadImage(graph.current, {
        filename: `${safeTitle}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
        format,
        scale: format === "png" ? scale : 1,
      });
    },
    async reset(): Promise<void> {
      if (!graph.current) return;
      const Plotly = await loadPlotly();
      const update: Record<string, unknown> = {};
      for (const key of Object.keys(graph.current._fullLayout ?? {})) {
        if (/^[xy]axis\d*$/.test(key)) update[`${key}.autorange`] = true;
      }
      await Plotly.relayout(graph.current, update);
    },
    async zoom(factor): Promise<void> {
      if (!graph.current) return;
      const Plotly = await loadPlotly();
      const update: Record<string, unknown> = {};
      for (const [key, axis] of Object.entries(graph.current._fullLayout ?? {})) {
        if (!/^[xy]axis\d*$/.test(key) || !Array.isArray(axis.range)) continue;
        const [start, end] = axis.range;
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        const center = (start + end) / 2;
        const half = (end - start) / 2 * factor;
        update[`${key}.range`] = [center - half, center + half];
      }
      await Plotly.relayout(graph.current, update);
    },
  }), [spec.appearance.title, spec.type]);

  useEffect(() => {
    const root = host.current;
    if (!root) return;

    const token = {};
    let active = true;
    let animationFrame = 0;
    let observer: ResizeObserver | undefined;
    let removeWindowListener: (() => void) | undefined;
    lifecycleToken.current = token;

    const onPointerDown = (event: PointerEvent): void => {
      selectionGestureBaseRows.current = [...selectedRows.current];
      selectionGestureModified.current = event.ctrlKey;
    };
    const onMouseDown = (event: MouseEvent): void => {
      if (activeDragMode.current !== "lasso") return;
      // Plotly reserves Ctrl-drag for temporary pan and Shift-drag for its own
      // persistent selection. Selection modifiers are handled by this component.
      if (event.ctrlKey) {
        Object.defineProperty(event, "ctrlKey", { configurable: true, value: false });
      }
      if (event.shiftKey) {
        Object.defineProperty(event, "shiftKey", { configurable: true, value: false });
      }
    };
    const onWindowBlur = (): void => {
      selectionGestureModified.current = false;
    };
    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("blur", onWindowBlur);

    const scheduleResize = (): void => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        renderQueue.current = renderQueue.current
          .then(async () => {
            const element = graph.current;
            const bounds = root.getBoundingClientRect();
            if (!active || lifecycleToken.current !== token || !element || bounds.width < 1 || bounds.height < 1) return;
            const Plotly = await loadPlotly();
            if (active && lifecycleToken.current === token && graph.current === element) {
              await Plotly.Plots.resize(element);
            }
          })
          .catch((error: unknown) => {
            if (active) reportPlotlyError(error);
          });
      });
    };
    requestResize.current = scheduleResize;

    void loadPlotly().then(() => {
      if (lifecycleToken.current !== token) return;
      if (typeof ResizeObserver === "undefined") {
        window.addEventListener("resize", scheduleResize);
        removeWindowListener = () => window.removeEventListener("resize", scheduleResize);
      } else {
        observer = new ResizeObserver(scheduleResize);
        observer.observe(root);
      }
      scheduleResize();
    });

    return () => {
      active = false;
      cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      removeWindowListener?.();
      root.removeEventListener("pointerdown", onPointerDown, true);
      root.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("blur", onWindowBlur);
      if (requestResize.current === scheduleResize) requestResize.current = () => undefined;

      renderQueue.current = renderQueue.current
        .then(async () => {
          if (lifecycleToken.current !== token) return;
          const Plotly = await loadPlotly();
          graph.current = undefined;
          Plotly.purge(root);
        })
        .catch(reportPlotlyError);
    };
  }, []);

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    let active = true;
    renderQueue.current = renderQueue.current
      .then(async () => {
        const Plotly = await loadPlotly();
        if (!active) return;
        if (graph.current) removeInteractionListeners(graph.current);
        const element = await Plotly.react(root, interactiveData, {
          ...figure.layout,
          dragmode: dragMode,
          datarevision: spec.id,
        }, {
          displaylogo: false,
          displayModeBar: false,
          doubleClick: "reset+autosize",
          responsive: true,
          scrollZoom: true,
        });
        if (!active) return;
        graph.current = element;
        await applySelectedRows(Plotly, element, interactiveData, selectedRows.current);
        if (!active || graph.current !== element) return;
        removeInteractionListeners(element);
        const eventRowIds = (event?: PlotlyEvent): string[] =>
          (event?.points ?? []).flatMap((point) => rowIdsFromCustomData(point.customdata));
        const selectRows = (
          rowIds: string[],
          event?: PlotlyEvent,
          forceModified?: boolean,
        ): void => {
          const modified = forceModified ?? (
            event?.event?.ctrlKey
            || selectionGestureModified.current
          );
          const baseRows = modified
            ? selectionGestureBaseRows.current
            : selectedRows.current;
          const next = resolveSelectedRowIds(baseRows, rowIds, Boolean(modified));
          selectedRows.current = next;
          handlers.current.onSelectRows(next);
          selectionGestureBaseRows.current = next;
          selectionGestureModified.current = false;
        };
        const clearSelectionOutline = (): void => {
          const revision = ++outlineCleanupRevision.current;
          suppressedSelectionEvents.current += 1;
          void Plotly.relayout(element, { selections: [] })
            .then(async () => {
              if (graph.current !== element || revision !== outlineCleanupRevision.current) return;
              await applySelectedRows(Plotly, element, interactiveData, selectedRows.current);
            })
            .catch(reportPlotlyError)
            .finally(() => {
              suppressedSelectionEvents.current = Math.max(0, suppressedSelectionEvents.current - 1);
            });
        };
        element.on("plotly_selecting", (event?: PlotlyEvent) => {
          if (!selectionGestureModified.current || suppressedSelectionEvents.current) return;
          const previewRows = resolveSelectedRowIds(
            selectionGestureBaseRows.current,
            eventRowIds(event),
            true,
          );
          void applySelectedRows(Plotly, element, interactiveData, previewRows)
            .catch(reportPlotlyError);
        });
        element.on("plotly_selected", (event?: PlotlyEvent) => {
          if (!event || suppressedSelectionEvents.current) return;
          selectRows(eventRowIds(event), event);
          clearSelectionOutline();
        });
        element.on("plotly_deselect", () => {
          if (suppressedSelectionEvents.current) return;
          selectRows([], undefined, false);
        });
        element.on("plotly_click", (event?: PlotlyEvent) => {
          const rowIds = rowIdsFromCustomData(event?.points?.[0]?.customdata);
          if (rowIds.length) selectRows(rowIds, event);
        });
        element.on("plotly_hover", (event?: PlotlyEvent) => {
          handlers.current.onHoverRow(rowIdsFromCustomData(event?.points?.[0]?.customdata)[0]);
        });
        element.on("plotly_unhover", () => handlers.current.onHoverRow(undefined));
        requestResize.current();
      })
      .catch((error: unknown) => {
        if (active) reportPlotlyError(error);
      });
    return () => {
      active = false;
    };
  }, [dragMode, figure.layout, interactiveData, spec.id]);

  useEffect(() => {
    let active = true;
    renderQueue.current = renderQueue.current
      .then(async () => {
        const element = graph.current;
        if (!active || !element) return;
        const Plotly = await loadPlotly();
        if (!active || graph.current !== element) return;
        await applySelectedRows(Plotly, element, interactiveData, selectedRows.current);
      })
      .catch((error: unknown) => {
        if (active) reportPlotlyError(error);
      });
    return () => {
      active = false;
    };
  }, [selectedRowIds]);

  return <div className="csva-plotly-host" ref={host} />;
});
