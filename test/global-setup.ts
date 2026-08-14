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

import { apiBaseUrl, requireApiToken } from "./e2e-auth.js";

/**
 * Stop a misconfigured run before it starts.
 *
 * Without this the suite discovers the missing access token as a 401 inside the
 * first fixture call, or as a scenario that waits for UI that never loads — a
 * slow, confusing signal for what is a one-line configuration problem. The
 * guideline asks for missing prerequisites to be reported explicitly rather than
 * skipped silently, so this throws and names the variable.
 *
 * Only the run is gated: `--list` does not execute global setup, so test
 * discovery still works without a live stack.
 */
export default async function globalSetup(): Promise<void> {
  requireApiToken();
  // Surfaced so a report can record which service the run authenticated against.
  process.stdout.write(`ScienceDiscovery E2E target: ${apiBaseUrl()}\n`);
}
