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

import type { DiagnosticIds } from "@sciencediscovery/operational-logging/diagnostics";

// Legacy error surfaces retain strings. Keep only a small correlation index, not
// response bodies or request payloads; repeated identical failures keep the latest ID.
const correlations = new Map<string, DiagnosticIds>();
export function rememberErrorDiagnostic(message: string, ids: DiagnosticIds): void {
  if (!message || message.length > 10_000) return;
  correlations.delete(message);
  correlations.set(message, ids);
  if (correlations.size > 30) correlations.delete(correlations.keys().next().value!);
}
export function errorDiagnosticIds(message: string): DiagnosticIds {
  return correlations.get(message) ?? {};
}
