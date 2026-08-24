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

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { shortErrorMessage } from "@sciencediscovery/operational-logging";

import { startApiServer } from "./http/index.js";
import { apiLog } from "./logging.js";

export * from "./http/index.js";

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
if (isMain) {
  // The monitor observes both uncaught exceptions and unhandled rejections
  // without suppressing Node's normal fatal-exception behavior.
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    apiLog.error("uncaught_process_error", {
      errorMessage: shortErrorMessage(error),
      origin,
    });
  });
  startApiServer().catch((error: unknown) => {
    apiLog.error("service_start_failed", { errorMessage: shortErrorMessage(error) });
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
