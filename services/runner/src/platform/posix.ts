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

import { chmod } from "node:fs/promises";

import type { OsAdaptation } from "./types.js";

export const posixAdaptation: OsAdaptation = {
  restrictToOwner(path, options) {
    return chmod(path, options?.directory ? 0o700 : 0o600);
  },
  terminateTree(child) {
    return child.kill("SIGKILL");
  },
};
