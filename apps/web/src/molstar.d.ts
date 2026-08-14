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

// Mol* ships no `exports`/`types` fields (and some modules lack `.d.ts`), so the
// project's NodeNext `tsc` cannot resolve its deep entry points even though the
// bundler can. Declare the small surface we use here; runtime resolution is
// handled by Vite/rolldown against the real modules.

declare module "molstar/lib/mol-plugin-ui/context" {
  interface StateBuilderTo { insert(transformer: unknown, params: unknown): unknown }
  export interface PluginUIContext {
    dispose(): void;
    runTask(task: unknown): Promise<unknown>;
    canvas3d?: {
      handleResize(): void;
      requestDraw(): void;
      setProps(props: Record<string, unknown>): void;
    };
    state: { data: { build(): { to(ref: unknown): StateBuilderTo }; updateTree(tree: unknown): unknown } };
    managers: {
      camera: { reset(): void };
      structure: { hierarchy: { current: { structures: ReadonlyArray<{ cell: unknown }> } } };
    };
    builders: {
      data: { rawData(params: { data: string }): Promise<unknown> };
      structure: {
        parseTrajectory(data: unknown, format: string): Promise<unknown>;
        hierarchy: { applyPreset(trajectory: unknown, preset: string): Promise<unknown> };
      };
    };
  }
}

declare module "molstar/lib/mol-model/structure" {
  export const Structure: { toStructureElementLoci(structure: unknown): unknown };
}

declare module "molstar/lib/mol-model/structure/structure/util/superposition" {
  export function alignAndSuperpose(loci: unknown[]): Array<{ bTransform: unknown; rmsd: number; alignmentScore: number }>;
}

declare module "molstar/lib/mol-plugin-state/transforms" {
  export const StateTransforms: { Model: { TransformStructureConformation: unknown } };
}

declare module "molstar/lib/mol-plugin-ui" {
  import type { PluginUIContext } from "molstar/lib/mol-plugin-ui/context";
  export function createPluginUI(options: {
    target: HTMLElement;
    render: (component: unknown, container: Element) => unknown;
    spec?: { layout?: unknown };
    onBeforeUIRender?: (ctx: PluginUIContext) => Promise<void> | void;
  }): Promise<PluginUIContext>;
}

declare module "molstar/lib/mol-plugin-ui/react18" {
  export function renderReact18(component: unknown, container: Element): void;
}

declare module "molstar/lib/mol-plugin-ui/spec" {
  export const DefaultPluginUISpec: () => { layout?: unknown };
}

declare module "molstar/lib/mol-util/color" {
  export function Color(hex: number): number;
}
