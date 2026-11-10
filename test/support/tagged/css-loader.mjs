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

/** A stylesheet import carries no value for a node test.
 *
 * `apps/desktop` views import their CSS for the side effect of loading it into a
 * browser bundle, so a component test that mounts such a view hits
 * `ERR_UNKNOWN_FILE_EXTENSION` before any assertion runs. The collector and the
 * worker both import test modules, so the loader is registered once by
 * `node.mjs` rather than by each suite. Styles themselves are covered by the
 * visual/E2E runs, not by a unit test.
 */
export async function load(url, context, next) {
  if (url.endsWith(".css")) {
    return { format: "module", shortCircuit: true, source: "export default {};\n" };
  }
  return next(url, context);
}
