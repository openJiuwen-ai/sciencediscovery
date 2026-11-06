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

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** Every workspace entry the web app imports from `src/`. */
const WORKSPACE_ENTRIES = [
  "@sciencediscovery/artifact-json/manifest",
  "@sciencediscovery/artifact-json/web",
  "@sciencediscovery/mcp/manifest",
  "@sciencediscovery/mcp/web",
  "@sciencediscovery/operational-logging/diagnostics",
  "@sciencediscovery/plan/manifest",
  "@sciencediscovery/plan/web",
  "@sciencediscovery/plugin-sdk",
  "@sciencediscovery/plugin-sdk/views",
  "@sciencediscovery/scheduler/manifest",
  "@sciencediscovery/schema",
  "@sciencediscovery/skill/manifest",
  "@sciencediscovery/skill/web",
  "@sciencediscovery/trajectory",
  "@sciencediscovery/trajectory/web",
];

test("every workspace package the web app imports resolves from its built entry", () => {
  // These packages publish their runtime entry from `dist/`, the same entry the
  // browser bundle and `node dist/server.js` load. When that directory is
  // missing — a clean tree, before any build — importing one of them throws
  // ERR_MODULE_NOT_FOUND and takes the whole test file with it, which is how a
  // bare `tsx --test` run lost 63 of its 448 tests. The suite's `test` script
  // now builds them first; this test says so instead of leaving the failure to
  // surface as a wall of module errors.
  for (const entry of WORKSPACE_ENTRIES) {
    const url = import.meta.resolve(entry);
    const file = url.startsWith("file:") ? fileURLToPath(url) : url;
    // `import.meta.resolve` only maps the specifier; the file behind it is what
    // the import loads, so the check that matters is that it exists.
    assert.ok(
      existsSync(file),
      `${entry} resolves to ${file}, which does not exist; the workspace packages need building first`,
    );
  }
});
