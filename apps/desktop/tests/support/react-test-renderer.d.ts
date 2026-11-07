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

// `react-test-renderer` ships no type declarations, and this app's tsconfig
// includes `tests/**`, so `tsc -p apps/desktop` needs the surface the suite
// uses. The package itself is a devDependency of this app (see package.json),
// so the runtime import resolves without a shim.

declare module "react-test-renderer" {
  import type { ReactElement } from "react";

  export interface ReactTestInstance {
    children: Array<ReactTestInstance | string>;
    findAllByType(type: string): ReactTestInstance[];
    findByProps(props: Record<string, unknown>): ReactTestInstance;
    props: Record<string, unknown>;
    type: string;
  }

  export interface ReactTestRenderer {
    root: ReactTestInstance;
    toJSON(): unknown;
    unmount(): void;
  }

  export function act(body: () => void | Promise<void>): Promise<void>;
  export function create(element: ReactElement, options?: Record<string, unknown>): ReactTestRenderer;
}
