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
  createOperationalLogger,
  type LogFields,
  type OperationalLogger,
} from "@sciencediscovery/operational-logging";

const noopLogger: OperationalLogger = {
  path: "",
  debug() {},
  info() {},
  warn() {},
  error() {},
};

let apiLogger = noopLogger;
let runLogger = noopLogger;

function facade(current: () => OperationalLogger): OperationalLogger {
  return {
    get path() { return current().path; },
    debug: (event: string, fields?: LogFields) => current().debug(event, fields),
    info: (event: string, fields?: LogFields) => current().info(event, fields),
    warn: (event: string, fields?: LogFields) => current().warn(event, fields),
    error: (event: string, fields?: LogFields) => current().error(event, fields),
  };
}

export const apiLog = facade(() => apiLogger);
export const runLog = facade(() => runLogger);

export function configureApiLogging(dataDir: string): void {
  apiLogger = createOperationalLogger({ category: "api", dataDir, service: "api" });
  runLogger = createOperationalLogger({ category: "run", dataDir, service: "api" });
}
