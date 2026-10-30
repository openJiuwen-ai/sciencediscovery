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

import type { WslState } from "../types.js";
import type { WslCommandRunner, WslPlatform } from "./types.js";

/** POSIX：WSL 不适用，恒 null（ExecutionCapability.wsl 留空）。 */
export const posixWslPlatform: WslPlatform = {
  detectWslState(_run?: WslCommandRunner): Promise<WslState | null> {
    return Promise.resolve(null);
  },
};
