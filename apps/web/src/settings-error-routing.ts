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

export type SettingsErrorReporter = (message?: string) => void;

const SETTINGS_OPERATION_ROUTES = {
  loadScopedSettings: { propagate: false, scope: "scoped" },
  revokePermission: { propagate: false, scope: "system" },
  saveGlobalSettings: { propagate: true, scope: "system" },
  saveQuotaSettings: { propagate: true, scope: "system" },
  saveSandboxNetworkSettings: { propagate: true, scope: "system" },
  saveScopedSettings: { propagate: false, scope: "scoped" },
  saveTimeoutSettings: { propagate: true, scope: "system" },
} as const;

export type SettingsOperationName = keyof typeof SETTINGS_OPERATION_ROUTES;

type SettingsErrorReporters = {
  scoped: SettingsErrorReporter;
  system: SettingsErrorReporter;
};

export function createSettingsErrorRouter(reporters: SettingsErrorReporters): {
  run<T>(
    operationName: SettingsOperationName,
    operation: () => Promise<T>,
    fallbackMessage: string,
  ): Promise<T | undefined>;
} {
  return {
    async run<T>(operationName: SettingsOperationName, operation: () => Promise<T>, fallbackMessage: string) {
      const route = SETTINGS_OPERATION_ROUTES[operationName];
      const reportError = reporters[route.scope];
      reportError();
      try {
        return await operation();
      } catch (reason) {
        reportError(reason instanceof Error ? reason.message : fallbackMessage);
        if (route.propagate) throw reason;
        return undefined;
      }
    },
  };
}
