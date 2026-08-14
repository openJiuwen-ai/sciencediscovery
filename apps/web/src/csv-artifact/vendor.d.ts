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

declare module "plotly.js-dist-min" {
  export interface PlotlyPoint {
    customdata?: unknown;
    pointIndex?: number;
    pointNumber?: number;
    x?: unknown;
    y?: unknown;
  }

  export interface PlotlyEvent {
    event?: MouseEvent;
    points?: PlotlyPoint[];
  }

  export interface PlotlyHTMLElement extends HTMLDivElement {
    _fullLayout?: Record<string, {
      autorange?: boolean;
      range?: [number, number];
    }>;
    on(event: string, callback: (event?: PlotlyEvent) => void): PlotlyHTMLElement;
    removeAllListeners(event?: string): PlotlyHTMLElement;
  }

  interface DownloadImageOptions {
    filename: string;
    format: "png" | "svg";
    height?: number;
    scale?: number;
    width?: number;
  }

  export interface PlotlyApi {
    Plots: {
      resize(root: PlotlyHTMLElement): Promise<void> | void;
    };
    downloadImage(root: PlotlyHTMLElement, options: DownloadImageOptions): Promise<string>;
    purge(root: Element): void;
    react(
      root: Element,
      data: Array<Record<string, unknown>>,
      layout?: Record<string, unknown>,
      config?: Record<string, unknown>,
    ): Promise<PlotlyHTMLElement>;
    relayout(root: PlotlyHTMLElement, update: Record<string, unknown>): Promise<PlotlyHTMLElement>;
    restyle(root: PlotlyHTMLElement, update: Record<string, unknown>): Promise<PlotlyHTMLElement>;
  }

  const Plotly: PlotlyApi;
  export default Plotly;
}
