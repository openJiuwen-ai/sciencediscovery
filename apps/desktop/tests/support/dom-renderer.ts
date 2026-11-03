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

// `apps/desktop` has no DOM test environment (tests/TEST-PLAN.md): static
// rendering cannot press a key, and interaction cases otherwise wait for the
// browser E2E run. The cases that have to press Enter on a real handler mount
// the component with `react-test-renderer`, the same way the web suite does.
//
// It is a devDependency of this app, so the import below resolves on its own;
// `./react-test-renderer.d.ts` declares the part of its surface these tests use
// because the package ships no type declarations.

export { act, create } from "react-test-renderer";
export type { ReactTestInstance, ReactTestRenderer } from "react-test-renderer";
